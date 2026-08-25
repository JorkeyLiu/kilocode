// kilocode_change - P4.3 lock identity + asset-removal serialization regression
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "fs/promises"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { KilocodeConfig } from "../../src/kilocode/config/config"
import { KilocodeConfigOverlay } from "../../src/kilocode/config/overlay"
import { canonicalRoot } from "../../src/project/instance-context"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"

const originalConfig = Global.Path.config
afterEach(() => {
  ;(Global.Path as { config: string }).config = originalConfig
})

describe("P4.3 canonical lock identity (LOCK-005)", () => {
  test("nested and workspace-root contexts use one identical project lock key and target", async () => {
    await using tmpRoot = await tmpdir({ git: true })
    const root = tmpRoot.path
    const nested = path.join(root, "a", "b")
    await mkdir(nested, { recursive: true })

    // canonicalRoot must converge regardless of directory depth
    expect(canonicalRoot(nested, root)).toBe(root)
    expect(canonicalRoot(root, root)).toBe(root)
    expect(canonicalRoot(root, undefined)).toBe(root)

    // project target is deterministic canonical path for both contexts
    const tRoot = await KilocodeConfigOverlay.projectTarget({ directory: root, worktree: root })
    const tNested = await KilocodeConfigOverlay.projectTarget({ directory: nested, worktree: root })
    expect(tRoot).toBe(tNested)
    expect(tRoot).toBe(path.join(root, ".kilo", "kilo.jsonc"))

    // lock keys must be identical for same canonical root
    const kRoot = KilocodeConfig.configDiscoveryProjectKey(root)
    const kNested = KilocodeConfig.configDiscoveryProjectKey(nested, root)
    const kRootWithWorktree = KilocodeConfig.configDiscoveryProjectKey(root, root)
    expect(kRoot).toBe(kNested)
    expect(kRoot).toBe(kRootWithWorktree)

    // also via update path: projectConfigUpdateTarget resolves same file
    const fs = await Effect.runPromise(Effect.gen(function* () { return yield* FSUtil.Service }).pipe(Effect.provide(FSUtil.defaultLayer)))
    // use FSUtil.Service via direct import: create a tiny runtime
    const rt = ManagedRuntime.make(FSUtil.defaultLayer)
    const targetViaRoot = await rt.runPromise(KilocodeConfig.projectConfigUpdateTarget({ fs, directory: root, worktree: root } as any))
    const targetViaNested = await rt.runPromise(KilocodeConfig.projectConfigUpdateTarget({ fs, directory: nested, worktree: root } as any))
    expect(targetViaRoot).toBe(targetViaNested)
    expect(targetViaRoot).toBe(path.join(root, ".kilo", "kilo.jsonc"))
    await rt.dispose()
  }, 30_000)

  test("concurrent canonical agent removal vs project config mutation on same canonical root serializes (nested vs root)", async () => {
    await using projectTmp = await tmpdir({ git: true })
    const root = projectTmp.path
    const nested = path.join(root, "a")
    await mkdir(nested, { recursive: true })
    const kiloDir = path.join(root, ".kilo")
    const file = path.join(kiloDir, "kilo.jsonc")
    await Filesystem.write(file, JSON.stringify({ agent: { "race-agent": { description: "x" } }, model: "keep/me" }, null, 2))

    // isolate global so only project file is relevant
    await using globalTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path

    const keyRoot = KilocodeConfig.configDiscoveryProjectKey(root)
    const keyNested = KilocodeConfig.configDiscoveryProjectKey(nested, root)
    expect(keyRoot).toBe(keyNested)

    const rt = ManagedRuntime.make(Layer.merge(EffectFlock.defaultLayer, FSUtil.defaultLayer))
    try {
      const ready = await rt.runPromise(Deferred.make<void>())
      const gate = await rt.runPromise(Deferred.make<void>())
      const holder = rt.runFork(
        Effect.gen(function* () {
          const flock = yield* EffectFlock.Service
          // hold the canonical project lock via nested key
          return yield* flock.withLock(Deferred.succeed(ready, void 0).pipe(Effect.andThen(Deferred.await(gate))), keyNested)
        }),
      )
      await rt.runPromise(Effect.timeout(Deferred.await(ready), "2 seconds"))

      const { remove } = await import("../../src/kilocode/agent/index.ts")
      // Removal from nested context must block on same lock
      const dirs = [kiloDir]
      const pending = remove({
        name: "race-agent",
        agent: { name: "race-agent", native: false, options: {} } as any,
        dirs,
        directory: nested,
        worktree: root,
      })
      const blocked = await rt.runPromise(Effect.exit(Effect.timeout(Effect.promise(() => pending), "400 millis")))
      expect(blocked._tag).toBe("Failure")

      // also a direct config mutation from root must block on same key
      const { KilocodeConfig: KC } = await import("../../src/kilocode/config/config.ts")
      const { ConfigParse } = await import("../../src/config/parse.ts")
      const flockRt = ManagedRuntime.make(Layer.merge(EffectFlock.defaultLayer, FSUtil.defaultLayer))
      const pendingConfig = flockRt.runPromise(
        Effect.gen(function* () {
          const fsu = yield* FSUtil.Service
          return yield* KC.updateProjectConfig({
            fs: fsu,
            directory: root,
            worktree: root,
            config: { model: "race/model" } as any,
            read: (f: string) =>
              fsu.readFileString(f).pipe(
                Effect.map((s) => s as string | undefined),
                Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
              ),
            parse: (input: string, f: string) => ConfigParse.jsonc(input, f) as any,
            patch: (input: string, cfg: any) => {
              const { applyEdits, modify } = require("jsonc-parser")
              return Object.entries(cfg).reduce(
                (out: string, [k, v]) =>
                  applyEdits(out, modify(out, [k], v, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
                input,
              )
            },
            writable: (c: any) => c,
          })
        }),
      )
      const blockedConfig = await rt.runPromise(
        Effect.exit(Effect.timeout(Effect.promise(() => pendingConfig as Promise<unknown>), "400 millis")),
      )
      // At least the agent removal blocked; config mutation also contends on same key
      // (it may queue behind the holder rather than the pending removal, but must not complete instantly)
      expect(blockedConfig._tag).toBe("Failure")

      await rt.runPromise(Deferred.succeed(gate, void 0))
      await rt.runPromise(Fiber.join(holder))

      await pending
      await pendingConfig.catch(() => {})
      const after = JSON.parse(await Bun.file(file).text())
      expect(after.agent?.["race-agent"]).toBeUndefined()
      await flockRt.dispose()
    } finally {
      await rt.dispose()
    }
  }, 60_000)

  test("canonical markdown asset deletion is serialized under the project lock", async () => {
    await using projectTmp = await tmpdir({ git: true })
    const root = projectTmp.path
    const kiloDir = path.join(root, ".kilo", "agents")
    await mkdir(kiloDir, { recursive: true })
    const md = path.join(kiloDir, "race-agent.md")
    await Bun.write(md, "# race")
    const kiloFile = path.join(root, ".kilo", "kilo.jsonc")
    await Filesystem.write(kiloFile, JSON.stringify({ agent: { "race-agent": { description: "x" } } }, null, 2))

    await using globalTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path

    const key = KilocodeConfig.configDiscoveryProjectKey(root)
    const rt = ManagedRuntime.make(Layer.merge(EffectFlock.defaultLayer, FSUtil.defaultLayer))
    try {
      const ready = await rt.runPromise(Deferred.make<void>())
      const gate = await rt.runPromise(Deferred.make<void>())
      const holder = rt.runFork(
        Effect.gen(function* () {
          const flock = yield* EffectFlock.Service
          return yield* flock.withLock(Deferred.succeed(ready, void 0).pipe(Effect.andThen(Deferred.await(gate))), key)
        }),
      )
      await rt.runPromise(Effect.timeout(Deferred.await(ready), "2 seconds"))

      const { remove } = await import("../../src/kilocode/agent/index.ts")
      const pending = remove({
        name: "race-agent",
        agent: { name: "race-agent", native: false, options: {} } as any,
        dirs: [path.join(root, ".kilo")],
        directory: root,
        worktree: root,
      })
      const blocked = await rt.runPromise(Effect.exit(Effect.timeout(Effect.promise(() => pending), "400 millis")))
      expect(blocked._tag).toBe("Failure")
      // markdown must still exist while holder parks
      expect(await Bun.file(md).exists()).toBe(true)

      await rt.runPromise(Deferred.succeed(gate, void 0))
      await rt.runPromise(Fiber.join(holder))

      await pending
      expect(await Bun.file(md).exists()).toBe(false)
      const after = JSON.parse(await Bun.file(kiloFile).text())
      expect(after.agent?.["race-agent"]).toBeUndefined()
      // atomic jsonc: no tmp leftovers
      const { readdir } = await import("node:fs/promises")
      const leftovers = (await readdir(path.join(root, ".kilo"))).filter((n) => n.includes(".tmp"))
      expect(leftovers.length).toBe(0)
    } finally {
      await rt.dispose()
    }
  }, 60_000)
})
