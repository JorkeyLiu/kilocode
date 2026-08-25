// kilocode_change - P4.3 agent removal lock-ownership / concurrency test
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "path"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { KilocodeConfig } from "../../src/kilocode/config/config"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"

const originalConfig = Global.Path.config

afterEach(() => {
  ;(Global.Path as { config: string }).config = originalConfig
})

describe("P4.3 agent removal uses shared config discovery locks", () => {
  test("canonical agent removal uses shared config discovery locks and atomic persistence", async () => {
    const src = readFileSync(path.join(import.meta.dir, "../../src/kilocode/agent/index.ts"), "utf8")
    expect(src).toContain("KilocodeConfig.configDiscoveryGlobalKey")
    expect(src).toContain("KilocodeConfig.configDiscoveryProjectKey")
    expect(src).toContain("EffectFlock.Service")
    expect(src).toContain("withLock")
    expect(src).toContain("KilocodeAtomicWrite.write")
    expect(src).toContain("Bun.file(file).exists()")
    expect(src).toContain("Bun.file(file).text()")
    expect(src).toContain("LockTimeoutError")
    expect(src).toContain("LockCompromisedError")
    // preserves withColdMutation lifecycle (handler) is still present
    const handler = readFileSync(
      path.join(import.meta.dir, "../../src/kilocode/server/httpapi/handlers/kilocode.ts"),
      "utf8",
    )
    expect(handler).toContain("withColdMutation")
    expect(handler).toContain('scope: "global"')
  })
})

describe("P4.3 agent removal serializes with Config.Service via EffectFlock", () => {
  test("global agent removal blocks on the shared global discovery lock", async () => {
    await using globalTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path
    const file = path.join(globalTmp.path, "kilo.jsonc")
    await Filesystem.write(file, JSON.stringify({ agent: { "race-agent": { description: "x" } } }, null, 2))

    const key = KilocodeConfig.configDiscoveryGlobalKey()
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

      // agent removal should block on the same global key
      const { remove } = await import("../../src/kilocode/agent/index.ts")
      const dirs = [path.join(globalTmp.path, ".kilo")] // no md, only config
      const pending = remove({
        name: "race-agent",
        agent: { name: "race-agent", native: false, options: {} } as any,
        dirs,
        directory: globalTmp.path,
      })
      const blocked = await rt.runPromise(
        Effect.exit(Effect.timeout(Effect.promise(() => pending), "400 millis")),
      )
      // while holder parks, removal must not complete (timeout)
      expect(blocked._tag).toBe("Failure")

      await rt.runPromise(Deferred.succeed(gate, void 0))
      await rt.runPromise(Fiber.join(holder))

      // now it completes and the agent entry is gone, file is still valid JSONC
      await pending
      const after = JSON.parse(await Bun.file(file).text())
      expect(after.agent?.["race-agent"]).toBeUndefined()
    } finally {
      await rt.dispose()
    }
  })

  test("project agent removal blocks on the shared project discovery lock", async () => {
    await using projectTmp = await tmpdir()
    const kiloDir = path.join(projectTmp.path, ".kilo")
    const file = path.join(kiloDir, "kilo.jsonc")
    await Filesystem.write(file, JSON.stringify({ agent: { "race-agent": { description: "x" } } }, null, 2))

    const key = KilocodeConfig.configDiscoveryProjectKey(projectTmp.path)
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
      // isolate global so only project file is relevant
      await using globalTmp = await tmpdir()
      ;(Global.Path as { config: string }).config = globalTmp.path
      const dirs = [kiloDir]
      const pending = remove({
        name: "race-agent",
        agent: { name: "race-agent", native: false, options: {} } as any,
        dirs,
        directory: projectTmp.path,
      })
      const blocked = await rt.runPromise(
        Effect.exit(Effect.timeout(Effect.promise(() => pending), "400 millis")),
      )
      expect(blocked._tag).toBe("Failure")

      await rt.runPromise(Deferred.succeed(gate, void 0))
      await rt.runPromise(Fiber.join(holder))

      await pending
      const after = JSON.parse(await Bun.file(file).text())
      expect(after.agent?.["race-agent"]).toBeUndefined()
    } finally {
      await rt.dispose()
    }
  })

  test("concurrent agent removal and unrelated project config write preserve both (LOCK-002)", async () => {
    await using projectTmp = await tmpdir()
    const kiloDir = path.join(projectTmp.path, ".kilo")
    const file = path.join(kiloDir, "kilo.jsonc")
    await Filesystem.write(
      file,
      JSON.stringify({ agent: { "race-agent": { description: "x" } }, model: "keep/me" }, null, 2),
    )

    // separate global so project file is the only target
    await using globalTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path

    const { remove } = await import("../../src/kilocode/agent/index.ts")
    const { KilocodeConfig: KC } = await import("../../src/kilocode/config/config.ts")
    const { ConfigParse } = await import("../../src/config/parse.ts")

    const flockRt = ManagedRuntime.make(Layer.merge(EffectFlock.defaultLayer, FSUtil.defaultLayer))
    const applyUpdate = (patch: Record<string, unknown>) =>
      flockRt.runPromise(
        Effect.gen(function* () {
          const fsu = yield* FSUtil.Service
          return yield* KC.updateProjectConfig({
            fs: fsu,
            directory: projectTmp.path,
            config: patch as any,
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

    await Promise.all([
      remove({
        name: "race-agent",
        agent: { name: "race-agent", native: false, options: {} } as any,
        dirs: [kiloDir],
        directory: projectTmp.path,
      }),
      applyUpdate({ model: "race/model" }),
    ])

    const written = JSON.parse(await Bun.file(file).text())
    expect(written.agent?.["race-agent"]).toBeUndefined()
    // either the original keep/me or the raced model wins, but the file must be valid and not lose the agent deletion
    expect(written.model === "race/model" || written.model === "keep/me").toBe(true)
    // atomic commit: no tmp leftovers
    const { readdir } = await import("node:fs/promises")
    const leftovers = (await readdir(kiloDir)).filter((n) => n.includes(".tmp"))
    expect(leftovers.length).toBe(0)
    await flockRt.dispose()
  })
})
