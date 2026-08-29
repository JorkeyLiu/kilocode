// kilocode_change - new file
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, ManagedRuntime } from "effect"
import { awaitRebuilds, ConfigRebuild, forkRebuild } from "../../../src/kilocode/server/config-rebuild"
import { awaitWithTimeout, testEffect } from "../../lib/effect"

const it = testEffect(ConfigRebuild.defaultLayer)

describe("config rebuild tracker", () => {
  it.live("awaitRebuilds fences a rebuild registered while awaiting", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* forkRebuild(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, void 0)
          yield* Deferred.await(release)
        }),
      )
      yield* Deferred.await(started)
      const finished = yield* Deferred.make<void>()
      const waiter = yield* awaitRebuilds().pipe(
        Effect.tap(() => Deferred.succeed(finished, void 0)),
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      expect((yield* Deferred.poll(finished))._tag).toBe("None")
      const secondRelease = yield* Deferred.make<void>()
      yield* forkRebuild(Deferred.await(secondRelease))
      yield* Deferred.succeed(release, void 0)
      expect((yield* Deferred.poll(finished))._tag).toBe("None")
      yield* Deferred.succeed(secondRelease, void 0)
      yield* awaitWithTimeout(Fiber.join(waiter), "awaitRebuilds did not observe registered completion")
    }),
  )

  it.live("awaitRebuilds surfaces a failed child after unregistering it", () =>
    Effect.gen(function* () {
      yield* forkRebuild(Effect.die(new Error("tracker failure")))
      const first = yield* Effect.exit(awaitRebuilds())
      expect(Exit.isFailure(first)).toBe(true)
      yield* awaitRebuilds()
    }),
  )

  it.live("interrupted rebuilds unregister and leave awaitRebuilds clear", () =>
    Effect.gen(function* () {
      yield* forkRebuild(Effect.interrupt)
      yield* awaitRebuilds()
      yield* awaitRebuilds()
    }),
  )

  it.live("owner shutdown interrupts and joins an explicit rebuild", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>()
      const stopped = Deferred.makeUnsafe<void>()
      const rt = ManagedRuntime.make(ConfigRebuild.defaultLayer)
      yield* Effect.promise(() =>
        rt.runPromise(
          forkRebuild(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, void 0)
              yield* Deferred.await(Deferred.makeUnsafe<void>())
            }).pipe(Effect.ensuring(Deferred.succeed(stopped, void 0))),
          ),
        ),
      )
      yield* awaitWithTimeout(Deferred.await(started), "owned rebuild did not start")
      yield* Effect.promise(() => rt.dispose())
      yield* awaitWithTimeout(Deferred.await(stopped), "owner shutdown did not join rebuild")
      yield* Effect.promise(() => rt.dispose())
    }),
  )

  it.live("rejects a closed owner without registering tracker work", () =>
    Effect.gen(function* () {
      const rt = ManagedRuntime.make(ConfigRebuild.defaultLayer)
      const owner = yield* Effect.promise(() => rt.runPromise(ConfigRebuild.Service))
      yield* Effect.promise(() => rt.dispose())
      const ran = yield* Effect.promise(() =>
        Effect.runPromise(
          owner.fork(
            Effect.sync(() => {
              throw new Error("closed rebuild ran")
            }),
          ),
        ),
      )
      expect(ran).toBe(false)
      yield* awaitRebuilds()
    }),
  )
})
