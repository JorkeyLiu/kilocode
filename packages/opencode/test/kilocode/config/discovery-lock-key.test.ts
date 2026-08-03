/**
 * Focused unit + race tests for the global discovery lock key (LOCK-001).
 *
 * The key must derive deterministically from the canonical global config
 * domain (the resolved Global.Path.config), not a process-independent
 * constant. Otherwise isolated XDG/test config roots contend on the same lock
 * file in the shared state lock root (60-120s backoff delays), while processes
 * sharing one config root must still serialize through a single key.
 *
 * Proves:
 * 1. Same root -> same key across independent call sites.
 * 2. Different roots -> different keys (isolated domains never contend).
 * 3. Writers sharing a root serialize through the derived key (mutual
 *    exclusion at the flock level), and a different root does NOT block.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { KilocodeConfig } from "../../../src/kilocode/config/config"
import { tmpdir } from "../../fixture/fixture"

const original = Global.Path.config

afterEach(() => {
  ;(Global.Path as { config: string }).config = original
})

/** EffectFlock against an isolated lock root so the test never touches user state. */
const flockLayer = (stateDir: string) =>
  EffectFlock.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ state: stateDir })),
  )

const withKey = (key: string, body: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    return yield* flock.withLock(body, key)
  })

describe("configDiscoveryGlobalKey derivation", () => {
  test("same root produces the same derived key across call sites", async () => {
    await using root = await tmpdir()
    ;(Global.Path as { config: string }).config = root.path
    // Independent call sites (updateGlobal, config transaction, custom provider
    // save) must agree on the key for the same config domain.
    const expected = `config:discover:global:${Hash.fast(path.resolve(root.path))}`
    expect(KilocodeConfig.configDiscoveryGlobalKey()).toBe(expected)
    expect(KilocodeConfig.configDiscoveryGlobalKey()).toBe(expected)
    // Derived from the domain, never the legacy process-independent constant.
    expect(expected).not.toBe("config:discover:global")
  })

  test("different roots produce different keys", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    ;(Global.Path as { config: string }).config = a.path
    const keyA = KilocodeConfig.configDiscoveryGlobalKey()
    ;(Global.Path as { config: string }).config = b.path
    const keyB = KilocodeConfig.configDiscoveryGlobalKey()
    ;(Global.Path as { config: string }).config = a.path
    const keyA2 = KilocodeConfig.configDiscoveryGlobalKey()
    expect(keyA).not.toBe(keyB)
    expect(keyA2).toBe(keyA)
  })
})

describe("configDiscoveryGlobalKey race behavior", () => {
  test("writers sharing a root serialize through the derived key", async () => {
    await using root = await tmpdir()
    await using state = await tmpdir()
    ;(Global.Path as { config: string }).config = root.path
    const key = KilocodeConfig.configDiscoveryGlobalKey()
    const rt = ManagedRuntime.make(flockLayer(state.path))
    try {
      // Holder acquires the derived key, then publishes readiness and parks.
      const ready = await rt.runPromise(Deferred.make<void>())
      const gate = await rt.runPromise(Deferred.make<void>())
      const holder = rt.runFork(
        withKey(key, Deferred.succeed(ready, void 0).pipe(Effect.andThen(Deferred.await(gate)))),
      )
      await rt.runPromise(Effect.timeout(Deferred.await(ready), "2 seconds"))

      // Second writer on the SAME key must block: awaiting it times out
      // (Exit.Failure) while the holder parks.
      const second = rt.runFork(withKey(key, Effect.void))
      const blocked = await rt.runPromise(Effect.exit(Effect.timeout(Fiber.await(second), "300 millis")))
      expect(blocked._tag).toBe("Failure")

      // Release the holder; the blocked writer completes.
      await rt.runPromise(Deferred.succeed(gate, void 0))
      await rt.runPromise(Fiber.join(holder))
      await rt.runPromise(Effect.timeout(Fiber.await(second), "2 seconds"))
    } finally {
      await rt.dispose()
    }
  })

  test("isolated roots do not contend through the derived key", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await using state = await tmpdir()
    const rt = ManagedRuntime.make(flockLayer(state.path))
    try {
      ;(Global.Path as { config: string }).config = a.path
      const keyA = KilocodeConfig.configDiscoveryGlobalKey()
      ;(Global.Path as { config: string }).config = b.path
      const keyB = KilocodeConfig.configDiscoveryGlobalKey()

      // Holder acquires keyA and parks.
      const ready = await rt.runPromise(Deferred.make<void>())
      const gate = await rt.runPromise(Deferred.make<void>())
      const holder = rt.runFork(
        withKey(keyA, Deferred.succeed(ready, void 0).pipe(Effect.andThen(Deferred.await(gate)))),
      )
      await rt.runPromise(Effect.timeout(Deferred.await(ready), "2 seconds"))

      // A writer for the OTHER root must NOT wait on keyA: it completes
      // immediately instead of timing out (the pre-fix constant key would
      // have blocked it exactly like keyA).
      const exit = await rt.runPromise(
        Effect.exit(Effect.timeout(withKey(keyB, Effect.void), "300 millis")),
      )
      expect(exit._tag).toBe("Success")

      await rt.runPromise(Deferred.succeed(gate, void 0))
      await rt.runPromise(Fiber.join(holder))
    } finally {
      await rt.dispose()
    }
  })
})
