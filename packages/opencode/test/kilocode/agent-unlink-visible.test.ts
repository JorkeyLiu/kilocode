// kilocode_change - P4.3 markdown unlink failure visibility (audit finding 3)
import { afterEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"

const originalConfig = Global.Path.config
afterEach(() => {
  ;(Global.Path as { config: string }).config = originalConfig
})

describe("P4.3 agent markdown unlink is visible, not silent (audit 3)", () => {
  test("source no longer swallows unlink errors and logs on failure", () => {
    const src = readFileSync(path.join(import.meta.dir, "../../src/kilocode/agent/index.ts"), "utf8")
    expect(src).not.toContain("unlink(m).catch(() => {})")
    expect(src).not.toContain(".catch(() => {})")
    // Must log or propagate — check for explicit error visibility
    expect(src).toContain("failed to delete agent markdown")
    expect(src).toContain("tapError")
    // localFound only after successful unlink — the success mark follows the Effect promise
    const unlinkIndex = src.indexOf("unlink(m)")
    const foundIndex = src.indexOf("localFound = true", unlinkIndex)
    expect(unlinkIndex).toBeGreaterThan(-1)
    expect(foundIndex).toBeGreaterThan(unlinkIndex)
    // Preserves lock ownership and atomic write semantics
    expect(src).toContain("KilocodeConfig.configDiscoveryGlobalKey")
    expect(src).toContain("KilocodeAtomicWrite.write")
    // Preserves partial multi-file limitation comment
    expect(src).toContain("not a single atomic filesystem")
  })

  test("unlink failure is propagated and does not report success", async () => {
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path

    const kiloDir = path.join(projectTmp.path, ".kilo")
    const agentDir = path.join(kiloDir, "agents")
    await mkdir(agentDir, { recursive: true })
    await Bun.write(path.join(agentDir, "fail-agent.md"), "# fail")
    const kiloFile = path.join(kiloDir, "kilo.jsonc")
    await Filesystem.write(kiloFile, JSON.stringify({ agent: { "fail-agent": { description: "x" } } }, null, 2))

    const mdPath = path.join(agentDir, "fail-agent.md")
    const { chmod } = await import("node:fs/promises")
    // Make parent directory unwritable so unlink throws EACCES (deterministic for non-root)
    await chmod(agentDir, 0o555)

    try {
      const { remove } = await import("../../src/kilocode/agent/index.ts")
      let threw = false
      try {
        await remove({
          name: "fail-agent",
          agent: { name: "fail-agent", native: false, options: {} } as any,
          dirs: [kiloDir],
          directory: projectTmp.path,
        })
      } catch (err) {
        threw = true
        expect(String(err).toLowerCase()).toMatch(/eacces|eperm|permission/)
      }
      expect(threw).toBe(true)
      // File still exists — localFound was not set for this entry
      expect(await Bun.file(mdPath).exists()).toBe(true)
      // Config entry must still be present (atomic write was not reached due to earlier failure)
      const after = JSON.parse(await Bun.file(kiloFile).text())
      expect(after.agent?.["fail-agent"]).toBeDefined()
    } finally {
      await chmod(agentDir, 0o755).catch(() => {})
    }
  })

  test("successful unlink still deletes and marks found", async () => {
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path

    const kiloDir = path.join(projectTmp.path, ".kilo")
    const agentDir = path.join(kiloDir, "agents")
    await mkdir(agentDir, { recursive: true })
    await Bun.write(path.join(agentDir, "ok-agent.md"), "# ok")
    const kiloFile = path.join(kiloDir, "kilo.jsonc")
    await Filesystem.write(kiloFile, JSON.stringify({ agent: { "ok-agent": { description: "x" } } }, null, 2))

    const { remove } = await import("../../src/kilocode/agent/index.ts")
    await remove({
      name: "ok-agent",
      agent: { name: "ok-agent", native: false, options: {} } as any,
      dirs: [kiloDir],
      directory: projectTmp.path,
    })

    expect(await Bun.file(path.join(agentDir, "ok-agent.md")).exists()).toBe(false)
    const after = JSON.parse(await Bun.file(kiloFile).text())
    expect(after.agent?.["ok-agent"]).toBeUndefined()
  })
})
