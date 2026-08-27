import { expect } from "bun:test"
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

// P4.4 canonical — legacy discovery removed, canonical workspace .kilo only.
// This file now proves absence of ancestor/.kilocode/KILO_CONFIG_DIR and retention of canonical.

const it = testEffect(Layer.mergeAll(Config.defaultLayer, FSUtil.defaultLayer))

// Isolated global config root — fallible mkdtemp before any global mutation; restores on failure.
const withCleanState = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-")))
      const disabled = Flag.KILO_DISABLE_DEFAULT_PLUGINS
      const orig = Global.Path.config
      const prev = {
        KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
        KILO_TUI_CONFIG: process.env.KILO_TUI_CONFIG,
        KILO_DISABLE_PROJECT_CONFIG: process.env.KILO_DISABLE_PROJECT_CONFIG,
      }
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      delete process.env.KILO_CONFIG_DIR
      delete process.env.KILO_TUI_CONFIG
      delete process.env.KILO_DISABLE_PROJECT_CONFIG
      ;(Global.Path as { config: string }).config = tmp
      return { disabled, orig, prev, tmp }
    }),
    () => self,
    ({ disabled, orig, prev, tmp }) =>
      Effect.gen(function* () {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = disabled
        ;(Global.Path as { config: string }).config = orig
        for (const [k, v] of Object.entries(prev) as Array<[string, string | undefined]>) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
        yield* Effect.promise(() =>
          fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
            console.error("[test cleanup] withCleanState rm failed", { tmp, err })
            return undefined
          }),
        )
      }),
  )

const withEnv = <A, E, R>(name: string, value: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )

const getTuiConfig = (directory: string) =>
  TuiConfig.Service.use((svc) => svc.get()).pipe(
    Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)))),
  )

it.instance("TUI discovers workspace .kilo/tui.json", () =>
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

it.instance("TUI does not discover .kilocode/tui.json", () =>
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

it.instance("TUI does not discover .kilo ancestor via walk (nested cwd)", () =>
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

it.instance("TUI does not discover .kilocode ancestor via walk (nested cwd)", () =>
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

it.instance("TUI loads global config when no project config exists", () =>
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

it.instance("TUI KILO_CONFIG_DIR does not load tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const profile = path.join(test.directory, "profile-dir")
      yield* fs.makeDirectory(profile, { recursive: true })
      yield* fs.writeJson(path.join(profile, "tui.json"), { theme: "profile-theme" })
      const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
      expect(cfg.theme).toBeUndefined()
      // with global, global wins not profile
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global-theme" })
      const cfg2 = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
      expect(cfg2.theme).toBe("global-theme")
    }),
  ),
)

it.instance("TUI project-disable excludes .kilo but retains global, KILO_CONFIG_DIR still ignored", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "should-be-ignored" }, null, 2))
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global-kept" })
      const profile = path.join(test.directory, "profile-dir")
      yield* fs.makeDirectory(profile, { recursive: true })
      yield* fs.writeJson(path.join(profile, "tui.json"), { theme: "profile-kept" })
      const withoutDisable = yield* getTuiConfig(test.directory)
      expect(withoutDisable.theme).toBe("should-be-ignored")
      const withDisableAndProfile = yield* withEnv("KILO_DISABLE_PROJECT_CONFIG", "true", withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory)))
      expect(withDisableAndProfile.theme).toBe("global-kept")
      expect(withDisableAndProfile.theme).not.toBe("profile-kept")
      const withDisableOnly = yield* withEnv("KILO_DISABLE_PROJECT_CONFIG", "true", getTuiConfig(test.directory))
      expect(withDisableOnly.theme).toBe("global-kept")
    }),
  ),
)

it.instance("TUI .kilo plugin discovery is gated by disable flag", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeWithDirs(
        path.join(test.directory, ".kilo", "tui.json"),
        JSON.stringify({ plugin: ["local-plugin@1.0.0"] }, null, 2),
      )
      yield* Effect.promise(() => markPluginDependenciesReady(path.join(test.directory, ".kilo")))
      const enabled = yield* getTuiConfig(test.directory)
      expect(enabled.plugin).toEqual(["local-plugin@1.0.0"])
      const disabled = yield* withEnv("KILO_DISABLE_PROJECT_CONFIG", "true", getTuiConfig(test.directory))
      expect(disabled.plugin ?? []).toEqual([])
      yield* Effect.promise(() => TuiConfig.waitForDependencies().catch(() => undefined))
    }),
  ),
)

it.instance("TUI KILO_CONFIG_DIR does not win setting collision against .kilo", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const profile = path.join(test.directory, "profile-dir")
      yield* fs.makeDirectory(profile, { recursive: true })
      yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "from-kilo" }, null, 2))
      yield* fs.writeJson(path.join(profile, "tui.json"), { theme: "from-profile" })
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "from-global" })
      const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
      expect(cfg.theme).toBe("from-kilo")
      expect(cfg.theme).not.toBe("from-profile")
    }),
  ),
)

it.instance("TUI KILO_CONFIG_DIR does not win setting collision against .kilocode (ignored)", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const profile = path.join(test.directory, "profile-dir")
      yield* fs.makeDirectory(profile, { recursive: true })
      yield* fs.writeWithDirs(path.join(test.directory, ".kilocode", "tui.json"), JSON.stringify({ theme: "from-kilocode" }, null, 2))
      yield* fs.writeJson(path.join(profile, "tui.json"), { theme: "from-profile" })
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "from-global" })
      const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
      expect(cfg.theme).toBe("from-global")
      expect(cfg.theme).not.toBe("from-kilocode")
      expect(cfg.theme).not.toBe("from-profile")
    }),
  ),
)

it.instance("TUI KILO_CONFIG_DIR does not win plugin duplicate against .kilo", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const profile = path.join(test.directory, "profile-dir")
      yield* fs.makeDirectory(profile, { recursive: true })
      yield* fs.writeWithDirs(
        path.join(test.directory, ".kilo", "tui.json"),
        JSON.stringify({ plugin: [["shared-plugin@1.0.0", { source: "kilo" }], "kilo-only@1.0.0"] }, null, 2),
      )
      yield* fs.writeJson(path.join(profile, "tui.json"), {
        plugin: [["shared-plugin@2.0.0", { source: "profile" }], "profile-only@1.0.0"],
      })
      yield* Effect.promise(() => markPluginDependenciesReady(path.join(test.directory, ".kilo")))
      const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
      const specs = (cfg.plugin ?? []).map((s) => (Array.isArray(s) ? s[0] : s) as string)
      expect(specs).toContain("shared-plugin@1.0.0")
      expect(specs).not.toContain("shared-plugin@2.0.0")
      expect(specs).not.toContain("profile-only@1.0.0")
      expect(specs).toContain("kilo-only@1.0.0")
      yield* Effect.promise(() => TuiConfig.waitForDependencies().catch(() => undefined))
    }),
  ),
)

it.instance("TUI KILO_CONFIG_DIR does not win plugin duplicate against .kilocode (ignored)", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const profile = path.join(test.directory, "profile-dir")
      yield* fs.makeDirectory(profile, { recursive: true })
      yield* fs.writeWithDirs(
        path.join(test.directory, ".kilocode", "tui.json"),
        JSON.stringify({ plugin: [["shared-plugin@1.0.0", { source: "kilocode" }], "kilocode-only@1.0.0"] }, null, 2),
      )
      yield* fs.writeJson(path.join(profile, "tui.json"), {
        plugin: [["shared-plugin@2.0.0", { source: "profile" }], "profile-only@1.0.0"],
      })
      const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
      expect(cfg.plugin ?? []).toEqual([])
    }),
  ),
)
