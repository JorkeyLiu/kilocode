import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir, tmpdirRegistrySize } from "../fixture/fixture"
import { Database } from "@opencode-ai/core/database/database"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { markPluginDependenciesReady, markProjectConfigReady } from "../fixture/plugin"

void Log.init({ print: false })

function reportCleanup(stage: string, err: unknown) {
  console.error(`[test cleanup] ${stage} failed`, err)
}

describe("P4.4 TUI config console canonical root (nested directory)", () => {
  test("GET from nested directory reads canonical workspace root .kilo/tui.json (LOCK-SOURCE)", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const nested = path.join(dir, "a", "b")
          await fs.mkdir(nested, { recursive: true })
          const rootKilo = path.join(dir, ".kilo")
          await fs.mkdir(rootKilo, { recursive: true })
          await Bun.write(path.join(rootKilo, "tui.json"), JSON.stringify({ theme: "dracula" }, null, 2))
          const nestedKilo = path.join(nested, ".kilo")
          await fs.mkdir(nestedKilo, { recursive: true })
          await Bun.write(path.join(nestedKilo, "tui.json"), JSON.stringify({ theme: "nord" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      await markPluginDependenciesReady(path.join(tmp.path, "a", "b", ".kilo"))
      const nested = path.join(tmp.path, "a", "b")
      const response = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { theme?: string }
      expect(body.theme).toBe("dracula")
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { globalTmp, tmpPath: tmp?.path, err: waitError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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

  test("GET from nested respects canonical .kilo precedence over direct tui.json", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const nested = path.join(dir, "a")
          await fs.mkdir(nested, { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "nord" }, null, 2))
          const kilo = path.join(dir, ".kilo")
          await fs.mkdir(kilo, { recursive: true })
          await Bun.write(path.join(kilo, "tui.json"), JSON.stringify({ theme: "dracula" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      const nested = path.join(tmp.path, "a")
      const response = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { theme?: string }
      expect(body.theme).toBe("dracula")
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { globalTmp, tmpPath: tmp?.path, err: waitError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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

  test("PATCH from nested writes canonical root .kilo/tui.json and returned state matches (GET/PATCH/reload agree)", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({ git: true })
      await markProjectConfigReady(tmp.path)
      const nested = path.join(tmp.path, "a", "b")
      await fs.mkdir(nested, { recursive: true })

      const patchRes = await Server.Default().app.request("/tui/config?scope=project", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-kilo-directory": nested,
        },
        body: JSON.stringify({ theme: "nord", title_icon: "emojis" }),
      })
      expect(patchRes.status).toBe(200)
      const patchBody = (await patchRes.json()) as { theme?: string; title_icon?: string }
      expect(patchBody.theme).toBe("nord")
      expect(patchBody.title_icon).toBe("emojis")

      const canonicalFile = path.join(tmp.path, ".kilo", "tui.json")
      expect(await Bun.file(canonicalFile).exists()).toBe(true)
      const saved = await Bun.file(canonicalFile).json()
      expect(saved).toEqual({ theme: "nord", title_icon: "emojis" })
      const nestedFile = path.join(nested, ".kilo", "tui.json")
      expect(await Bun.file(nestedFile).exists()).toBe(false)

      const getRes = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(getRes.status).toBe(200)
      const getBody = (await getRes.json()) as { theme?: string; title_icon?: string }
      expect(getBody.theme).toBe("nord")
      expect(getBody.title_icon).toBe("emojis")

      const getRoot = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": tmp.path },
      })
      expect(getRoot.status).toBe(200)
      const rootBody = (await getRoot.json()) as { theme?: string }
      expect(rootBody.theme).toBe("nord")
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { globalTmp, tmpPath: tmp?.path, err: waitError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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

  test("PATCH from nested with existing canonical precedence preserves .kilo first rule", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const nested = path.join(dir, "a")
          await fs.mkdir(nested, { recursive: true })
          await Bun.write(path.join(dir, "tui.json"), JSON.stringify({ theme: "catppuccin" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      const nested = path.join(tmp.path, "a")
      const res = await Server.Default().app.request("/tui/config?scope=project", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-kilo-directory": nested },
        body: JSON.stringify({ theme: "dracula" }),
      })
      expect(res.status).toBe(200)
      const direct = path.join(tmp.path, "tui.json")
      expect(await Bun.file(direct).exists()).toBe(true)
      const saved = await Bun.file(direct).json()
      expect(saved.theme).toBe("dracula")
      const kilo = path.join(tmp.path, ".kilo", "tui.json")
      expect(await Bun.file(kilo).exists()).toBe(false)
      const nestedKilo = path.join(nested, ".kilo", "tui.json")
      expect(await Bun.file(nestedKilo).exists()).toBe(false)
      const get = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      const body = (await get.json()) as { theme?: string }
      expect(body.theme).toBe("dracula")
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { globalTmp, tmpPath: tmp?.path, err: waitError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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

  test("fallback when worktree absent uses directory directly (non-git)", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        init: async (dir) => {
          const rootKilo = path.join(dir, ".kilo")
          await fs.mkdir(rootKilo, { recursive: true })
          await Bun.write(path.join(rootKilo, "tui.json"), JSON.stringify({ theme: "dracula" }, null, 2))
          const nested = path.join(dir, "a")
          await fs.mkdir(nested, { recursive: true })
          const nestedKilo = path.join(nested, ".kilo")
          await fs.mkdir(nestedKilo, { recursive: true })
          await Bun.write(path.join(nestedKilo, "tui.json"), JSON.stringify({ theme: "nord" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      await markPluginDependenciesReady(path.join(tmp.path, "a", ".kilo"))
      const nested = path.join(tmp.path, "a")
      const nestedRes = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(nestedRes.status).toBe(200)
      const nestedBody = (await nestedRes.json()) as { theme?: string }
      expect(nestedBody.theme).toBe("nord")

      const rootRes = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": tmp.path },
      })
      expect(rootRes.status).toBe(200)
      const rootBody = (await rootRes.json()) as { theme?: string }
      expect(rootBody.theme).toBe("dracula")
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { globalTmp, tmpPath: tmp?.path, err: waitError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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

  test("global scope PATCH via nested still targets global config (preserve global behavior)", async () => {
    const globalTmpPath = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    let globalTmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    const orig = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmpPath
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmpPath)
      // Keep compat globalTmp object for existing cleanup expectations
      globalTmp = { path: globalTmpPath, extra: undefined, [Symbol.asyncDispose]: async () => { await fs.rm(globalTmpPath, { recursive: true, force: true }).catch(()=>undefined) } } as any
      tmp = await tmpdir({ git: true })
      await markProjectConfigReady(tmp.path)
      const nested = path.join(tmp.path, "a")
      await fs.mkdir(nested, { recursive: true })

      const res = await Server.Default().app.request("/tui/config?scope=global", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-kilo-directory": nested },
        body: JSON.stringify({ theme: "tokyo-night" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { theme?: string }
      expect(body.theme).toBe("tokyo-night")

      const projectFile = path.join(tmp.path, ".kilo", "tui.json")
      expect(await Bun.file(projectFile).exists()).toBe(false)

      const getViaNested = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(getViaNested.status).toBe(200)
      const getBody = (await getViaNested.json()) as { theme?: string }
      expect(getBody.theme).toBe("tokyo-night")
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
        ;(Global.Path as { config: string }).config = orig
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
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { globalTmp: globalTmpPath, tmpPath: tmp?.path, err: waitError })
      } else {
        if (tmp) {
          try {
            await tmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("tmp dispose", err)
          }
        }
        if (globalTmp) {
          try {
            await globalTmp[Symbol.asyncDispose]()
          } catch (err) {
            reportCleanup("globalTmp dispose", err)
          }
        } else {
          await fs.rm(globalTmpPath, { recursive: true, force: true }).catch((err) => {
            reportCleanup("rm globalTmpPath", err)
            return undefined
          })
        }
      }
      if (waitError !== undefined) throw waitError
    }
  })

  test("PATCH from nested -> POST reload -> GET retains canonical state (default app, LOCK-SOURCE)", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({ git: true })
      await markProjectConfigReady(tmp.path)
      const nested = path.join(tmp.path, "a", "b")
      await fs.mkdir(nested, { recursive: true })

      const patchRes = await Server.Default().app.request("/tui/config?scope=project", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-kilo-directory": nested },
        body: JSON.stringify({ theme: "nord", title_icon: "emojis" }),
      })
      expect(patchRes.status).toBe(200)
      const patchBody = (await patchRes.json()) as { theme?: string; title_icon?: string }
      expect(patchBody.theme).toBe("nord")

      const reloadRes = await Server.Default().app.request(`/instance/reload?directory=${encodeURIComponent(nested)}`, {
        method: "POST",
        headers: { "x-kilo-directory": nested },
      })
      expect(reloadRes.status).toBe(200)

      const getNested = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(getNested.status).toBe(200)
      const nestedBody = (await getNested.json()) as { theme?: string; title_icon?: string }
      expect(nestedBody.theme).toBe("nord")
      expect(nestedBody.title_icon).toBe("emojis")

      const getRoot = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": tmp.path },
      })
      expect(getRoot.status).toBe(200)
      const rootBody = (await getRoot.json()) as { theme?: string }
      expect(rootBody.theme).toBe("nord")

      const canonicalFile = path.join(tmp.path, ".kilo", "tui.json")
      expect(await Bun.file(canonicalFile).exists()).toBe(true)
      expect(await Bun.file(canonicalFile).json()).toEqual({ theme: "nord", title_icon: "emojis" })
      expect(await Bun.file(path.join(nested, ".kilo", "tui.json")).exists()).toBe(false)
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
        console.error("[test cleanup] waitForDependencies failed, retaining owned tmp", { globalTmp, tmpPath: tmp?.path, err: waitError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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
})

describe("P4.4 TUI config console production Server.listen (LOCK-SOURCE) — worktree propagation with scoped cleanup", () => {
  test("GET via production listener from nested reads canonical root (worktree propagation)", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
    let base = ""
    let probeFailed: boolean | undefined
    let probeError: unknown
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const nested = path.join(dir, "a", "b")
          await fs.mkdir(nested, { recursive: true })
          const rootKilo = path.join(dir, ".kilo")
          await fs.mkdir(rootKilo, { recursive: true })
          await Bun.write(path.join(rootKilo, "tui.json"), JSON.stringify({ theme: "dracula" }, null, 2))
          const nestedKilo = path.join(nested, ".kilo")
          await fs.mkdir(nestedKilo, { recursive: true })
          await Bun.write(path.join(nestedKilo, "tui.json"), JSON.stringify({ theme: "nord" }, null, 2))
        },
      })
      await markProjectConfigReady(tmp.path)
      await markPluginDependenciesReady(path.join(tmp.path, ".kilo"))
      await markPluginDependenciesReady(path.join(tmp.path, "a", "b", ".kilo"))
      const nested = path.join(tmp.path, "a", "b")
      listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      base = listener.url.toString().replace(/\/$/, "")
      const response = await fetch(`${base}/tui/config`, {
        headers: { "x-kilo-directory": nested },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { theme?: string }
      expect(body.theme).toBe("dracula")
      expect(body.theme).not.toBe("nord")

      const direct = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(direct.status).toBe(200)
      const directBody = (await direct.json()) as { theme?: string }
      expect(directBody.theme).toBe("dracula")
    } finally {
      let waitError: unknown
      if (listener) {
        try {
          await listener.stop(true)
        } catch (err) {
          reportCleanup("listener.stop", err)
        }
      }
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
      if (listener && base) {
        try {
          await fetch(`${base}/tui/config`, { headers: { "x-kilo-directory": tmp?.path ?? "" } })
          probeFailed = false
        } catch {
          probeFailed = true
        }
      }
      if (probeFailed !== undefined) {
        try {
          expect(probeFailed).toBe(true)
        } catch (err) {
          probeError = err
          reportCleanup("fetchFailed check", err)
        }
      }
      if (waitError !== undefined || probeError !== undefined) {
        console.error("[test cleanup] retaining owned tmp due to failure", { globalTmp, tmpPath: tmp?.path, waitError, probeError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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
      if (probeError !== undefined) throw probeError
    }
  })

  test("PATCH via production listener from nested writes canonical root and GETs converge", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
    let base = ""
    let probeFailed: boolean | undefined
    let probeError: unknown
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({ git: true })
      await markProjectConfigReady(tmp.path)
      const nested = path.join(tmp.path, "a", "b")
      await fs.mkdir(nested, { recursive: true })

      listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      base = listener.url.toString().replace(/\/$/, "")
      const patchRes = await fetch(`${base}/tui/config?scope=project`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-kilo-directory": nested,
        },
        body: JSON.stringify({ theme: "nord", title_icon: "emojis" }),
      })
      expect(patchRes.status).toBe(200)
      const patchBody = (await patchRes.json()) as { theme?: string; title_icon?: string }
      expect(patchBody.theme).toBe("nord")
      expect(patchBody.title_icon).toBe("emojis")

      const canonicalFile = path.join(tmp.path, ".kilo", "tui.json")
      expect(await Bun.file(canonicalFile).exists()).toBe(true)
      expect(await Bun.file(canonicalFile).json()).toEqual({ theme: "nord", title_icon: "emojis" })
      expect(await Bun.file(path.join(nested, ".kilo", "tui.json")).exists()).toBe(false)

      const getNested = await fetch(`${base}/tui/config`, {
        headers: { "x-kilo-directory": nested },
      })
      expect(getNested.status).toBe(200)
      const nestedBody = (await getNested.json()) as { theme?: string; title_icon?: string }
      expect(nestedBody.theme).toBe("nord")
      expect(nestedBody.title_icon).toBe("emojis")

      const getRoot = await fetch(`${base}/tui/config`, {
        headers: { "x-kilo-directory": tmp.path },
      })
      expect(getRoot.status).toBe(200)
      const rootBody = (await getRoot.json()) as { theme?: string }
      expect(rootBody.theme).toBe("nord")

      const getViaDefault = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(((await getViaDefault.json()) as { theme?: string }).theme).toBe("nord")
    } finally {
      let waitError: unknown
      if (listener) {
        try {
          await listener.stop(true)
        } catch (err) {
          reportCleanup("listener.stop", err)
        }
      }
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
      if (listener && base) {
        try {
          await fetch(`${base}/tui/config`, { headers: { "x-kilo-directory": tmp?.path ?? "" } })
          probeFailed = false
        } catch {
          probeFailed = true
        }
      }
      if (probeFailed !== undefined) {
        try {
          expect(probeFailed).toBe(true)
        } catch (err) {
          probeError = err
          reportCleanup("fetchFailed check", err)
        }
      }
      if (waitError !== undefined || probeError !== undefined) {
        console.error("[test cleanup] retaining owned tmp due to failure", { globalTmp, tmpPath: tmp?.path, waitError, probeError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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
      if (probeError !== undefined) throw probeError
    }
  })

  test("PATCH -> POST reload -> GET via production listener retains canonical (LOCK-SOURCE, scoped)", async () => {
    const globalTmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-test-global-"))
    const origGlobal = Global.Path.config
    const origFlag = Flag.KILO_DISABLE_DEFAULT_PLUGINS
    const origProject = process.env.KILO_DISABLE_PROJECT_CONFIG
    const origConfig = process.env.KILO_CONFIG
    const origTuiConfig = process.env.KILO_TUI_CONFIG
    const origConfigDir = process.env.KILO_CONFIG_DIR
    let globalMutated = false
    let tmp: Awaited<ReturnType<typeof tmpdir>> | undefined
    let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
    let base = ""
    let probeFailed: boolean | undefined
    let probeError: unknown
    try {
      Flag.KILO_DISABLE_DEFAULT_PLUGINS = true
      ;(Global.Path as { config: string }).config = globalTmp
      if (origProject !== undefined) delete process.env.KILO_DISABLE_PROJECT_CONFIG
      if (origConfig !== undefined) delete process.env.KILO_CONFIG
      if (origTuiConfig !== undefined) delete process.env.KILO_TUI_CONFIG
      if (origConfigDir !== undefined) delete process.env.KILO_CONFIG_DIR
      globalMutated = true
      await markPluginDependenciesReady(globalTmp)
      expect(Database.path()).toBe(":memory:")
      tmp = await tmpdir({ git: true })
      await markProjectConfigReady(tmp.path)
      const nested = path.join(tmp.path, "a", "b")
      await fs.mkdir(nested, { recursive: true })

      listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      base = listener.url.toString().replace(/\/$/, "")
      const patchRes = await fetch(`${base}/tui/config?scope=project`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-kilo-directory": nested },
        body: JSON.stringify({ theme: "nord", title_icon: "emojis" }),
      })
      expect(patchRes.status).toBe(200)
      const patchBody = (await patchRes.json()) as { theme?: string }
      expect(patchBody.theme).toBe("nord")

      const reloadRes = await fetch(`${base}/instance/reload?directory=${encodeURIComponent(nested)}`, {
        method: "POST",
        headers: { "x-kilo-directory": nested },
      })
      expect(reloadRes.status).toBe(200)

      const getNested = await fetch(`${base}/tui/config`, {
        headers: { "x-kilo-directory": nested },
      })
      expect(getNested.status).toBe(200)
      const nestedBody = (await getNested.json()) as { theme?: string; title_icon?: string }
      expect(nestedBody.theme).toBe("nord")
      expect(nestedBody.title_icon).toBe("emojis")

      const getRoot = await fetch(`${base}/tui/config`, {
        headers: { "x-kilo-directory": tmp.path },
      })
      expect(getRoot.status).toBe(200)
      const rootBody = (await getRoot.json()) as { theme?: string }
      expect(rootBody.theme).toBe("nord")

      const canonicalFile = path.join(tmp.path, ".kilo", "tui.json")
      expect(await Bun.file(canonicalFile).exists()).toBe(true)
      expect(await Bun.file(canonicalFile).json()).toEqual({ theme: "nord", title_icon: "emojis" })
      expect(await Bun.file(path.join(nested, ".kilo", "tui.json")).exists()).toBe(false)

      const getViaDefault = await Server.Default().app.request("/tui/config", {
        headers: { "x-kilo-directory": nested },
      })
      expect(((await getViaDefault.json()) as { theme?: string }).theme).toBe("nord")
    } finally {
      let waitError: unknown
      if (listener) {
        try {
          await listener.stop(true)
        } catch (err) {
          reportCleanup("listener.stop", err)
        }
      }
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
        Flag.KILO_DISABLE_DEFAULT_PLUGINS = origFlag
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
      if (listener && base) {
        try {
          await fetch(`${base}/tui/config`, { headers: { "x-kilo-directory": tmp?.path ?? "" } })
          probeFailed = false
        } catch {
          probeFailed = true
        }
      }
      if (probeFailed !== undefined) {
        try {
          expect(probeFailed).toBe(true)
        } catch (err) {
          probeError = err
          reportCleanup("fetchFailed check", err)
        }
      }
      if (waitError !== undefined || probeError !== undefined) {
        console.error("[test cleanup] retaining owned tmp due to failure", { globalTmp, tmpPath: tmp?.path, waitError, probeError })
      } else {
        await fs.rm(globalTmp, { recursive: true, force: true }).catch((err) => {
          reportCleanup("rm globalTmp", err)
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
      if (probeError !== undefined) throw probeError
    }
  })

  test("lifecycle: no lingering listener, tmp, or database after console suite", async () => {
    expect(Database.path()).toBe(":memory:")
    expect(tmpdirRegistrySize()).toBe(0)
  })
})
