import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"

describe("test isolation preload", () => {
  test("Global.Path and Database.path resolve inside run-owned temp XDG root", async () => {
    const data = Global.Path.data
    const xdgData = process.env.XDG_DATA_HOME ?? ""
    const ownedMarker = "kilo-core-test-"
    const realHomeData = path.join(os.homedir(), ".local", "share", "kilo")

    // XDG_DATA_HOME must be owned temp when preload is active
    if (xdgData) {
      expect(xdgData).toContain(ownedMarker)
      // runRoot is the mkdtemp dir: XDG_DATA_HOME = <runRoot>/share
      const runRoot = path.dirname(xdgData)
      expect(path.basename(runRoot).startsWith(ownedMarker)).toBe(true)
      // prove runRoot is confined to tmpdir with correct separator boundary (real and lexical)
      const tmpReal = await fs.realpath(os.tmpdir()).catch(() => os.tmpdir())
      const tmpLex = os.tmpdir()
      const isLexConfined = runRoot === tmpReal || runRoot.startsWith(tmpReal + path.sep) || runRoot === tmpLex || runRoot.startsWith(tmpLex + path.sep)
      expect(isLexConfined).toBe(true)
      // also check via realpath
      const runReal = await fs.realpath(runRoot).catch(() => runRoot)
      const isRealConfined = runReal === tmpReal || runReal.startsWith(tmpReal + path.sep)
      expect(isRealConfined).toBe(true)
      expect(data).toContain(ownedMarker)
      // data is XDG_DATA_HOME/kilo
      expect(data).toBe(path.join(xdgData, "kilo"))
    } else {
      // fallback: preload not active — still ensure not real home if we expect isolation
      expect(data).toContain(ownedMarker)
    }

    expect(data).not.toBe(realHomeData)
    expect(data).not.toContain(path.join(os.homedir(), ".local", "share", "kilo") + path.sep + "kilo.db")

    const dbPath = Database.path()
    if (dbPath !== ":memory:") {
      expect(dbPath).toContain(ownedMarker)
      expect(dbPath).not.toBe(path.join(realHomeData, "kilo.db"))
      // db should be under the isolated data root, not real home
      expect(dbPath.startsWith(data) || dbPath.startsWith(xdgData)).toBe(true)
    }

    // Path.tmp remains system temp — unaffected by XDG isolation
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "kilo"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })
})
