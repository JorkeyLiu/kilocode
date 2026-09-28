import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { OBSERVATION_VERSION } from "../../src/private-worker/observation"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { tryPrivateOperationExact } from "../../src/kilo-provider/session-operation-private"
import { submitPrivateFirst } from "../../src/kilo-provider/session-submit"
import { canonicalDirectory } from "../../src/private-worker/canonical-directory"

function tmpEnv(): { tmp: string; dbPath: string; xdg: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-op-exact-"))
  const data = path.join(tmp, "data")
  fs.mkdirSync(data, { recursive: true })
  const dbPath = path.join(data, "kilo.db")
  const xdg = {
    XDG_DATA_HOME: path.join(tmp, "xdg-data"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  }
  for (const v of Object.values(xdg)) fs.mkdirSync(v, { recursive: true })
  return { tmp, dbPath, xdg, cleanup: async () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

async function seed(): Promise<void> {
  const { Database } = await import("@opencode-ai/core/database/database")
  const { SessionTable, SessionOperationTable } = await import("@opencode-ai/core/session/sql")
  const { ProjectTable } = await import("@opencode-ai/core/project/sql")
  const { Effect, ManagedRuntime } = await import("effect")
  // Resolved via env at call time; caller sets KILO_OP_DB before invoking.
  const file = process.env.KILO_OP_DB!
  const layer = Database.layerNoLease(file)
  const rt = ManagedRuntime.make(layer)
  try {
    const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
    const dir = canonicalDirectory("/tmp/ws")
    await Effect.runPromise(
      db.insert(ProjectTable).values({ id: "proj_op_exact" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie),
    )
    const addSession = (id: string, directory: string) =>
      Effect.runPromise(
        db.insert(SessionTable).values({ id: id as never, project_id: "proj_op_exact" as never, slug: `slug-${id}`, directory: canonicalDirectory(directory) as never, title: `title-${id}`, version: "1", parent_id: null as never, time_created: 10, time_updated: 20 } as never).run().pipe(Effect.orDie),
      )
    await addSession("ses_op_exact_a", dir)
    await addSession("ses_op_exact_b", dir)
    await addSession("ses_op_exact_c", dir)
    await addSession("ses_op_exact_r", dir)
    await addSession("ses_op_exact_u", dir)
    const addOp = (op_id: string, session_id: string, outcome: string, code: string, message: string, time: number, op_kind = "prompt") =>
      Effect.runPromise(
        db.insert(SessionOperationTable).values({ op_id: op_id as never, session_id: session_id as never, op_kind: op_kind as never, outcome: outcome as never, code: code as never, message: message as never, time: time as never, cancel: null as never, detail: "secret detail token=xyz" as never, stack: "trace password=123" as never, revision: 1 as never, idempotency_hash: null as never, request_id: null as never, directory: null as never, message_id: null as never, parent_session_id: null as never } as never).run().pipe(Effect.orDie),
      )
    await addOp("prompt:msg_exact_accept", "ses_op_exact_a", "in-flight", "prompt.inflight", "prompt accepted", 42)
    await addOp("prompt:msg_exact_term", "ses_op_exact_b", "failed", "E_RUNTIME", "runtime boom", 77)
    await addOp("prompt:msg_shared", "ses_op_exact_c", "succeeded", "ok", "ok", 7)
    await addOp("revert:ses_op_exact_r:tok1", "ses_op_exact_r", "succeeded", "revert.succeeded", "revert succeeded", 11, "revert")
    await addOp("unrevert:ses_op_exact_u:tok2", "ses_op_exact_u", "succeeded", "unrevert.succeeded", "unrevert succeeded", 12, "unrevert")
    void dir
  } finally {
    await rt.dispose()
  }
}

describe("observation/operation exact via real extension private worker (SQLite+IPC)", () => {
  it("exact accepted + terminal + mismatch via real worker, unavailable/closed, single-attempt re-observe zero SDK", async () => {
    const { dbPath, xdg, cleanup } = tmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svc.initialize()
      expect(svc.isStarted()).toBe(true)
      process.env.KILO_OP_DB = dbPath
      try {
        await seed()
      } finally {
        delete process.env.KILO_OP_DB
      }

      const dir = "/tmp/ws"
      // Committed accepted prompt:<messageId> via real IPC, no direct adapter fake.
      const accepted = (await svc.operation({ directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_exact_accept" })) as {
        v: string
        status: string
        operation: Record<string, unknown>
      }
      expect(accepted.v).toBe(OBSERVATION_VERSION)
      expect(accepted.status).toBe("found")
      expect(accepted.operation.opId).toBe("prompt:msg_exact_accept")
      expect(accepted.operation.outcome).toBe("in-flight")
      expect(new Set(Object.keys(accepted.operation))).toEqual(new Set(["opId", "outcome", "code", "message", "time"]))
      expect("detail" in accepted.operation).toBe(false)
      expect("stack" in accepted.operation).toBe(false)

      // Terminal row via same real worker.
      const terminal = (await svc.operation({ directory: dir, sessionId: "ses_op_exact_b", opId: "prompt:msg_exact_term" })) as {
        status: string
        operation: { outcome: string; code: string; message: string }
      }
      expect(terminal.status).toBe("found")
      expect(terminal.operation.outcome).toBe("failed")
      expect(terminal.operation.code).toBe("E_RUNTIME")

      // Mismatched directory/session + absent op.
      const absent = (await svc.operation({ directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_missing" })) as { status: string }
      expect(absent.status).toBe("not_found")
      const cross = (await svc.operation({ directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_shared" })) as { status: string }
      expect(cross.status).toBe("scope_mismatch")
      const otherDir = (await svc.operation({ directory: "/tmp/other", sessionId: "ses_op_exact_a", opId: "prompt:msg_exact_accept" })) as { status: string }
      expect(otherDir.status).toBe("scope_mismatch")

      // Invalid opId rejects InvalidParams, does not resolve.
      let bad = false
      try {
        await svc.operation({ directory: dir, sessionId: "ses_op_exact_a", opId: "bad-op" })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)

      // Narrow checkpoint exact ops via the same real worker: panel-safe, no leak, scoped.
      const rok = (await svc.operation({ directory: dir, sessionId: "ses_op_exact_r", opId: "revert:ses_op_exact_r:tok1" })) as {
        status: string
        operation: Record<string, unknown>
      }
      expect(rok.status).toBe("found")
      expect(rok.operation.opId).toBe("revert:ses_op_exact_r:tok1")
      expect(rok.operation.outcome).toBe("succeeded")
      expect(new Set(Object.keys(rok.operation))).toEqual(new Set(["opId", "outcome", "code", "message", "time"]))
      const uok = (await svc.operation({ directory: dir, sessionId: "ses_op_exact_u", opId: "unrevert:ses_op_exact_u:tok2" })) as {
        status: string
        operation: Record<string, unknown>
      }
      expect(uok.status).toBe("found")
      expect(uok.operation.opId).toBe("unrevert:ses_op_exact_u:tok2")
      const rcross = (await svc.operation({ directory: dir, sessionId: "ses_op_exact_r", opId: "unrevert:ses_op_exact_u:tok2" })) as { status: string }
      expect(rcross.status).toBe("scope_mismatch")
      let createBad = false
      try {
        await svc.operation({ directory: dir, sessionId: "ses_op_exact_r", opId: "create:tok1" })
      } catch (e) {
        createBad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(createBad).toBe(true)

      // Provider-boundary exact read over the same real worker.
      const reader = svc as unknown as Parameters<typeof tryPrivateOperationExact>[0]
      const found = await tryPrivateOperationExact(reader, { directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_exact_accept" })
      expect(found.kind).toBe("found")
      const term = await tryPrivateOperationExact(reader, { directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_missing" })
      expect(term.kind).toBe("terminal")
      const scope = await tryPrivateOperationExact(reader, { directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_shared" })
      expect(scope.kind).toBe("terminal")
      const off = await tryPrivateOperationExact(null, { directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_exact_accept" })
      expect(off.kind).toBe("unavailable")
      const rfound = await tryPrivateOperationExact(reader, { directory: dir, sessionId: "ses_op_exact_r", opId: "revert:ses_op_exact_r:tok1" })
      expect(rfound.kind).toBe("found")
      const ufound = await tryPrivateOperationExact(reader, { directory: dir, sessionId: "ses_op_exact_u", opId: "unrevert:ses_op_exact_u:tok2" })
      expect(ufound.kind).toBe("found")

      // Transport uncertainty: one ambiguous private attempt + one exact re-observation, zero SDK.
      const observeExact = async () => {
        const attempt = await tryPrivateOperationExact(reader, { directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_exact_accept" })
        if (attempt.kind === "found") return { kind: "found" as const, operation: { opId: attempt.operation.opId, outcome: attempt.operation.outcome, code: attempt.operation.code, message: attempt.operation.message } }
        if (attempt.kind === "terminal") return { kind: "terminal" as const, error: attempt.error }
        return { kind: "unavailable" as const }
      }
      let priv = 0
      let sdk = 0
      let obs = 0
      const countedObserve = async () => {
        obs += 1
        return observeExact()
      }
      const res = await submitPrivateFirst({
        available: () => true,
        opId: "prompt:msg_exact_accept",
        scope: "Prompt",
        request: { requestId: "r1", opId: "prompt:msg_exact_accept" },
        dispatch: {
          factory: () => {
            priv += 1
            return { id: 1, promise: Promise.resolve({ status: "ambiguous", transportUnknown: true }), cancel: () => true }
          },
          direct: null,
          cancel: null,
          invalidate: null,
          peek: null,
        },
        validate: () => {},
        fallback: async () => {
          sdk += 1
          return {}
        },
        messageId: "msg_exact_accept",
        observeExact: countedObserve,
      })
      expect(res).toEqual({})
      expect(priv).toBe(1)
      expect(obs).toBe(1)
      expect(sdk).toBe(0)

      // Same harness for terminal: ambiguous private + exact failed surfaces runtime failure, zero SDK.
      const observeTerm = async () => {
        const attempt = await tryPrivateOperationExact(reader, { directory: dir, sessionId: "ses_op_exact_b", opId: "prompt:msg_exact_term" })
        if (attempt.kind === "found") return { kind: "found" as const, operation: { opId: attempt.operation.opId, outcome: attempt.operation.outcome, code: attempt.operation.code, message: attempt.operation.message } }
        if (attempt.kind === "terminal") return { kind: "terminal" as const, error: attempt.error }
        return { kind: "unavailable" as const }
      }
      let sdk2 = 0
      let thrown: unknown = null
      try {
        await submitPrivateFirst({
          available: () => true,
          opId: "prompt:msg_exact_term",
          scope: "Command",
          request: { requestId: "r2", opId: "prompt:msg_exact_term" },
          dispatch: {
            factory: () => {
              throw new Error("Peer closed")
            },
            direct: null,
            cancel: null,
            invalidate: null,
            peek: null,
          },
          validate: () => {},
          fallback: async () => {
            sdk2 += 1
            return {}
          },
          messageId: "msg_exact_term",
          observeExact: observeTerm,
        })
      } catch (e) {
        thrown = e
      }
      expect((thrown as { code?: string }).code).toBe("E_RUNTIME")
      expect(sdk2).toBe(0)

      // Worker closed: operation rejects Not started, exact read is unavailable.
      const host = svc.getHost()
      svc.dispose()
      if (host) await host.waitForExit(2000).then(() => undefined, () => undefined)
      expect(svc.isStarted()).toBe(false)
      let closed = false
      try {
        await svc.operation({ directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_exact_accept" })
      } catch (e) {
        closed = true
        expect(String((e as Error).message)).toMatch(/Not started/)
      }
      expect(closed).toBe(true)
      const afterClose = await tryPrivateOperationExact(reader, { directory: dir, sessionId: "ses_op_exact_a", opId: "prompt:msg_exact_accept" })
      expect(afterClose.kind).toBe("unavailable")
    } finally {
      const host = svc.getHost()
      svc.dispose()
      if (host) await host.waitForExit(2000).then(() => undefined, () => undefined)
      expect(svc.getHost()).toBeNull()
      await cleanup()
    }
  }, 25000)
})
