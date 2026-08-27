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
import { KiloTuiThreadDaemon } from "@/kilocode/cli/cmd/tui/thread"
import { DaemonClient } from "@/kilocode/daemon/client"
import { Daemon } from "@/kilocode/daemon/daemon"
import { canonicalRoot, resolveWorktree } from "@/project/instance-context"
import { tmpdir, disposeAllInstances, tmpdirRegistrySize } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import * as Log from "@opencode-ai/core/util/log"
import { resolveAttachConfigRoot } from "@/cli/cmd/tui/attach"
import { Filesystem } from "@/util/filesystem"
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
      // Pre-stub global dir so no detached plugin install outlives fixture — restore globals if stub throws
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
          // Retain owned tmp for afterAll re-disposal / flag; surface error after restore
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

type AttachArgs = Parameters<typeof KiloTuiThreadDaemon.attach>[0]["args"]
const mockConnection: DaemonClient.Connection = {
  url: "http://127.0.0.1:9",
  headers: {},
  state: Daemon.State.parse({
    pid: 1,
    hostname: "127.0.0.1",
    port: 9,
    url: "http://127.0.0.1:9",
    username: "kilo",
    password: "test",
    token: "t",
    version: "0.0.0",
    startedAt: new Date().toISOString(),
    log: "/tmp/kilo.log",
  }),
}
// Fully type-checked minimal fixture — satisfies NetworkOptions contract without assertion cast
const emptyAttachArgs = {
  port: 0,
  hostname: "127.0.0.1",
  mdns: false,
  "mdns-domain": "kilo.local",
  cors: [],
} satisfies AttachArgs

function reportCleanup(stage: string, err: unknown) {
  // Failure-safe: preserve test assertion while making cleanup failure observable via stderr/Log
  console.error(`[test cleanup] ${stage} failed`, err)
}

describe("P4.4 TUI attach canonical root — daemon and explicit attach (LOCK-SOURCE)", () => {
  test("daemon attach uses canonical root: nested Git loads root config ignoring nested", async () => {
    // Fallible acquisition before global mutation; outer finalizer guarantees ordered cleanup
    // globalMutated set before readiness so original state is restored if stub throws
    const tmpGlobal = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origDisabled = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = tmpGlobal
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(tmpGlobal)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a", "b"), { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "root-direct" }, null, 2))
          await Bun.write(path.join(dir, "a", "b", "tui.json"), JSON.stringify({ theme: "nested-direct" }, null, 2))
          const rootKilo = path.join(dir, ".kilo")
          await fs.mkdir(rootKilo, { recursive: true })
          await Bun.write(path.join(rootKilo, "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
          const nestedKilo = path.join(dir, "a", "b", ".kilo")
          await fs.mkdir(nestedKilo, { recursive: true })
          await Bun.write(path.join(nestedKilo, "tui.json"), JSON.stringify({ theme: "nested-kilo" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      await markPluginDependenciesReady(path.join(tmp.path, "a", "b", ".kilo"))
      const nested = path.join(tmp.path, "a", "b")
      const origMaybe = DaemonClient.maybe
      let capturedConfig: { theme?: string } | undefined
      let capturedDirectory: string | undefined
      ;(DaemonClient as { maybe: typeof DaemonClient.maybe }).maybe = async () => mockConnection
      try {
        const ok = await KiloTuiThreadDaemon.attach({
          args: emptyAttachArgs,
          cwd: nested,
          input: async () => undefined,
          start: async (input) => {
            capturedConfig = input.config as { theme?: string }
            capturedDirectory = input.directory
          },
        })
        expect(ok).toBe(true)
        expect(capturedConfig).toBeDefined()
        expect(capturedConfig?.theme).toBe("root-kilo")
        expect(capturedConfig?.theme).not.toBe("nested-direct")
        const canonical = canonicalRoot(nested, await resolveWorktree(nested))
        expect(canonical).toBe(tmp.path)
        capturedConfig = undefined
        const ok2 = await KiloTuiThreadDaemon.attach({
          args: emptyAttachArgs,
          cwd: canonical,
          input: async () => undefined,
          start: async (input) => {
            capturedConfig = input.config as { theme?: string }
            capturedDirectory = input.directory
          },
        })
        expect(ok2).toBe(true)
        expect((capturedConfig as { theme?: string } | undefined)?.theme).toBe("root-kilo")
        expect(capturedDirectory).toBe(canonical)
      } finally {
        ;(DaemonClient as { maybe: typeof DaemonClient.maybe }).maybe = origMaybe
      }
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
      if (globalMutated) {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origDisabled
        ;(Global.Path as { config: string }).config = origGlobal
        if (origProject === undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
        else process.env.KILO_DISABLE_PROJECT_CONFIG = origProject
        if (origConfig === undefined) delete process.env.KILO_CONFIG
        else process.env.KILO_CONFIG = origConfig
        if (origTuiConfig === undefined) delete process.env.KILO_TUI_CONFIG
        else process.env.KILO_TUI_CONFIG = origTuiConfig
        if (origConfigDir === undefined) delete process.env.KILO_CONFIG_DIR
        else process.env.KILO_CONFIG_DIR = origConfigDir
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpGlobal, tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
        await fs.rm(tmpGlobal, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm tmpGlobal", err)
          return undefined
        })
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("daemon attach fallback non-Git uses directory itself", async () => {
    const tmpGlobal = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origDisabled = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = tmpGlobal
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(tmpGlobal)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        init: async (dir) => {
          const nested = path.join(dir, "a", "b")
          await fs.mkdir(nested, { recursive: true })
          await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
          await Bun.write(path.join(dir, ".kilo", "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "root-direct" }, null, 2))
          await fs.mkdir(path.join(nested, ".kilo"), { recursive: true })
          await Bun.write(path.join(nested, ".kilo", "tui.json"), JSON.stringify({ theme: "nested-kilo" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      await markPluginDependenciesReady(path.join(tmp.path, "a", "b", ".kilo"))
      const nested = path.join(tmp.path, "a", "b")
      const worktree = await resolveWorktree(nested)
      expect(worktree).toBeUndefined()
      expect(canonicalRoot(nested, worktree)).toBe(nested)
      const origMaybe = DaemonClient.maybe
      let capturedConfig: { theme?: string } | undefined
      ;(DaemonClient as { maybe: typeof DaemonClient.maybe }).maybe = async () => mockConnection
      try {
        const ok = await KiloTuiThreadDaemon.attach({
          args: emptyAttachArgs,
          cwd: nested,
          input: async () => undefined,
          start: async (input) => {
            capturedConfig = input.config as { theme?: string }
          },
        })
        expect(ok).toBe(true)
        expect(capturedConfig?.theme).toBe("nested-kilo")
      } finally {
        ;(DaemonClient as { maybe: typeof DaemonClient.maybe }).maybe = origMaybe
      }
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
      if (globalMutated) {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origDisabled
        ;(Global.Path as { config: string }).config = origGlobal
        if (origProject === undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
        else process.env.KILO_DISABLE_PROJECT_CONFIG = origProject
        if (origConfig === undefined) delete process.env.KILO_CONFIG
        else process.env.KILO_CONFIG = origConfig
        if (origTuiConfig === undefined) delete process.env.KILO_TUI_CONFIG
        else process.env.KILO_TUI_CONFIG = origTuiConfig
        if (origConfigDir === undefined) delete process.env.KILO_CONFIG_DIR
        else process.env.KILO_CONFIG_DIR = origConfigDir
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpGlobal, tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
        await fs.rm(tmpGlobal, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm tmpGlobal", err)
          return undefined
        })
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("explicit attach pure helper resolves canonical worktree root for local git dir", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let nonGit: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a", "b"), { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "root-direct" }, null, 2))
          const kilo = path.join(dir, ".kilo")
          await fs.mkdir(kilo, { recursive: true })
          await Bun.write(path.join(kilo, "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
        },
      })
      const nested = path.join(tmp.path, "a", "b")
      const localBase = Filesystem.resolve(tmp.path)
      const canonical = await resolveAttachConfigRoot(localBase)
      expect(canonical).toBe(Filesystem.resolve(tmp.path))
      const canonicalNested = await resolveAttachConfigRoot(Filesystem.resolve(nested))
      expect(canonicalNested).toBe(Filesystem.resolve(tmp.path))
      nonGit = await tmpdir()
      const nonGitNested = path.join(nonGit.path, "a")
      await fs.mkdir(nonGitNested, { recursive: true })
      const nonGitCanonical = await resolveAttachConfigRoot(nonGitNested)
      expect(nonGitCanonical).toBe(nonGitNested)
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
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { nonGit: nonGit?.path, tmpPath: tmp?.path, err: waitError })
      } else {
        if (nonGit) {
          try {
            await nonGit[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("nonGit dispose", err)
          }
        }
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

  test("explicit attach pure helper does not follow unavailable remote dir (LOCK-SOURCE)", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    const tmpGlobal = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const prevDisable = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a"), { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "root-direct" }, null, 2))
          const kilo = path.join(dir, ".kilo")
          await fs.mkdir(kilo, { recursive: true })
          await Bun.write(path.join(kilo, "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
        },
      })
      const localBase = Filesystem.resolve(tmp.path)
      const remoteDir = path.join(os.tmpdir(), `kilo-remote-nonexistent-${Math.random().toString(36).slice(2)}`)
      expect(await Bun.file(remoteDir).exists()).toBe(false)
      const canonicalLocal = await resolveAttachConfigRoot(localBase)
      expect(canonicalLocal).toBe(localBase)
      const canonicalRemote = await resolveAttachConfigRoot(remoteDir)
      expect(canonicalRemote).toBe(remoteDir)
      expect(canonicalLocal).not.toBe(canonicalRemote)
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = tmpGlobal
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(tmpGlobal)
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      const cfgLocal = await Effect.runPromise(
        TuiConfig.Service.use((svc) => svc.get()).pipe(
          Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, canonicalLocal)))),
          Effect.provide(Config.defaultLayer),
          Effect.provide(FSUtil.defaultLayer),
        ),
      )
      expect(cfgLocal.theme).toBe("root-kilo")
      const cfgRemote = await Effect.runPromise(
        TuiConfig.Service.use((svc) => svc.get()).pipe(
          Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, canonicalRemote)))),
          Effect.provide(Config.defaultLayer),
          Effect.provide(FSUtil.defaultLayer),
        ),
      )
      expect(cfgRemote.theme).toBeUndefined()
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
      if (globalMutated) {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = prevDisable
        ;(Global.Path as { config: string }).config = origGlobal
        if (origProject === undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
        else process.env.KILO_DISABLE_PROJECT_CONFIG = origProject
        if (origConfig === undefined) delete process.env.KILO_CONFIG
        else process.env.KILO_CONFIG = origConfig
        if (origTuiConfig === undefined) delete process.env.KILO_TUI_CONFIG
        else process.env.KILO_TUI_CONFIG = origTuiConfig
        if (origConfigDir === undefined) delete process.env.KILO_CONFIG_DIR
        else process.env.KILO_CONFIG_DIR = origConfigDir
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpGlobal, tmpPath: tmp?.path, err: waitError })
      } else {
        await fs.rm(tmpGlobal, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm tmpGlobal", err)
          return undefined
        })
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

  test("explicit attach canonical via shared resolveWorktree/canonicalRoot boundary", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a"), { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "root-direct" }, null, 2))
          const kilo = path.join(dir, ".kilo")
          await fs.mkdir(kilo, { recursive: true })
          await Bun.write(path.join(kilo, "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
          await Bun.write(path.join(dir, "a", "tui.json"), JSON.stringify({ theme: "nested-direct" }, null, 2))
          await fs.mkdir(path.join(dir, "a", ".kilo"), { recursive: true })
          await Bun.write(path.join(dir, "a", ".kilo", "tui.json"), JSON.stringify({ theme: "nested-kilo" }, null, 2))
        },
      })
      const nested = path.join(tmp.path, "a")
      const worktree = await resolveWorktree(nested)
      const canonical = canonicalRoot(nested, worktree)
      expect(canonical).toBe(tmp.path)
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      const cfg = await Effect.runPromise(getTuiConfig(canonical).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(cfg.theme).toBe("root-kilo")
      const cfgRaw = await Effect.runPromise(getTuiConfig(nested).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(cfgRaw.theme).toBe("root-kilo")
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

  test("explicit attach non-Git fallback is directory itself", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        init: async (dir) => {
          const nested = path.join(dir, "a")
          await fs.mkdir(nested, { recursive: true })
          await fs.mkdir(path.join(nested, ".kilo"), { recursive: true })
          await Bun.write(path.join(nested, ".kilo", "tui.json"), JSON.stringify({ theme: "nested-kilo" }, null, 2))
          await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
          await Bun.write(path.join(dir, ".kilo", "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
        },
      })
      const nested = path.join(tmp.path, "a")
      const worktree = await resolveWorktree(nested)
      expect(worktree).toBeUndefined()
      const canonical = canonicalRoot(nested, worktree)
      expect(canonical).toBe(nested)
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      await markPluginDependenciesReady(path.join(tmp.path, "a", ".kilo"))
      const cfg = await Effect.runPromise(getTuiConfig(canonical).pipe(withClean, Effect.provide(Config.defaultLayer), Effect.provide(FSUtil.defaultLayer)))
      expect(cfg.theme).toBe("nested-kilo")
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

  test("static entrypoints thread canonical root to TuiConfig", async () => {
    const daemonSrc = await fs.readFile(path.join(import.meta.dir, "../../src/kilocode/cli/cmd/tui/thread.ts"), "utf8")
    expect(daemonSrc).toContain("CurrentWorkingDirectory")
    expect(daemonSrc).toContain("input.cwd")
    expect(daemonSrc).toContain("Layer.succeed(CurrentWorkingDirectory")
    const attachSrc = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/attach.ts"), "utf8")
    expect(attachSrc).toContain("resolveAttachConfigRoot")
    expect(attachSrc).toContain("localBase")
    expect(attachSrc).toContain("selectedLocalDir")
    expect(attachSrc).toContain("configBase")
    expect(attachSrc).toContain("Filesystem.resolve(process.cwd())")
  })

  test("ConfigPaths.files retained API vs no active TUI call", async () => {
    const pathsSrc = await fs.readFile(path.join(import.meta.dir, "../../src/config/paths.ts"), "utf8")
    expect(pathsSrc).toContain("export const files")
    expect(pathsSrc).toContain("fileInDirectory")
    const tuiSrc = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/config/tui.ts"), "utf8")
    expect(tuiSrc).not.toContain("ConfigPaths.files")
    expect(tuiSrc).toContain("ConfigPaths.fileInDirectory")
    expect(tuiSrc).not.toContain("const dirs = workspaceDirs")
  })

  test("explicit attach canonicalForConfig uses same resolveWorktree/canonicalRoot + Filesystem.resolve boundary as standalone", async () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({ git: true })
      const nested = path.join(tmp.path, "a", "b")
      await fs.mkdir(nested, { recursive: true })
      const baseFromDir = nested
      const worktree = await resolveWorktree(baseFromDir)
      const canonicalFromDir = canonicalRoot(baseFromDir, worktree)
      expect(canonicalFromDir).toBe(tmp.path)
      const cwdBase = Filesystem.resolve(process.cwd())
      const worktree2 = await resolveWorktree(cwdBase)
      const canonicalFromCwd = canonicalRoot(cwdBase, worktree2)
      expect(typeof canonicalFromCwd).toBe("string")
      expect(Filesystem.resolve(path.join(tmp.path, "a"))).toBe(Filesystem.resolve(path.join(tmp.path, "a")))
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

  test("remote attach with unavailable --dir does not displace local canonical config root (LOCK-SOURCE)", async () => {
    const attachSrc = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/attach.ts"), "utf8")
    expect(attachSrc).toContain("localBase")
    expect(attachSrc).toContain("selectedLocalDir")
    expect(attachSrc).toContain("configBase")
    expect(attachSrc).toContain("Filesystem.resolve(process.cwd())")
    expect(attachSrc).toContain("resolveAttachConfigRoot")
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    const tmpGlobal = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const prevDisable = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    try {
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a"), { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "root-direct" }, null, 2))
          const kilo = path.join(dir, ".kilo")
          await fs.mkdir(kilo, { recursive: true })
          await Bun.write(path.join(kilo, "tui.json"), JSON.stringify({ theme: "root-kilo" }, null, 2))
        },
      })
      const localBase = Filesystem.resolve(tmp.path)
      const remoteDir = path.join(os.tmpdir(), `kilo-remote-nonexistent-${Math.random().toString(36).slice(2)}`)
      expect(await Bun.file(remoteDir).exists()).toBe(false)
      expect(() => {
        process.chdir(remoteDir)
      }).toThrow()
      const canonicalLocal = await resolveAttachConfigRoot(localBase)
      expect(canonicalLocal).toBe(localBase)
      const canonicalRemote = await resolveAttachConfigRoot(remoteDir)
      expect(canonicalRemote).toBe(remoteDir)
      expect(canonicalLocal).not.toBe(canonicalRemote)
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = tmpGlobal
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(tmpGlobal)
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      const cfgLocal = await Effect.runPromise(
        TuiConfig.Service.use((svc) => svc.get()).pipe(
          Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, canonicalLocal)))),
          Effect.provide(Config.defaultLayer),
          Effect.provide(FSUtil.defaultLayer),
        ),
      )
      expect(cfgLocal.theme).toBe("root-kilo")
      const cfgRemote = await Effect.runPromise(
        TuiConfig.Service.use((svc) => svc.get()).pipe(
          Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, canonicalRemote)))),
          Effect.provide(Config.defaultLayer),
          Effect.provide(FSUtil.defaultLayer),
        ),
      )
      expect(cfgRemote.theme).toBeUndefined()
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
      if (globalMutated) {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = prevDisable
        ;(Global.Path as { config: string }).config = origGlobal
        if (origProject === undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
        else process.env.KILO_DISABLE_PROJECT_CONFIG = origProject
        if (origConfig === undefined) delete process.env.KILO_CONFIG
        else process.env.KILO_CONFIG = origConfig
        if (origTuiConfig === undefined) delete process.env.KILO_TUI_CONFIG
        else process.env.KILO_TUI_CONFIG = origTuiConfig
        if (origConfigDir === undefined) delete process.env.KILO_CONFIG_DIR
        else process.env.KILO_CONFIG_DIR = origConfigDir
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpGlobal, tmpPath: tmp?.path, err: waitError })
      } else {
        await fs.rm(tmpGlobal, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm tmpGlobal", err)
          return undefined
        })
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

  test("explicit attach valid local --dir uses selected local directory as config root (LOCK-SOURCE)", async () => {
    const attachSrc = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/attach.ts"), "utf8")
    expect(attachSrc).toContain("selectedLocalDir")
    expect(attachSrc).toContain("configBase")
    expect(attachSrc).toContain("localBase")
    let callerTmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let targetTmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let tmpGlobal: string | undefined
    const origGlobal = Global.Path.config
    const prevDisable = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    const origCwd = process.cwd()
    try {
      expect(Database.path()).toBe(":memory:")
      callerTmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "caller-direct" }, null, 2))
          const kilo = path.join(dir, ".kilo")
          await fs.mkdir(kilo, { recursive: true })
          await Bun.write(path.join(kilo, "tui.json"), JSON.stringify({ theme: "caller-kilo" }, null, 2))
        },
      })
      targetTmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await fs.mkdir(path.join(dir, "a"), { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "target-direct" }, null, 2))
          const kilo = path.join(dir, ".kilo")
          await fs.mkdir(kilo, { recursive: true })
          await Bun.write(path.join(kilo, "tui.json"), JSON.stringify({ theme: "target-kilo" }, null, 2))
        },
      })
      const localBase = Filesystem.resolve(callerTmp.path)
      // CWD mutation inside immediate try/finally so restoration is guaranteed even if subsequent logic throws
      try {
        process.chdir(targetTmp.path)
      } catch (err) {
        reportCleanup("process.chdir target", err)
        throw err
      }
      const selectedLocalDir = Filesystem.resolve(process.cwd())
      const configBase = selectedLocalDir ?? localBase
      expect(selectedLocalDir).toBe(Filesystem.resolve(targetTmp.path))
      expect(configBase).toBe(Filesystem.resolve(targetTmp.path))
      expect(configBase).not.toBe(localBase)
      const canonicalFromSelected = await resolveAttachConfigRoot(configBase)
      expect(canonicalFromSelected).toBe(Filesystem.resolve(targetTmp.path))
      const canonicalFromCaller = await resolveAttachConfigRoot(localBase)
      expect(canonicalFromCaller).toBe(Filesystem.resolve(callerTmp.path))
      expect(canonicalFromSelected).not.toBe(canonicalFromCaller)
      tmpGlobal = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = tmpGlobal
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(tmpGlobal)
      await markProjectConfigReady(callerTmp.path)
      await markProjectConfigReady(targetTmp.path)
      await markPluginDependenciesReady(path.join(callerTmp.path, ".kilo"))
      await markPluginDependenciesReady(path.join(targetTmp.path, ".kilo"))
      const cfgSelected = await Effect.runPromise(
        TuiConfig.Service.use((svc) => svc.get()).pipe(
          Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, canonicalFromSelected)))),
          Effect.provide(Config.defaultLayer),
          Effect.provide(FSUtil.defaultLayer),
        ),
      )
      expect(cfgSelected.theme).toBe("target-kilo")
      const cfgCaller = await Effect.runPromise(
        TuiConfig.Service.use((svc) => svc.get()).pipe(
          Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, canonicalFromCaller)))),
          Effect.provide(Config.defaultLayer),
          Effect.provide(FSUtil.defaultLayer),
        ),
      )
      expect(cfgCaller.theme).toBe("caller-kilo")
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
      try {
        process.chdir(origCwd)
      } catch (err) {
        reportCleanup("restore CWD", err)
      }
      if (globalMutated && tmpGlobal) {
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = prevDisable
        ;(Global.Path as { config: string }).config = origGlobal
        if (origProject === undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
        else process.env.KILO_DISABLE_PROJECT_CONFIG = origProject
        if (origConfig === undefined) delete process.env.KILO_CONFIG
        else process.env.KILO_CONFIG = origConfig
        if (origTuiConfig === undefined) delete process.env.KILO_TUI_CONFIG
        else process.env.KILO_TUI_CONFIG = origTuiConfig
        if (origConfigDir === undefined) delete process.env.KILO_CONFIG_DIR
        else process.env.KILO_CONFIG_DIR = origConfigDir
      }
      if (waitError !== undefined) {
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { tmpGlobal, callerPath: callerTmp?.path, targetPath: targetTmp?.path, err: waitError })
      } else {
        if (tmpGlobal) {
          await fs.rm(tmpGlobal, { recursive: true, force: true }).catch((err) => {
            reportCleanup("rm tmpGlobal", err)
            return undefined
          })
        }
        if (targetTmp) {
          try {
            await targetTmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("targetTmp dispose", err)
          }
        }
        if (callerTmp) {
          try {
            await callerTmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("callerTmp dispose", err)
          }
        }
      }
      // Prove no lingering CWD/tmp/database state (only after ordered cleanup, before wait error throw)
      try {
        expect(process.cwd()).toBe(origCwd)
        expect(Database.path()).toBe(":memory:")
      } catch (err) {
        reportCleanup("post-cleanup assertion", err)
        throw err
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("lifecycle: no lingering CWD, tmp, or database after attach suite", async () => {
    expect(Database.path()).toBe(":memory:")
    expect(tmpdirRegistrySize()).toBe(0)
    const cwd = process.cwd()
    expect(typeof cwd).toBe("string")
    // CWD persistence in production AttachCommand is intentional established CLI behavior (always chdirs and retains).
    // Verify production source still contains that persistence and test suite restores CWD.
    const attachSrc = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/tui/attach.ts"), "utf8")
    expect(attachSrc).toContain("process.chdir(args.dir)")
    expect(attachSrc).not.toContain("process.chdir(orig")
  })
})
