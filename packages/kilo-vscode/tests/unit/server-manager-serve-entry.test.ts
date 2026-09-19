import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  resolveCliPath,
  resolveServeBinaryName,
  resolveFullBinaryName,
} from "../../src/services/cli-backend/server-manager"

describe("resolveCliPath serve-only preference", () => {
  let root = ""

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-serve-entry-"))
    fs.mkdirSync(path.join(root, "bin"), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("prefers bin/kilo-serve when present", () => {
    fs.writeFileSync(path.join(root, "bin", "kilo"), "full")
    fs.writeFileSync(path.join(root, "bin", "kilo-serve"), "serve")
    expect(resolveCliPath(root)).toBe(path.join(root, "bin", "kilo-serve"))
  })

  it("falls back to bin/kilo when kilo-serve is absent", () => {
    fs.writeFileSync(path.join(root, "bin", "kilo"), "full")
    expect(resolveCliPath(root)).toBe(path.join(root, "bin", "kilo"))
  })

  it("falls back to bin/kilo when bin is empty", () => {
    expect(resolveCliPath(root)).toBe(path.join(root, "bin", "kilo"))
  })

  it("benchmark override still wins over kilo-serve", () => {
    fs.writeFileSync(path.join(root, "bin", "kilo-serve"), "serve")
    const snap = path.join(root, "snap-kilo")
    fs.writeFileSync(snap, "snap")
    expect(resolveCliPath(root, { KILO_P0_BACKEND_CLI: snap })).toBe(snap)
  })

  it("resolves platform binary names", () => {
    expect(resolveServeBinaryName("win32")).toBe("kilo-serve.exe")
    expect(resolveServeBinaryName("darwin")).toBe("kilo-serve")
    expect(resolveFullBinaryName("win32")).toBe("kilo.exe")
    expect(resolveFullBinaryName("darwin")).toBe("kilo")
  })
})
