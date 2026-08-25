// kilocode_change - P4.3 mode/modes retired (LOCK-002): agent removal must not touch mode/modes
import { describe, expect, test, afterEach } from "bun:test"
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

describe("P4.3 agent removal does not touch retired mode/modes assets", () => {
  test("canonical mode/modes files remain untouched while agent files/config are removed (project scope)", async () => {
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path

    const kiloDir = path.join(projectTmp.path, ".kilo")
    const agentFile = path.join(kiloDir, "agent", "victim.md")
    const agentsNestedFile = path.join(kiloDir, "agents", "nested", "victim.md")
    const modeFile = path.join(kiloDir, "mode", "victim.md")
    const modesFile = path.join(kiloDir, "modes", "victim.md")
    const modeNestedFile = path.join(kiloDir, "mode", "nested", "victim.md")

    await mkdir(path.join(kiloDir, "agent"), { recursive: true })
    await mkdir(path.join(kiloDir, "agents", "nested"), { recursive: true })
    await mkdir(path.join(kiloDir, "mode"), { recursive: true })
    await mkdir(path.join(kiloDir, "modes"), { recursive: true })
    await Bun.write(agentFile, "# agent victim")
    await Bun.write(agentsNestedFile, "# agents nested victim")
    await Bun.write(modeFile, "# mode victim — retired, must survive")
    await Bun.write(modesFile, "# modes victim — retired, must survive")
    // Also ensure a nested mode file outside the old non-recursive pattern stays
    await Bun.write(modeNestedFile, "# nested mode victim")

    const kiloFile = path.join(kiloDir, "kilo.jsonc")
    await Filesystem.write(kiloFile, JSON.stringify({ agent: { victim: { description: "to remove" }, keep: { description: "keep" } }, default_agent: "victim" }, null, 2))

    const { remove } = await import("../../src/kilocode/agent/index.ts")
    await remove({
      name: "victim",
      agent: { name: "victim", native: false, options: {} } as any,
      dirs: [kiloDir],
      directory: projectTmp.path,
    })

    // Agent markdown deleted (canonical patterns only)
    expect(await Bun.file(agentFile).exists()).toBe(false)
    expect(await Bun.file(agentsNestedFile).exists()).toBe(false)
    // Retired mode/modes untouched — no scan, no unlink
    expect(await Bun.file(modeFile).exists()).toBe(true)
    expect(await Bun.file(modesFile).exists()).toBe(true)
    expect(await Bun.file(modeNestedFile).exists()).toBe(true)

    // JSONC entry removed + default_agent cleared atomically; sibling kept
    const after = JSON.parse(await Bun.file(kiloFile).text())
    expect(after.agent?.victim).toBeUndefined()
    expect(after.agent?.keep).toBeDefined()
    expect(after.default_agent).toBeUndefined()
  })

  test("canonical mode/modes files remain untouched while global agent files are removed (global scope)", async () => {
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()
    ;(Global.Path as { config: string }).config = globalTmp.path

    const globalAgentFile = path.join(globalTmp.path, "agent", "g-victim.md")
    const globalModesFile = path.join(globalTmp.path, "modes", "g-victim.md")
    const globalModeFile = path.join(globalTmp.path, "mode", "g-victim.md")
    await mkdir(path.join(globalTmp.path, "agent"), { recursive: true })
    await mkdir(path.join(globalTmp.path, "modes"), { recursive: true })
    await mkdir(path.join(globalTmp.path, "mode"), { recursive: true })
    await Bun.write(globalAgentFile, "# global agent")
    await Bun.write(globalModesFile, "# retired global modes")
    await Bun.write(globalModeFile, "# retired global mode")

    const globalKiloFile = path.join(globalTmp.path, "kilo.jsonc")
    await Filesystem.write(globalKiloFile, JSON.stringify({ agent: { "g-victim": { description: "x" } } }, null, 2))

    const { remove } = await import("../../src/kilocode/agent/index.ts")
    await remove({
      name: "g-victim",
      agent: { name: "g-victim", native: false, options: {} } as any,
      dirs: [path.join(projectTmp.path, ".kilo")],
      directory: projectTmp.path,
    })

    expect(await Bun.file(globalAgentFile).exists()).toBe(false)
    expect(await Bun.file(globalModesFile).exists()).toBe(true)
    expect(await Bun.file(globalModeFile).exists()).toBe(true)
    const after = JSON.parse(await Bun.file(globalKiloFile).text())
    expect(after.agent?.["g-victim"]).toBeUndefined()
  })

  test("source no longer scans or mentions mode/modes", () => {
    const src = readFileSync(path.join(import.meta.dir, "../../src/kilocode/agent/index.ts"), "utf8")
    expect(src).not.toContain("{mode,modes}")
    expect(src).not.toContain("mode,modes")
    // Protects the sole canonical pattern remains
    expect(src).toContain('{agent,agents}/**/" + name + ".md')
    expect(src).toContain("Retired `mode`/`modes` assets are never scanned or deleted here (P4.3)")
    // Shared discovery lock + atomic write preserved
    expect(src).toContain("KilocodeConfig.configDiscoveryGlobalKey")
    expect(src).toContain("KilocodeConfig.configDiscoveryProjectKey")
    expect(src).toContain("KilocodeAtomicWrite.write")
    expect(src).toContain("KilocodeConfigOverlay.globalTarget()")
    expect(src).toContain("KilocodeConfigOverlay.projectTarget")
  })
})
