/**
 * Production backend harness for the P0 benchmark.
 *
 * Boots the real production listener path — `Server.listen({ hostname, port,
 * appLayer })` → `KiloListener.build` → `HttpRouter.serve` with the AppLayer
 * (the same path `kilo serve` uses) — on 127.0.0.1:0, alongside a real
 * loopback `TestLLMServer` (test/lib/llm-server.ts) that answers the
 * `test/test-model` provider's requests. All HTTP/SSE client traffic goes over
 * a real socket to that listener; `Server.Default` (the in-memory web handler)
 * is never used as production evidence.
 *
 * P0 records: with `Log.init({ print: true })` the `service=p0-perf` records
 * are written to stderr, one complete line per record. `startCapture()` tees
 * `process.stderr.write` and appends each p0 line; per-sample slices are taken
 * by index so samples never double-count each other's records.
 *
 * Resource ownership: the LLM server lives in a scope owned by this module;
 * `stop()` closes the listener (its own scope), closes the LLM scope, and
 * awaits rebuild quiescence before the caller removes the run-owned dirs.
 */

import { Context, Effect, Exit, Layer, Scope } from "effect"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { TestLLMServer } from "../lib/llm-server"
import { Server } from "@/server/server"
import { awaitRebuilds } from "@/kilocode/server/config-rebuild"
import * as P0 from "./p0-records"

/** Run an Effect to completion (Effects in this build are not thenable). */
export const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect)

// ---------------------------------------------------------------------------
// P0 stderr capture
// ---------------------------------------------------------------------------

export type P0Capture = {
  /** Append-only parsed records (all samples). */
  readonly records: P0.P0Record[]
  /** Snapshot the current append index; `slice` returns records since then. */
  readonly mark: () => number
  /** Records appended since `from` (index returned by `mark`). */
  readonly slice: (from: number) => P0.P0Record[]
}

let captureLines: string[] = []
let teeInstalled = false

/**
 * Install the stderr tee that extracts `service=p0-perf` lines. Each Log
 * record is written as one complete line, so chunk splitting is not a concern
 * for p0 records. Installed once per process and intentionally never
 * uninstalled: the capture is append-only, `stop()` closes the listener/LLM
 * scope but does NOT unwrap stderr, and the harness owns the whole process.
 */
export function startCapture(): P0Capture {
  if (!teeInstalled) {
    const original = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      original.call(process.stderr, chunk)
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      if (text.includes("service=p0-perf")) captureLines.push(text)
      return true
    }) as typeof process.stderr.write
    teeInstalled = true
  }
  return {
    records: [],
    mark: () => captureLines.length,
    slice: (from) => extractSlice(from),
  }
}

/** Parse records appended since index `from` (lazily — records parse on demand). */
function extractSlice(from: number): P0.P0Record[] {
  const lines = captureLines.slice(from)
  const out: P0.P0Record[] = []
  for (const line of lines) {
    const rec = P0.parseP0Line(line)
    if (rec) out.push(rec)
  }
  return out
}

/** Parse the full captured text (used by tests). */
export function capturedText(): string {
  return captureLines.join("")
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export type BackendHandle = {
  /** Listener base URL (http://127.0.0.1:<port>). */
  readonly base: string
  readonly port: number
  readonly llm: TestLLMServer["Service"]
  readonly capture: P0Capture
  /** Close the listener + LLM server; idempotent. */
  readonly stop: () => Promise<void>
}

let booted: BackendHandle | undefined

/**
 * Boot the production listener + TestLLMServer once per process. The LLM
 * server layer is built through the process-wide memoMap into a scope owned
 * here; `Server.listen` manages its own listener scope. Returns the shared
 * handle; repeated calls return the same instance. If the LLM layer build or
 * `Server.listen` fails (partial boot), the LLM scope is closed before the
 * error propagates so no loopback listener/port survives.
 */
export async function bootBackend(): Promise<BackendHandle> {
  if (booted) return booted
  const capture = startCapture()
  const scope = await Effect.runPromise(Scope.make())
  try {
    const llm = await Effect.runPromise(
      Layer.buildWithMemoMap(TestLLMServer.layer, memoMap, scope).pipe(
        Effect.map((ctx) => Context.get(ctx, TestLLMServer)),
      ),
    )
    // Production path: same as `kilo serve` → Server.listen → KiloListener.build
    // (AppLayer default). Port 0 lets the OS assign; the P0 `listener` span
    // records the resolved address.
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const handle: BackendHandle = {
      base: listener.url.toString().replace(/\/$/, ""),
      port: listener.port,
      llm,
      capture,
      stop: async () => {
        if (!booted) return
        booted = undefined
        // Convergence quiescence before any instance disposal: the coordinator
        // owns the convergence workers (LOCK-007) and the tracker settles last.
        await Effect.runPromise(awaitRebuilds().pipe(Effect.catchCause(() => Effect.void)))
        await listener.stop(true)
        await Effect.runPromise(Scope.close(scope, Exit.void))
      },
    }
    booted = handle
    return handle
  } catch (error) {
    // The LLM scope is owned here. On a partial boot (LLM layer build failure
    // or Server.listen rejection) close it so the loopback listener/port never
    // leaks; the original error propagates unchanged.
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined)
    throw error
  }
}

// ---------------------------------------------------------------------------
// HTTP / SSE client
// ---------------------------------------------------------------------------

/** HTTP helper: JSON request against the listener with the instance directory header. */
export async function api(
  base: string,
  dir: string,
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers: Record<string, string> = { "x-kilo-directory": dir }
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json"
    init.body = JSON.stringify(init.json)
  }
  return fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } })
}

/** Parse a JSON response, failing with status + body text on non-2xx. */
export async function json<T>(response: Response | Promise<Response>): Promise<T> {
  const res = await response
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  return (await res.json()) as T
}

export type SseEvent = {
  id?: string
  type: string
  properties: Record<string, unknown>
}

export type SseSubscription = {
  /** Events received so far (in order). */
  readonly events: SseEvent[]
  /** True once the server closed the stream (e.g. instance disposed). */
  readonly ended: () => boolean
  /** Stop reading and close the connection (owned by the caller). */
  readonly close: () => void
  /**
   * Resolve when an event matching `pred` arrives (or timeout). Rejects on
   * timeout; resolves undefined if the stream ended first.
   */
  readonly waitFor: (pred: (event: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent | undefined>
}

/**
 * Subscribe to the production `/event` SSE stream for `dir`. The instance
 * context middleware boots the directory instance on subscription, so the
 * first subscribe also triggers the instance boot stages. The caller owns the
 * subscription and MUST call `close()` (and `waitFor` promises carry a bounded
 * timeout) so no reader leaks.
 */
export function subscribe(base: string, dir: string): SseSubscription {
  const controller = new AbortController()
  const events: SseEvent[] = []
  let settled = false
  // Cursor into `events`: waitFor only considers events at/after this index,
  // so a second waitFor never re-delivers an event the first one consumed
  // (sequential waits on the same subscription — e.g. scenario 9's two
  // permission asks — must each see a distinct event).
  let scanFrom = 0
  const waiters: Array<{ pred: (event: SseEvent) => boolean; resolve: (e: SseEvent | undefined) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = []

  const advance = (event: SseEvent) => {
    const index = events.indexOf(event)
    if (index >= scanFrom) scanFrom = index + 1
  }

  const check = (event: SseEvent) => {
    for (let i = 0; i < waiters.length; i++) {
      const waiter = waiters[i]
      if (waiter && waiter.pred(event)) {
        waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        advance(event)
        waiter.resolve(event)
        break
      }
    }
  }

  const finish = () => {
    if (settled) return
    settled = true
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
  }

  fetch(`${base}/event`, { headers: { "x-kilo-directory": dir }, signal: controller.signal })
    .then((res) => {
      if (!res.body) return finish()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const pump = (): Promise<void> =>
        reader.read().then(
          ({ done, value }) => {
            if (done) return finish()
            buffer += decoder.decode(value, { stream: true })
            let sep: number
            while ((sep = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, sep)
              buffer = buffer.slice(sep + 2)
              const dataLine = frame
                .split("\n")
                .find((line) => line.startsWith("data:"))
                ?.slice(5)
                .trim()
              if (!dataLine) continue
              let raw: Record<string, unknown>
              try {
                raw = JSON.parse(dataLine) as Record<string, unknown>
              } catch {
                continue
              }
              if (typeof raw.type !== "string") continue
              const event: SseEvent = {
                type: raw.type,
                properties: (raw.properties ?? {}) as Record<string, unknown>,
                ...(typeof raw.id === "string" ? { id: raw.id } : {}),
              }
              events.push(event)
              check(event)
            }
            return pump()
          },
          (error: unknown) => {
            if (controller.signal.aborted) return
            finish()
            for (const waiter of waiters.splice(0)) {
              clearTimeout(waiter.timer)
              waiter.reject(error instanceof Error ? error : new Error(String(error)))
            }
          },
        )
      void pump()
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) return
      finish()
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

  return {
    events,
    ended: () => settled,
    close: () => {
      controller.abort()
      finish()
    },
    waitFor: (pred, timeoutMs = 15_000) =>
      new Promise<SseEvent | undefined>((resolve, reject) => {
        for (let i = scanFrom; i < events.length; i++) {
          if (pred(events[i]!)) {
            scanFrom = i + 1
            return resolve(events[i])
          }
        }
        if (settled) return resolve(undefined)
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`SSE waitFor timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.push({ pred, resolve, reject, timer })
      }),
  }
}

/** Dispose one loaded instance through the production HTTP route (per-sample cleanup). */
export async function disposeInstance(base: string, dir: string): Promise<void> {
  try {
    await api(base, dir, "/instance/dispose", { method: "POST" })
  } catch {
    // instance may already be disposed; per-sample cleanup must not fail the sample
  }
}
