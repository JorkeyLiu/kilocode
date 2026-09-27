import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { SessionPromptDispatchService, layer as PromptLayer } from "@/kilocode/session/session-prompt-dispatch"
import { SessionCommandDispatchService, layer as CommandLayer } from "@/kilocode/session/session-command-dispatch"
import { Command } from "@/command"
import { createSessionOperationsDeps } from "@/private-worker/session-operations-adapter"

const toTestEffect = <A>(self: Effect.Effect<A, unknown, unknown>): Effect.Effect<A, never, never> =>
  self.pipe(Effect.catchCause((cause: unknown) => Effect.die(cause))) as unknown as Effect.Effect<A, never, never>
const runTest = (self: Effect.Effect<void, unknown, unknown>) => Effect.runPromise(toTestEffect(self))

const SID = "ses_abc12300000000000001"
const DIR = "/tmp/ws"

const ensureSession = (db: any) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: "proj-test" as any, worktree: DIR as any, vcs: "git", time_created: Date.now(), time_updated: Date.now(), sandboxes: [] as any } as any)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: SID as any, project_id: "proj-test" as any, slug: "test", directory: DIR, title: "t", version: "1", revision: 0, time_created: Date.now(), time_updated: Date.now() } as any)
      .run()
      .pipe(Effect.orDie)
  })

function fakeStore() {
  const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
  return Layer.succeed(InstanceStore.Service, {
    load: () => Effect.succeed(fakeCtx),
    reload: () => Effect.succeed(fakeCtx),
    dispose: () => Effect.void,
    disposeSafe: () => Effect.void,
    disposeDirectory: () => Effect.void,
    disposeAll: () => Effect.void,
    provide: (_i: unknown, e: Effect.Effect<unknown>) => e as Effect.Effect<unknown>,
    snapshot: () => Effect.succeed(Option.none()),
    directories: () => Effect.succeed([]),
  } as any)
}

describe("generation failure single normalization boundary (direction 79-94)", () => {
  test("provider/tool/transport-shaped errors share one scrub/cap boundary before durable write", async () => {
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const shapes = [
              { mid: "msg_abc12300000000000011", raw: "provider 401 api_key=provider-secret-1", detail: "status=401 authorization=Bearer provider-secret-1" },
              { mid: "msg_abc12300000000000012", raw: "tool failed token=tool-secret-2", detail: "Error: tool failed password=hunter2-tool" },
              { mid: "msg_abc12300000000000013", raw: "transport eof secret=transport-secret-3", detail: "transport eof credential=transport-secret-3" },
            ]
            for (const s of shapes) {
              const opId = SessionOperation.promptId(s.mid)
              yield* SessionOperation.ensurePromptInFlight(db, SID as any, opId)
              const rec = SessionOperation.generationTerminal({
                opId,
                outcome: "failed",
                code: "prompt.failed",
                message: s.raw + " " + "x".repeat(600),
                detail: s.detail + " " + "y".repeat(1200),
              })
              const res = yield* SessionOperation.tryTransitionPromptTerminal(db, SID as any, rec)
              expect(res.applied).toBe(true)
              const row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
              expect(row).toBeDefined()
              // secret redaction before durable write
              expect(row!.message).not.toContain("provider-secret-1")
              expect(row!.message).not.toContain("tool-secret-2")
              expect(row!.message).not.toContain("transport-secret-3")
              expect(row!.message).not.toContain("hunter2-tool")
              expect(row!.message).toContain("[redacted]")
              expect(row!.message.length).toBeLessThanOrEqual(501)
              if (row!.detail) {
                expect(row!.detail).not.toContain("provider-secret-1")
                expect(row!.detail).not.toContain("tool-secret-2")
                expect(row!.detail).not.toContain("transport-secret-3")
                expect(row!.detail.length).toBeLessThanOrEqual(1001)
              }
              // classification never schedules recovery: budget stays 0, no replay
              expect(row!.recovery_budget).toBe(0)
              expect(row!.recovery_next_at).toBeNull()
              expect(row!.recovery_provenance).toBe("terminal")
            }
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("panel projection carries versioned redacted fields only, no diagnostic detail/stack", async () => {
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const mid = "msg_abc12300000000000021"
            const opId = SessionOperation.promptId(mid)
            yield* SessionOperation.ensurePromptInFlight(db, SID as any, opId)
            const rec = SessionOperation.generationTerminal({
              opId,
              outcome: "failed",
              code: "prompt.failed",
              message: "boom api_key=panel-secret",
              detail: "diagnostic password=panel-secret",
            })
            const withStack: SessionOperation.FailureRecord = { ...rec, stack: "stack token=panel-secret" }
            const res = yield* SessionOperation.tryTransitionPromptTerminal(db, SID as any, withStack)
            expect(res.applied).toBe(true)
            const stored = yield* SessionOperation.get(db, opId)
            expect(stored).toBeDefined()
            const panel = SessionOperation.toPanelRecord(stored!)
            expect(panel.detail).toBeUndefined()
            expect(panel.stack).toBeUndefined()
            expect(panel.message).not.toContain("panel-secret")
            // versioned panel projection via production adapter keeps structure
            const deps = createSessionOperationsDeps(db)
            const out = yield* Effect.promise(() => deps.operations({ directory: DIR, sessionId: SID, limit: 5 }))
            expect(out.status).toBe("found")
            if (out.status !== "found") throw new Error("expected found")
            const entry = out.operations.find((o) => o.opId === opId)!
            expect(entry).toBeDefined()
            expect((entry as unknown as Record<string, unknown>).detail).toBeUndefined()
            expect((entry as unknown as Record<string, unknown>).stack).toBeUndefined()
            expect(entry.message).not.toContain("panel-secret")
            // unattributable prompt (no generation member/receipt) omits recovery rather than a placeholder budget
            expect(entry.recovery).toBeUndefined()
            // success/in-flight carry no failure recovery record
            const okMid = "msg_abc12300000000000022"
            const okOp = SessionOperation.promptId(okMid)
            yield* SessionOperation.ensurePromptInFlight(db, SID as any, okOp)
            const okRec = SessionOperation.generationTerminal({ opId: okOp, outcome: "succeeded", code: "prompt.succeeded", message: "ok" })
            const okRes = yield* SessionOperation.tryTransitionPromptTerminal(db, SID as any, okRec)
            expect(okRes.applied).toBe(true)
            const out2 = yield* Effect.promise(() => deps.operations({ directory: DIR, sessionId: SID, limit: 5 }))
            if (out2.status !== "found") throw new Error("expected found")
            const okEntry = out2.operations.find((o) => o.opId === okOp)!
            expect(okEntry.recovery).toBeUndefined()
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("idempotent terminal repeated call emits zero new feed and zero revision", async () => {
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const mid = "msg_abc12300000000000031"
            const opId = SessionOperation.promptId(mid)
            yield* SessionOperation.ensurePromptInFlight(db, SID as any, opId)
            const rec = SessionOperation.generationTerminal({ opId, outcome: "failed", code: "prompt.failed", message: "boom" })
            const first = yield* SessionOperation.tryTransitionPromptTerminal(db, SID as any, rec)
            expect(first.applied).toBe(true)
            const feed1 = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, SID as any)).all().pipe(Effect.orDie)
            const rev1 = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, SID as any)).get().pipe(Effect.orDie)
            const second = yield* SessionOperation.tryTransitionPromptTerminal(db, SID as any, rec)
            expect(second.applied).toBe(false)
            expect((second as { entry?: unknown }).entry).toBeUndefined()
            const feed2 = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, SID as any)).all().pipe(Effect.orDie)
            const rev2 = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, SID as any)).get().pipe(Effect.orDie)
            expect(feed2.length).toBe(feed1.length)
            expect(rev2!.rev).toBe(rev1!.rev)
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("prompt vs command share one convergence (same wrapper, same codes, same redaction)", async () => {
    const promptMid = "msg_abc12300000000000041"
    const commandMid = "msg_abc12300000000000042"
    const secret = "shared-secret-41-42"
    const promptReq = {
      v: 1,
      requestId: "req-p",
      opId: `prompt:${promptMid}`,
      op: "session/prompt",
      idempotencyKey: `prompt:${promptMid}`,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: promptMid, parts: [{ type: "text", text: "hi" }] },
    }
    const commandReq = {
      v: 1,
      requestId: "req-c",
      opId: `prompt:${commandMid}`,
      op: "session/command",
      idempotencyKey: `prompt:${commandMid}`,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: commandMid, command: "probe", arguments: "hello" },
    }
    // prompt path
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: () => Effect.fail(new Error(`prompt boom api_key=${secret}`)),
              command: () => Effect.succeed({ id: "dummy" } as any),
              cancel: () => Effect.void,
              loop: () => Effect.die(new Error("unused")),
              shell: () => Effect.die(new Error("unused")),
              resolvePromptParts: () => Effect.succeed([] as never),
            } as any),
            Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any),
            fakeStore(),
            Layer.succeed(GenerationGate.Service, GenerationGate.noop),
            Layer.succeed(ControlLease.Service, ControlLease.noop),
          )
          const full = Layer.mergeAll(Layer.provide(PromptLayer, deps), deps)
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(promptReq)) as any
            expect(r.status).toBe("succeeded")
            let row: any
            for (let i = 0; i < 50; i++) {
              row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${promptMid}`)).get().pipe(Effect.orDie)
              if (row && row.outcome === "failed") break
              yield* Effect.sleep("20 millis")
            }
            expect(row!.outcome).toBe("failed")
            expect(row!.code).toBe("prompt.failed")
            expect(row!.message).not.toContain(secret)
            expect(row!.message).toContain("[redacted]")
            expect(row!.recovery_budget).toBe(0)
            const stored = yield* SessionOperation.get(db, `prompt:${promptMid}`)
            const panel = SessionOperation.toPanelRecord(stored!)
            expect(panel.detail).toBeUndefined()
          }).pipe(Effect.provide(full))
        }),
      ),
    )
    // command path converges identically
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: () => Effect.succeed({ id: "dummy" } as any),
              command: () => Effect.fail(new Error(`command boom password=${secret}`)),
              cancel: () => Effect.void,
              loop: () => Effect.die(new Error("unused")),
              shell: () => Effect.die(new Error("unused")),
              resolvePromptParts: () => Effect.succeed([] as never),
            } as any),
            Layer.succeed(Command.Service, {
              get: (n: string) => (n === "probe" ? Effect.succeed({ name: "probe", template: "hi" } as any) : Effect.succeed(undefined as any)),
              list: () => Effect.succeed([{ name: "probe" } as any]),
            } as any),
            Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any),
            fakeStore(),
            Layer.succeed(GenerationGate.Service, GenerationGate.noop),
            Layer.succeed(ControlLease.Service, ControlLease.noop),
          )
          const full = Layer.mergeAll(Layer.provide(CommandLayer, deps), deps)
          yield* Effect.gen(function* () {
            const svc = yield* SessionCommandDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(commandReq)) as any
            expect(r.status).toBe("succeeded")
            let row: any
            for (let i = 0; i < 50; i++) {
              row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${commandMid}`)).get().pipe(Effect.orDie)
              if (row && row.outcome === "failed") break
              yield* Effect.sleep("20 millis")
            }
            expect(row!.outcome).toBe("failed")
            expect(row!.code).toBe("prompt.failed")
            expect(row!.message).not.toContain(secret)
            expect(row!.message).toContain("[redacted]")
            expect(row!.recovery_budget).toBe(0)
            const stored = yield* SessionOperation.get(db, `prompt:${commandMid}`)
            const panel = SessionOperation.toPanelRecord(stored!)
            expect(panel.detail).toBeUndefined()
          }).pipe(Effect.provide(full))
        }),
      ),
    )
    // wrapper identity: crash fixed record and live record use the same normalize
    const crash = SessionOperation.generationTerminal({ opId: SessionOperation.promptId("msg_abc12300000000000043"), outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned due to runtime restart", time: 1 })
    const live = SessionOperation.generationTerminal({ opId: SessionOperation.promptId("msg_abc12300000000000043"), outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned", time: 1 })
    expect(crash.code).toBe(live.code)
    expect(crash.outcome).toBe("abandoned")
  })

  test("pre-accept prompt validation.failed via production dispatch writes nothing and scrubs", async () => {
    const secret = "pre-secret-51"
    const mid = "msg_abc12300000000000051"
    const opId = `prompt:${mid}`
    const badReq = {
      v: 1,
      requestId: "req-p51",
      opId,
      op: "session/prompt",
      idempotencyKey: opId,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: mid, parts: [{ type: "text", text: "hi" }] },
      [`api_key=${secret}`]: "x",
    }
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: () => Effect.die(new Error("unused")),
              command: () => Effect.succeed({ id: "dummy" } as any),
              cancel: () => Effect.void,
              loop: () => Effect.die(new Error("unused")),
              shell: () => Effect.die(new Error("unused")),
              resolvePromptParts: () => Effect.succeed([] as never),
            } as any),
            Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any),
            fakeStore(),
            Layer.succeed(GenerationGate.Service, GenerationGate.noop),
            Layer.succeed(ControlLease.Service, ControlLease.noop),
          )
          const full = Layer.mergeAll(Layer.provide(PromptLayer, deps), deps)
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const feedBefore = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, SID as any)).all().pipe(Effect.orDie)
            const revBefore = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, SID as any)).get().pipe(Effect.orDie)
            const r = (yield* svc.dispatch(badReq)) as any
            expect(r.status).toBe("failed")
            expect(r.accepted).toBe(false)
            expect(r.failure.code).toBe("validation.failed")
            expect(r.failure.retryable).toBe(false)
            expect(r.failure.message).not.toContain(secret)
            expect(r.failure.message).toContain("[redacted]")
            const stored = yield* SessionOperation.get(db, opId)
            expect(stored).toBeUndefined()
            const feedAfter = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, SID as any)).all().pipe(Effect.orDie)
            const revAfter = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, SID as any)).get().pipe(Effect.orDie)
            expect(feedAfter.length).toBe(feedBefore.length)
            expect(feedAfter.length).toBe(0)
            expect(revAfter!.rev).toBe(revBefore!.rev)
          }).pipe(Effect.provide(full))
        }),
      ),
    )
  })

  test("pre-accept command command.not_found via production dispatch writes nothing and scrubs", async () => {
    const secret = "cmd-secret-52"
    const mid = "msg_abc12300000000000052"
    const opId = `prompt:${mid}`
    const badCommand = `missing-probe api_key=${secret}`
    const badReq = {
      v: 1,
      requestId: "req-c52",
      opId,
      op: "session/command",
      idempotencyKey: opId,
      context: { directory: DIR, sessionId: SID, parentSessionId: null },
      payload: { messageId: mid, command: badCommand, arguments: "hello" },
    }
    const published: Array<{ type: unknown; payload: unknown }> = []
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: () => Effect.succeed({ id: "dummy" } as any),
              command: () => Effect.succeed({ id: "dummy" } as any),
              cancel: () => Effect.void,
              loop: () => Effect.die(new Error("unused")),
              shell: () => Effect.die(new Error("unused")),
              resolvePromptParts: () => Effect.succeed([] as never),
            } as any),
            Layer.succeed(Command.Service, {
              get: (n: string) => (n === "probe" ? Effect.succeed({ name: "probe", template: "hi" } as any) : Effect.succeed(undefined as any)),
              list: () => Effect.succeed([{ name: "probe" } as any]),
            } as any),
            Layer.succeed(EventV2Bridge.Service, {
              publish: (type: unknown, payload: unknown) => {
                published.push({ type, payload })
                return Effect.void
              },
            } as any),
            fakeStore(),
            Layer.succeed(GenerationGate.Service, GenerationGate.noop),
            Layer.succeed(ControlLease.Service, ControlLease.noop),
          )
          const full = Layer.mergeAll(Layer.provide(CommandLayer, deps), deps)
          yield* Effect.gen(function* () {
            const svc = yield* SessionCommandDispatchService
            const db = (yield* Database.Service).db
            yield* ensureSession(db)
            const feedBefore = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, SID as any)).all().pipe(Effect.orDie)
            const revBefore = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, SID as any)).get().pipe(Effect.orDie)
            const r = (yield* svc.dispatch(badReq)) as any
            expect(r.status).toBe("failed")
            expect(r.accepted).toBe(false)
            expect(r.failure.code).toBe("command.not_found")
            expect(r.failure.retryable).toBe(false)
            expect(r.failure.message).not.toContain(secret)
            expect(r.failure.message).toContain("[redacted]")
            // event message uses the same normalized/scrubbed result as the reply
            expect(published.length).toBe(1)
            expect(published[0]!.type).toBe(Session.Event.Error)
            const eventPayload = published[0]!.payload as { error?: { data?: { message?: unknown }; message?: unknown } }
            const eventMessage = String(eventPayload?.error?.data?.message ?? eventPayload?.error?.message ?? "")
            expect(eventMessage).not.toContain(secret)
            expect(eventMessage).toContain("[redacted]")
            expect(eventMessage).toBe(r.failure.message)
            const eventJson = JSON.stringify(published[0])
            expect(eventJson).not.toContain(secret)
            expect(eventJson).not.toContain(JSON.stringify(secret).slice(1, -1))
            const replyJson = JSON.stringify(r)
            expect(replyJson).not.toContain(secret)
            const stored = yield* SessionOperation.get(db, opId)
            expect(stored).toBeUndefined()
            const feedAfter = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, SID as any)).all().pipe(Effect.orDie)
            const revAfter = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, SID as any)).get().pipe(Effect.orDie)
            expect(feedAfter.length).toBe(feedBefore.length)
            expect(feedAfter.length).toBe(0)
            expect(revAfter!.rev).toBe(revBefore!.rev)
          }).pipe(Effect.provide(full))
        }),
      ),
    )
  })
})
