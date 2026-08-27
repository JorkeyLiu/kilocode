import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config } from "@/config/config"
import { CurrentWorkingDirectory } from "@/cli/cmd/tui/config/cwd"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { markPluginDependenciesReady } from "../fixture/plugin"

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))
function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

const it = testEffect(Layer.mergeAll(Config.defaultLayer, FSUtil.defaultLayer))
// Isolated global config root — fallible mkdtemp before any global mutation; outer guard restores on failure.
const withCleanState = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-")))
      const disabled = Flag.KILO_DISABLE_DEFAULT_PLUGINS
      const prev = {
        KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
        KILO_TUI_CONFIG: process.env.KILO_TUI_CONFIG,
        KILO_DISABLE_PROJECT_CONFIG: process.env.KILO_DISABLE_PROJECT_CONFIG,
      }
      const orig = Global.Path.config
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      delete process.env.KILO_CONFIG_DIR
      delete process.env.KILO_TUI_CONFIG
      delete process.env.KILO_DISABLE_PROJECT_CONFIG
      ;(Global.Path as { config: string }).config = tmp
      return { disabled, prev, orig, tmp }
    }),
    () => self,
    ({ disabled, prev, orig, tmp }) =>
      Effect.gen(function* () {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = disabled
        ;(Global.Path as { config: string }).config = orig
        yield* Effect.promise(() =>
          fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
            console.error("[test cleanup] withCleanState rm failed", { tmp, err })
            return undefined
          }),
        )
        for (const [k, v] of Object.entries(prev) as Array<[string, string | undefined]>) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }),
  )
const withEnv = <A, E, R>(name: string, value: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => { const prev = process.env[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; return prev }),
    () => self,
    (prev) => Effect.sync(() => { if (prev === undefined) delete process.env[name]; else process.env[name] = prev }),
  )
const getTuiConfig = (directory: string) =>
  TuiConfig.Service.use((s) => s.get()).pipe(Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)))))

describe("P4.4 TUI canonical source removal — LOCK-SOURCE", () => {
  test("static: no ancestor walk, no .kilocode, no KILO_CONFIG_DIR/KILO_TUI_CONFIG/migrate as effective source", () => {
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).not.toContain("KILO_CONFIG_DIR")
    expect(tui).not.toContain("Flag.KILO_TUI_CONFIG")
    expect(tui).not.toContain("KILO_TUI_CONFIG")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(tui).not.toContain("migrate")
    expect(tui).not.toContain("yield* afs.up")
    expect(tui).not.toContain('targets: [".kilocode"')
    expect(tui).not.toContain('targets: [".kilo"')
    expect(tui).not.toContain(".kilocode")
    expect(tui).not.toContain("ConfigPaths.directories()")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).toContain("Global.Path.config")
    expect(tui).toContain('path.join(root, ".kilo")')
    expect(tui).toContain("workspaceKiloDir")
    expect(tui).toContain("workspaceDirs")
    expect(tui).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    // Also prove kilocode config-console target is canonical only
    const kcfg = read("kilocode/tui/config.ts")
    expect(kcfg).not.toContain(".kilocode")
    expect(kcfg).not.toContain("Filesystem.findUp")
    expect(kcfg).not.toContain("Flag.KILO")
    expect(kcfg).toContain('const dirs = [".kilo"]')
    const paths = read("config/paths.ts")
    expect(paths).toContain("return unique([Global.Path.config])")
    expect(paths).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(paths).not.toContain('targets: [".kilo"]')
  })

  test("static: sole KILO_CONFIG_DIR reader is global override and sandbox deny, not TUI", () => {
    const flag = readRepo("packages/core/src/flag/flag.ts")
    expect(flag).toContain("get KILO_CONFIG_DIR()")
    const global = readRepo("packages/core/src/global.ts")
    expect(global).toContain("Flag.KILO_CONFIG_DIR ?? Path.config")
    const policy = read("kilocode/sandbox/policy.ts")
    expect(policy).toContain('"KILO_CONFIG_DIR"')
    expect(policy).toContain('"KILO_CONFIG"')
  })

  test("test-profile lists canonical removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-tui-canonical-source-removal")
    expect(profile).toContain("p4-4-t16-tui-legacy-discovery")
    expect(profile).toContain("p4-4-t18-config-paths-kilo-config-dir-removal")
    expect(profile).toContain("p4-4-tui-migrate-kilo-config-removal")
    const t16Idx = profile.indexOf("p4-4-t16-tui-legacy-discovery")
    const t18Idx = profile.indexOf("p4-4-t18-config-paths-kilo-config-dir-removal")
    const canonicalIdx = profile.indexOf("p4-4-tui-canonical-source-removal")
    const migrateIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    expect(t16Idx).toBeLessThan(t18Idx)
    expect(t18Idx).toBeLessThan(canonicalIdx)
    expect(canonicalIdx).toBeLessThan(migrateIdx)
  })
})

describe("P4.4 TUI canonical runtime — workspace .kilo only", () => {
  it.instance("discovers workspace .kilo/tui.json", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "workspace-kilo" }, null, 2))
        const cfg = yield* getTuiConfig(test.directory)
        expect(cfg.theme).toBe("workspace-kilo")
      }),
    ),
  )

  it.instance("discovers workspace direct tui.json without ancestor walk", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "workspace-direct" })
        const cfg = yield* getTuiConfig(test.directory)
        expect(cfg.theme).toBe("workspace-direct")
      }),
    ),
  )

  it.instance("does not discover ancestor .kilo/tui.json", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const nested = path.join(test.directory, "a", "b")
        yield* fs.makeDirectory(nested, { recursive: true })
        yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "ancestor-kilo" }, null, 2))
        const cfg = yield* getTuiConfig(nested)
        expect(cfg.theme).toBeUndefined()
      }),
    ),
  )

  it.instance("does not discover ancestor direct tui.json", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const nested = path.join(test.directory, "a", "b")
        yield* fs.makeDirectory(nested, { recursive: true })
        yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "ancestor-direct" })
        const cfg = yield* getTuiConfig(nested)
        expect(cfg.theme).toBeUndefined()
      }),
    ),
  )

  it.instance("does not discover .kilocode/tui.json", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeWithDirs(path.join(test.directory, ".kilocode", "tui.json"), JSON.stringify({ theme: "workspace-kilocode" }, null, 2))
        const cfg = yield* getTuiConfig(test.directory)
        expect(cfg.theme).toBeUndefined()
      }),
    ),
  )

  it.instance("does not discover ancestor .kilocode", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const nested = path.join(test.directory, "a", "b")
        yield* fs.makeDirectory(nested, { recursive: true })
        yield* fs.writeWithDirs(path.join(test.directory, ".kilocode", "tui.json"), JSON.stringify({ theme: "ancestor-kilocode" }, null, 2))
        const cfg = yield* getTuiConfig(nested)
        expect(cfg.theme).toBeUndefined()
      }),
    ),
  )

  it.instance("loads global when no project config", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global-theme" })
        const cfg = yield* getTuiConfig(test.directory)
        expect(cfg.theme).toBe("global-theme")
      }),
    ),
  )

  it.instance("workspace .kilo wins over direct and global", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "from-global", diff_style: "auto" })
        yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "from-direct", diff_style: "auto" })
        yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "from-kilo", diff_style: "stacked" }, null, 2))
        const cfg = yield* getTuiConfig(test.directory)
        expect(cfg.theme).toBe("from-kilo")
        expect(cfg.diff_style).toBe("stacked")
      }),
    ),
  )

  it.instance("direct wins over global when .kilo absent", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "from-global" })
        yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "from-direct" })
        const cfg = yield* getTuiConfig(test.directory)
        expect(cfg.theme).toBe("from-direct")
      }),
    ),
  )

  it.instance("KILO_CONFIG_DIR does not override canonical", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const profile = path.join(test.directory, "profile-dir")
        yield* fs.makeDirectory(profile, { recursive: true })
        yield* fs.writeJson(path.join(profile, "tui.json"), { theme: "profile-theme" })
        yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global-theme" })
        yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "workspace-kilo" }, null, 2))
        const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
        expect(cfg.theme).toBe("workspace-kilo")
        // also when workspace .kilo absent, global wins, not profile
        yield* fs.remove(path.join(test.directory, ".kilo", "tui.json"), { force: true })
        yield* fs.remove(path.join(test.directory, "tui.json"), { force: true }).pipe(Effect.ignore)
        const cfg2 = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
        expect(cfg2.theme).toBe("global-theme")
        expect(cfg2.theme).not.toBe("profile-theme")
      }),
    ),
  )

  it.instance("project-disable excludes workspace direct and .kilo but retains global", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global-kept" })
        yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "should-be-ignored" }, null, 2))
        yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "should-be-ignored-direct" })
        const withoutDisable = yield* getTuiConfig(test.directory)
        expect(withoutDisable.theme).toBe("should-be-ignored")
        const withDisable = yield* withEnv("KILO_DISABLE_PROJECT_CONFIG", "true", getTuiConfig(test.directory))
        expect(withDisable.theme).toBe("global-kept")
        // also KILO_CONFIG_DIR still ignored when disabled
        const profile = path.join(test.directory, "profile-dir")
        yield* fs.makeDirectory(profile, { recursive: true })
        yield* fs.writeJson(path.join(profile, "tui.json"), { theme: "profile-kept" })
        const withDisableAndProfile = yield* withEnv("KILO_DISABLE_PROJECT_CONFIG", "true", withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory)))
        expect(withDisableAndProfile.theme).toBe("global-kept")
        expect(withDisableAndProfile.theme).not.toBe("profile-kept")
      }),
    ),
  )

  it.instance("KILO_CONFIG_DIR does not affect plugin duplicate resolution", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const profile = path.join(test.directory, "profile-dir")
        yield* fs.makeDirectory(profile, { recursive: true })
        yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ plugin: ["kilo-only@1.0.0"] }, null, 2))
        yield* fs.writeJson(path.join(profile, "tui.json"), { plugin: ["profile-only@9.0.0"] })
        // Mark exact canonical .kilo dir ready to prevent detached plugin install outliving fixture
        yield* Effect.promise(() => markPluginDependenciesReady(path.join(test.directory, ".kilo")))
        const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
        expect(cfg.plugin).toEqual(["kilo-only@1.0.0"])
        expect(cfg.plugin).not.toContain("profile-only@9.0.0")
        // Await dependencies before disposal to ensure no background install outlives fixture
        yield* Effect.promise(() => TuiConfig.waitForDependencies().catch(() => undefined))
      }),
    ),
  )

  it.instance("KILO_TUI_CONFIG does not override canonical global/direct/.kilo", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        const custom = path.join(test.directory, "custom-tui.json")
        yield* fs.writeJson(custom, { theme: "from-env", diff_style: "stacked" })
        yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global-theme", diff_style: "auto" })
        yield* fs.writeJson(path.join(test.directory, "tui.json"), { theme: "direct-theme" })
        const cfg = yield* withEnv("KILO_TUI_CONFIG", custom, getTuiConfig(test.directory))
        expect(cfg.theme).toBe("direct-theme")
        expect(cfg.diff_style).toBe("auto")
        expect(cfg.theme).not.toBe("from-env")
        // also when direct absent, .kilo still wins over env
        yield* fs.remove(path.join(test.directory, "tui.json"), { force: true })
        yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "kilo-theme" }, null, 2))
        const cfg2 = yield* withEnv("KILO_TUI_CONFIG", custom, getTuiConfig(test.directory))
        expect(cfg2.theme).toBe("kilo-theme")
        // when only global and env, global wins
        yield* fs.remove(path.join(test.directory, ".kilo", "tui.json"), { force: true })
        const cfg3 = yield* withEnv("KILO_TUI_CONFIG", custom, getTuiConfig(test.directory))
        expect(cfg3.theme).toBe("global-theme")
        expect(cfg3.theme).not.toBe("from-env")
      }),
    ),
  )

  it.instance("legacy kilo.json/kilo.jsonc does not influence TUI config (no migrate)", () =>
    withCleanState(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(path.join(test.directory, "kilo.json"), { theme: "migrated-theme", tui: { scroll_speed: 5 }, keybinds: { app_exit: "ctrl+q" } })
        yield* fs.writeFileString(path.join(test.directory, "kilo.jsonc"), `{"theme": "jsonc-theme", "tui": {"scroll_speed": 9}}`)
        const cfg = yield* getTuiConfig(test.directory)
        expect(cfg.theme).toBeUndefined()
        expect(cfg.scroll_speed).toBeUndefined()
        // tui.json should NOT have been materialized by migrate
        expect(yield* fs.existsSafe(path.join(test.directory, "tui.json"))).toBe(false)
        // legacy file remains but not influencing
        expect(JSON.parse(yield* fs.readFileString(path.join(test.directory, "kilo.json"))).theme).toBe("migrated-theme")
      }),
    ),
  )

  it.instance("no active TUI startup reads forbidden sources — migrate file absent and env absence proven via source", () =>
    withCleanState(
      Effect.gen(function* () {
        const tuiSrc = read("cli/cmd/tui/config/tui.ts")
        // tui-migrate.ts file is physically removed (residual package)
        const migrateExists = existsSync(join(repo, "packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts"))
        expect(migrateExists).toBe(false)
        // tui.ts must not contain migrate import or KILO_TUI_CONFIG reader
        expect(tuiSrc).not.toContain("migrateTuiConfig")
        expect(tuiSrc).not.toContain("tui-migrate")
        expect(tuiSrc).not.toContain("KILO_TUI_CONFIG")
        expect(tuiSrc).not.toContain("migrate")
        // Flag.KILO_TUI_CONFIG getter is physically removed
        const flag = readRepo("packages/core/src/flag/flag.ts")
        expect(flag).not.toContain("KILO_TUI_CONFIG")
        // global sandbox still retains deny, but not effective source
        const policy = read("kilocode/sandbox/policy.ts")
        expect(policy).toContain('"KILO_CONFIG_DIR"')
      }),
    ),
  )
})
