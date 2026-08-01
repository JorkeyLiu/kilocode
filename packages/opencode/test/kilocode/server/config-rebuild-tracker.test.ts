// kilocode_change - new file
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { awaitRebuilds, forkRebuild } from "../../../src/kilocode/server/config-rebuild"
import { awaitWithTimeout, it } from "../../lib/effect"

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
})
