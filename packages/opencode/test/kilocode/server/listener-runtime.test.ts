import { afterEach, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../../src/server/server"
import { SessionPaths } from "../../../src/server/routes/instance/httpapi/groups/session"
import { withTimeout } from "../../../src/util/timeout"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

const previous = {
  flag: Flag.KILO_SERVER_PASSWORD,
  env: process.env.KILO_SERVER_PASSWORD,
}

afterEach(async () => {
  Flag.KILO_SERVER_PASSWORD = previous.flag
  if (previous.env === undefined) delete process.env.KILO_SERVER_PASSWORD
  else process.env.KILO_SERVER_PASSWORD = previous.env
  await disposeAllInstances()
  await resetDatabase()
})

type Created = { id: string }

// Sequential phase budgets. The outer test timeout must exceed their sum
// (plus session setup and listener stop) so slow CI surfaces the
// phase-specific error instead of a misleading outer timeout.
const BUSY_TIMEOUT_MS = 15_000
const STOPPED_TIMEOUT_MS = 15_000
const SETTLE_TIMEOUT_MS = 15_000
const LISTENER_STOP_TIMEOUT_MS = 10_000
// Bounded drain so settle-timeout and early-phase failures still observe
// late shell rejections before listener cleanup without waiting forever.
const SHELL_DRAIN_TIMEOUT_MS = 5_000
// Shared body-read budget for response parsing (headers arrival alone is not
// settle). Happy-path worst case is 15+15+15+5(body)+10=60s; the failure path
// adds at most the 5s drain below (65s total), still inside the 75s outer
// timeout with a 10s setup/cleanup margin. Covers tmpdir git init,
// Server.listen, session create/children/shell/abort round-trips, parsing,
// and disposal.
const SHELL_BODY_TIMEOUT_MS = 5_000
// Per-operation header bounds so every HTTP operation (create, children,
// status, shell headers, abort) stays finite and the enclosing phase deadline
// still fires with its phase-specific message instead of hanging on one
// unbounded fetch. Shell headers cover busy(15s)+stopped(15s)+settle(15s)
// with a 5s margin because the shell POST stays in-flight until abort
// interrupts the `sleep 30` work.
const CREATE_TIMEOUT_MS = 10_000
const CHILDREN_TIMEOUT_MS = 5_000
const ABORT_TIMEOUT_MS = 10_000
const SHELL_HEADERS_TIMEOUT_MS = 50_000
// Worst-case phases total 55s plus the 5s body and 5s drain above (65s).
// Outer timeout adds a 10s setup/cleanup margin for tmpdir git init,
// Server.listen, session create/children/shell/abort round-trips, response
// parsing, listener stop, and afterEach disposal.
const TEST_TIMEOUT_MS = 75_000
// Single status-fetch bound inside poll(). Keeps each iteration finite when the
// listener event loop stalls so the enclosing phase deadline still fires with
// its phase-specific message instead of hanging on one unbounded fetch.
const STATUS_FETCH_TIMEOUT_MS = 2_000
// Status body-parse bound inside the same fetchStatus operation. Headers and
// JSON parsing complete inside one bounded operation; a stalled body retries
// the poll iteration instead of escaping cleanup control.
const STATUS_BODY_TIMEOUT_MS = 2_000

async function poll(
  check: (remainingMs: number) => Promise<boolean>,
  timeoutMs: number,
  message: string,
  intervalMs = 100,
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(message)
    if (await check(remaining)) {
      // Re-check the deadline after a successful check so a slow final
      // iteration started just before the deadline cannot report a false
      // pass after the budget already expired. Strict >= closes the
      // equal-boundary false pass where Date.now() === deadline.
      if (Date.now() >= deadline) throw new Error(message)
      return
    }
    if (Date.now() > deadline) throw new Error(message)
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(message)
    await Bun.sleep(Math.min(intervalMs, left))
  }
}

// Single-boundary error aggregation. Every failure path funnels primary plus
// observed shell/cleanup errors through here so nested AggregateErrors are
// flattened and identical identities are de-duplicated instead of nesting
// AggregateError inside AggregateError.
function flattenErrors(err: unknown): unknown[] {
  if (err instanceof AggregateError) return (err.errors as unknown[]).flatMap(flattenErrors)
  return [err]
}

function mergeErrors(primary: unknown, extras: unknown[]): unknown {
  const combined = [...flattenErrors(primary), ...extras.flatMap(flattenErrors)]
  const uniq: unknown[] = []
  for (const item of combined) {
    if (!uniq.includes(item)) uniq.push(item)
  }
  if (uniq.length === 1) return uniq[0]
  const message = primary instanceof Error ? primary.message : String(primary)
  return new AggregateError(uniq, message)
}

type ShellOutcome = {
  responseReady: boolean
  bodySettled: boolean
  verified: boolean
  ok: boolean
  status?: number
  output?: string
  error?: unknown
}

type ShellDone = {
  parts: Array<{ type: string; state?: { output?: string; metadata?: { output?: string } } }>
}

test("listener aborts shared parent and subagent runners", async () => {
  Flag.KILO_SERVER_PASSWORD = undefined
  delete process.env.KILO_SERVER_PASSWORD
  await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  const dir = encodeURIComponent(tmp.path)
  // All state is created inside the listener's own runtime graph: sessions,
  // running shell work, status, and abort all go through listener HTTP so the
  // abort handler observes the same InstanceStore/Database/runner bucket that
  // started the work. No AppRuntime/test-instance runners are injected.
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  // Primary test error preserved across cleanup. A listener.stop failure in
  // the finally block is reported as secondary via a flattened AggregateError
  // and never replaces the primary error. shells/bodies/ops plus
  // shellErrors/opErrors are hoisted so the single outer catch can
  // bounded-drain late rejections before cleanup even when an early phase
  // fails before settle.
  let primary: unknown
  let hasPrimary = false
  let shells: Promise<Response>[] = []
  let bodies: Promise<ShellDone>[] = []
  let ops: Promise<unknown>[] = []
  let shellErrors: unknown[] = []
  let opErrors: unknown[] = []
  const shellOutcomes: Record<string, ShellOutcome> = {}
  try {
    const recordOp = (err: unknown) => {
      if (!opErrors.includes(err)) opErrors.push(err)
      if (!shellErrors.includes(err)) shellErrors.push(err)
    }
    const own = <T>(p: Promise<T>): Promise<T> => {
      ops.push(p as unknown as Promise<unknown>)
      p.then(
        () => undefined,
        (err) => {
          recordOp(err)
        },
      )
      return p
    }
    const snippet = async (response: Response, ms: number): Promise<string> => {
      try {
        return (await withTimeout(response.text(), ms, "error body timed out")).slice(0, 500)
      } catch (readErr) {
        return `<body unreadable: ${readErr instanceof Error ? readErr.message : String(readErr)}>`
      }
    }
    const isStatusFetchTimeout = (err: unknown) =>
      err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")
    const isStatusBodyTimeout = (err: unknown) =>
      err instanceof Error && err.message.includes("status body timed out")
    // Status ownership: same ops set, but expected poll not-ready signals
    // (fetch TimeoutError/AbortError, status body timeout) stay not-ready and
    // are not recorded as business errors. Non-2xx and parse errors are
    // recorded. The attached handler marks every status operation handled so
    // no unhandledrejection fires on early-exit paths.
    const ownStatus = <T>(p: Promise<T>): Promise<T> => {
      ops.push(p as unknown as Promise<unknown>)
      p.then(
        () => undefined,
        (err) => {
          if (!isStatusFetchTimeout(err) && !isStatusBodyTimeout(err)) recordOp(err)
        },
      )
      return p
    }
    const create = async (body: Record<string, unknown>): Promise<Created> => {
      const url = new URL(`${SessionPaths.create}?directory=${dir}`, listener.url).toString()
      // Headers (fetch with bounded signal) plus JSON body parsing complete
      // inside one bounded withTimeout operation. HTTP non-2xx becomes a
      // session-scoped Error with endpoint/status/snippet; timeouts throw and
      // are recorded via own(), never success.
      const op = withTimeout(
        (async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
          })
          if (response.status !== 200) {
            const text = await snippet(response, SHELL_BODY_TIMEOUT_MS)
            throw new Error(`create failed with HTTP ${response.status}: ${text} [endpoint=session.create]`)
          }
          expect(response.status).toBe(200)
          return (await response.json()) as Created
        })(),
        CREATE_TIMEOUT_MS,
        "create timed out",
      )
      return own(op)
    }
    const parent = await create({ title: "parent" })
    const child = await create({ title: "child", parentID: parent.id })
    const nested = await create({ title: "nested", parentID: child.id })

    // Prove the parent/child/nested tree exists in the listener-owned DB.
    const childrenUrl = (id: string) =>
      new URL(SessionPaths.children.replace(":sessionID", id) + `?directory=${dir}`, listener.url).toString()
    const fetchChildren = async (id: string): Promise<Created[]> => {
      const url = childrenUrl(id)
      const op = withTimeout(
        (async () => {
          const response = await fetch(url, { signal: AbortSignal.timeout(CHILDREN_TIMEOUT_MS) })
          if (response.status !== 200) {
            const text = await snippet(response, SHELL_BODY_TIMEOUT_MS)
            throw new Error(`children ${id} failed with HTTP ${response.status}: ${text} [endpoint=session.children]`)
          }
          expect(response.status).toBe(200)
          return (await response.json()) as Created[]
        })(),
        CHILDREN_TIMEOUT_MS,
        `children ${id} timed out`,
      )
      return own(op)
    }
    expect((await fetchChildren(parent.id)).map((item) => item.id)).toEqual([child.id])
    expect((await fetchChildren(child.id)).map((item) => item.id)).toEqual([nested.id])

    const statusUrl = new URL(`${SessionPaths.status}?directory=${dir}`, listener.url).toString()
    const fetchStatus = (remainingMs: number): Promise<Record<string, { type: string }>> => {
      // Clamp the single fetch to the remaining phase budget so a poll
      // iteration started just before the deadline cannot drift past it by a
      // full nominal timeout. Headers (bounded signal fetch) plus JSON body
      // parsing (bounded withTimeout) complete in the same owned operation and
      // are registered synchronously, so a later single-snapshot drain still
      // observes every started poll iteration. The raw response.json()
      // promise is also pushed: withTimeout is only an outer race, and
      // without this the losing body promise could outlive cleanup.
      // Timeout/abort/body-timeout still means not-ready (handled by
      // callers); HTTP non-2xx and other errors are rethrown with endpoint
      // context and never converted to success.
      const bound = Math.max(1, Math.min(STATUS_FETCH_TIMEOUT_MS, remainingMs))
      const bodyBound = Math.max(1, Math.min(STATUS_BODY_TIMEOUT_MS, remainingMs))
      const op = (async () => {
        const response = await fetch(statusUrl, { signal: AbortSignal.timeout(bound) })
        if (response.status !== 200) {
          const text = await snippet(response, STATUS_BODY_TIMEOUT_MS)
          throw new Error(`status failed with HTTP ${response.status}: ${text} [endpoint=session.status]`)
        }
        expect(response.status).toBe(200)
        const raw = response.json() as Promise<Record<string, { type: string }>>
        ops.push(raw as unknown as Promise<unknown>)
        raw.then(
          () => undefined,
          (err) => {
            if (!isStatusFetchTimeout(err) && !isStatusBodyTimeout(err)) recordOp(err)
          },
        )
        return (await withTimeout(raw, bodyBound, "status body timed out")) as Record<string, { type: string }>
      })()
      return ownStatus(op)
    }

    // Start cancellable shell work on each session inside the listener graph.
    // Each POST stays in-flight until the sleep finishes or abort interrupts it.
    const shellUrl = (id: string) =>
      new URL(SessionPaths.shell.replace(":sessionID", id) + `?directory=${dir}`, listener.url).toString()
    for (const id of [parent.id, child.id, nested.id]) {
      shellOutcomes[id] = { responseReady: false, bodySettled: false, verified: false, ok: false }
    }
    // Tracked shell wrapper with pre-registered body ownership. The body slot
    // (parse plus abort-marker verification) is created and pushed into
    // bodies/ops synchronously at start, so a single-snapshot allSettled
    // drain in the catch path still waits for body/verification work that is
    // only wired up later in the headers callback. The slot settles bounded:
    // headers timeout, body timeout, non-2xx snippet, and network failures
    // all settle it; the raw and bounded body promises are additionally
    // pushed so the withTimeout outer race cannot leak an unobserved body.
    // State control: responseReady is set only after a Response is received;
    // bodySettled only after body parse success/failure or explicit non-2xx
    // completion; headers/network rejection records error only and never
    // fabricates ready/settled. HTTP non-2xx becomes a session-specific Error
    // (with status plus a bounded body snippet) so the business error is
    // preserved for the single-boundary merge even when an early phase fails
    // first. Network and timeout rejections propagate unchanged and are
    // recorded visibly.
    const startTrackedShell = (id: string): Promise<Response> => {
      const outcome = shellOutcomes[id]!
      let settleBody!: (value: ShellDone) => void
      let failBody!: (reason?: unknown) => void
      const slot: Promise<ShellDone> = new Promise<ShellDone>((resolve, reject) => {
        settleBody = resolve
        failBody = reject
      })
      let bodyFinished = false
      const settleOnce = (value: ShellDone) => {
        if (bodyFinished) return
        bodyFinished = true
        settleBody(value)
      }
      const failOnce = (err: unknown) => {
        if (bodyFinished) return
        bodyFinished = true
        failBody(err)
      }
      bodies.push(slot)
      ops.push(slot as unknown as Promise<unknown>)
      slot.then(
        () => undefined,
        (err) => {
          recordOp(err)
        },
      )
      const tracked: Promise<Response> = withTimeout(
        fetch(shellUrl(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // Explicit model skips provider default-model lookup (no providers
            // are configured on a bare listener), so shell starts
            // deterministically with no LLM involvement; abort still interrupts
            // the running child process.
            agent: "build",
            command: "sleep 30",
            model: { providerID: "test", modelID: "test-model" },
          }),
          signal: AbortSignal.timeout(SHELL_HEADERS_TIMEOUT_MS),
        }),
        SHELL_HEADERS_TIMEOUT_MS,
        `shell ${id} headers timed out`,
      ).then(
        async (response) => {
          outcome.status = response.status
          outcome.responseReady = true
          if (response.status !== 200) {
            const text = await snippet(response, SHELL_BODY_TIMEOUT_MS)
            const err = new Error(`shell ${id} failed with HTTP ${response.status}: ${text} [endpoint=session.shell]`)
            outcome.bodySettled = true
            outcome.error = err
            failOnce(err)
            throw err
          }
          // Body ownership is wired to the pre-registered slot, not pushed as
          // a new late promise. Raw plus bounded promises are also pushed so
          // the outer withTimeout race cannot hide a stalled body from drain.
          const raw: Promise<ShellDone> = response.json() as Promise<ShellDone>
          ops.push(raw as unknown as Promise<unknown>)
          raw.then(
            () => undefined,
            (err) => {
              recordOp(err)
            },
          )
          const bounded: Promise<ShellDone> = withTimeout(raw, SHELL_BODY_TIMEOUT_MS, `shell ${id} body timed out`)
          ops.push(bounded as unknown as Promise<unknown>)
          bounded.then(
            () => undefined,
            (err) => {
              recordOp(err)
            },
          )
          const verified: Promise<ShellDone> = bounded.then(
            (done) => {
              try {
                outcome.bodySettled = true
                const output = done.parts.map((part) => part.state?.output ?? "").join("\n")
                outcome.output = output
                if (!output.includes("User aborted the command")) {
                  const err = new Error(`shell ${id} missing abort marker: ${output.slice(0, 500)}`)
                  outcome.error = err
                  failOnce(err)
                  throw err
                }
                outcome.verified = true
                outcome.ok = true
                settleOnce(done)
                return done
              } catch (err) {
                outcome.bodySettled = true
                if (outcome.error === undefined) outcome.error = err
                failOnce(outcome.error)
                throw outcome.error
              }
            },
            (bodyErr) => {
              outcome.bodySettled = true
              if (outcome.error === undefined) outcome.error = bodyErr
              failOnce(bodyErr)
              throw bodyErr
            },
          )
          verified.then(
            () => undefined,
            (err) => {
              recordOp(err)
            },
          )
          return response
        },
        (err) => {
          // Headers/network failure: no Response was received, so neither
          // responseReady nor bodySettled may be set. Record the error and
          // settle the pre-registered slot so the bounded drain observes it.
          outcome.error = err
          failOnce(err)
          throw err
        },
      )
      // Central recorder: marks each headers promise handled (no
      // unhandledrejection on early-exit paths) while keeping the original
      // `tracked` promise untouched for `Promise.all`/`Promise.allSettled`.
      // De-duplicated so the non-2xx throw above is recorded exactly once.
      tracked.then(
        () => undefined,
        (err) => {
          if (!shellErrors.includes(err)) shellErrors.push(err)
          if (!opErrors.includes(err)) opErrors.push(err)
          if (outcome.error === undefined) outcome.error = err
        },
      )
      ops.push(tracked as unknown as Promise<unknown>)
      return tracked
    }
    shells = [startTrackedShell(parent.id), startTrackedShell(child.id), startTrackedShell(nested.id)]

    // Readiness signal: all three sessions report busy in the listener graph.
    await poll(
      async (remaining) => {
        try {
          const status = await fetchStatus(remaining)
          return (
            status[parent.id]?.type === "busy" &&
            status[child.id]?.type === "busy" &&
            status[nested.id]?.type === "busy"
          )
        } catch (err) {
          if (isStatusFetchTimeout(err) || isStatusBodyTimeout(err)) return false
          throw err
        }
      },
      BUSY_TIMEOUT_MS,
      "listener sessions never became busy",
    )

    // Receipt only: 200/true does not prove cancellation. Headers plus JSON
    // body complete inside one bounded operation; non-2xx throws with
    // endpoint/status/snippet and timeouts throw instead of success.
    const abortUrl = new URL(
      SessionPaths.abort.replace(":sessionID", parent.id) + `?directory=${dir}`,
      listener.url,
    ).toString()
    const aborted = await own(
      withTimeout(
        (async () => {
          const response = await fetch(abortUrl, {
            method: "POST",
            signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
          })
          if (response.status !== 200) {
            const text = await snippet(response, SHELL_BODY_TIMEOUT_MS)
            throw new Error(`abort failed with HTTP ${response.status}: ${text} [endpoint=session.abort]`)
          }
          expect(response.status).toBe(200)
          const data = (await response.json()) as boolean
          expect(data).toBe(true)
          return data
        })(),
        ABORT_TIMEOUT_MS,
        "abort timed out",
      ),
    )
    expect(aborted).toBe(true)

    // Observable stopped effect 1: every session leaves busy in the listener
    // graph. A missing status entry alone is never enough: each missing entry
    // additionally requires per-session verified shell evidence (body
    // successfully parsed, HTTP 2xx, abort marker already asserted), so a
    // dropped status key without corresponding terminal shell evidence cannot
    // pass and header-only responseReady is insufficient. Explicit non-busy
    // entries still count directly. The busy gate stays first so a single
    // remaining busy session keeps the phase pending.
    await poll(
      async (remaining) => {
        try {
          const status = await fetchStatus(remaining)
          if (
            status[parent.id]?.type === "busy" ||
            status[child.id]?.type === "busy" ||
            status[nested.id]?.type === "busy"
          ) {
            return false
          }
          const ready = (id: string) => {
            const entry = status[id]
            if (entry !== undefined && entry.type !== undefined && entry.type !== "busy") return true
            return shellOutcomes[id]?.verified === true
          }
          return ready(parent.id) && ready(child.id) && ready(nested.id)
        } catch (err) {
          if (isStatusFetchTimeout(err) || isStatusBodyTimeout(err)) return false
          throw err
        }
      },
      STOPPED_TIMEOUT_MS,
      "listener did not stop the parent/child/nested sessions",
    )

    // Observable stopped effect 2: the in-flight shell requests resolve
    // (interrupted) instead of running the full 30s sleep. Bodies were
    // already owned at start time above via pre-registered slots; here they
    // are awaited under the settle/body budget family and re-asserted per
    // session. A body timeout throws, never success, and parse failures were
    // already recorded into shellErrors/opErrors for the single-boundary
    // merge.
    const settled = await withTimeout(
      Promise.all(shells),
      SETTLE_TIMEOUT_MS,
      "listener shell work was not interrupted",
    )
    const ids = [parent.id, child.id, nested.id]
    const parsed = await withTimeout(Promise.all(bodies), SHELL_BODY_TIMEOUT_MS, "listener shell response body was not readable")
    for (let index = 0; index < parsed.length; index++) {
      const response = settled[index]!
      expect(response.status).toBe(200)
      // Interrupted shells persist the abort marker; a naturally completed
      // `sleep 30` could not resolve inside this timeout, so this proves the
      // abort actually stopped the work instead of merely being received.
      const done = parsed[index]!
      const output = done.parts.map((part) => part.state?.output ?? "").join("\n")
      expect(output).toContain("User aborted the command")
      shellOutcomes[ids[index]!]!.ok = true
    }
  } catch (err) {
    // Single error-aggregation boundary. Bounded-drain every owned operation:
    // pre-registered shell slots plus shell headers, raw/bounded bodies,
    // status headers/bodies, and create/children/abort operations. Because
    // slots are registered synchronously at start, one snapshot observes even
    // late-wired body/verification work. allSettled observes late rejections
    // (including HTTP non-2xx business errors and JSON/body parse errors
    // recorded above) before listener cleanup. The drain itself is bounded;
    // a drain timeout is recorded visibly instead of silently swallowed so
    // the primary error is preserved and merged without empty catch-all
    // handlers.
    await withTimeout(Promise.allSettled([...ops]), SHELL_DRAIN_TIMEOUT_MS, "shell drain timed out").then(
      () => undefined,
      (drainErr) => {
        if (!opErrors.includes(drainErr)) opErrors.push(drainErr)
        if (!shellErrors.includes(drainErr)) shellErrors.push(drainErr)
      },
    )
    await Bun.sleep(0)
    const extras = [...opErrors, ...shellErrors]
    const merged = extras.length > 0 ? mergeErrors(err, extras) : err
    primary = merged
    hasPrimary = true
    throw merged
  } finally {
    // Cleanup always runs. A stop failure is secondary: when a primary error
    // exists it is reported together via a flattened AggregateError instead
    // of covering the primary error; without a primary error the cleanup
    // error throws.
    try {
      await withTimeout(listener.stop(true), LISTENER_STOP_TIMEOUT_MS, "timed out cleaning up shared-runtime listener")
    } catch (cleanupErr) {
      if (hasPrimary) {
        const combined = [...flattenErrors(primary), ...flattenErrors(cleanupErr)]
        const uniq: unknown[] = []
        for (const item of combined) {
          if (!uniq.includes(item)) uniq.push(item)
        }
        throw new AggregateError(uniq, "listener test failed and cleanup also failed")
      }
      throw cleanupErr
    }
  }
}, TEST_TIMEOUT_MS)
