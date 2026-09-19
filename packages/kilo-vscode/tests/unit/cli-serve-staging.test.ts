import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const LOCAL_BIN = fs.readFileSync(path.join(ROOT, "script", "local-bin.ts"), "utf8")
const WATCH_CLI = fs.readFileSync(path.join(ROOT, "script", "watch-cli.ts"), "utf8")

describe("watch-cli serve staging — Windows naming", () => {
  it("derives kilo/kilo-serve names by platform (no hardcoded extensionless)", () => {
    expect(WATCH_CLI).toContain('kilo.exe')
    expect(WATCH_CLI).toContain('kilo-serve.exe')
    expect(WATCH_CLI).toContain('process.platform === "win32"')
  })

  it("maps win32 to the windows dist tag like local-bin", () => {
    expect(WATCH_CLI).toContain('"windows"')
    expect(WATCH_CLI).toContain("platformTag")
    expect(WATCH_CLI).toContain("binName")
    expect(WATCH_CLI).toContain("serveName")
  })

  it("skips chmod for the Windows executables", () => {
    expect(WATCH_CLI).toContain('!== "kilo-serve.exe"')
  })
})

describe("local-bin serve staging — missing serve binary", () => {
  it("tracks the serve binary next to kilo", () => {
    expect(LOCAL_BIN).toContain("targetServePath")
    expect(LOCAL_BIN).toContain("kilo-serve.exe")
    expect(LOCAL_BIN).toContain("serveExists")
  })

  it("treats kilo-present/serve-missing as not ready", () => {
    expect(LOCAL_BIN).toContain("serveExists || wrapper")
    expect(LOCAL_BIN).toContain("kiloReady")
  })

  it("keeps the source-wrapper fallback (missing serve stays valid there)", () => {
    expect(LOCAL_BIN).toContain("isSourceWrapper")
    expect(LOCAL_BIN).toContain("keeping full-CLI fallback")
  })

  it("copies serve from dist without a full rebuild when kilo is fresh", () => {
    expect(LOCAL_BIN).toContain("copyServeBinary")
    expect(LOCAL_BIN).toContain("findKiloBinaryInOpencodeDist")
  })
})
