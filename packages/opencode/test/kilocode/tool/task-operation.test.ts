// kilocode_change - runtime-owned prompt operation for task child + background inject
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import type { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { KiloTaskOperation } from "@/kilocode/tool/task-operation"

const SID = "ses_taskop000000000001"
const DIR = "/tmp/ws-taskop"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const run = <A>(self: Effect.Effect<A, unknown, unknown>) =>
  Effect.runPromise(self.pipe(Effect.catchCause((c: unknown) => Effect.die(c))) as Effect.Effect<A, never, never>)

const ensureSession = (db: any, sid: string = SID) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: "proj-taskop" as any, worktree: DIR as any, vcs: "git", time_created: Date.now(), time_updated: Date.now(), sandboxes: [] as any } as any)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sid as any, project_id: "proj-taskop" as any, slug: "taskop", directory: DIR, title: "t", version: "1", revision: 0, time_created: Date.now(), time_updated: Date.now() } as any)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

function reply(sessionID: SessionID, parent: MessageID, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: parent,
      sessionID,
      mode: "general",
      agent: "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
  }
}

const stubSessions = (msgs: () => SessionV1.WithParts[]) =>
  ({ messages: (_: unknown) => Effect.succeed(msgs()) }) as unknown as Session.Interface

const opRow = (db: any, opId: string) =>
  Effect.gen(function* () {
    const row = (yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)) as unknown as Record<string, unknown>
    if (!row) throw new Error(`missing row ${opId}`)
    return row
  })

describe("kilocode.tool.task-operation (real DB)", () => {
  test("child success writes succeeded op + receipt", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const mid = MessageID.ascending()
            const want = reply(sid, mid, "done")
            let calls = 0
            const out = yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => []),
              sessionID: sid,
              messageID: mid,
              run: Effect.sync(() => {
                calls++
                return want
              }),
            })
            expect(calls).toBe(1)
            expect(out.info.id).toBe(want.info.id)
            const opId = KiloTaskOperation.opIdFor(mid)
            const row = yield* opRow(db, opId)
            expect(row["outcome"]).toBe("succeeded")
            const receipt = yield* SessionOperation.getReceipt(db, opId)
            expect(receipt).toBeDefined()
            // unattributable without generation member uses existing gen_unknown, never a fake link
            expect(receipt!.genID).toBeNull()
            expect(receipt!.unknown).toBe("no_member")
            expect(receipt!.used).toBeNull()
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("real retry uses new mid/new op per attempt", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const first = MessageID.ascending()
            const second = MessageID.ascending()
            expect(first).not.toBe(second)
            const sessions = stubSessions(() => [])
            yield* KiloTaskOperation.traced({
              db,
              sessions,
              sessionID: sid,
              messageID: first,
              run: Effect.succeed(reply(sid, first, "one")),
            })
            yield* KiloTaskOperation.traced({
              db,
              sessions,
              sessionID: sid,
              messageID: second,
              run: Effect.succeed(reply(sid, second, "two")),
            })
            const a = yield* opRow(db, KiloTaskOperation.opIdFor(first))
            const b = yield* opRow(db, KiloTaskOperation.opIdFor(second))
            expect(a["outcome"]).toBe("succeeded")
            expect(b["outcome"]).toBe("succeeded")
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("failure and cancel produce controlled terminal outcomes", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const failMid = MessageID.ascending()
            const failExit = yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => []),
              sessionID: sid,
              messageID: failMid,
              run: Effect.fail(new Error("boom")),
            }).pipe(Effect.exit)
            expect(Exit.isFailure(failExit)).toBe(true)
            const failRow = yield* opRow(db, KiloTaskOperation.opIdFor(failMid))
            expect(failRow["outcome"]).toBe("failed")
            const cancelMid = MessageID.ascending()
            const cancelExit = yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => []),
              sessionID: sid,
              messageID: cancelMid,
              run: Effect.interrupt,
            }).pipe(Effect.exit)
            expect(Exit.hasInterrupts(cancelExit)).toBe(true)
            const cancelRow = yield* opRow(db, KiloTaskOperation.opIdFor(cancelMid))
            expect(cancelRow["outcome"]).toBe("abandoned")
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("background stable mid: duplicate same mid never re-executes", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const parent = SessionID.make(SID)
            const child = SessionID.make("ses_taskop000000000002")
            const mid = KiloTaskOperation.backgroundMessageID(child)
            expect(KiloTaskOperation.backgroundMessageID(child)).toBe(mid)
            const cached = reply(parent, mid, "injected")
            let store: SessionV1.WithParts[] = []
            const sessions = stubSessions(() => store)
            let calls = 0
            const input = (): SessionPrompt.PromptInput =>
              ({ messageID: mid, sessionID: parent, agent: "build", parts: [{ type: "text" as const, text: "x" }] }) as SessionPrompt.PromptInput
            const first = yield* KiloTaskOperation.traced({
              db,
              sessions,
              sessionID: parent,
              messageID: mid,
              run: Effect.sync(() => {
                calls++
                return cached
              }),
            })
            expect(calls).toBe(1)
            expect(first.info.id).toBe(cached.info.id)
            // second inject with same stable mid sees terminal row and returns cached assistant
            store = [cached]
            void input
            const second = yield* KiloTaskOperation.traced({
              db,
              sessions,
              sessionID: parent,
              messageID: mid,
              run: Effect.sync(() => {
                calls++
                return reply(parent, mid, "second")
              }),
            })
            expect(calls).toBe(1)
            expect(second.info.id).toBe(cached.info.id)
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("crash orphan converges via existing pre-bind sweep", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const mid = MessageID.ascending()
            const opId = KiloTaskOperation.opIdFor(mid)
            yield* SessionOperation.ensurePromptInFlight(db, sid, opId)
            const sweep = yield* SessionOperation.convergeOrphanedInFlight(db)
            expect(sweep.converged).toContain(opId)
            const row = yield* opRow(db, opId)
            expect(row["outcome"]).toBe("abandoned")
            const receipt = yield* SessionOperation.getReceipt(db, opId)
            expect(receipt!.unknown).toBe("no_member")
            const rerun = yield* SessionOperation.convergeOrphanedInFlight(db)
            expect(rerun.converged).toEqual([])
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("unattributable receipt never fabricates a generation link", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const mid = MessageID.ascending()
            const opId = KiloTaskOperation.opIdFor(mid)
            yield* SessionOperation.ensurePromptInFlight(db, sid, opId)
            const rec = SessionOperation.generationTerminal({ opId, outcome: "failed", code: "prompt.failed", message: "boom" })
            const res = yield* SessionOperation.tryTransitionPromptTerminal(db, sid, rec)
            expect(res.applied).toBe(true)
            const receipt = yield* SessionOperation.getReceipt(db, opId)
            expect(receipt!.genID).toBeNull()
            expect(receipt!.unknown).toBe("no_member")
            expect(Cause).toBeDefined()
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("terminal replay selects owned assistant by parentID, ignores later unrelated", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const mid = MessageID.ascending()
            const otherMid = MessageID.ascending()
            const owned = reply(sid, mid, "owned")
            const unrelated = reply(sid, otherMid, "unrelated-later")
            let calls = 0
            const sessions = stubSessions(() => [owned, unrelated])
            const first = yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => []),
              sessionID: sid,
              messageID: mid,
              run: Effect.sync(() => {
                calls++
                return owned
              }),
            })
            expect(first.info.id).toBe(owned.info.id)
            // replay with a store whose latest assistant is unrelated must still return the owned one
            const second = yield* KiloTaskOperation.traced({
              db,
              sessions,
              sessionID: sid,
              messageID: mid,
              run: Effect.sync(() => {
                calls++
                return reply(sid, mid, "must-not-run")
              }),
            })
            expect(calls).toBe(1)
            expect(second.info.id).toBe(owned.info.id)
            expect(second.info.id).not.toBe(unrelated.info.id)
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("terminal replay without owned assistant dies instead of returning unrelated", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const mid = MessageID.ascending()
            const otherMid = MessageID.ascending()
            const owned = reply(sid, mid, "owned")
            yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => []),
              sessionID: sid,
              messageID: mid,
              run: Effect.succeed(owned),
            })
            let calls = 0
            const exit = yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => [reply(sid, otherMid, "unrelated-only")]),
              sessionID: sid,
              messageID: mid,
              run: Effect.sync(() => {
                calls++
                return reply(sid, mid, "must-not-run")
              }),
            }).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            expect(calls).toBe(0)
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("concurrent same mid executes run only once", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const mid = MessageID.ascending()
            const want = reply(sid, mid, "shared")
            let calls = 0
            const slow = Effect.gen(function* () {
              yield* Effect.sleep(30)
              calls++
              return want
            })
            const sessions = stubSessions(() => [])
            const [a, b] = yield* Effect.all(
              [
                KiloTaskOperation.traced({ db, sessions, sessionID: sid, messageID: mid, run: slow }),
                KiloTaskOperation.traced({ db, sessions, sessionID: sid, messageID: mid, run: slow }),
              ],
              { concurrency: 2 },
            )
            expect(calls).toBe(1)
            expect(a.info.id).toBe(want.info.id)
            expect(b.info.id).toBe(want.info.id)
            const row = yield* opRow(db, KiloTaskOperation.opIdFor(mid))
            expect(row["outcome"]).toBe("succeeded")
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("terminal CAS race fails closed and never reports false success", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const sid = SessionID.make(SID)
            const mid = MessageID.ascending()
            const opId = KiloTaskOperation.opIdFor(mid)
            const want = reply(sid, mid, "winner-takes-it")
            // run wins the terminal CAS externally first (simulates a concurrent
            // winner / crash sweep); the owner terminalize must then lose and die.
            const racing = Effect.gen(function* () {
              const rec = SessionOperation.generationTerminal({
                opId,
                outcome: "failed",
                code: "prompt.failed",
                message: "external winner",
              })
              const res = yield* SessionOperation.tryTransitionPromptTerminal(db, sid, rec)
              expect(res.applied).toBe(true)
              return want
            })
            const exit = yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => []),
              sessionID: sid,
              messageID: mid,
              run: racing,
            }).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            const row = yield* opRow(db, opId)
            expect(row["outcome"]).toBe("failed")
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("duplicate background inject replays owned result despite later unrelated", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const parent = SessionID.make(SID)
            const child = SessionID.make("ses_taskop000000000003")
            const mid = KiloTaskOperation.backgroundMessageID(child)
            const otherMid = MessageID.ascending()
            const owned = reply(parent, mid, "injected-owned")
            const unrelated = reply(parent, otherMid, "unrelated-later")
            let calls = 0
            const first = yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => []),
              sessionID: parent,
              messageID: mid,
              run: Effect.sync(() => {
                calls++
                return owned
              }),
            })
            expect(first.info.id).toBe(owned.info.id)
            const second = yield* KiloTaskOperation.traced({
              db,
              sessions: stubSessions(() => [owned, unrelated]),
              sessionID: parent,
              messageID: mid,
              run: Effect.sync(() => {
                calls++
                return reply(parent, mid, "must-not-run")
              }),
            })
            expect(calls).toBe(1)
            expect(second.info.id).toBe(owned.info.id)
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })
})
