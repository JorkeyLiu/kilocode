import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { path as dbPath } from "@opencode-ai/core/database/database"

const custom = ["latest", "beta", "prod"].includes(InstallationChannel) ? test.skip : test

afterEach(() => {
  mock.restore()
})

describe("core database path fallback observability", () => {
  custom("fallback still returns legacy opencode db when only legacy exists and logs warn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-core-db-fallback-"))
    const origData = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const origEnv = process.env.KILO_DISABLE_CHANNEL_DB
    delete process.env.KILO_DISABLE_CHANNEL_DB
    const warn = spyOn(Log.create({ service: "database" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const next = path.join(dir, `kilo-${safe}.db`)
      const prev = path.join(dir, `opencode-${safe}.db`)
      const sentinel = "kilo-secret-sentinel-9f2c1e7a-do-not-leak"
      expect(fs.existsSync(next)).toBe(false)
      await Bun.write(prev, sentinel)
      expect(fs.existsSync(prev)).toBe(true)

      const result = dbPath()
      expect(result).toBe(prev)
      expect(warn).toHaveBeenCalledTimes(1)
      const [msg, extra] = warn.mock.calls[0] as [string, Record<string, unknown>]
      expect(msg).toContain("legacy opencode")
      expect(extra).toEqual({
        channel: InstallationChannel,
        safe,
        canonical: next,
        legacy: prev,
      })
      expect(Object.keys(extra).sort()).toEqual(["canonical", "channel", "legacy", "safe"])
      expect(JSON.stringify(extra)).not.toContain(sentinel)
      expect(JSON.stringify(extra).length).toBeLessThan(1024)
    } finally {
      if (origEnv === undefined) delete process.env.KILO_DISABLE_CHANNEL_DB
      else process.env.KILO_DISABLE_CHANNEL_DB = origEnv
      ;(Global.Path as { data: string }).data = origData
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  custom("canonical kilo path selected when neither file exists and does not log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-core-db-canonical-"))
    const origData = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const origEnv = process.env.KILO_DISABLE_CHANNEL_DB
    delete process.env.KILO_DISABLE_CHANNEL_DB
    const warn = spyOn(Log.create({ service: "database" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const next = path.join(dir, `kilo-${safe}.db`)
      const prev = path.join(dir, `opencode-${safe}.db`)
      expect(fs.existsSync(next)).toBe(false)
      expect(fs.existsSync(prev)).toBe(false)
      const result = dbPath()
      expect(result).toBe(next)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      if (origEnv === undefined) delete process.env.KILO_DISABLE_CHANNEL_DB
      else process.env.KILO_DISABLE_CHANNEL_DB = origEnv
      ;(Global.Path as { data: string }).data = origData
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  custom("canonical wins when both kilo and opencode exist and does not log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-core-db-both-"))
    const origData = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const origEnv = process.env.KILO_DISABLE_CHANNEL_DB
    delete process.env.KILO_DISABLE_CHANNEL_DB
    const warn = spyOn(Log.create({ service: "database" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const next = path.join(dir, `kilo-${safe}.db`)
      const prev = path.join(dir, `opencode-${safe}.db`)
      await Bun.write(next, "")
      await Bun.write(prev, "")
      const result = dbPath()
      expect(result).toBe(next)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      if (origEnv === undefined) delete process.env.KILO_DISABLE_CHANNEL_DB
      else process.env.KILO_DISABLE_CHANNEL_DB = origEnv
      ;(Global.Path as { data: string }).data = origData
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  custom("disableChannelDb via env bypasses fallback and does not log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-core-db-disable-"))
    const origData = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const origEnv = process.env.KILO_DISABLE_CHANNEL_DB
    const warn = spyOn(Log.create({ service: "database" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const prev = path.join(dir, `opencode-${safe}.db`)
      await Bun.write(prev, "")
      process.env.KILO_DISABLE_CHANNEL_DB = "1"
      const result = dbPath()
      expect(result).toBe(path.join(dir, "kilo.db"))
      expect(warn).not.toHaveBeenCalled()

      process.env.KILO_DISABLE_CHANNEL_DB = "true"
      const result2 = dbPath()
      expect(result2).toBe(path.join(dir, "kilo.db"))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      ;(Global.Path as { data: string }).data = origData
      if (origEnv === undefined) delete process.env.KILO_DISABLE_CHANNEL_DB
      else process.env.KILO_DISABLE_CHANNEL_DB = origEnv
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  custom("KILO_DB override bypasses fallback and does not log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-core-db-flag-"))
    const origData = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const origFlag = Flag.KILO_DB
    const origEnv = process.env.KILO_DISABLE_CHANNEL_DB
    delete process.env.KILO_DISABLE_CHANNEL_DB
    const warn = spyOn(Log.create({ service: "database" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const prev = path.join(dir, `opencode-${safe}.db`)
      await Bun.write(prev, "")

      Flag.KILO_DB = ":memory:"
      expect(dbPath()).toBe(":memory:")
      expect(warn).not.toHaveBeenCalled()

      Flag.KILO_DB = "/tmp/custom-core-override.db"
      expect(dbPath()).toBe("/tmp/custom-core-override.db")
      expect(warn).not.toHaveBeenCalled()

      Flag.KILO_DB = "relative.db"
      expect(dbPath()).toBe(path.join(dir, "relative.db"))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      if (origEnv === undefined) delete process.env.KILO_DISABLE_CHANNEL_DB
      else process.env.KILO_DISABLE_CHANNEL_DB = origEnv
      Flag.KILO_DB = origFlag
      ;(Global.Path as { data: string }).data = origData
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("existing compatibility fallback still works when channel non-canonical", async () => {
    if (["latest", "beta", "prod"].includes(InstallationChannel)) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-core-db-compat-"))
    const origData = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const origEnv = process.env.KILO_DISABLE_CHANNEL_DB
    delete process.env.KILO_DISABLE_CHANNEL_DB
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const prev = path.join(dir, `opencode-${safe}.db`)
      await Bun.write(prev, "")
      expect(dbPath()).toBe(prev)
    } finally {
      if (origEnv === undefined) delete process.env.KILO_DISABLE_CHANNEL_DB
      else process.env.KILO_DISABLE_CHANNEL_DB = origEnv
      ;(Global.Path as { data: string }).data = origData
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
