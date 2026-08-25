import { describe, expect, test, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
import { Global } from "@opencode-ai/core/global"
import { KilocodeConfigOverlay } from "../../src/kilocode/config/overlay"

const original = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
})

describe("P4.3 overlay — mode/modes not in retained effective config", () => {
  test("project .kilo/mode(s) files do not enter overlay", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilocode-p43-mode-project-"))
    try {
      const kiloDir = path.join(tmp, ".kilo")
      await fs.mkdir(path.join(kiloDir, "agent"), { recursive: true })
      await fs.mkdir(path.join(kiloDir, "mode"), { recursive: true })
      await fs.mkdir(path.join(kiloDir, "modes"), { recursive: true })

      await Bun.write(
        path.join(kiloDir, "agent", "good.md"),
        `---\ndescription: good agent\nmode: primary\n---\ngood prompt`,
      )
      await Bun.write(
        path.join(kiloDir, "mode", "bad.md"),
        `---\ndescription: bad mode\nmode: primary\n---\nbad prompt`,
      )
      await Bun.write(
        path.join(kiloDir, "modes", "bad2.md"),
        `---\ndescription: bad2 mode\nmode: primary\n---\nbad2 prompt`,
      )

      const result = await KilocodeConfigOverlay.resolve({
        directory: tmp,
        scope: "project",
        effective: {},
        global: {},
        sources: [],
      })

      expect(result.project.agent?.good).toBeDefined()
      expect(result.project.agent?.bad).toBeUndefined()
      expect(result.project.agent?.bad2).toBeUndefined()
      // ensure retired mode files did not create agents
      expect(Object.keys(result.project.agent ?? {})).toEqual(["good"])
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("global mode/modes files do not enter overlay", async () => {
    const tmpGlobal = await fs.mkdtemp(path.join(os.tmpdir(), "kilocode-p43-mode-global-"))
    const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "kilocode-p43-mode-global-project-"))
    try {
      ;(Global.Path as { config: string }).config = tmpGlobal
      await fs.mkdir(path.join(tmpGlobal, "agent"), { recursive: true })
      await fs.mkdir(path.join(tmpGlobal, "mode"), { recursive: true })
      await fs.mkdir(path.join(tmpGlobal, "modes"), { recursive: true })

      await Bun.write(
        path.join(tmpGlobal, "agent", "global-good.md"),
        `---\ndescription: global good\nmode: primary\n---\nglobal good prompt`,
      )
      await Bun.write(
        path.join(tmpGlobal, "mode", "global-bad.md"),
        `---\ndescription: global bad\nmode: primary\n---\nglobal bad prompt`,
      )
      await Bun.write(
        path.join(tmpGlobal, "modes", "global-bad2.md"),
        `---\ndescription: global bad2\nmode: primary\n---\nglobal bad2 prompt`,
      )

      await fs.mkdir(path.join(tmpProject, ".kilo"), { recursive: true })

      const result = await KilocodeConfigOverlay.resolve({
        directory: tmpProject,
        scope: "project",
        effective: {},
        global: {},
        sources: [],
      })

      expect(result.global.agent?.["global-good"]).toBeDefined()
      expect(result.global.agent?.["global-bad"]).toBeUndefined()
      expect(result.global.agent?.["global-bad2"]).toBeUndefined()
    } finally {
      ;(Global.Path as { config: string }).config = original
      await fs.rm(tmpGlobal, { recursive: true, force: true }).catch(() => {})
      await fs.rm(tmpProject, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("overlay withAgents loads only canonical agent dirs, not mode/modes", async () => {
    const overlaySrc = readFileSync(path.join(import.meta.dir, "../../src/kilocode/config/overlay.ts"), "utf8")
    expect(overlaySrc).not.toContain("{mode,modes}")
    expect(overlaySrc).toContain('ConfigAgent.load(')
    // globalDirs and projectDirs must be canonical only
    expect(overlaySrc).toContain("return [Global.Path.config]")
    expect(overlaySrc).toContain('path.join(root, ".kilo")')
    expect(overlaySrc).not.toContain('".kilocode"')
    expect(overlaySrc).not.toContain('".kilo/.kilo"')
  })

  test("guidance strings distinguish global vs project canonical roots", async () => {
    const skill = readFileSync(path.join(import.meta.dir, "../../src/kilocode/skills/kilo-config.md"), "utf8")
    const prompt = readFileSync(path.join(import.meta.dir, "../../src/kilocode/system-prompt.ts"), "utf8")
    const docs = readFileSync(
      path.join(import.meta.dir, "../../../kilo-docs/pages/contributing/architecture/cli-runtime.md"),
      "utf8",
    )

    // skill: global assets directly under Global.Path.config, not .kilo subdirectory
    expect(skill).toContain("${Global.Path.config}/{command,commands,agent,agents,skill,skills,rules}")
    expect(skill).toContain("directly under the global")
    expect(skill).not.toContain("~/.config/kilo/.kilo")
    expect(skill).not.toContain("same .kilo structure")
    expect(skill).not.toContain("| Mode |")

    // system prompt: distinguishes global vs project
    expect(prompt).toContain("assets directly under ${Global.Path.config}/")
    expect(prompt).toContain("project: canonicalRoot/.kilo/")
    expect(prompt).not.toContain("same .kilo structure")

    // docs: global typed assets distinction
    expect(docs).toContain("plus `${Global.Path.config}/{agent,agents,command,commands,skill,skills,rules}` typed assets directly under the global root")
    expect(docs).toContain("no `${Global.Path.config}/.kilo/` subdirectory")
    // deferred source inventory note
    expect(docs).toContain("KilocodeConfigSources")
    expect(docs).toContain("not effective-config authority")

    // skill deferred note
    expect(skill).toContain("KilocodeConfigSources")
    expect(skill).toContain("not effective-config authority")
  })
})
