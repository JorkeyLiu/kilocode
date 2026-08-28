import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "../../../src/storage/db"

const custom = ["latest", "beta", "prod"].includes(InstallationChannel) ? test.skip : test

afterEach(() => {
  mock.restore()
})

describe("opencode storage db fallback observability", () => {
  custom("fallback still returns legacy opencode db when only legacy exists and logs warn exactly once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-db-fallback-opencode-"))
    const orig = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const warn = spyOn(Log.create({ service: "db" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const next = path.join(dir, `kilo-${safe}.db`)
      const prev = path.join(dir, `opencode-${safe}.db`)
      const sentinel = "kilo-secret-sentinel-9f2c1e7a-do-not-leak"
      expect(fs.existsSync(next)).toBe(false)
      await Bun.write(prev, sentinel)
      expect(fs.existsSync(prev)).toBe(true)

      const result = Database.getChannelPath({ disableChannelDb: false })
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
      ;(Global.Path as { data: string }).data = orig
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  custom("canonical kilo path selected when neither file exists and does not log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-db-canonical-"))
    const orig = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const warn = spyOn(Log.create({ service: "db" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const next = path.join(dir, `kilo-${safe}.db`)
      const prev = path.join(dir, `opencode-${safe}.db`)
      expect(fs.existsSync(next)).toBe(false)
      expect(fs.existsSync(prev)).toBe(false)

      const result = Database.getChannelPath({ disableChannelDb: false })
      expect(result).toBe(next)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      ;(Global.Path as { data: string }).data = orig
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  custom("canonical wins when both kilo and opencode exist and does not log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-db-both-"))
    const orig = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const warn = spyOn(Log.create({ service: "db" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const next = path.join(dir, `kilo-${safe}.db`)
      const prev = path.join(dir, `opencode-${safe}.db`)
      await Bun.write(next, "")
      await Bun.write(prev, "")
      const result = Database.getChannelPath({ disableChannelDb: false })
      expect(result).toBe(next)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      ;(Global.Path as { data: string }).data = orig
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  custom("disableChannelDb bypasses fallback and does not log even when legacy exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-db-disable-"))
    const orig = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const warn = spyOn(Log.create({ service: "db" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const prev = path.join(dir, `opencode-${safe}.db`)
      await Bun.write(prev, "")
      const result = Database.getChannelPath({ disableChannelDb: true })
      expect(result).toBe(path.join(dir, "kilo.db"))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      ;(Global.Path as { data: string }).data = orig
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  custom("KILO_DB override bypasses fallback and does not log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-db-flag-"))
    const origData = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    const origFlag = Flag.KILO_DB
    const warn = spyOn(Log.create({ service: "db" }), "warn")
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const prev = path.join(dir, `opencode-${safe}.db`)
      await Bun.write(prev, "")
      Flag.KILO_DB = ":memory:"
      const result = Database.getPath({ disableChannelDb: false })
      expect(result).toBe(":memory:")
      expect(warn).not.toHaveBeenCalled()

      // absolute override
      Flag.KILO_DB = "/tmp/custom-kilo-override.db"
      const result2 = Database.getPath({ disableChannelDb: false })
      expect(result2).toBe("/tmp/custom-kilo-override.db")
      expect(warn).not.toHaveBeenCalled()

      // relative override should still join with data dir but bypass fallback
      Flag.KILO_DB = "relative.db"
      const result3 = Database.getPath({ disableChannelDb: false })
      expect(result3).toBe(path.join(dir, "relative.db"))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      Flag.KILO_DB = origFlag
      ;(Global.Path as { data: string }).data = origData
      mock.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("existing compatibility fallback test still passes for non-canonical channel", async () => {
    if (["latest", "beta", "prod"].includes(InstallationChannel)) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-db-compat-"))
    const orig = Global.Path.data
    ;(Global.Path as { data: string }).data = dir
    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const old = path.join(dir, `opencode-${safe}.db`)
      await Bun.write(old, "")
      expect(Database.getChannelPath({ disableChannelDb: false })).toBe(old)
    } finally {
      ;(Global.Path as { data: string }).data = orig
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
