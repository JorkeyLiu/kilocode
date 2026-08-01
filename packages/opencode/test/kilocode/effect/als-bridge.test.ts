// kilocode_change - new file
/**
 * Direct coverage for `runInInstance`, the canonical legacy AsyncLocalStorage
 * bridge (ratchet-classified in script/check-opencode-promise-facades.ts).
 *
 * Proves:
 * 1. The bridged run exposes `Instance.current` (legacy ALS) for the whole
 *    effect, including across scheduler yields.
 * 2. Promise-side code (outside the Effect fiber, so `Fiber.getCurrent()` is
 *    undefined and `InstanceRef` alone cannot reach it) still reads the
 *    instance context through the ALS propagation.
 * 3. Interrupting the caller cancels the ALS-scoped run instead of leaving it
 *    detached.
 */
import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Instance, type InstanceContext } from "../../../src/kilocode/instance"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { Project } from "../../../src/project/project"
import { tmpdir } from "../../fixture/fixture"

function makeCtx(dir: string): InstanceContext {
  return {
    directory: dir,
    worktree: dir,
    project: {
      id: ProjectV2.ID.make("proj-als-bridge"),
      worktree: dir,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    } satisfies Project.Info,
  }
}

describe("runInInstance (ALS bridge)", () => {
  test("exposes the legacy Instance.current context for the whole run", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path

    const result = await Effect.runPromise(
      runInInstance(
        makeCtx(dir),
        Effect.gen(function* () {
          const first = Instance.current.directory
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          const after = Instance.current.directory
          return { first, after }
        }),
      ),
    )
    expect(result).toEqual({ first: dir, after: dir })
  })

  test("covers Promise-side Instance.current reads that InstanceRef alone cannot", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    const ctx = makeCtx(dir)

    // Control: Promise-side code (a chained async continuation, so no Effect
    // fiber is current) cannot read the instance through InstanceRef alone.
    const withoutBridge = await Effect.runPromise(
      Effect.promise(async () => {
        await Promise.resolve()
        try {
          return Instance.current.directory
        } catch {
          return "not-found"
        }
      }).pipe(Effect.provideService(InstanceRef, ctx)),
    )
    expect(withoutBridge).toBe("not-found")

    // The bridge restores the ALS context into that same Promise-side code.
    const withBridge = await Effect.runPromise(
      runInInstance(
        ctx,
        Effect.promise(async () => {
          await Promise.resolve()
          return Instance.current.directory
        }),
      ),
    )
    expect(withBridge).toBe(dir)
  })

  test("interrupting the caller cancels the ALS-scoped run", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    const entered = Deferred.makeUnsafe<void>()
    const blocked = Deferred.makeUnsafe<void>()

    const fiber = Effect.runFork(
      runInInstance(
        makeCtx(dir),
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, void 0)
          yield* Deferred.await(blocked)
          return "completed"
        }),
      ),
    )

    await Deferred.await(entered)
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })
})
