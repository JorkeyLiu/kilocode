import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { BackgroundJob } from "@/background/job"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import { MessageID, SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"
import * as Ownership from "@/retention/ownership"

const statusStub = Layer.succeed(
  SessionStatus.Service,
  SessionStatus.Service.of({
    get: () => Effect.succeed({ type: "idle" as const }),
    list: () => Effect.succeed(new Map()),
    set: () => Effect.void,
  }),
)
const runLayer = SessionRunState.layer.pipe(
  Layer.provide(statusStub),
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Ownership.layer),
)

const it = testEffect(runLayer)

const pollOrDie = (self: Effect.Effect<any | undefined>, message: string) =>
  pollWithTimeout(self, message).pipe(Effect.orDie)

const fallback = { info: { id: "fallback" }, parts: [] } as any
const doneValue = (id: string) => ({ info: { id }, parts: [] }) as any

function ids(sessionID: SessionID, n: string) {
  return MessageID.make(`msg_${sessionID}_${n}` as any as string)
}

describe("session epoch membership signal", () => {
  it.instance("prompt route: base plus two adopted extras share one generation", () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const sessionID = SessionID.make(`ses_membership_base_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const base = ids(sessionID, "base")
      const extra1 = ids(sessionID, "extra1")
      const extra2 = ids(sessionID, "extra2")
      const gate = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()

      const bodyResult = yield* Deferred.make<any>()
      const baseFiber = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        base,
        run.ensureRunning(sessionID, Effect.succeed(fallback), {
          prelude: (generationID: string) =>
            Effect.gen(function* () {
              const active = KiloSessionPromptQueue.active(sessionID)
              expect(active).toBe(base)
              expect(typeof generationID).toBe("string")
            }),
          body: (generationID: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* pollOrDie(
                Effect.sync(() =>
                  KiloSessionPromptQueue._isQueued(sessionID, extra1) &&
                  KiloSessionPromptQueue._isQueued(sessionID, extra2)
                    ? (true as const)
                    : undefined,
                ),
                "follow-ups never queued",
              )
              const before = yield* run.epochMembership(sessionID)
              expect(before?.generationID).toBe(generationID)
              expect([...(before?.messageIDs ?? [])]).toEqual([base])
              KiloSessionPromptQueue.adopt(sessionID)
              const after = yield* run.epochMembership(sessionID)
              expect(after?.generationID).toBe(generationID)
              expect([...(after?.messageIDs ?? [])]).toEqual([base, extra1, extra2])
              expect(after?.sessionID).toBe(sessionID)
              yield* Deferred.succeed(bodyResult, after)
              yield* Deferred.await(gate)
              return doneValue("base-done")
            }),
        }),
        Effect.succeed(doneValue("base-cancelled")),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"), Effect.orDie)
      const second = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        extra1,
        Effect.succeed(doneValue("extra1-work")),
        Effect.succeed(doneValue("extra1-settled")),
      ).pipe(Effect.forkChild)
      const third = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        extra2,
        Effect.succeed(doneValue("extra2-work")),
        Effect.succeed(doneValue("extra2-settled")),
      ).pipe(Effect.forkChild)

      const observed: any = yield* Deferred.await(bodyResult).pipe(Effect.timeout("5 seconds"), Effect.orDie)
      expect([...observed.messageIDs]).toEqual([base, extra1, extra2])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(baseFiber)
      const e2 = yield* Fiber.await(second)
      const e3 = yield* Fiber.await(third)
      expect(Exit.isSuccess(e2) && e2.value.info.id).toBe("extra1-settled")
      expect(Exit.isSuccess(e3) && e3.value.info.id).toBe("extra2-settled")
      expect(yield* run.epochMembership(sessionID)).toBeUndefined()
      expect(yield* run.activeGeneration(sessionID)).toBeUndefined()
      expect(KiloSessionPromptQueue._hasInternalState(sessionID)).toBe(false)
    }),
  )

  it.instance("cancelled pending and pre-accept are never members", () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const sessionID = SessionID.make(`ses_membership_cancel_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const base = ids(sessionID, "base")
      const dropped = ids(sessionID, "dropped")
      const kept = ids(sessionID, "kept")
      const gate = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const seen = yield* Deferred.make<any>()

      const baseFiber = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        base,
        run.ensureRunning(sessionID, Effect.succeed(fallback), {
          prelude: () => Effect.void,
          body: (generationID: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* pollOrDie(
                Effect.sync(() =>
                  KiloSessionPromptQueue._isQueued(sessionID, dropped) &&
                  KiloSessionPromptQueue._isQueued(sessionID, kept)
                    ? (true as const)
                    : undefined,
                ),
                "follow-ups never queued",
              )
              expect(KiloSessionPromptQueue.isOwned(sessionID, kept)).toBe(true)
              const pre = yield* run.epochMembership(sessionID)
              expect([...(pre?.messageIDs ?? [])]).toEqual([base])
              expect(yield* KiloSessionPromptQueue.cancelOne(sessionID, dropped)).toBe(true)
              KiloSessionPromptQueue.adopt(sessionID)
              const after = yield* run.epochMembership(sessionID)
              expect(after?.generationID).toBe(generationID)
              expect([...(after?.messageIDs ?? [])]).toEqual([base, kept])
              yield* Deferred.succeed(seen, after)
              yield* Deferred.await(gate)
              return doneValue("base-done")
            }),
        }),
        Effect.succeed(doneValue("base-cancelled")),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"), Effect.orDie)
      const s2 = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        dropped,
        Effect.succeed(doneValue("dropped-work")),
        Effect.succeed(doneValue("dropped-settled")),
      ).pipe(Effect.forkChild)
      const s3 = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        kept,
        Effect.succeed(doneValue("kept-work")),
        Effect.succeed(doneValue("kept-settled")),
      ).pipe(Effect.forkChild)

      const observed: any = yield* Deferred.await(seen).pipe(Effect.timeout("5 seconds"), Effect.orDie)
      expect([...observed.messageIDs]).toEqual([base, kept])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(baseFiber)
      const e2 = yield* Fiber.await(s2)
      const e3 = yield* Fiber.await(s3)
      if (Exit.isSuccess(e2)) expect(e2.value.info.id).toBe("dropped-settled")
      if (Exit.isSuccess(e3)) expect(e3.value.info.id).toBe("kept-settled")
      expect(yield* run.epochMembership(sessionID)).toBeUndefined()
      expect(KiloSessionPromptQueue._hasInternalState(sessionID)).toBe(false)
    }),
  )

  it.instance("retarget extras share the same epoch and snapshot is read-only", () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const sessionID = SessionID.make(`ses_membership_retarget_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const base = ids(sessionID, "base")
      const injected = ids(sessionID, "injected")
      const gate = yield* Deferred.make<void>()

      const fiber = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        base,
        run.ensureRunning(sessionID, Effect.succeed(fallback), {
          prelude: () => Effect.void,
          body: (generationID: string) =>
            Effect.gen(function* () {
              KiloSessionPromptQueue.retarget(sessionID, injected)
              const first = yield* run.epochMembership(sessionID)
              expect(first?.generationID).toBe(generationID)
              expect([...(first?.messageIDs ?? [])]).toEqual([base, injected])
              ;(first?.messageIDs as MessageID[]).push(ids(sessionID, "evil") as any)
              const second = yield* run.epochMembership(sessionID)
              expect([...(second?.messageIDs ?? [])]).toEqual([base, injected])
              const snap = KiloSessionPromptQueue.snapshot(sessionID)
              expect(snap?.base).toBe(base)
              expect([...(snap?.extras ?? [])]).toEqual([injected])
              yield* Deferred.await(gate)
              return doneValue("ok")
            }),
        }),
        Effect.succeed(doneValue("cancelled")),
      ).pipe(Effect.forkChild)

      yield* pollOrDie(
        Effect.gen(function* () {
          const gen = yield* run.activeGeneration(sessionID)
          return gen ? (true as const) : undefined
        }),
        "epoch never started",
      )
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(fiber)
      expect(yield* run.epochMembership(sessionID)).toBeUndefined()
      expect(KiloSessionPromptQueue._hasInternalState(sessionID)).toBe(false)
    }),
  )

  it.instance("command route uses the same queue plus runner membership path", () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const sessionID = SessionID.make(`ses_membership_cmd_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const base = ids(sessionID, "cmd-base")
      const extra = ids(sessionID, "cmd-extra")
      const gate = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const seen = yield* Deferred.make<any>()

      const fiber = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        base,
        run.ensureRunning(sessionID, Effect.succeed(fallback), {
          prelude: (generationID: string) =>
            Effect.sync(() => {
              expect(KiloSessionPromptQueue.active(sessionID)).toBe(base)
              expect(typeof generationID).toBe("string")
            }),
          body: (generationID: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* pollOrDie(
                Effect.sync(() =>
                  KiloSessionPromptQueue._isQueued(sessionID, extra) ? (true as const) : undefined,
                ),
                "command follow-up never queued",
              )
              KiloSessionPromptQueue.adopt(sessionID)
              const membership = yield* run.epochMembership(sessionID)
              expect(membership?.generationID).toBe(generationID)
              expect([...(membership?.messageIDs ?? [])]).toEqual([base, extra])
              yield* Deferred.succeed(seen, membership)
              yield* Deferred.await(gate)
              return doneValue("cmd-done")
            }),
        }),
        Effect.succeed(doneValue("cmd-cancelled")),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"), Effect.orDie)
      const follow = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        extra,
        Effect.succeed(doneValue("extra-work")),
        Effect.succeed(doneValue("extra-settled")),
      ).pipe(Effect.forkChild)

      const observed: any = yield* Deferred.await(seen).pipe(Effect.timeout("5 seconds"), Effect.orDie)
      expect([...observed.messageIDs]).toEqual([base, extra])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(fiber)
      const e = yield* Fiber.await(follow)
      if (Exit.isSuccess(e)) expect(e.value.info.id).toBe("extra-settled")
      expect(yield* run.epochMembership(sessionID)).toBeUndefined()
      expect(KiloSessionPromptQueue._hasInternalState(sessionID)).toBe(false)
    }),
  )

  it.instance("abort retains members until convergence then cleans up in owner scope", () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const sessionID = SessionID.make(`ses_membership_abort_${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const base = ids(sessionID, "base")
      const gate = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()

      const fiber = yield* KiloSessionPromptQueue.enqueue(
        sessionID,
        base,
        run.ensureRunning(sessionID, Effect.succeed(fallback), {
          prelude: () => Effect.void,
          body: (generationID: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(gate)
              return doneValue(`gen-${generationID}`)
            }),
        }),
        Effect.succeed(doneValue("cancelled")),
      ).pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      yield* pollOrDie(
        Effect.gen(function* () {
          const m = yield* run.epochMembership(sessionID)
          return m ? (true as const) : undefined
        }),
        "membership never visible",
      )
      yield* KiloSessionPromptQueue.cancel(sessionID)
      const retained = yield* run.epochMembership(sessionID)
      expect([...(retained?.messageIDs ?? [])]).toEqual([base])
      expect(retained?.sessionID).toBe(sessionID)
      expect(typeof retained?.generationID).toBe("string")

      const snap = yield* run.cancel(sessionID)
      expect(snap.wasBusy).toBe(true)
      expect(snap.generationID).toBe(retained?.generationID)
      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toEqual(fallback)
      yield* pollOrDie(
        Effect.gen(function* () {
          const m = yield* run.epochMembership(sessionID)
          return m === undefined ? (true as const) : undefined
        }),
        "membership never cleaned after abort",
      )
      expect(yield* run.activeGeneration(sessionID)).toBeUndefined()
      expect(KiloSessionPromptQueue._hasInternalState(sessionID)).toBe(false)
    }),
  )
})
