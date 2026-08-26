import { expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config } from "@/config/config"
import { CurrentWorkingDirectory } from "@/cli/cmd/tui/config/cwd"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Config.defaultLayer, FSUtil.defaultLayer))

const globalTuiFiles = ["tui.json", "tui.jsonc"].map((file) => path.join(Global.Path.config, file))

const cleanState = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  delete process.env.KILO_CONFIG_DIR
  delete process.env.KILO_TUI_CONFIG
  delete process.env.KILO_DISABLE_PROJECT_CONFIG
  yield* Effect.forEach(globalTuiFiles, (file) => fs.remove(file, { force: true }).pipe(Effect.ignore), {
    discard: true,
  })
})

const withCleanState = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const disabled = Flag.KILO_DISABLE_DEFAULT_PLUGINS
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      yield* cleanState
      return disabled
    }),
    () => self,
    (disabled) =>
      Effect.gen(function* () {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = disabled
        yield* cleanState
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

it.instance("TUI discovers deferred .kilocode/tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      yield* fs.writeWithDirs(path.join(test.directory, ".kilocode", "tui.json"), JSON.stringify({ theme: "workspace-kilocode" }, null, 2))
      const cfg = yield* getTuiConfig(test.directory)
      expect(cfg.theme).toBe("workspace-kilocode")
    }),
  ),
)

it.instance("TUI discovers .kilo ancestor via walk (nested cwd)", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const nested = path.join(test.directory, "a", "b")
      yield* fs.makeDirectory(nested, { recursive: true })
      yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "ancestor-kilo" }, null, 2))
      const cfg = yield* getTuiConfig(nested)
      expect(cfg.theme).toBe("ancestor-kilo")
    }),
  ),
)

it.instance("TUI discovers .kilocode ancestor via walk (nested cwd)", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const nested = path.join(test.directory, "a", "b")
      yield* fs.makeDirectory(nested, { recursive: true })
      yield* fs.writeWithDirs(path.join(test.directory, ".kilocode", "tui.json"), JSON.stringify({ theme: "ancestor-kilocode" }, null, 2))
      const cfg = yield* getTuiConfig(nested)
      expect(cfg.theme).toBe("ancestor-kilocode")
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

it.instance("TUI KILO_CONFIG_DIR profile loads tui.json", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      const profile = path.join(test.directory, "profile-dir")
      yield* fs.makeDirectory(profile, { recursive: true })
      yield* fs.writeJson(path.join(profile, "tui.json"), { theme: "profile-theme" })
      const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
      expect(cfg.theme).toBe("profile-theme")
    }),
  ),
)

it.instance("TUI project-disable excludes .kilo and .kilocode but retains global and KILO_CONFIG_DIR", () =>
  withCleanState(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const test = yield* TestInstance
      // project .kilo should be ignored when disabled
      yield* fs.writeWithDirs(path.join(test.directory, ".kilo", "tui.json"), JSON.stringify({ theme: "should-be-ignored" }, null, 2))
      yield* fs.writeWithDirs(path.join(test.directory, ".kilocode", "tui.json"), JSON.stringify({ theme: "should-be-ignored-2" }, null, 2))
      yield* fs.writeJson(path.join(Global.Path.config, "tui.json"), { theme: "global-kept" })

      const profile = path.join(test.directory, "profile-dir")
      yield* fs.makeDirectory(profile, { recursive: true })
      yield* fs.writeJson(path.join(profile, "tui.json"), { theme: "profile-kept" })

      // without disable, project wins
      const withoutDisable = yield* getTuiConfig(test.directory)
      expect(withoutDisable.theme).toBe("should-be-ignored")

      // with disable, project ignored, profile then global win (profile has higher precedence than global? check order: dirs loop after global, but projectFiles also? For this test we set both global and profile; profile should win over global because dirs includes KILO_CONFIG_DIR after global. Let's verify.)
      const withDisableAndProfile = yield* withEnv("KILO_DISABLE_PROJECT_CONFIG", "true", withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory)))
      // profile should be loaded when project disabled
      expect(withDisableAndProfile.theme).toBe("profile-kept")

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
      const enabled = yield* getTuiConfig(test.directory)
      expect(enabled.plugin).toEqual(["local-plugin@1.0.0"])

      const disabled = yield* withEnv("KILO_DISABLE_PROJECT_CONFIG", "true", getTuiConfig(test.directory))
      expect(disabled.plugin ?? []).toEqual([])
    }),
  ),
)

it.instance("TUI KILO_CONFIG_DIR wins setting collision against .kilo", () =>
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
      expect(cfg.theme).toBe("from-profile")
    }),
  ),
)

it.instance("TUI KILO_CONFIG_DIR wins setting collision against .kilocode", () =>
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
      expect(cfg.theme).toBe("from-profile")
    }),
  ),
)

it.instance("TUI KILO_CONFIG_DIR wins plugin duplicate against .kilo", () =>
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

      const cfg = yield* withEnv("KILO_CONFIG_DIR", profile, getTuiConfig(test.directory))
      const specs = (cfg.plugin ?? []).map((s) => (Array.isArray(s) ? s[0] : s) as string)
      expect(specs).toContain("shared-plugin@2.0.0")
      expect(specs).not.toContain("shared-plugin@1.0.0")
      expect(specs).toContain("kilo-only@1.0.0")
      expect(specs).toContain("profile-only@1.0.0")

      const origins = cfg.plugin_origins ?? []
      const shared = origins.find((o) => (Array.isArray(o.spec) ? o.spec[0] : o.spec) === "shared-plugin@2.0.0" || (typeof o.spec === "string" && o.spec.startsWith("shared-plugin@2")))
      expect(shared).toBeDefined()
      expect(shared?.source).toBe(path.join(profile, "tui.json"))
    }),
  ),
)

it.instance("TUI KILO_CONFIG_DIR wins plugin duplicate against .kilocode", () =>
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
      const specs = (cfg.plugin ?? []).map((s) => (Array.isArray(s) ? s[0] : s) as string)
      expect(specs).toContain("shared-plugin@2.0.0")
      expect(specs).not.toContain("shared-plugin@1.0.0")
      expect(specs).toContain("kilocode-only@1.0.0")
      expect(specs).toContain("profile-only@1.0.0")

      const origins = cfg.plugin_origins ?? []
      const shared = origins.find((o) => {
        const name = Array.isArray(o.spec) ? (o.spec[0] as string) : (o.spec as string)
        return name.startsWith("shared-plugin@2")
      })
      expect(shared?.source).toBe(path.join(profile, "tui.json"))
    }),
  ),
)
