// kilocode_change - new file
/**
 * Deterministic unit tests for the writer-preferring generation gate
 * (LOCK-002/003/006). No sleeps: every race is sequenced through Deferreds and
 * admission side-effects observed synchronously. Uses `it.live` so the bounded
 * timeout combinators are real failure bounds.
 */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { testEffect } from "../../lib/effect"
import { awaitWithTimeout } from "../../lib/effect"

const it = testEffect(GenerationGate.defaultLayer)

const isDone = <A>(deferred: Deferred.Deferred<A>) => Effect.map(Deferred.poll(deferred), (opt) => opt._tag === "Some")

describe("GenerationGate admission", () => {
  it.live("a reader admitted before a writer drains, then queued readers are admitted after release", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const releaseA = yield* gate.acquire("d")
      const releaseB = yield* gate.acquire("d")

      const ticket = yield* gate.beginWrite("d")

      // New readers wait while the writer barrier is held.
      const queued = yield* Deferred.make<boolean>()
      const waiting = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const release = yield* gate.acquire("d")
          yield* Deferred.succeed(queued, true)
          yield* release
        }),
      )
      expect(yield* isDone(queued)).toBe(false)

      // The writer drain resolves only when both pre-barrier readers release.
      expect(yield* isDone(ticket.drained)).toBe(false)
      yield* releaseA
      expect(yield* isDone(ticket.drained)).toBe(false)
      yield* releaseB
      yield* awaitWithTimeout(Deferred.await(ticket.drained), "writer drain did not fire")
      yield* ticket.release

      // The queued reader is admitted after the writer releases.
      yield* awaitWithTimeout(Deferred.await(queued), "queued reader was never admitted")
      yield* Fiber.join(waiting)
    }),
  )

  it.live("readers queued during a barrier never overlap the writer's drain/dispose window", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const ticket = yield* gate.beginWrite("d")
      const entered = yield* Deferred.make<boolean>()
      const reader = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const release = yield* gate.acquire("d")
          yield* Deferred.succeed(entered, true)
          yield* release
        }),
      )
      expect(yield* isDone(entered)).toBe(false)
      yield* ticket.release
      yield* awaitWithTimeout(Deferred.await(entered), "reader was never admitted after release")
      yield* Fiber.join(reader)
    }),
  )

  it.live("concurrent cold PATCHes serialize: the second writer is granted only after the first releases", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const first = yield* gate.beginWrite("d")
      const secondStarted = yield* Deferred.make<boolean>()
      const second = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const ticket = yield* gate.beginWrite("d")
          yield* Deferred.succeed(secondStarted, true)
          yield* ticket.release
        }),
      )
      expect(yield* isDone(secondStarted)).toBe(false)
      yield* first.release
      yield* awaitWithTimeout(Deferred.await(secondStarted), "second writer never granted after first release")
      yield* Fiber.join(second)
    }),
  )

  it.live("a global writer excludes readers and per-directory writers across directories", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const ticket = yield* gate.beginWriteGlobal()

      const admitted = yield* Deferred.make<boolean>()
      const reader = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const release = yield* gate.acquire("other")
          yield* Deferred.succeed(admitted, true)
          yield* release
        }),
      )
      const writerAdmitted = yield* Deferred.make<boolean>()
      const writer = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const next = yield* gate.beginWrite("other")
          yield* Deferred.succeed(writerAdmitted, true)
          yield* next.release
        }),
      )
      expect(yield* isDone(admitted)).toBe(false)
      expect(yield* isDone(writerAdmitted)).toBe(false)

      yield* ticket.release
      yield* awaitWithTimeout(Deferred.await(admitted), "reader never admitted after global release")
      yield* awaitWithTimeout(Deferred.await(writerAdmitted), "per-directory writer never granted after global release")
      yield* Fiber.join(reader)
      yield* Fiber.join(writer)
    }),
  )

  it.live("a global writer waits for an active per-directory writer to finish", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const local = yield* gate.beginWrite("d")
      const globalStarted = yield* Deferred.make<boolean>()
      const globalFiber = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const ticket = yield* gate.beginWriteGlobal()
          yield* Deferred.succeed(globalStarted, true)
          yield* ticket.release
        }),
      )
      expect(yield* isDone(globalStarted)).toBe(false)
      yield* local.release
      yield* awaitWithTimeout(Deferred.await(globalStarted), "global writer never granted after local writer released")
      yield* Fiber.join(globalFiber)
    }),
  )

  it.live("drainFor resolves per-directory drains for the active global writer", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const release = yield* gate.acquire("d")
      const ticket = yield* gate.beginWriteGlobal()
      const drain = ticket.drainFor("d")
      expect(yield* isDone(drain)).toBe(false)
      yield* release
      yield* awaitWithTimeout(Deferred.await(drain), "global per-directory drain never fired")
      yield* ticket.release
    }),
  )

  it.live("abort releases the barrier without granting the queued work until released", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const ticket = yield* gate.beginWrite("d")
      const entered = yield* Deferred.make<boolean>()
      const reader = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const release = yield* gate.acquire("d")
          yield* Deferred.succeed(entered, true)
          yield* release
        }),
      )
      expect(yield* isDone(entered)).toBe(false)
      yield* ticket.abort
      yield* awaitWithTimeout(Deferred.await(entered), "reader never admitted after abort")
      yield* Fiber.join(reader)
    }),
  )

  it.live("cancelling the reserved local waiter promotes the next FIFO writer", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const first = yield* gate.beginWrite("d")
      const bStarted = yield* Deferred.make<void>()
      const b = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* gate.beginWrite("d")
          yield* Deferred.succeed(bStarted, void 0)
        }),
      )
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const cStarted = yield* Deferred.make<void>()
      const c = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const ticket = yield* gate.beginWrite("d")
          yield* Deferred.succeed(cStarted, void 0)
          yield* ticket.release
        }),
      )
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* first.release
      yield* Fiber.interrupt(b)
      yield* awaitWithTimeout(Deferred.await(cStarted), "next local writer was not promoted")
      expect(yield* isDone(cStarted)).toBe(true)
      yield* Fiber.join(c)
    }),
  )

  it.live("cancelling the reserved global waiter promotes the next global writer", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const first = yield* gate.beginWriteGlobal()
      const bStarted = yield* Deferred.make<void>()
      const b = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* gate.beginWriteGlobal()
          yield* Deferred.succeed(bStarted, void 0)
        }),
      )
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const cStarted = yield* Deferred.make<void>()
      const c = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const ticket = yield* gate.beginWriteGlobal()
          yield* Deferred.succeed(cStarted, void 0)
          yield* ticket.release
        }),
      )
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* first.release
      yield* Fiber.interrupt(b)
      yield* awaitWithTimeout(Deferred.await(cStarted), "next global writer was not promoted")
      expect(yield* isDone(cStarted)).toBe(true)
      yield* Fiber.join(c)
    }),
  )

  it.live("claims three local writers in FIFO order", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const first = yield* gate.beginWrite("d")
      const order: string[] = []
      const bQueued = yield* Deferred.make<void>()
      const cQueued = yield* Deferred.make<void>()
      const b = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.succeed(bQueued, void 0)
          const ticket = yield* gate.beginWrite("d")
          order.push("B")
          yield* ticket.release
        }),
      )
      const c = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.succeed(cQueued, void 0)
          const ticket = yield* gate.beginWrite("d")
          order.push("C")
          yield* ticket.release
        }),
      )
      yield* Deferred.await(bQueued)
      yield* Deferred.await(cQueued)
      order.push("A")
      yield* first.release
      yield* Fiber.join(b)
      yield* Fiber.join(c)
      expect(order).toEqual(["A", "B", "C"])
    }),
  )

  it.live("preserves local-before-global FIFO and blocks later readers", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const first = yield* gate.beginWrite("d")
      const order: string[] = []
      const localQueued = yield* Deferred.make<void>()
      const globalQueued = yield* Deferred.make<void>()
      const local = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.succeed(localQueued, void 0)
          const ticket = yield* gate.beginWrite("d")
          order.push("local")
          yield* ticket.release
        }),
      )
      const global = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.succeed(globalQueued, void 0)
          const ticket = yield* gate.beginWriteGlobal()
          order.push("global")
          yield* ticket.release
        }),
      )
      yield* Deferred.await(localQueued)
      yield* Deferred.await(globalQueued)
      const entered = yield* Deferred.make<void>()
      const reader = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const release = yield* gate.acquire("other")
          yield* Deferred.succeed(entered, void 0)
          yield* release
        }),
      )
      yield* first.release
      yield* Fiber.join(local)
      expect((yield* Deferred.poll(entered))._tag).toBe("None")
      yield* Fiber.join(global)
      yield* awaitWithTimeout(Deferred.await(entered), "reader did not proceed after global release")
      yield* Fiber.join(reader)
      expect(order).toEqual(["local", "global"])
    }),
  )

  it.live("prepareWrite waits behind an active global writer and is granted after release", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const global = yield* gate.beginWriteGlobal()
      const entered = yield* Deferred.make<boolean>()
      const prep = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const release = yield* gate.prepareWrite("d")
          yield* Deferred.succeed(entered, true)
          yield* release
        }),
      )
      expect(yield* isDone(entered)).toBe(false)
      yield* global.release
      yield* awaitWithTimeout(Deferred.await(entered), "prepareWrite never granted after global release")
      yield* Fiber.join(prep)
    }),
  )

  it.live("prepareWrite blocks later global writers while held", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const release = yield* gate.prepareWrite("d")
      const globalStarted = yield* Deferred.make<boolean>()
      const global = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const ticket = yield* gate.beginWriteGlobal()
          yield* Deferred.succeed(globalStarted, true)
          yield* ticket.release
        }),
      )
      expect(yield* isDone(globalStarted)).toBe(false)
      yield* release
      yield* awaitWithTimeout(Deferred.await(globalStarted), "global writer never granted after prep release")
      yield* Fiber.join(global)
    }),
  )

  it.live("prepareWrite keeps its FIFO place behind a queued global writer", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const first = yield* gate.beginWrite("d")
      const order: string[] = []
      const globalQueued = yield* Deferred.make<void>()
      const global = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.succeed(globalQueued, void 0)
          const ticket = yield* gate.beginWriteGlobal()
          order.push("global")
          yield* ticket.release
        }),
      )
      yield* Deferred.await(globalQueued)
      const prepQueued = yield* Deferred.make<void>()
      const prep = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.succeed(prepQueued, void 0)
          const release = yield* gate.prepareWrite("other")
          order.push("prep")
          yield* release
        }),
      )
      yield* Deferred.await(prepQueued)
      order.push("local")
      yield* first.release
      yield* Fiber.join(global)
      yield* Fiber.join(prep)
      expect(order).toEqual(["local", "global", "prep"])
    }),
  )

  it.live("prepareWrite release followed by same-directory beginWrite does not self-deadlock", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const release = yield* gate.prepareWrite("d")
      yield* release
      const ticket = yield* gate.beginWrite("d")
      expect(yield* isDone(ticket.drained)).toBe(true)
      yield* ticket.release
    }),
  )

  it.live("prepareWrite excludes same-directory readers and writers until release", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const release = yield* gate.prepareWrite("d")
      const enteredReader = yield* Deferred.make<boolean>()
      const reader = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const r = yield* gate.acquire("d")
          yield* Deferred.succeed(enteredReader, true)
          yield* r
        }),
      )
      const enteredWriter = yield* Deferred.make<boolean>()
      const writer = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const ticket = yield* gate.beginWrite("d")
          yield* Deferred.succeed(enteredWriter, true)
          yield* ticket.release
        }),
      )
      expect(yield* isDone(enteredReader)).toBe(false)
      expect(yield* isDone(enteredWriter)).toBe(false)
      yield* release
      yield* awaitWithTimeout(Deferred.await(enteredReader), "reader never admitted after prep release")
      yield* awaitWithTimeout(Deferred.await(enteredWriter), "writer never admitted after prep release")
      yield* Fiber.join(reader)
      yield* Fiber.join(writer)
    }),
  )

  it.live("cancelling a queued prepareWrite promotes the next FIFO writer", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const first = yield* gate.beginWrite("d")
      const prepQueued = yield* Deferred.make<void>()
      const prep = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.succeed(prepQueued, void 0)
          yield* gate.prepareWrite("d")
        }),
      )
      yield* Deferred.await(prepQueued)
      const globalStarted = yield* Deferred.make<void>()
      const global = yield* Effect.forkDetach(
        Effect.gen(function* () {
          const ticket = yield* gate.beginWriteGlobal()
          yield* Deferred.succeed(globalStarted, void 0)
          yield* ticket.release
        }),
      )
      yield* Effect.yieldNow
      yield* first.release
      yield* Fiber.interrupt(prep)
      yield* awaitWithTimeout(Deferred.await(globalStarted), "next FIFO writer was not promoted after prep cancel")
      yield* Fiber.join(global)
    }),
  )
})
