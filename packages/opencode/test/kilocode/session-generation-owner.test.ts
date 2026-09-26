import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { Runner } from "@/effect/runner"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import { MessageID, SessionID } from "@/session/schema"
import { pollWithTimeout } from "../lib/effect"

function stack(file: string) {
  const database = Database.layerNoLease(file)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projects = Layer.succeed(
    Project.Service,
    Project.Service.of({
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions)
}

async function freshFile() {
  const dir = await mkdtemp(join(tmpdir(), "gen-owner-"))
  return { dir, file: join(dir, "kilo.db") }
}

function withStack<A>(
  file: string,
  fn: (env: { db: Database.Interface["db"]; svc: any }) => Effect.Effect<A, unknown, unknown>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(stack(file))
        const db = Context.get(ctx, Database.Service).db
        const svc = Context.get(ctx, SessionV2.Service) as any
        return yield* fn({ db, svc })
      }),
    ) as Effect.Effect<A>,
  )
}

const setupProject = (db: Database.Interface["db"]) =>
  db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)

const feedRows = (db: Database.Interface["db"]) =>
  db
    .select({ seq: SessionChangefeedTable.seq, kind: SessionChangefeedTable.kind })
    .from(SessionChangefeedTable)
    .all()
    .pipe(Effect.orDie)

const pollOrDie = (self: Effect.Effect<any | undefined>, message: string) =>
  pollWithTimeout(self, message).pipe(Effect.orDie)

function ids(sessionID: SessionID, n: string) {
  return MessageID.make(`msg_${sessionID}_${n}` as any as string)
}

describe("durable generation owner + accepted membership", () => {
  test("1:N base plus adopted extras share one gen, cancelled and retarget excluded, idempotent no feed", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as SessionID
          const base = MessageID.make("msg_base_001")
          const extra1 = MessageID.make("msg_extra_001")
          const extra2 = MessageID.make("msg_drop_001")
          for (const m of [base, extra1, extra2]) {
            const r = yield* SessionOperation.ensurePromptInFlight(db, sid as never, SessionOperation.promptId(m as string))
            expect(r.fresh).toBe(true)
          }
          const feedBefore = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length

          const scope = yield* Scope.Scope
          const runner = Runner.make<string>(scope)
          const genHolder = yield* Deferred.make<string>()
          const entered = yield* Deferred.make<void>()
          const joined = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()

          const baseFiber = yield* KiloSessionPromptQueue.enqueue(
            sid,
            base,
            Effect.gen(function* () {
              return yield* runner.ensureRunning({
                prelude: (gen: string) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(genHolder, gen)
                    yield* SessionGeneration.begin(db, sid as never, gen, base as string, 2).pipe(Effect.orDie)
                  }),
                body: (gen: string) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined)
                    yield* pollOrDie(
                      Effect.sync(() =>
                        KiloSessionPromptQueue._isQueued(sid, extra1) && KiloSessionPromptQueue._isQueued(sid, extra2)
                          ? (true as const)
                          : undefined,
                      ),
                      "follow-ups never queued",
                    )
                    expect(yield* KiloSessionPromptQueue.cancelOne(sid, extra2)).toBe(true)
                    const adopted = KiloSessionPromptQueue.adopt(sid)
                    expect(adopted).toEqual([extra1])
                    KiloSessionPromptQueue.retarget(sid, MessageID.make("msg_synth_001") as never)
                    const res = yield* SessionGeneration.add(db, sid as never, gen, adopted as unknown as string[]).pipe(
                      Effect.orDie,
                    )
                    expect(res.added).toEqual([SessionOperation.promptId(extra1 as string)])
                    expect(res.skipped).toEqual([])
                    const members = yield* SessionGeneration.listMembers(db, gen)
                    expect(members.map((m) => m.promptOpID).sort()).toEqual(
                      [SessionOperation.promptId(base as string), SessionOperation.promptId(extra1 as string)].sort(),
                    )
                    const owner = yield* SessionGeneration.getOwner(db, gen)
                    expect(owner?.sessionID).toBe(sid as unknown as string)
                    expect(owner?.limit).toBe(2)
                    expect(owner?.used).toBe(0)
                    expect(owner?.reason).toBeNull()
                    expect(Number.isFinite(owner?.occurrence)).toBe(true)
                    yield* Deferred.succeed(joined, undefined)
                    yield* Deferred.await(gate)
                    yield* SessionGeneration.close(db, sid as never, gen, "completed").pipe(Effect.orDie)
                    return "base-done"
                  }),
              })
            }),
            Effect.succeed("base-cancelled"),
          ).pipe(Effect.forkChild)

          yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"), Effect.orDie)
          const f2 = yield* KiloSessionPromptQueue.enqueue(sid, extra1, Effect.succeed("e1-work"), Effect.succeed("e1-settled")).pipe(
            Effect.forkChild,
          )
          const f3 = yield* KiloSessionPromptQueue.enqueue(sid, extra2, Effect.succeed("e2-work"), Effect.succeed("e2-settled")).pipe(
            Effect.forkChild,
          )
          const gen = yield* Deferred.await(genHolder).pipe(Effect.timeout("5 seconds"), Effect.orDie)
          yield* Deferred.await(joined).pipe(Effect.timeout("5 seconds"), Effect.orDie)
          const feedMid = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(feedMid).toBe(feedBefore)

          const dup = yield* SessionGeneration.add(db, sid as never, gen, [extra1 as string, base as string]).pipe(Effect.orDie)
          expect(dup.added).toEqual([])
          expect(dup.skipped.sort()).toEqual(
            [SessionOperation.promptId(extra1 as string), SessionOperation.promptId(base as string)].sort(),
          )
          const feedDup = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(feedDup).toBe(feedMid)

          const synth = yield* SessionGeneration.add(db, sid as never, gen, ["msg_synth_001" as string]).pipe(Effect.orDie)
          expect(synth.added).toEqual([])
          expect(synth.skipped).toEqual([SessionOperation.promptId("msg_synth_001")])

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(baseFiber)
          const e2 = yield* Fiber.await(f2)
          const e3 = yield* Fiber.await(f3)
          if (Exit.isSuccess(e2)) expect(e2.value).toBe("e1-settled")
          if (Exit.isSuccess(e3)) expect(e3.value).toBe("e2-settled")
          const owner = yield* SessionGeneration.getOwner(db, gen)
          expect(owner?.reason).toBe("completed")
          expect(Number.isFinite(owner?.closedAt)).toBe(true)
          const feedAfter = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(feedAfter).toBe(feedBefore)
          expect(KiloSessionPromptQueue._hasInternalState(sid)).toBe(false)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("terminal prompt rows are never live members and empty owner creates nothing", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as SessionID
          const live = MessageID.make("msg_live_002")
          const done = MessageID.make("msg_done_002")
          const missing = MessageID.make("msg_missing_002")
          yield* SessionOperation.ensurePromptInFlight(db, sid as never, SessionOperation.promptId(live as string))
          yield* SessionOperation.put(db, sid as never, {
            opId: SessionOperation.promptId(done as string),
            opKind: "prompt",
            outcome: "succeeded",
            code: "prompt.succeeded",
            message: "ok",
            time: Date.now(),
          })
          const feedBefore = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          const gen = `gen_empty_${Date.now()}`
          const res = yield* SessionGeneration.begin(db, sid as never, gen, missing as string, 2).pipe(Effect.orDie)
          expect(res).toEqual({ created: false, empty: true })
          expect(yield* SessionGeneration.getOwner(db, gen)).toBeUndefined()
          const gen2 = `gen_term_${Date.now()}`
          const res2 = yield* SessionGeneration.begin(db, sid as never, gen2, done as string, 2).pipe(Effect.orDie)
          expect(res2).toEqual({ created: false, empty: true })
          expect(yield* SessionGeneration.getOwner(db, gen2)).toBeUndefined()
          const gen3 = `gen_live_${Date.now()}`
          const res3 = yield* SessionGeneration.begin(db, sid as never, gen3, live as string, 2).pipe(Effect.orDie)
          expect(res3).toEqual({ created: true, added: SessionOperation.promptId(live as string) })
          const add = yield* SessionGeneration.add(db, sid as never, gen3, [done as string, missing as string]).pipe(Effect.orDie)
          expect(add.added).toEqual([])
          expect(add.skipped.sort()).toEqual(
            [SessionOperation.promptId(done as string), SessionOperation.promptId(missing as string)].sort(),
          )
          const members = yield* SessionGeneration.listMembers(db, gen3)
          expect(members.map((m) => m.promptOpID)).toEqual([SessionOperation.promptId(live as string)])
          yield* SessionGeneration.close(db, sid as never, gen3, "interrupted").pipe(Effect.orDie)
          const feedAfter = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(feedAfter).toBe(feedBefore)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("crash restart closes orphan owners once with exact feed and no replay", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as SessionID
          const base = MessageID.make("msg_crash_base")
          const extra = MessageID.make("msg_crash_extra")
          const provOp = SessionOperation.providerId("msg_crash_base", 0)
          yield* SessionOperation.ensurePromptInFlight(db, sid as never, SessionOperation.promptId(base as string))
          yield* SessionOperation.ensurePromptInFlight(db, sid as never, SessionOperation.promptId(extra as string))
          yield* SessionOperation.put(db, sid as never, {
            opId: provOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider accepted",
            time: Date.now(),
          })
          const gen = `gen_crash_${Date.now()}`
          const begun = yield* SessionGeneration.begin(db, sid as never, gen, base as string, 2).pipe(Effect.orDie)
          expect(begun).toEqual({ created: true, added: SessionOperation.promptId(base as string) })
          const added = yield* SessionGeneration.add(db, sid as never, gen, [extra as string]).pipe(Effect.orDie)
          expect(added.added).toEqual([SessionOperation.promptId(extra as string)])
          const feed = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          return { sid: sid as unknown as string, gen, baseOp: SessionOperation.promptId(base as string), extraOp: SessionOperation.promptId(extra as string), provOp, feed }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const orphan = yield* SessionGeneration.getOwner(db, ids.gen)
          expect(orphan?.reason).toBeNull()
          const sweep = yield* SessionGeneration.convergeOrphaned(db)
          expect(sweep.converged).toEqual([ids.gen])
          expect(sweep.raced).toEqual([])
          const closed = yield* SessionGeneration.getOwner(db, ids.gen)
          expect(closed?.reason).toBe("crash")
          expect(Number.isFinite(closed?.closedAt)).toBe(true)
          expect(closed?.occurrence).toBe(orphan?.occurrence)
          const members = yield* SessionGeneration.listMembers(db, ids.gen)
          expect(members.map((m) => m.promptOpID).sort()).toEqual([ids.baseOp, ids.extraOp].sort())
          const after = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(after).toBe(before)
          const rerun = yield* SessionGeneration.convergeOrphaned(db)
          expect(rerun).toEqual({ converged: [], raced: [], skipped: [] })
          const final = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(final).toBe(after)
          const baseRec = yield* SessionOperation.get(db, ids.baseOp)
          expect(baseRec?.outcome).toBe("in-flight")
          const provRec = yield* SessionOperation.get(db, ids.provOp)
          expect(provRec?.outcome).toBe("in-flight")
          const retryRow = yield* db
            .select()
            .from(SessionOperationTable)
            .where(eq(SessionOperationTable.op_id, SessionOperation.providerId("msg_crash_base", 1)))
            .get()
            .pipe(Effect.orDie)
          expect(retryRow).toBeUndefined()
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
