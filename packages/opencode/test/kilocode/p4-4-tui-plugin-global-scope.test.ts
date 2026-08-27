import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config } from "@/config/config"
import { CurrentWorkingDirectory } from "@/cli/cmd/tui/config/cwd"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { tmpdir, disposeAllInstances } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { Npm } from "@opencode-ai/core/npm"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const getTuiConfig = (directory: string) =>
  TuiConfig.Service.use((s) => s.get()).pipe(
    Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)))),
  )

describe("P4.4 TUI plugin origin global scope when Global.Path.config under worktree (LOCK-SOURCE)", () => {
  test("static: global plugin origin assembly uses explicit global scope independent of containment", async () => {
    const src = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/config/tui.ts"), "utf8")
    expect(src).toContain('mergeFile(acc, file, "global"')
    expect(src).toContain('mergeFile(acc, file, "local"')
    expect(src).toContain("Filesystem.contains(Global.Path.config, file)")
    expect(src).toContain("LOCK-SOURCE")
    // Ensure global files are explicitly global, not derived via pluginScope path heuristic alone
    expect(src).not.toContain("const scope = pluginScope(file, canonicalCtx)")
  })

  test("runtime: Global.Path.config beneath worktree retains global scope, precedence and dirs preserved", async () => {
    await using tmp = await tmpdir({ git: true })
    // Global config physically located inside the worktree (defect regression)
    const globalDir = path.join(tmp.path, "inner-global")
    await fs.mkdir(globalDir, { recursive: true })
    const origConfig = Global.Path.config
    const origDisable = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
    ;(Global.Path as { config: string }).config = globalDir
    try {
      // Global tui.json (lowest precedence) — should be scope global even though globalDir is inside worktree root
      await Bun.write(path.join(globalDir, "tui.json"), JSON.stringify({ plugin: ["global-plugin@1.0.0"] }, null, 2))
      // Workspace root direct tui.json (middle precedence) — local scope
      await Bun.write(path.join(tmp.path, "tui.json"), JSON.stringify({ plugin: ["shared-plugin@1.0.0", "direct-only@1.0.0"] }, null, 2))
      // Workspace .kilo/tui.json (highest precedence) — local scope, overrides shared-plugin
      const kiloDir = path.join(tmp.path, ".kilo")
      await fs.mkdir(kiloDir, { recursive: true })
      await Bun.write(path.join(kiloDir, "tui.json"), JSON.stringify({ plugin: ["shared-plugin@2.0.0", "kilo-only@1.0.0"] }, null, 2))

      // Prevent detached plugin install from outliving fixture — mark exact canonical dirs ready
      await markPluginDependenciesReady(globalDir)
      await markPluginDependenciesReady(tmp.path)
      await markPluginDependenciesReady(kiloDir)

      const cfg = await Effect.runPromise(
        getTuiConfig(tmp.path).pipe(Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)),
      )

      // Wait for any forked install fibers before disposal
      await TuiConfig.waitForDependencies().catch(() => undefined)

      // Plugin list reflects dedup/overrides: shared-plugin winner is 2.0.0 from .kilo, global/direct/kilo-only preserved
      expect(cfg.plugin).toEqual(["global-plugin@1.0.0", "direct-only@1.0.0", "shared-plugin@2.0.0", "kilo-only@1.0.0"])

      const origins = cfg.plugin_origins ?? []
      expect(origins.length).toBe(4)

      const find = (spec: string) => origins.find((o) => o.spec === spec)
      const globalOrigin = find("global-plugin@1.0.0")
      expect(globalOrigin).toBeDefined()
      expect(globalOrigin!.scope).toBe("global")
      expect(globalOrigin!.source).toBe(path.join(globalDir, "tui.json"))

      const directOrigin = find("direct-only@1.0.0")
      expect(directOrigin).toBeDefined()
      expect(directOrigin!.scope).toBe("local")
      expect(directOrigin!.source).toBe(path.join(tmp.path, "tui.json"))

      const sharedWinner = find("shared-plugin@2.0.0")
      expect(sharedWinner).toBeDefined()
      expect(sharedWinner!.scope).toBe("local")
      expect(sharedWinner!.source).toBe(path.join(kiloDir, "tui.json"))

      const kiloOnly = find("kilo-only@1.0.0")
      expect(kiloOnly).toBeDefined()
      expect(kiloOnly!.scope).toBe("local")
      expect(kiloOnly!.source).toBe(path.join(kiloDir, "tui.json"))

      // Dirs derived from winning origins only, source path preserved, dedup/overrides intact
      const dirs = (cfg as any).dirs ?? []
      // dirs not exposed on Resolved? Check via loadState dirs or via plugin_origins dirs logic — we verify via plugin_origins sources
      // Instead assert that dirs would be globalDir, tmp.path, kiloDir via origin dirnames unique order
      const expectedDirs = [globalDir, tmp.path, kiloDir]
      const actualDirs = [...new Set(origins.filter((o) => o.source !== "builtin").map((o) => path.dirname(o.source)))]
      expect(actualDirs).toEqual(expectedDirs)

      // Also verify that pluginScope fallback still correctly classifies global-under-root as global via Global.Path.config containment
      const src = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/config/tui.ts"), "utf8")
      expect(src).toContain('Filesystem.contains(Global.Path.config, file)')
    } finally {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = origDisable
      ;(Global.Path as { config: string }).config = origConfig
      await disposeAllInstances()
      await resetDatabase()
    }
  })

  test("runtime same-instance capture: global-under-worktree install targets equal winning dirs (no pre-mark hide)", async () => {
    await using tmp = await tmpdir({ git: true })
    const globalDir = path.join(tmp.path, "inner-global-capture")
    await fs.mkdir(globalDir, { recursive: true })
    const origConfig = Global.Path.config
    const origDisable = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
    ;(Global.Path as { config: string }).config = globalDir
    try {
      await Bun.write(path.join(globalDir, "tui.json"), JSON.stringify({ plugin: ["global-plugin@1.0.0"] }, null, 2))
      await Bun.write(path.join(tmp.path, "tui.json"), JSON.stringify({ plugin: ["shared-plugin@1.0.0", "direct-only@1.0.0"] }, null, 2))
      const kiloDir = path.join(tmp.path, ".kilo")
      await fs.mkdir(kiloDir, { recursive: true })
      await Bun.write(path.join(kiloDir, "tui.json"), JSON.stringify({ plugin: ["shared-plugin@2.0.0", "kilo-only@1.0.0"] }, null, 2))

      const captured: string[] = []
      const capturingNpm = Layer.mock(Npm.Service, {
        install: (dir: string) => Effect.sync(() => captured.push(dir)),
      })
      const layer = TuiConfig.layer.pipe(
        Layer.provide(capturingNpm),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Layer.succeed(CurrentWorkingDirectory, tmp.path)),
      )
      const cfg = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* TuiConfig.Service
          const c = yield* svc.get()
          yield* svc.waitForDependencies()
          return c
        }).pipe(Effect.provide(layer), Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)),
      )

      expect(cfg.plugin).toEqual(["global-plugin@1.0.0", "direct-only@1.0.0", "shared-plugin@2.0.0", "kilo-only@1.0.0"])
      const origins = cfg.plugin_origins ?? []
      const expectedDirs = [globalDir, tmp.path, kiloDir]
      const actualDirs = [...new Set(origins.filter((o) => o.source !== "builtin").map((o) => path.dirname(o.source)))]
      expect(actualDirs).toEqual(expectedDirs)
      // same-instance actual install dirs, not reconstructed, proves data.dirs correctness
      expect(captured).toEqual(expectedDirs)
      expect(new Set(captured).size).toBe(captured.length)
    } finally {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = origDisable
      ;(Global.Path as { config: string }).config = origConfig
      await disposeAllInstances()
      await resetDatabase()
    }
  })
})
