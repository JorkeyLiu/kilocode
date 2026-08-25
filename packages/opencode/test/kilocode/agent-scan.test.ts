// kilocode_change - P4.3 scan error narrowing (Finding 2)
// Glob.scan ENOENT-as-empty, non-ENOENT must be visible/propagated.

import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import { Glob } from "@opencode-ai/core/util/glob"
import { remove } from "../../src/kilocode/agent"
import type { Info as AgentInfo } from "../../src/agent/agent"
import { tmpdir } from "../fixture/fixture"

const originalScan = Glob.scan

afterEach(() => {
  // restore
  ;(Glob as unknown as { scan: typeof originalScan }).scan = originalScan
})

describe("Kilo agent Glob.scan error handling (P4.3)", () => {
  test("ENOENT scan returns empty and allows config removal to proceed", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, ".kilo")
    const file = path.join(dir, "kilo.jsonc")
    await mkdir(dir, { recursive: true })
    await Bun.write(file, JSON.stringify({ agent: { "scan-enoent": { description: "x" } } }, null, 2))

    // Simulate missing asset dir: Glob.scan throws ENOENT
    ;(Glob as unknown as { scan: typeof originalScan }).scan = (() =>
      Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))) as unknown as typeof originalScan

    await remove({
      name: "scan-enoent",
      agent: { name: "scan-enoent", native: false, options: {} } as AgentInfo,
      dirs: [dir],
      directory: tmp.path,
    })

    const cfg = parseJsonc(await Bun.file(file).text())
    expect(cfg.agent?.["scan-enoent"]).toBeUndefined()
  })

  test("non-ENOENT scan error is visible and propagated (not swallowed as empty)", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, ".kilo")
    const file = path.join(dir, "kilo.jsonc")
    await mkdir(dir, { recursive: true })
    await Bun.write(file, JSON.stringify({ agent: { "scan-fail": { description: "x" } } }, null, 2))

    const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    ;(Glob as unknown as { scan: typeof originalScan }).scan = (() => Promise.reject(err)) as unknown as typeof originalScan

    let threw = false
    try {
      await remove({
        name: "scan-fail",
        agent: { name: "scan-fail", native: false, options: {} } as AgentInfo,
        dirs: [dir],
        directory: tmp.path,
      })
    } catch (e) {
      threw = true
      expect(String(e)).toContain("EACCES")
    }
    expect(threw).toBe(true)

    // Config file must remain unchanged (no silent no-match removal)
    const cfg = parseJsonc(await Bun.file(file).text())
    expect(cfg.agent?.["scan-fail"]).toBeDefined()

    // Unlink failures remain visible: simulate unlink EACCES via real file permission? Skip — unlink path already uses log+orDie.
  })
})
