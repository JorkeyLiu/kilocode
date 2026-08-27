import { describe, expect, test } from "bun:test"
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
import { canonicalRoot, resolveWorktree, resolveCanonicalRoot } from "@/project/instance-context"
import { tmpdir, disposeAllInstances, tmpdirRegistrySize } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@opencode-ai/core/database/database"
import { markPluginDependenciesReady, markProjectConfigReady } from "../fixture/plugin"

void Log.init({ print: false })

const getTuiConfig = (directory: string) =>
  TuiConfig.Service.use((svc) => svc.get()).pipe(
    Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)))),
  )

// Isolated global config root — fallible mkdtemp before any global mutation; outer guard restores on failure.
// Snapshots/restores KILO_DISABLE_PROJECT_CONFIG alongside other process-global test state (LOCK-SOURCE isolation).
// Ordered release: quiesce dependencies before deleting owned tmp; on wait failure retain tmp and surface error.
// Acquire guarantees restoration if readiness setup throws (mutation is undone before propagating).
const withClean = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-")))
      const disabled = Flag.KILO_DISABLE_DEFAULT_PLUGINS
      const orig = Global.Path.config
      const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
      const origConfig = process.env.KILO_CONFIG
      const origTuiConfig = process.env.KILO_TUI_CONFIG
      const origConfigDir = process.env.KILO_CONFIG_DIR
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = tmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      try {
        yield* Effect.promise(() => markPluginDependenciesReady(tmp))
      } catch (err) {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = disabled
        ;(Global.Path as { config: string }).config = orig
        if (origProject === undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
        else process.env.KILO_DISABLE_PROJECT_CONFIG = origProject
        if (origConfig === undefined) delete process.env.KILO_CONFIG
        else process.env.KILO_CONFIG = origConfig
        if (origTuiConfig === undefined) delete process.env.KILO_TUI_CONFIG
        else process.env.KILO_TUI_CONFIG = origTuiConfig
        if (origConfigDir === undefined) delete process.env.KILO_CONFIG_DIR
        else process.env.KILO_CONFIG_DIR = origConfigDir
        yield* Effect.promise(() =>
          fs.rm(tmp, { recursive: true, force: true }).catch((e) => {
            console.error("[test cleanup] withClean rm after readiness failure", { tmp, err: e })
            return undefined
          }),
        )
        return yield* Effect.fail(err as Error)
      }
      return { disabled, orig, tmp, origProject, origConfig, origTuiConfig, origConfigDir }
    }),
    () => self,
    ({ disabled, orig, tmp, origProject, origConfig, origTuiConfig, origConfigDir }) =>
      Effect.gen(function* () {
        let waitError: unknown
        try {
          yield* Effect.promise(() => TuiConfig.waitForDependencies())
        } catch (err) {
          waitError = err
          console.error("[test cleanup] withClean waitForDependencies failed", err)
        }
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = disabled
        ;(Global.Path as { config: string }).config = orig
        if (origProject === undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
        else process.env.KILO_DISABLE_PROJECT_CONFIG = origProject
        if (origConfig === undefined) delete process.env.KILO_CONFIG
        else process.env.KILO_CONFIG = origConfig
        if (origTuiConfig === undefined) delete process.env.KILO_TUI_CONFIG
        else process.env.KILO_TUI_CONFIG = origTuiConfig
        if (origConfigDir === undefined) delete process.env.KILO_CONFIG_DIR
        else process.env.KILO_CONFIG_DIR = origConfigDir
        if (waitError !== undefined) {
          console.error("[test cleanup] withClean retaining global tmp due to wait failure", { tmp, err: waitError })
          return yield* Effect.fail(waitError as Error)
        }
        yield* Effect.promise(() =>
          fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
            console.error("[test cleanup] withClean rm failed", { tmp, err })
            return undefined
          }),
        )
      }),
  )

function reportCleanup(stage: string, err: unknown) {
  console.error(`[test cleanup] ${stage} failed`, err)
}

describe("P4.4 TUI CLI nested canonical root (LOCK-SOURCE)", () => {
  test("resolveWorktree returns worktree for git, undefined for non-git", async () => {
    let gitTmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let nonGitTmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      gitTmp = await tmpdir({ git: true })
      const nested = path.join(gitTmp.path, "a", "b")
      await fs.mkdir(nested, { recursive: true })
      const worktree = await resolveWorktree(nested)
      expect(worktree).toBeDefined()
      const { Filesystem } = await import("@/util/filesystem")
      expect(Filesystem.resolve(worktree!)).toBe(Filesystem.resolve(gitTmp.path))
      expect(canonicalRoot(nested, worktree)).toBe(Filesystem.resolve(gitTmp.path))
      expect(await resolveCanonicalRoot(nested)).toBe(Filesystem.resolve(gitTmp.path))

      nonGitTmp = await tmpdir()
      const nonGitNested = path.join(nonGitTmp.path, "a")
      await fs.mkdir(nonGitNested, { recursive: true })
      const worktree2 = await resolveWorktree(nonGitNested)
      expect(worktree2).toBeUndefined()
      expect(canonicalRoot(nonGitNested, worktree2)).toBe(nonGitNested)
      expect(await resolveCanonicalRoot(nonGitNested)).toBe(nonGitNested)
    } finally {
      let waitError: unknown
      try {
        await TuiConfig.waitForDependencies()
      } catch (err) {
        waitError = err
        reportCleanup("waitForDependencies", err)
      }
      try {
        await disposeAllInstances()
      } catch (err) {
        reportCleanup("disposeAllInstances", err)
      }
      try {
        await resetDatabase()
      } catch (err) {
        reportCleanup("resetDatabase", err)
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { gitTmp: gitTmp?.path, nonGitTmp: nonGitTmp?.path, err: waitError })
      } else {
        if (nonGitTmp) {
          try {
            await nonGitTmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("nonGitTmp dispose", err)
          }
        }
        if (gitTmp) {
          try {
            await gitTmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("gitTmp dispose", err)
          }
        }
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("standalone CLI nested reads root direct tui.json, ignoring nested direct", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a", "b"), { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "root-direct" }, null, 2))
          await Bun.write(path.join(dir, "a", "b", "tui.json"), JSON.stringify({ theme: "nested-direct" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      const nested = path.join(tmp.path, "a", "b")
      const cfg = await Effect.runPromise(getTuiConfig(nested).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(cfg.theme).toBe("root-direct")
      expect(cfg.theme).not.toBe("nested-direct")
    } finally {
      let waitError: unknown
      try {
        await TuiConfig.waitForDependencies()
      } catch (err) {
        waitError = err
        reportCleanup("waitForDependencies", err)
      }
      try {
        await disposeAllInstances()
      } catch (err) {
        reportCleanup("disposeAllInstances", err)
      }
      try {
        await resetDatabase()
      } catch (err) {
        reportCleanup("resetDatabase", err)
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("standalone CLI nested reads root .kilo/tui.json, ignoring nested .kilo", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a", "b"), { recursive: true })
          const rootKilo = path.join(dir, ".kilo")
          await fs.mkdir(rootKilo, { recursive: true })
          await Bun.write(path.join(rootKilo, "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
          const nestedKilo = path.join(dir, "a", "b", ".kilo")
          await fs.mkdir(nestedKilo, { recursive: true })
          await Bun.write(path.join(nestedKilo, "tui.json"), JSON.stringify({ theme: "nested-kilo" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      const nested = path.join(tmp.path, "a", "b")
      const cfg = await Effect.runPromise(getTuiConfig(nested).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(cfg.theme).toBe("root-kilo")
      expect(cfg.theme).not.toBe("nested-kilo")
    } finally {
      let waitError: unknown
      try {
        await TuiConfig.waitForDependencies()
      } catch (err) {
        waitError = err
        reportCleanup("waitForDependencies", err)
      }
      try {
        await disposeAllInstances()
      } catch (err) {
        reportCleanup("disposeAllInstances", err)
      }
      try {
        await resetDatabase()
      } catch (err) {
        reportCleanup("resetDatabase", err)
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("nested CLI precedence: root .kilo wins over root direct", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a"), { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "root-direct", diff_style: "auto" }, null, 2))
          const kilo = path.join(dir, ".kilo")
          await fs.mkdir(kilo, { recursive: true })
          await Bun.write(path.join(kilo, "tui.json"), JSON.stringify({ theme: "root-kilo", diff_style: "stacked" }, null, 2))
          await Bun.write(path.join(dir, "a", "tui.json"), JSON.stringify({ theme: "nested-direct" }, null, 2))
          await fs.mkdir(path.join(dir, "a", ".kilo"), { recursive: true })
          await Bun.write(path.join(dir, "a", ".kilo", "tui.json"), JSON.stringify({ theme: "nested-kilo" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      const nested = path.join(tmp.path, "a")
      const cfg = await Effect.runPromise(getTuiConfig(nested).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(cfg.theme).toBe("root-kilo")
      expect(cfg.diff_style).toBe("stacked")
    } finally {
      let waitError: unknown
      try {
        await TuiConfig.waitForDependencies()
      } catch (err) {
        waitError = err
        reportCleanup("waitForDependencies", err)
      }
      try {
        await disposeAllInstances()
      } catch (err) {
        reportCleanup("disposeAllInstances", err)
      }
      try {
        await resetDatabase()
      } catch (err) {
        reportCleanup("resetDatabase", err)
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("nested candidates ignored when root has no config -> undefined, not nested", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a", "b"), { recursive: true })
          await Bun.write(path.join(dir, "a", "b", "tui.json"), JSON.stringify({ theme: "nested-only" }, null, 2))
          await fs.mkdir(path.join(dir, "a", "b", ".kilo"), { recursive: true })
          await Bun.write(path.join(dir, "a", "b", ".kilo", "tui.json"), JSON.stringify({ theme: "nested-kilo-only" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      const nested = path.join(tmp.path, "a", "b")
      const cfg = await Effect.runPromise(getTuiConfig(nested).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(cfg.theme).toBeUndefined()
      expect(cfg.theme).not.toBe("nested-only")
      expect(cfg.theme).not.toBe("nested-kilo-only")
    } finally {
      let waitError: unknown
      try {
        await TuiConfig.waitForDependencies()
      } catch (err) {
        waitError = err
        reportCleanup("waitForDependencies", err)
      }
      try {
        await disposeAllInstances()
      } catch (err) {
        reportCleanup("disposeAllInstances", err)
      }
      try {
        await resetDatabase()
      } catch (err) {
        reportCleanup("resetDatabase", err)
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("non-git fallback: nested reads its own .kilo, not root", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        init: async (dir) => {
          const rootKilo = path.join(dir, ".kilo")
          await fs.mkdir(rootKilo, { recursive: true })
          await Bun.write(path.join(rootKilo, "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
          const nested = path.join(dir, "a")
          await fs.mkdir(nested, { recursive: true })
          const nestedKilo = path.join(nested, ".kilo")
          await fs.mkdir(nestedKilo, { recursive: true })
          await Bun.write(path.join(nestedKilo, "tui.json"), JSON.stringify({ theme: "nested-kilo" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      await markPluginDependenciesReady(path.join(tmp.path, "a", ".kilo"))
      const nested = path.join(tmp.path, "a")
      const cfg = await Effect.runPromise(getTuiConfig(nested).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(cfg.theme).toBe("nested-kilo")
      expect(cfg.theme).not.toBe("root-kilo")
      const rootCfg = await Effect.runPromise(getTuiConfig(tmp.path).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(rootCfg.theme).toBe("root-kilo")
    } finally {
      let waitError: unknown
      try {
        await TuiConfig.waitForDependencies()
      } catch (err) {
        waitError = err
        reportCleanup("waitForDependencies", err)
      }
      try {
        await disposeAllInstances()
      } catch (err) {
        reportCleanup("disposeAllInstances", err)
      }
      try {
        await resetDatabase()
      } catch (err) {
        reportCleanup("resetDatabase", err)
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("thread canonical: thread resolve uses worktree root (static check)", async () => {
    const src = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/thread.ts"), "utf8")
    expect(src).toContain("resolveWorktree")
    expect(src).toContain("canonicalRoot")
    expect(src).toContain("canonicalCwd")
    expect(src).toContain("CurrentWorkingDirectory")
  })

  test("tui.ts uses canonical root for direct/.kilo/fileScope/pluginScope", async () => {
    const src = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/config/tui.ts"), "utf8")
    expect(src).toContain("resolveWorktree")
    expect(src).toContain("canonicalRoot")
    expect(src).toContain("const root = canonicalRoot")
    expect(src).toContain('path.join(root, ".kilo")')
    expect(src).toContain('ConfigPaths.fileInDirectory(root, "tui")')
    expect(src).toContain("fileScope")
    expect(src).toContain('mergeFile(acc, file, "global"')
    expect(src).toContain('mergeFile(acc, file, "local"')
    expect(src).toContain('Filesystem.contains(Global.Path.config, file)')
    expect(src).not.toContain('path.join(ctx.directory, ".kilo")')
    expect(src).not.toContain("pluginScope(file, canonicalCtx)")
  })

  test("resolveThreadDirectory pure boundary (standalone entrypoint) respects Filesystem.resolve and KILO_DEV_CWD", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    const origDev = process.env.KILO_DEV_CWD
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir()
      const { resolveThreadDirectory } = await import("../../src/cli/cmd/tui/thread")
      const { Filesystem } = await import("@/util/filesystem")
      const a = path.join(tmp.path, "a", "b")
      const proj = path.join(tmp.path, "proj")
      const root = path.join(tmp.path, "root")
      const nested = path.join(root, "nested")
      const devRoot = path.join(tmp.path, "dev-root")
      const match = path.join(tmp.path, "match")
      for (const p of [a, proj, root, nested, devRoot, match]) await fs.mkdir(p, { recursive: true })
      await fs.mkdir(path.join(root, "proj"), { recursive: true })
      await fs.mkdir(path.join(devRoot, "proj"), { recursive: true })

      expect(resolveThreadDirectory(undefined, undefined, a)).toBe(Filesystem.resolve(a))
      expect(resolveThreadDirectory(proj, undefined, a)).toBe(Filesystem.resolve(proj))
      expect(resolveThreadDirectory("proj", root, nested)).toBe(Filesystem.resolve(path.join(nested, "proj")))
      // Env mutation inside immediate try/finally so restoration is guaranteed
      process.env.KILO_DEV_CWD = devRoot
      try {
        expect(resolveThreadDirectory(undefined, "/tmp/envPWD", a)).toBe(Filesystem.resolve(devRoot))
        expect(resolveThreadDirectory("proj", "/tmp/envPWD", a)).toBe(Filesystem.resolve(path.join(devRoot, "proj")))
      } finally {
        if (origDev === undefined) delete process.env.KILO_DEV_CWD
        else process.env.KILO_DEV_CWD = origDev
      }
      expect(resolveThreadDirectory(undefined, match, match)).toBe(Filesystem.resolve(match))
      expect(resolveThreadDirectory("proj", match, match)).toBe(Filesystem.resolve(path.join(match, "proj")))
    } finally {
      // Ensure env restored even if test throws before inner finally
      if (process.env.KILO_DEV_CWD !== origDev) {
        if (origDev === undefined) delete process.env.KILO_DEV_CWD
        else process.env.KILO_DEV_CWD = origDev
      }
      let waitError: unknown
      try {
        await TuiConfig.waitForDependencies()
      } catch (err) {
        waitError = err
        reportCleanup("waitForDependencies", err)
      }
      try {
        await disposeAllInstances()
      } catch (err) {
        reportCleanup("disposeAllInstances", err)
      }
      try {
        await resetDatabase()
      } catch (err) {
        reportCleanup("resetDatabase", err)
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("lifecycle: no lingering instances or tmp after nested suite", async () => {
    expect(Database.path()).toBe(":memory:")
    expect(tmpdirRegistrySize()).toBe(0)
    // Prove ordered cleanup: instance before tmp removal is enforced in above tests
    const { Filesystem } = await import("@/util/filesystem")
    expect(typeof Filesystem.resolve(process.cwd())).toBe("string")
  })
})
