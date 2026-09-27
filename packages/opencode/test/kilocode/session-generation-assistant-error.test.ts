import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { SessionPromptDispatchService, layer as PromptLayer } from "@/kilocode/session/session-prompt-dispatch"
import { SessionCommandDispatchService, layer as CommandLayer } from "@/kilocode/session/session-command-dispatch"
import { Command } from "@/command"

const toTestEffect = <A>(self: Effect.Effect<A, unknown, unknown>): Effect.Effect<A, never, never> =>
  self.pipe(Effect.catchCause((cause: unknown) => Effect.die(cause))) as unknown as Effect.Effect<A, never, never>
const runTest = (self: Effect.Effect<void, unknown, unknown>) => Effect.runPromise(toTestEffect(self))

const SID = "ses_abc12300000000000091"
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

function promptReq(mid: string, requestId: string, extra?: Record<string, unknown>) {
  return {
    v: 1,
    requestId,
    opId: `prompt:${mid}`,
    op: "session/prompt",
    idempotencyKey: `prompt:${mid}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: mid, parts: [{ type: "text", text: "hi" }], ...(extra ?? {}) },
  }
}

function commandReq(mid: string, requestId: string) {
  return {
    v: 1,
    requestId,
    opId: `prompt:${mid}`,
    op: "session/command",
    idempotencyKey: `prompt:${mid}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: mid, command: "probe", arguments: "hello" },
  }
}

const waitTerminal = (db: any, opId: string) =>
  Effect.gen(function* () {
    let row: any
    for (let i = 0; i < 100; i++) {
      row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
      if (row && row.outcome !== "in-flight") break
      yield* Effect.sleep("20 millis")
    }
    return row as any
  })

describe("accepted generation assistant-error classification", () => {
  test("prompt Success assistant UnknownError terminalizes failed, receipt failed owner error replay forbidden, no duplicate session.error", async () => {
    const mid = "msg_abc12300000000000091"
    const opId = `prompt:${mid}`
    const gen = "genPromptErr91"
    const secret = "prompt-secret-91"
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const published: Array<{ type: unknown }> = []
          let dbRef: { db: any } | undefined
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: (input: any) =>
                Effect.gen(function* () {
                  const db = dbRef!.db
                  const m = String(input?.messageID ?? input?.messageId ?? mid)
                  yield* SessionGeneration.begin(db, SID as never, gen, m, 2).pipe(Effect.orDie)
                  yield* SessionGeneration.close(db, SID as never, gen, "error").pipe(Effect.orDie)
                  return {
                    info: {
                      role: "assistant",
                      id: "asst-91",
                      sessionID: SID,
                      parentID: m,
                      error: { name: "UnknownError", data: { message: `boom api_key=${secret}` } },
                    },
                    parts: [],
                  } as any
                }),
              command: () => Effect.succeed({ id: "dummy" } as any),
              cancel: () => Effect.void,
              loop: () => Effect.die(new Error("unused")),
              shell: () => Effect.die(new Error("unused")),
              resolvePromptParts: () => Effect.succeed([] as never),
            } as any),
            Layer.succeed(EventV2Bridge.Service, {
              publish: (type: unknown) => {
                published.push({ type })
                return Effect.void
              },
            } as any),
            fakeStore(),
            Layer.succeed(GenerationGate.Service, GenerationGate.noop),
            Layer.succeed(ControlLease.Service, ControlLease.noop),
          )
          const full = Layer.mergeAll(Layer.provide(PromptLayer, deps), deps)
          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            dbRef = { db }
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(promptReq(mid, "req-91"))) as any
            expect(r.status).toBe("succeeded")
            const row = yield* waitTerminal(db, opId)
            expect(row.outcome).toBe("failed")
            expect(row.code).toBe("prompt.failed")
            expect(row.message).not.toContain(secret)
            expect(row.message).toContain("[redacted]")
            expect(row.recovery_budget).toBe(0)
            const receipt = yield* SessionOperation.getReceipt(db, opId)
            expect(receipt).toBeDefined()
            expect(receipt!.outcome).toBe("failed")
            expect(receipt!.replay).toBe("forbidden")
            expect(receipt!.genID).toBe(gen)
            expect(receipt!.closeReason).toBe("error")
            const owner = yield* SessionGeneration.getOwner(db, gen)
            expect(owner?.reason).toBe("error")
            expect(owner?.closedAt).not.toBeNull()
            expect(owner?.nextAt).toBeNull()
            // processor already emitted session.error for this path; dispatch must not duplicate
            expect(published.filter((p) => String(p.type) === "session.error").length).toBe(0)
            // replay forbidden: same op replays terminal failed, accepted false
            const r2 = (yield* svc.dispatch(promptReq(mid, "req-91-replay"))) as any
            expect(r2.status).toBe("failed")
            expect(r2.accepted).toBe(false)
            expect(r2.failure.code).toBe("prompt.failed")
          }).pipe(Effect.provide(full))
        }),
      ),
    )
  })

  test("command Success assistant APIError with JSON quoted keys scrubs and terminalizes failed", async () => {
    const mid = "msg_abc12300000000000092"
    const opId = `prompt:${mid}`
    const gen = "genCommandErr92"
    const secret = "command-secret-92"
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const published: Array<{ type: unknown }> = []
          let dbRef: { db: any } | undefined
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: () => Effect.succeed({ id: "dummy" } as any),
              command: (input: any) =>
                Effect.gen(function* () {
                  const db = dbRef!.db
                  const m = String((input as any)?.messageID ?? (input as any)?.messageId ?? mid)
                  yield* SessionGeneration.begin(db, SID as never, gen, m, 2).pipe(Effect.orDie)
                  yield* SessionGeneration.close(db, SID as never, gen, "error").pipe(Effect.orDie)
                  return {
                    info: {
                      role: "assistant",
                      id: "asst-92",
                      sessionID: SID,
                      parentID: m,
                      error: { name: "APIError", data: { message: `upstream {"api_key": "${secret}"} failed` } },
                    },
                    parts: [],
                  } as any
                }),
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
              publish: (type: unknown) => {
                published.push({ type })
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
            dbRef = { db }
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(commandReq(mid, "req-92"))) as any
            expect(r.status).toBe("succeeded")
            const row = yield* waitTerminal(db, opId)
            expect(row.outcome).toBe("failed")
            expect(row.code).toBe("prompt.failed")
            expect(row.message).not.toContain(secret)
            expect(row.message).toContain("[redacted]")
            if (row.detail) expect(row.detail).not.toContain(secret)
            const receipt = yield* SessionOperation.getReceipt(db, opId)
            expect(receipt!.outcome).toBe("failed")
            expect(receipt!.replay).toBe("forbidden")
            expect(receipt!.genID).toBe(gen)
            expect(receipt!.closeReason).toBe("error")
            expect(published.filter((p) => String(p.type) === "session.error").length).toBe(0)
            const r2 = (yield* svc.dispatch(commandReq(mid, "req-92-replay"))) as any
            expect(r2.status).toBe("failed")
            expect(r2.accepted).toBe(false)
          }).pipe(Effect.provide(full))
        }),
      ),
    )
  })

  test("noReply user-only stays succeeded", async () => {
    const mid = "msg_abc12300000000000093"
    const opId = `prompt:${mid}`
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: (input: any) =>
                Effect.succeed({
                  info: { role: "user", id: String(input?.messageID ?? mid), sessionID: SID },
                  parts: [],
                } as any),
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
            const r = (yield* svc.dispatch(promptReq(mid, "req-93", { noReply: true }))) as any
            expect(r.status).toBe("succeeded")
            const row = yield* waitTerminal(db, opId)
            expect(row.outcome).toBe("succeeded")
            expect(row.code).toBe("prompt.succeeded")
          }).pipe(Effect.provide(full))
        }),
      ),
    )
  })

  test("aborted assistant error stays abandoned", async () => {
    const mid = "msg_abc12300000000000094"
    const opId = `prompt:${mid}`
    const gen = "genAbort94"
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          let dbRef: { db: any } | undefined
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: (input: any) =>
                Effect.gen(function* () {
                  const db = dbRef!.db
                  const m = String(input?.messageID ?? mid)
                  yield* SessionGeneration.begin(db, SID as never, gen, m, 2).pipe(Effect.orDie)
                  yield* SessionGeneration.close(db, SID as never, gen, "interrupted").pipe(Effect.orDie)
                  return {
                    info: {
                      role: "assistant",
                      id: "asst-94",
                      sessionID: SID,
                      parentID: m,
                      error: { name: "AbortedError", data: { message: "aborted" } },
                    },
                    parts: [],
                  } as any
                }),
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
            dbRef = { db }
            yield* ensureSession(db)
            const r = (yield* svc.dispatch(promptReq(mid, "req-94"))) as any
            expect(r.status).toBe("succeeded")
            const row = yield* waitTerminal(db, opId)
            expect(row.outcome).toBe("abandoned")
            expect(row.code).toBe("prompt.abandoned")
            const receipt = yield* SessionOperation.getReceipt(db, opId)
            expect(receipt!.outcome).toBe("abandoned")
            expect(receipt!.replay).toBe("forbidden")
          }).pipe(Effect.provide(full))
        }),
      ),
    )
  })

  test("adopted one gen two ops keep identities, both failed", async () => {
    const base = "msg_abc12300000000000095"
    const extra = "msg_abc12300000000000096"
    const gen = "genAdopt9596"
    const secret = "adopt-secret-9596"
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          let dbRef: { db: any } | undefined
          const flags = { baseBegan: false, extraBegan: false, closed: false }
          const dbLayer = Database.layerNoLease(":memory:")
          const deps = Layer.mergeAll(
            dbLayer,
            Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any),
            Layer.succeed(SessionPrompt.Service, {
              prompt: (input: any) =>
                Effect.gen(function* () {
                  const db = dbRef!.db
                  const m = String(input?.messageID ?? "")
                  yield* SessionGeneration.begin(db, SID as never, gen, m, 2).pipe(Effect.orDie)
                  if (m === base) flags.baseBegan = true
                  if (m === extra) flags.extraBegan = true
                  let tries = 0
                  while (!(flags.baseBegan && flags.extraBegan) && tries < 200) {
                    yield* Effect.sleep("10 millis")
                    tries++
                  }
                  if (m === base && !flags.closed) {
                    flags.closed = true
                    yield* SessionGeneration.close(db, SID as never, gen, "error").pipe(Effect.orDie)
                  } else {
                    let t = 0
                    while (!flags.closed && t < 200) {
                      yield* Effect.sleep("10 millis")
                      t++
                    }
                  }
                  return {
                    info: {
                      role: "assistant",
                      id: `asst-${m}`,
                      sessionID: SID,
                      parentID: m,
                      error: { name: "APIError", data: { message: `adopt boom password=${secret}` } },
                    },
                    parts: [],
                  } as any
                }),
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
            dbRef = { db }
            yield* ensureSession(db)
            const r1 = (yield* svc.dispatch(promptReq(base, "req-95"))) as any
            const r2 = (yield* svc.dispatch(promptReq(extra, "req-96"))) as any
            expect(r1.status).toBe("succeeded")
            expect(r2.status).toBe("succeeded")
            const bRow = yield* waitTerminal(db, `prompt:${base}`)
            const eRow = yield* waitTerminal(db, `prompt:${extra}`)
            expect(bRow.outcome).toBe("failed")
            expect(eRow.outcome).toBe("failed")
            expect(bRow.code).toBe("prompt.failed")
            expect(eRow.code).toBe("prompt.failed")
            expect(bRow.message).not.toContain(secret)
            expect(eRow.message).not.toContain(secret)
            const bReceipt = yield* SessionOperation.getReceipt(db, `prompt:${base}`)
            const eReceipt = yield* SessionOperation.getReceipt(db, `prompt:${extra}`)
            expect(bReceipt!.genID).toBe(gen)
            expect(eReceipt!.genID).toBe(gen)
            expect(bReceipt!.outcome).toBe("failed")
            expect(eReceipt!.outcome).toBe("failed")
            expect(bReceipt!.replay).toBe("forbidden")
            expect(eReceipt!.replay).toBe("forbidden")
            const members = yield* SessionGeneration.listMembers(db, gen).pipe(Effect.orDie)
            expect(members.map((m: any) => m.promptOpID).sort()).toEqual([`prompt:${base}`, `prompt:${extra}`].sort())
          }).pipe(Effect.provide(full))
        }),
      ),
    )
  })
})
