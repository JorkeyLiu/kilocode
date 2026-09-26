import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option, Scope } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { SessionPromptDispatchService, layer as PromptLayer } from "@/kilocode/session/session-prompt-dispatch"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import { Runner } from "@/effect/runner"

// Minimal behavior: private dispatch accepted base + extra mid-turn adopted,
// then wait all dispatch scope fibers to terminal before asserting.
// Uses production SessionPromptDispatch + production queue/Runner +
// production SessionOperation/SessionGeneration + real DB (:memory:).
// Downstream LLM is stubbed by a controlled queue+Runner body (no network);
// full LLM adoption path stays covered by session-prompt-queue.test.ts.

const toTestEffect = <A>(self: Effect.Effect<A, unknown, unknown>): Effect.Effect<A, never, never> =>
  self.pipe(Effect.catchCause((cause: unknown) => Effect.die(cause))) as unknown as Effect.Effect<A, never, never>
const runTest = (self: Effect.Effect<void, unknown, unknown>) => Effect.runPromise(toTestEffect(self))

const SID = "ses_abc12300000000000011"
const BASE = "msg_abc12300000000000011"
const EXTRA = "msg_abc12300000000000012"
const DIR = "/tmp/ws"

function reqFor(mid: string, requestId: string) {
  return {
    v: 1,
    requestId,
    opId: `prompt:${mid}`,
    op: "session/prompt",
    idempotencyKey: `prompt:${mid}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: mid, parts: [{ type: "text", text: "hi" }] },
  }
}

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

describe("private dispatch adopted settlement", () => {
  test("base + mid-turn extra share one generation; both ops succeed after all scope fibers settle", async () => {
    await runTest(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const runner = Runner.make<{ id: string }>(scope)
          const entered = yield* Deferred.make<void>()
          const joined = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          const genHolder = yield* Deferred.make<string>()
          let extraWorkRan = false

          const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
          const dbLayer = Database.layerNoLease(":memory:")
          const sessionLayer = Layer.succeed(Session.Service, { get: () => Effect.succeed({ directory: DIR, id: SID }) } as any)
          const promptLayer = Layer.succeed(SessionPrompt.Service, {
            prompt: (input: any) =>
              Effect.gen(function* () {
                const mid = (input?.messageID ?? input?.messageId ?? "") as string
                const sid = (input?.sessionID ?? SID) as any
                if (String(mid) === EXTRA) {
                  return yield* KiloSessionPromptQueue.enqueue(
                    sid,
                    mid as never,
                    Effect.gen(function* () {
                      extraWorkRan = true
                      return { id: "extra-independent" } as any
                    }),
                    Effect.succeed({ id: "extra-settled" } as any),
                  )
                }
                return yield* KiloSessionPromptQueue.enqueue(
                  sid,
                  mid as never,
                  Effect.gen(function* () {
                    return yield* runner.ensureRunning({
                      prelude: (gen: string) =>
                        Effect.gen(function* () {
                          yield* Deferred.succeed(genHolder, gen)
                          yield* SessionGeneration.begin(dbRef!.db, sid as never, gen, String(mid) as never, 2).pipe(Effect.orDie)
                        }),
                      body: (_gen: string) =>
                        Effect.gen(function* () {
                          const gen = yield* Deferred.await(genHolder)
                          yield* Deferred.succeed(entered, void 0)
                          let tries = 0
                          while (!KiloSessionPromptQueue._isQueued(sid as never, EXTRA as never)) {
                            if (tries++ > 250) yield* Effect.die(new Error("extra never queued"))
                            yield* Effect.sleep("5 millis")
                          }
                          const adopted = KiloSessionPromptQueue.adopt(sid as never)
                          expect(adopted.map(String)).toEqual([EXTRA])
                          const genNow = yield* Deferred.await(genHolder)
                          void genNow
                          const active = yield* Effect.sync(() => (runner as any).generationID as string | undefined)
                          const useGen = active ?? gen
                          yield* SessionGeneration.add(dbRef!.db, sid as never, useGen, adopted as unknown as string[]).pipe(Effect.orDie)
                          yield* Deferred.succeed(joined, void 0)
                          yield* Deferred.await(gate)
                          yield* SessionGeneration.close(dbRef!.db, sid as never, useGen, "completed").pipe(Effect.orDie)
                          return { id: "base-done" } as any
                        }),
                    })
                  }),
                  Effect.succeed({ id: "base-cancelled" } as any),
                )
              }),
            command: () => Effect.succeed({ id: "dummy" } as any),
            cancel: () => Effect.void,
            loop: () => Effect.die(new Error("unused")),
            shell: () => Effect.die(new Error("unused")),
            resolvePromptParts: () => Effect.succeed([] as never),
          } as any)
          const eventsLayer = Layer.succeed(EventV2Bridge.Service, { publish: () => Effect.void } as any)
          const storeLayer = Layer.succeed(InstanceStore.Service, {
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
          const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
          const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop)
          const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
          const full = Layer.mergeAll(Layer.provide(PromptLayer, deps), deps)

          // Late-bound DB ref for promptImpl closure (built after Layer.build).
          let dbRef: { db: any } | undefined
          void dbRef

          yield* Effect.gen(function* () {
            const svc = yield* SessionPromptDispatchService
            const db = (yield* Database.Service).db
            dbRef = { db }
            yield* ensureSession(db)

            const r1 = (yield* svc.dispatch(reqFor(BASE, "req-base")) as any) as any
            expect(r1.status).toBe("succeeded")
            expect(r1.accepted).toBe(true)

            yield* Deferred.await(entered).pipe(Effect.timeoutOption("5 seconds"))

            const r2 = (yield* svc.dispatch(reqFor(EXTRA, "req-extra")) as any) as any
            expect(r2.status).toBe("succeeded")
            expect(r2.accepted).toBe(true)

            // Owner closes first; adopted op may still be in-flight in the
            // short window before its dispatch fiber terminalizes. Do not
            // assert final outcome here.
            yield* Deferred.await(joined).pipe(Effect.timeoutOption("5 seconds"))
            const gen = yield* Deferred.await(genHolder).pipe(Effect.timeoutOption("5 seconds"))
            void gen
            yield* Deferred.succeed(gate, void 0)

            // Wait all dispatch scope fibers to terminal: both prompt rows leave in-flight.
            const outcomeOf = (opId: string) =>
              db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
            let tries = 0
            while (tries < 100) {
              const b = (yield* outcomeOf(`prompt:${BASE}`)) as any
              const e = (yield* outcomeOf(`prompt:${EXTRA}`)) as any
              if (b?.outcome !== "in-flight" && e?.outcome !== "in-flight") break
              yield* Effect.sleep("20 millis")
              tries += 1
            }
            const baseRow = (yield* outcomeOf(`prompt:${BASE}`)) as any
            const extraRow = (yield* outcomeOf(`prompt:${EXTRA}`)) as any
            expect(baseRow.outcome).toBe("succeeded")
            expect(baseRow.code).toBe("prompt.succeeded")
            expect(extraRow.outcome).toBe("succeeded")
            expect(extraRow.code).toBe("prompt.succeeded")

            // Owner membership/close: one generation, base + adopted extra, closed completed.
            const useGen = ((runner as any).generationID as string | undefined) ?? (yield* Deferred.await(genHolder))
            const owner = yield* SessionGeneration.getOwner(db, useGen).pipe(Effect.orDie)
            expect(owner?.reason).toBe("completed")
            const members = yield* SessionGeneration.listMembers(db, useGen).pipe(Effect.orDie)
            expect(members.map((m: any) => m.promptOpID).sort()).toEqual(
              [SessionOperation.promptId(BASE), SessionOperation.promptId(EXTRA)].sort(),
            )

            // Adopted extra never started independent work; queue fully drained.
            expect(extraWorkRan).toBe(false)
            expect(KiloSessionPromptQueue._hasInternalState(SID as never)).toBe(false)
          }).pipe(Effect.provide(full))
        }),
      ),
    )
  })
})
