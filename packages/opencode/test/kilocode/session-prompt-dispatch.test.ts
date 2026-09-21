// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { SessionPromptDispatchService, layer as DispatchLayer, validateRequest } from "@/kilocode/session/session-prompt-dispatch"

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"

function base() {
  return {
    v: 1,
    requestId: "req-1",
    opId: `prompt:${MID}`,
    op: "session/prompt",
    idempotencyKey: `prompt:${MID}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: MID, parts: [{ type: "text", text: "hi" }] },
  }
}

describe("session-prompt-dispatch validate", () => {
  test("accepts canonical prompt tuple", () => {
    expect(() => validateRequest(base())).not.toThrow()
  })
  test("rejects non-canonical opId", () => {
    expect(() => validateRequest({ ...base(), opId: "prompt:other" })).toThrow()
  })
  test("rejects idempotency mismatch", () => {
    expect(() => validateRequest({ ...base(), idempotencyKey: "prompt:other" })).toThrow()
  })
  test("rejects non-null parent", () => {
    const r = base() as Record<string, unknown>
    const ctx = { ...(r.context as Record<string, unknown>), parentSessionId: SID }
    expect(() => validateRequest({ ...r, context: ctx })).toThrow()
  })
  test("rejects bad messageId", () => {
    const r = base() as Record<string, unknown>
    const payload = { ...((r.payload as Record<string, unknown>) ?? {}), messageId: "bad" }
    expect(() => validateRequest({ ...r, payload })).toThrow()
  })
})

describe("session-prompt-dispatch accept-only scope ownership", () => {
  test("dispatch returns accepted before prompt completes and scope close interrupts background", async () => {
    const prog = Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const finished = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()

      const fakeDb = {
        select: (..._a: unknown[]) => ({
          from: (table: unknown) => ({
            where: (..._c: unknown[]) => ({
              get: () => {
                // fastRow for SessionOperation should be empty for this test
                if ((table as any)?.name === "session_operation" || String(table).includes("SessionOperation")) return Effect.succeed(undefined)
                return Effect.succeed(undefined)
              },
              all: () => Effect.succeed([]),
            }),
          }),
        }),
        transaction: (cb: (tx: unknown) => Effect.Effect<unknown>, _opts?: unknown) => {
          let inserted: any = null
          const tx: any = {
            select: (..._a: unknown[]) => ({
              from: (table: unknown) => ({
                where: (..._c: unknown[]) => ({
                  get: () => {
                    const n = String((table as any)?.name ?? "")
                    if (n.includes("session_operation") || (table as any) === SessionOperationTable) return Effect.succeed(inserted ?? undefined)
                    if (n.includes("session") || String(table).includes("SessionTable")) return Effect.succeed({ id: SID, revision: 0, time_created: Date.now(), time_updated: Date.now() } as any)
                    return Effect.succeed({ id: SID, revision: 0 } as any)
                  },
                  all: () => Effect.succeed([]),
                }),
              }),
            }),
            insert: (table: unknown) => ({
              values: (vals: any) => ({
                run: () => {
                  const isOp = table === SessionOperationTable || String((table as any)?.name ?? "").includes("session_operation")
                  if (isOp) inserted = { op_id: vals.op_id, session_id: vals.session_id, op_kind: vals.op_kind, outcome: vals.outcome, code: vals.code, message: vals.message, time: vals.time, cancel: vals.cancel, detail: vals.detail, stack: vals.stack, revision: vals.revision }
                  return Effect.succeed(undefined)
                },
                returning: () => ({ get: () => Effect.succeed({} as any), all: () => Effect.succeed([]) }),
                onConflictDoNothing: () => ({ returning: () => ({ get: () => Effect.succeed({} as any), all: () => Effect.succeed([]) }) }),
              }),
            }),
            update: () => ({ set: () => ({ where: () => ({ run: () => Effect.succeed(undefined), returning: () => ({ all: () => Effect.succeed([{ id: SID, revision: 1 } as any]) }) }) }) }),
          }
          return cb(tx as any)
        },
      }
      const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
      const dbLayer = Layer.succeed(Database.Service, { db: fakeDb } as any)
      const sessionLayer = Layer.succeed(Session.Service, {
        get: () => Effect.succeed({ directory: DIR, id: SID }),
      } as any)
      const promptLayer = Layer.succeed(SessionPrompt.Service, {
        prompt: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, void 0)
            yield* Deferred.await(gate)
            yield* Deferred.succeed(finished, void 0)
            return { id: "dummy" } as any
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.uninterruptible(Deferred.succeed(interrupted, void 0).pipe(Effect.asVoid))
                : Effect.void,
            ),
        ),
        cancel: () => Effect.void,
        loop: () => Effect.die(new Error("unused")),
        shell: () => Effect.die(new Error("unused")),
        resolvePromptParts: () => Effect.succeed([] as never),
      } as any)
      const eventsLayer = Layer.succeed(EventV2Bridge.Service, {
        publish: () => Effect.void,
      } as any)
      const storeLayer = Layer.succeed(InstanceStore.Service, {
        load: () => Effect.succeed(fakeCtx),
        reload: () => Effect.succeed(fakeCtx),
        dispose: () => Effect.void,
        disposeSafe: () => Effect.void,
        disposeDirectory: () => Effect.void,
        disposeAll: () => Effect.void,
        provide: (_input: unknown, effect: Effect.Effect<unknown>) => effect as Effect.Effect<unknown>,
        snapshot: () => Effect.succeed(Option.none()),
        directories: () => Effect.succeed([]),
      } as any)
      const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
      const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop)
      const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
      const full = Layer.provide(DispatchLayer, deps)
      const all = Layer.mergeAll(full, deps)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionPromptDispatchService
          const result = (yield* svc.dispatch(base())) as any
          expect(result.status).toBe("succeeded")
          expect(result.accepted).toBe(true)
          yield* Deferred.await(started).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.fail(new Error("prompt never started") as unknown as never),
            }),
          )
          const fin = yield* Deferred.poll(finished)
          expect(Option.isNone(fin)).toBe(true)
        }).pipe(Effect.provide(all)),
      )

      yield* Deferred.await(interrupted).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.fail(new Error("background not interrupted on scope close") as unknown as never),
        }),
      )
      const finAfter = yield* Deferred.poll(finished)
      expect(Option.isNone(finAfter)).toBe(true)
    })
    await Effect.runPromise(prog.pipe(Effect.scoped))
  })

  test("existing user replay returns accepted without starting a second generation", async () => {
    const prog = Effect.gen(function* () {
      let calls = 0
      const row = {
        id: MID,
        session_id: SID,
        session: SID,
        data: { role: "user" },
      }
      const fakeDb = {
        select: (..._a: unknown[]) => ({
          from: (table: unknown) => ({
            where: (..._c: unknown[]) => ({
              get: () => {
                const name = String((table as any)?.name ?? (table as any)?.[Symbol.toStringTag] ?? "")
                if (name.includes("session_operation") || table === SessionOperationTable) return Effect.succeed(undefined)
                return Effect.succeed(row as any)
              },
              all: () => Effect.succeed([]),
              orderBy: (..._o: unknown[]) => ({
                get: () => {
                  const name = String((table as any)?.name ?? (table as any)?.[Symbol.toStringTag] ?? "")
                  if (name.includes("session_operation") || table === SessionOperationTable) return Effect.succeed(undefined)
                  return Effect.succeed(row as any)
                },
                all: () => Effect.succeed([]),
              }),
            }),
          }),
        }),
        transaction: (cb: (tx: unknown) => Effect.Effect<unknown>, _opts?: unknown) => {
          const tx: any = {
            select: (..._a: unknown[]) => ({
              from: (table: unknown) => ({
                where: (..._c: unknown[]) => ({
                  get: () => {
                    const n = String((table as any)?.name ?? "")
                    if (n.includes("session_operation") || table === SessionOperationTable) return Effect.succeed(undefined)
                    if (n.includes("session") || String(table).includes("SessionTable")) return Effect.succeed({ id: SID, revision: 0 } as any)
                    return Effect.succeed(row as any)
                  },
                  all: () => Effect.succeed([]),
                  orderBy: (..._o: unknown[]) => ({
                    get: () => {
                      const n = String((table as any)?.name ?? "")
                      if (n.includes("session_operation") || table === SessionOperationTable) return Effect.succeed(undefined)
                      if (n.includes("session") || String(table).includes("SessionTable")) return Effect.succeed({ id: SID, revision: 0 } as any)
                      return Effect.succeed(row as any)
                    },
                    all: () => Effect.succeed([]),
                  }),
                }),
              }),
            }),
            insert: () => ({ values: (vals: any) => ({ run: () => Effect.succeed(undefined), returning: () => ({ get: () => Effect.succeed({} as any), all: () => Effect.succeed([]) }), onConflictDoNothing: () => ({ returning: () => ({ get: () => Effect.succeed({} as any), all: () => Effect.succeed([]) }) }) }) }),
            update: () => ({ set: () => ({ where: () => ({ run: () => Effect.succeed(undefined), returning: () => ({ all: () => Effect.succeed([{ id: SID, revision: 1 } as any]) }) }) }) }),
          }
          return cb(tx as any)
        },
      }
      const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
      const dbLayer = Layer.succeed(Database.Service, { db: fakeDb } as any)
      const sessionLayer = Layer.succeed(Session.Service, {
        get: () => Effect.succeed({ directory: DIR, id: SID }),
      } as any)
      const promptLayer = Layer.succeed(SessionPrompt.Service, {
        prompt: () =>
          Effect.gen(function* () {
            calls += 1
            return { id: "dummy" } as any
          }),
        cancel: () => Effect.void,
        loop: () => Effect.die(new Error("unused")),
        shell: () => Effect.die(new Error("unused")),
        resolvePromptParts: () => Effect.succeed([] as never),
      } as any)
      const eventsLayer = Layer.succeed(EventV2Bridge.Service, {
        publish: () => Effect.void,
      } as any)
      const storeLayer = Layer.succeed(InstanceStore.Service, {
        load: () => Effect.succeed(fakeCtx),
        reload: () => Effect.succeed(fakeCtx),
        dispose: () => Effect.void,
        disposeSafe: () => Effect.void,
        disposeDirectory: () => Effect.void,
        disposeAll: () => Effect.void,
        provide: (_input: unknown, effect: Effect.Effect<unknown>) => effect as Effect.Effect<unknown>,
        snapshot: () => Effect.succeed(Option.none()),
        directories: () => Effect.succeed([]),
      } as any)
      const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
      const leaseLayer = Layer.succeed(ControlLease.Service, ControlLease.noop)
      const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, storeLayer, gateLayer, leaseLayer)
      const full = Layer.provide(DispatchLayer, deps)
      const all = Layer.mergeAll(full, deps)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionPromptDispatchService
          const first = (yield* svc.dispatch(base())) as any
          expect(first.status).toBe("succeeded")
          expect(first.accepted).toBe(true)
          const second = (yield* svc.dispatch(base())) as any
          expect(second.status).toBe("succeeded")
          expect(second.accepted).toBe(true)
          expect(calls).toBe(0)
        }).pipe(Effect.provide(all)),
      )
    })
    await Effect.runPromise(prog.pipe(Effect.scoped))
  })
})
