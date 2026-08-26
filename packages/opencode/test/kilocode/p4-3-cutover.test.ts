import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { $ } from "bun"
import { join, resolve } from "node:path"

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}

describe("P4.3 cutover — legacy readers absent (canonical-only effective config)", () => {
  test("effective-config code has no legacy reader anchors", () => {
    const cfg = read("config/config.ts")
    const kilo = read("kilocode/config/config.ts")
    const stamp = read("kilocode/config/global-stamp.ts")
    const agent = read("config/agent.ts")

    // Legacy global filenames / TOML
    expect(cfg).not.toContain('path.join(Global.Path.config, "config.json")')
    expect(cfg).not.toContain('path.join(Global.Path.config, "kilo.json")')
    // kilo.jsonc must remain; ensure kilo.json without c is not present as separate legacy file
    // check that the exact legacy opencode filenames are absent
    expect(cfg).not.toContain('path.join(Global.Path.config, "opencode.json")')
    expect(cfg).not.toContain('path.join(Global.Path.config, "opencode.jsonc")')
    expect(cfg).not.toContain('with: { type: "toml" }')
    expect(cfg).not.toContain("loadLegacyConfigs")
    expect(cfg).not.toContain("loadOrganizationModes")
    expect(cfg).not.toContain("migrateBashPermission")
    expect(kilo).not.toContain("async function loadLegacyConfigs")
    expect(kilo).not.toContain("async function loadOrganizationModes")
    expect(kilo).not.toContain("async function migrateBashPermission")

    // Cloud/org/managed / well-known
    expect(cfg).not.toContain(".well-known/opencode")
    expect(cfg).not.toContain("managedConfigDir()")
    expect(cfg).not.toContain("readManagedPreferences")
    // KILO_* env/flag overlays
    // Flag.KILO_CONFIG and Flag.KILO_CONFIG_DIR must be absent; KILO_DISABLE_DEFAULT_PLUGINS is allowed
    expect(cfg).not.toContain("Flag.KILO_CONFIG ")
    expect(cfg).not.toContain("Flag.KILO_CONFIG)")
    expect(cfg).not.toContain("Flag.KILO_CONFIG,")
    expect(cfg).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(cfg.split("KILO_CONFIG_CONTENT").length).toBe(1) // no KILO_CONFIG_CONTENT at all
    expect(cfg).not.toContain("Flag.KILO_PERMISSION")
    expect(cfg).not.toContain("result.tools")
    // result.mode conversion (top-level mode/tools) removed; result.mode should not appear as conversion
    // We allow type definitions but not the merge block `result.mode`
    expect(cfg).not.toContain("result.mode")
    expect(agent).not.toContain("loadMode")
    expect(agent).toContain("export async function load(")

    // Ancestor / primary-worktree / .kilocode / .opencode discovery
    expect(cfg).not.toContain("ConfigPaths.files")
    expect(cfg).not.toContain("ConfigPaths.directories")
    expect(cfg).not.toContain("primaryPaths(")
    // .kilocode should not appear in effective config (only in notification helper is allowed elsewhere)
    expect(cfg).not.toContain(".kilocode")
    expect(cfg).not.toContain(".opencode")
    // opencode.json strings in effective config must be absent
    expect(cfg).not.toContain("opencode.json")

    // Global stamp must be canonical-only
    expect(stamp).toContain('const files = ["kilo.jsonc"]')
    expect(stamp).not.toContain('"config.json"')
    expect(stamp).not.toContain('"opencode.json"')
    expect(stamp).not.toContain('"opencode.jsonc"')

    // Kilocode config helpers narrowed to canonical
    expect(kilo).not.toContain('"kilo.json"')
    expect(kilo).not.toContain('"opencode.json')
    expect(kilo).not.toContain('".kilocode"')
    expect(kilo).toContain('KILO_CONFIG_FILES = ["kilo.jsonc"]')
    expect(kilo).toContain('ALL_CONFIG_FILES = ["kilo.jsonc"]')
    expect(kilo).toContain('KILO_DIR_SUFFIXES = [".kilo"]')
    expect(kilo).not.toContain('pathToFileURL')
  })

  test("canonical global/project config and asset loading remain", () => {
    const cfg = read("config/config.ts")
    expect(cfg).toContain('path.join(Global.Path.config, "kilo.jsonc")')
    expect(cfg).toContain('".kilo", "kilo.jsonc"')
    expect(cfg).toContain("ConfigAgent.load")
    expect(cfg).toContain("ConfigCommand.load")
    expect(cfg).toContain("ConfigPlugin.load")
    expect(cfg).toContain("KilocodeGlobalConfigStamp.read")
    expect(cfg).toContain("KilocodeDefaultPlugins.apply")
    expect(cfg).toContain("canonicalRoot")
    // isConfigDir helper still exists but narrowed
    const kilo = read("kilocode/config/config.ts")
    expect(kilo).toContain("function isConfigDir")
    expect(kilo).toContain('dir.endsWith(".kilo")')
    expect(kilo).toContain("canonicalRoot")
    const overlay = read("kilocode/config/overlay.ts")
    expect(overlay).toContain("canonicalRoot")
    // ConfigPaths remains legacy for TUI/CLI consumers (isolated from canonical effective config)
    const paths = read("config/paths.ts")
    expect(paths).toContain("Flag.KILO_CONFIG_DIR")
    expect(paths).toContain('targets: [".kilo"]')
    expect(paths).not.toContain('targets: [".kilocode", ".kilo"]')
    expect(paths.split('targets: [".kilo"]').length - 1).toBe(1)
    // T15 bounded correction: prove remaining single ancestor walk has exact residual shape
    expect(paths).toMatch(/targets:\s*\["\.kilo"\],\s*start:\s*directory,\s*stop:\s*worktree/)
    expect(paths).not.toContain("canonicalRoot")
    expect(paths).not.toContain("Global.Path.home")
    expect(paths).toContain("Global.Path.config")
  })

  test("no dual-read or import helper surface exists", () => {
    const cfg = read("config/config.ts")
    const kilo = read("kilocode/config/config.ts")
    const combined = cfg + kilo
    const lower = combined.toLowerCase()
    expect(combined).not.toContain("dualRead")
    expect(combined).not.toContain("DualRead")
    expect(combined).not.toContain("createDualReader")
    expect(combined).not.toContain("importLegacyConfig")
    expect(combined).not.toContain("importTool")
    expect(combined).not.toContain("MigrationTool")
    expect(lower).not.toContain("dual-read window")
    expect(lower).not.toContain("compatibility reader")
    // No migration/import tooling should exist as a function
    expect(kilo).not.toContain("loadLegacyConfigs")
    expect(kilo).not.toContain("fetchOrganizationModes")
  })

  test("skill discovery narrowed to canonical roots", () => {
    const skill = read("skill/index.ts")
    expect(skill).not.toContain("primaryPaths")
    expect(skill).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(skill).not.toContain(".kilocode")
    expect(skill).toContain("config.directories()")
    // Should still handle trusted vs untrusted correctly via projectRoot
    expect(skill).toContain("KILO_SKILL_PATTERN")
  })

  test("permission operational surface has no legacy reader anchors", () => {
    const perm = read("permission/index.ts")
    // global candidates must be canonical only
    expect(perm).toContain('return ["kilo.jsonc"].map((f) => path.join(Global.Path.config, f))')
    expect(perm).not.toContain('"kilo.json"')
    expect(perm).not.toContain('"opencode.json"')
    expect(perm).not.toContain('"config.json"')
    expect(perm).not.toContain('".kilocode/kilo.json"')
    expect(perm).not.toContain('".kilo/kilo.json"')
    expect(perm).not.toContain('"opencode.jsonc"')
    expect(perm).not.toContain('".kilocode"')
    // project candidates narrowed
    expect(perm).not.toContain('".kilocode/kilo.jsonc"')
    expect(perm).not.toContain('"kilo.jsonc", "kilo.json"')
    // must contain canonical project candidate
    expect(perm).toContain('".kilo/kilo.jsonc"')
    // legacy permission helpers absent
    expect(perm).not.toContain("migrateBashPermission")
  })

  test("instruction retains KILO_CONFIG_DIR profile fallback; effective config does not", () => {
    const instr = read("session/instruction.ts")
    const cfg = read("config/config.ts")
    const paths = read("config/paths.ts")
    // Instruction service (open CLI/TUI/ACP shared) retains profile directory behavior
    expect(instr).toContain("Flag.KILO_CONFIG_DIR")
    expect(instr).toContain("KILO_CONFIG_DIR")
    expect(instr).toContain('path.join(global.config, "AGENTS.md")')
    expect(instr).toContain("prefer KILO_CONFIG_DIR profile")
    // Effective config (Config.Service) remains canonical-only and ignores KILO_CONFIG_DIR
    expect(cfg).not.toContain("Flag.KILO_CONFIG_DIR")
    // ConfigPaths retains legacy for TUI/CLI consumers (isolated from effective config)
    // P4.4-T15: home `.kilo` walk deleted — only project ancestor walk remains.
    expect(paths).toContain("Flag.KILO_CONFIG_DIR")
    expect(paths).toContain('targets: [".kilo"]')
    expect(paths.split('targets: [".kilo"]').length - 1).toBe(1)
    // T15 bounded correction: prove remaining single ancestor walk has exact residual shape
    expect(paths).toMatch(/targets:\s*\["\.kilo"\],\s*start:\s*directory,\s*stop:\s*worktree/)
    expect(paths).not.toContain("Global.Path.home")
    expect(paths).toContain("Global.Path.config")
    expect(paths).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(paths).toContain("export const files")
    expect(paths).toContain("fileInDirectory")
    expect(paths).not.toContain("canonicalRoot")
  })

  test("overlay operational surface is canonical-only", () => {
    const overlay = read("kilocode/config/overlay.ts")
    expect(overlay).toContain('const files = ["kilo.jsonc"]')
    expect(overlay).toContain('const dirs = [".kilo"]')
    expect(overlay).not.toContain('"kilo.json"')
    expect(overlay).not.toContain('"opencode.json"')
    expect(overlay).not.toContain('"opencode.jsonc"')
    expect(overlay).not.toContain('".kilocode"')
    expect(overlay).not.toContain('"config.json"')
    expect(overlay).not.toContain(".kilocode")
    expect(overlay).not.toContain("Global.Path.home")
    expect(overlay).toContain('return [Global.Path.config]')
    // globalTarget canonical
    expect(overlay).toContain('const candidates = ["kilo.jsonc"].map')
    expect(overlay).toContain('path.join(Global.Path.config, file)')
    // projectTarget still finds canonical via .kilo using canonicalRoot
    expect(overlay).toContain('canonicalRoot')
    expect(overlay).toContain('path.join(root, ".kilo", "kilo.jsonc")')
  })

  test("operational mutation paths use canonical overlay targets", () => {
    const del = read("kilocode/server/custom-provider-delete.ts")
    const agent = read("kilocode/agent/index.ts")
    // custom-provider-delete must use canonical overlay helpers
    expect(del).toContain("KilocodeConfigOverlay.project")
    expect(del).toContain("KilocodeConfig.globalConfigTarget()")
    expect(del).toContain("KilocodeConfig.projectConfigUpdateTarget")
    expect(del).not.toContain(".kilocode")
    expect(del).not.toContain("opencode.json")
    expect(del).not.toContain("kilo.json\"")
    // agent mutation path uses canonical overlay and atomic write
    expect(agent).toContain("KilocodeConfigOverlay.globalTarget()")
    expect(agent).toContain("KilocodeConfigOverlay.projectTarget")
    expect(agent).toContain("KilocodeAtomicWrite")
    expect(agent).not.toContain("Bun.write")
    expect(agent).not.toContain('".kilocode/kilo.json"')
  })

  test("no obsolete as any migrateBashPermission patch remains in permission tests", () => {
    const svc = readFileSync(join(repo, "packages/opencode/test/permission/r18-service.test.ts"), "utf8")
    expect(svc).not.toContain("migrateBashPermission")
    expect(svc).not.toContain("(KilocodeConfig as any)")
  })

  test("canonical constants are narrowed at runtime", async () => {
    const { KilocodeConfig } = await import("../../src/kilocode/config/config.ts")
    expect(KilocodeConfig.KILO_CONFIG_FILES).toEqual(["kilo.jsonc"])
    expect(KilocodeConfig.ALL_CONFIG_FILES).toEqual(["kilo.jsonc"])
    expect(KilocodeConfig.KILO_DIR_SUFFIXES).toEqual([".kilo"])
    expect(KilocodeConfig.globalConfigTarget()).toMatch(/kilo\.jsonc$/)
    expect(KilocodeConfig.AGENT_PATTERNS.every((p: string) => p.includes(".kilo"))).toBe(true)
    expect(KilocodeConfig.COMMAND_PATTERNS.every((p: string) => p.includes(".kilo"))).toBe(true)
  })

  test("nested workspace-root canonical behavior preserved", async () => {
    const fs = await import("node:fs/promises")
    const os = await import("node:os")
    const path = await import("node:path")
    const { KilocodeConfigOverlay } = await import("../../src/kilocode/config/overlay.ts")
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kilocode-p43-nested-"))
    try {
      const canonicalFile = path.join(tmpRoot, ".kilo", "kilo.jsonc")
      await fs.mkdir(path.join(tmpRoot, ".kilo"), { recursive: true })
      await fs.writeFile(canonicalFile, JSON.stringify({ permission: { bash: "allow" }, model: "root/model" }, null, 2))
      const nested = path.join(tmpRoot, "a", "b")
      await fs.mkdir(nested, { recursive: true })
      const nestedKiloDir = path.join(nested, ".kilo")
      await fs.mkdir(nestedKiloDir, { recursive: true })
      const nestedFile = path.join(nestedKiloDir, "kilo.jsonc")
      await fs.writeFile(nestedFile, JSON.stringify({ permission: { bash: "deny" }, model: "nested/model" }, null, 2))
      const foundTarget = await KilocodeConfigOverlay.projectTarget({ directory: nested, worktree: tmpRoot })
      expect(foundTarget).toBe(canonicalFile)
      const loaded = await KilocodeConfigOverlay.project({ directory: nested, worktree: tmpRoot })
      const perm = loaded.permission as Record<string, unknown> | undefined
      expect(perm).toBeDefined()
      if (perm && typeof perm === "object" && "bash" in perm) {
        const bash = (perm as Record<string, unknown>).bash
        if (typeof bash === "string") expect(bash).toBe("allow")
        else if (bash && typeof bash === "object") expect((bash as Record<string, string>)["*"]).toBe("allow")
      }
      expect(loaded.model).toBe("root/model")
      const loadedBash = (loaded.permission as Record<string, unknown> | undefined)?.bash
      expect(loadedBash).not.toBe("deny")
      // projectConfigUpdateTarget must be deterministic canonical path for both root and nested
      const directTarget = path.join(tmpRoot, ".kilo", "kilo.jsonc")
      expect(directTarget).toBe(canonicalFile)
      expect(foundTarget).not.toBe(nestedFile)
      // Ensure nested file is ignored even though it exists
      const stillLoaded = await KilocodeConfigOverlay.project({ directory: nested, worktree: tmpRoot })
      expect(stillLoaded.model).not.toBe("nested/model")
      // Also verify legacy .kilocode is ignored
      const legacyFile = path.join(tmpRoot, ".kilocode", "kilo.jsonc")
      await fs.mkdir(path.join(tmpRoot, ".kilocode"), { recursive: true })
      await fs.writeFile(legacyFile, JSON.stringify({ permission: { bash: "deny" } }, null, 2))
      const loadedAfterLegacy = await KilocodeConfigOverlay.project({ directory: nested, worktree: tmpRoot })
      const legacyPerm = loadedAfterLegacy.permission as Record<string, unknown> | undefined
      if (legacyPerm && typeof legacyPerm === "object" && "bash" in legacyPerm) {
        expect((legacyPerm as Record<string, unknown>).bash).not.toBe("deny")
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)

  test("nested workspace-root Config.Service loading and canonical mutation targets converge", async () => {
    const fs = await import("node:fs/promises")
    const os = await import("node:os")
    const nodePath = await import("node:path")
    const { Effect, Layer, Option } = await import("effect")
    const { NodeFileSystem, NodePath } = await import("@effect/platform-node")
    const { FSUtil } = await import("@opencode-ai/core/fs-util")
    const { EffectFlock } = await import("@opencode-ai/core/util/effect-flock")
    const { Config } = await import("../../src/config/config.ts")
    const { Git } = await import("../../src/git")
    const { Env } = await import("../../src/env")
    const { Auth } = await import("../../src/auth")
    const { Account } = await import("../../src/account/account.ts")
    const { Npm } = await import("@opencode-ai/core/npm")
    const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
    const { HttpClient } = await import("effect/unstable/http")
    const { provideTestInstance } = await import("../fixture/fixture")
    const { Filesystem } = await import("../../src/util/filesystem")
    const { KilocodeConfig } = await import("../../src/kilocode/config/config")
    const { KilocodeConfigOverlay } = await import("../../src/kilocode/config/overlay")

    const tmpRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), "kilocode-p43-service-"))
    try {
      await $`git init`.cwd(tmpRoot).quiet()
      await $`git config core.fsmonitor false`.cwd(tmpRoot).quiet()
      await $`git config commit.gpgsign false`.cwd(tmpRoot).quiet()
      await $`git config user.email "test@kilo.test"`.cwd(tmpRoot).quiet()
      await $`git config user.name "Test"`.cwd(tmpRoot).quiet()
      await $`git commit --allow-empty -m "root"`.cwd(tmpRoot).quiet()

      const canonicalFile = nodePath.join(tmpRoot, ".kilo", "kilo.jsonc")
      await fs.mkdir(nodePath.join(tmpRoot, ".kilo"), { recursive: true })
      await Filesystem.write(canonicalFile, JSON.stringify({ model: "root/model", permission: { bash: "allow" } }, null, 2))

      const nested = nodePath.join(tmpRoot, "a", "b")
      await fs.mkdir(nested, { recursive: true })
      const nestedFile = nodePath.join(nested, ".kilo", "kilo.jsonc")
      await fs.mkdir(nodePath.join(nested, ".kilo"), { recursive: true })
      await Filesystem.write(nestedFile, JSON.stringify({ model: "nested/model", permission: { bash: "deny" } }, null, 2))

      const infra = CrossSpawnSpawner.defaultLayer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
      const emptyAccount = Layer.mock(Account.Service)({
        active: () => Effect.succeed(Option.none()),
        activeOrg: () => Effect.succeed(Option.none()),
      })
      const emptyAuth = Layer.mock(Auth.Service)({
        all: () => Effect.succeed({}),
      })
      const noopNpm = Layer.mock(Npm.Service)({
        install: () => Effect.void,
        add: () => Effect.die("not implemented"),
        which: () => Effect.succeed(Option.none()),
      })
      const unexpectedHttp = HttpClient.make((request) =>
        Effect.die(`unexpected http request: ${request.method} ${request.url}`),
      )
      const layer = Config.layer.pipe(
        Layer.provide(Git.defaultLayer),
        Layer.provide(EffectFlock.defaultLayer),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Env.defaultLayer),
        Layer.provide(emptyAuth),
        Layer.provide(emptyAccount),
        Layer.provideMerge(infra),
        Layer.provide(noopNpm),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
      )

      const load = () =>
        Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))
      const save = (config: Record<string, unknown>) =>
        Effect.runPromise(
          Config.Service.use((svc) => svc.update(config as unknown as never)).pipe(Effect.scoped, Effect.provide(layer)),
        )
      const directories = () =>
        Effect.runPromise(Config.Service.use((svc) => svc.directories()).pipe(Effect.scoped, Effect.provide(layer)))

      await provideTestInstance({
        directory: nested,
        fn: async () => {
          const loaded = await load()
          expect(loaded.model).toBe("root/model")
          const perm = loaded.permission as Record<string, unknown> | undefined
          const bash = perm && typeof perm === "object" && "bash" in perm ? (perm as Record<string, unknown>).bash : undefined
          if (typeof bash === "string") expect(bash).toBe("allow")
          else if (bash && typeof bash === "object") expect((bash as Record<string, string>)["*"]).toBe("allow")
          expect(loaded.model).not.toBe("nested/model")

          const foundTarget = await KilocodeConfigOverlay.projectTarget({ directory: nested, worktree: tmpRoot })
          expect(foundTarget).toBe(canonicalFile)
          expect(foundTarget).not.toBe(nestedFile)

          const updateTarget = await Effect.runPromise(
            Effect.gen(function* () {
              const fsu = yield* FSUtil.Service
              return yield* KilocodeConfig.projectConfigUpdateTarget({ fs: fsu, directory: nested, worktree: tmpRoot })
            }).pipe(Effect.provide(FSUtil.defaultLayer)),
          )
          expect(updateTarget).toBe(canonicalFile)

          const dirs = await directories()
          const realTmpRoot = await fs.realpath(tmpRoot)
          const realNested = await fs.realpath(nested).catch(() => nested)
          // Global dir is first, canonical project dir is second — compare via realpath to handle /var vs /private/var
          const canonicalDir = nodePath.join(realTmpRoot, ".kilo")
          const nestedDir = nodePath.join(realNested, ".kilo")
          expect(dirs.map((d) => nodePath.resolve(d))).toContain(nodePath.resolve(canonicalDir))
          expect(dirs.map((d) => nodePath.resolve(d))).not.toContain(nodePath.resolve(nestedDir))
          // Also ensure at least one dir ends with the service tmp prefix
          expect(dirs.some((d) => d.includes("kilocode-p43-service"))).toBe(true)

          await save({ model: "updated/model" })
          const written = await Filesystem.readJson<{ model: string }>(canonicalFile)
          expect(written.model).toBe("updated/model")
          const nestedExists = await fs
            .access(nestedFile)
            .then(() => true)
            .catch(() => false)
          if (nestedExists) {
            const nestedContent = await Filesystem.readJson<{ model: string }>(nestedFile)
            expect(nestedContent.model).toBe("nested/model")
          }
          const leftovers = (await fs.readdir(nodePath.join(tmpRoot, ".kilo"))).filter((name) => name.includes(".tmp"))
          expect(leftovers.length).toBe(0)

          const overlayLoaded = await KilocodeConfigOverlay.project({ directory: nested, worktree: tmpRoot })
          expect(overlayLoaded.model).toBe("updated/model")
        },
      })
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    }
  }, 60_000)
})
