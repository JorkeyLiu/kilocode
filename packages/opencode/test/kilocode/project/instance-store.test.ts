import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { GlobalBus } from "../../../src/bus/global"
import { registerDisposer } from "../../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { InstanceStore } from "../../../src/project/instance-store"
import { ControlLease } from "../../../src/kilocode/server/control-lease" // kilocode_change - LOCK-007
import { tmpdirScoped } from "../../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../../lib/effect"

const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(InstanceStore.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(Layer.provide(bootstrap)),
)
// kilocode_change start - LOCK-007: lease-aware disposal tests need the
// canonical lease coordinator so disposeSafe/reload seal and drain real leases.
const leaseIt = testEffect(
  Layer.mergeAll(InstanceStore.defaultLayer, ControlLease.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(
    Layer.provide(bootstrap),
  ),
)

const register = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(disposer)),
    (off) => Effect.sync(off),
  )

// kilocode_change start - LOCK-007: helpers for lease-delay assertions
const isDone = <A>(deferred: Deferred.Deferred<A>) => Effect.map(Deferred.poll(deferred), (opt) => opt._tag === "Some")

const unwrap = <A>(opt: Option.Option<A>): A => {
  if (opt._tag === "None") throw new Error("expected Some")
  return opt.value
}
// kilocode_change end

describe("InstanceStore disposal", () => {
  it.live("disposes four directories concurrently", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.all(
        Array.from({ length: 4 }, () => tmpdirScoped({ git: true })),
        { concurrency: "unbounded" },
      )
      const store = yield* InstanceStore.Service
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const started = new Set<string>()

      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.ignore))
      yield* register(async (directory) => {
        if (!dirs.includes(directory)) return
        started.add(directory)
        if (started.size === dirs.length) Deferred.doneUnsafe(ready, Effect.void)
        await Effect.runPromise(Deferred.await(release))
      })

      yield* Effect.forEach(dirs, (directory) => store.load({ directory }), { discard: true })
      const fiber = yield* store.disposeAll().pipe(Effect.forkScoped)

      yield* awaitWithTimeout(Deferred.await(ready), "instance disposal remained serial")
      expect(started).toEqual(new Set(dirs))

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
    }),
  )

  it.live("finishes sibling disposal when an event listener throws", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.all(
        Array.from({ length: 4 }, () => tmpdirScoped({ git: true })),
        { concurrency: "unbounded" },
      )
      const store = yield* InstanceStore.Service
      const before = yield* Effect.forEach(dirs, (directory) => store.load({ directory }))
      const disposed = new Set<string>()
      const listener = (event: { directory?: string; payload?: { type?: string } }) => {
        if (event.payload?.type === "server.instance.disposed" && event.directory === dirs[0]) {
          throw new Error("listener failed")
        }
      }

      yield* register(async (directory) => {
        if (dirs.includes(directory)) disposed.add(directory)
      })
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const exit = yield* Effect.exit(store.disposeAll())
      GlobalBus.off("event", listener)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(disposed).toEqual(new Set(dirs))

      const after = yield* Effect.forEach(dirs, (directory) => store.load({ directory }))
      for (const [index, ctx] of after.entries()) {
        expect(ctx).not.toBe(before[index])
      }
    }),
  )

  it.live("finishes queued disposal when the caller is interrupted", () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.all(
        Array.from({ length: 5 }, () => tmpdirScoped({ git: true })),
        { concurrency: "unbounded" },
      )
      const store = yield* InstanceStore.Service
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const started = new Set<string>()

      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.ignore))
      yield* register(async (directory) => {
        if (!dirs.includes(directory)) return
        started.add(directory)
        if (started.size === 4) Deferred.doneUnsafe(ready, Effect.void)
        await Effect.runPromise(Deferred.await(release))
      })
      yield* Effect.forEach(dirs, (directory) => store.load({ directory }), { discard: true })

      const disposal = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* awaitWithTimeout(Deferred.await(ready), "bounded disposal did not start")
      const scope = yield* Scope.Scope
      const interrupted = yield* Fiber.interrupt(disposal).pipe(Effect.forkIn(scope, { startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupted)

      expect(started).toEqual(new Set(dirs))
    }),
  )
})

// kilocode_change start - LOCK-007: every disposal entry point in scope seals
// and drains the exact identity's control + write leases before the disposers
// run, so an active snapshot control or write-intent handler can never race the
// disposal. These tests hold a real lease on the loaded identity and assert the
// disposers stay blocked until it releases.
describe("InstanceStore lease-aware disposal (LOCK-007)", () => {
  leaseIt.live("reload seals and drains an active control lease before disposing the previous identity", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const leases = yield* ControlLease.Service
      const first = yield* store.load({ directory: dir })
      const started = yield* Deferred.make<void>()
      const disposed: string[] = []
      yield* register(async (directory) => {
        if (directory !== dir) return
        Deferred.doneUnsafe(started, Effect.void)
        disposed.push(directory)
      })

      const lease = yield* Effect.sync(() => leases.acquire(first))
      expect(lease._tag).toBe("Some")
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      // The previous identity is sealed immediately: a late control attach is
      // refused while the reload waits on the active lease.
      expect((yield* Effect.sync(() => leases.acquire(first)))._tag).toBe("None")
      // The disposers have NOT run while the control lease is held.
      expect(yield* isDone(started)).toBe(false)
      yield* unwrap(lease)
      yield* awaitWithTimeout(Fiber.join(reload), "reload did not complete after the control lease released")
      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).not.toBe(first)
    }),
  )

  leaseIt.live("reload seals and drains an active write lease before disposing the previous identity", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const leases = yield* ControlLease.Service
      const first = yield* store.load({ directory: dir })
      const started = yield* Deferred.make<void>()
      const disposed: string[] = []
      yield* register(async (directory) => {
        if (directory !== dir) return
        Deferred.doneUnsafe(started, Effect.void)
        disposed.push(directory)
      })

      const lease = yield* Effect.sync(() => leases.acquireWrite(first))
      expect(lease._tag).toBe("Some")
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect((yield* Effect.sync(() => leases.acquireWrite(first)))._tag).toBe("None")
      expect(yield* isDone(started)).toBe(false)
      yield* unwrap(lease)
      yield* awaitWithTimeout(Fiber.join(reload), "reload did not complete after the write lease released")
      expect(disposed).toEqual([dir])
    }),
  )

  leaseIt.live("disposeSafe seals and drains an active control lease before disposing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const leases = yield* ControlLease.Service
      const first = yield* store.load({ directory: dir })
      const started = yield* Deferred.make<void>()
      const disposed: string[] = []
      yield* register(async (directory) => {
        if (directory !== dir) return
        Deferred.doneUnsafe(started, Effect.void)
        disposed.push(directory)
      })

      const lease = yield* Effect.sync(() => leases.acquire(first))
      expect(lease._tag).toBe("Some")
      const disposing = yield* store.disposeSafe(first).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect((yield* Effect.sync(() => leases.acquire(first)))._tag).toBe("None")
      expect(yield* isDone(started)).toBe(false)
      yield* unwrap(lease)
      yield* awaitWithTimeout(Fiber.join(disposing), "disposeSafe did not complete after the control lease released")
      expect(disposed).toEqual([dir])
      expect((yield* store.snapshot(dir))._tag).toBe("None")
    }),
  )

  leaseIt.live("disposeSafe seals and drains an active write lease before disposing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const leases = yield* ControlLease.Service
      const first = yield* store.load({ directory: dir })
      const started = yield* Deferred.make<void>()
      const disposed: string[] = []
      yield* register(async (directory) => {
        if (directory !== dir) return
        Deferred.doneUnsafe(started, Effect.void)
        disposed.push(directory)
      })

      const lease = yield* Effect.sync(() => leases.acquireWrite(first))
      expect(lease._tag).toBe("Some")
      const disposing = yield* store.disposeSafe(first).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect((yield* Effect.sync(() => leases.acquireWrite(first)))._tag).toBe("None")
      expect(yield* isDone(started)).toBe(false)
      yield* unwrap(lease)
      yield* awaitWithTimeout(Fiber.join(disposing), "disposeSafe did not complete after the write lease released")
      expect(disposed).toEqual([dir])
    }),
  )

  leaseIt.live("disposeSafe preserves the identity check: a replaced identity is a no-op", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const first = yield* store.load({ directory: dir })
      const disposed: string[] = []
      yield* register(async (directory) => {
        if (directory === dir) disposed.push(directory)
      })

      // The reload replaces the identity (disposing it exactly once).
      const second = yield* store.reload({ directory: dir })
      expect(disposed).toEqual([dir])
      // A stale disposeSafe of the replaced identity must be a pure no-op — the
      // reload owns its disposal, so no second disposal runs.
      yield* store.disposeSafe(first)
      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  leaseIt.live("an interrupted disposeSafe releases the drain when the lease later releases", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const leases = yield* ControlLease.Service
      const first = yield* store.load({ directory: dir })
      const disposed: string[] = []
      yield* register(async (directory) => {
        if (directory === dir) disposed.push(directory)
      })

      const lease = yield* Effect.sync(() => leases.acquireWrite(first))
      expect(lease._tag).toBe("Some")
      const disposing = yield* store.disposeSafe(first).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      // Interrupt the disposer while it awaits the drain: the identity stays
      // sealed and the disposers never run, and the drain signal is not leaked.
      yield* Fiber.interrupt(disposing)
      yield* unwrap(lease)
      yield* awaitWithTimeout(
        leases.sealAndDrain(first),
        "the drain did not complete after the lease released (interrupted disposer leaked it)",
      )
      expect(disposed).toEqual([])
    }),
  )
})
