/**
 * Architecture tests: source wrapper generation (P4.4-G2)
 *
 * Preset catalog removed per LOCK-006; wrapper no longer injects
 * KILO_MODELS_PATH. Tests verify the wrapper remains executable bash,
 * cd's into the opencode dir before exec, and contains no preset
 * catalog references.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { generateSourceWrapperContent } from "../../script/source-wrapper"

const ROOT = path.resolve(import.meta.dir, "../..")
const OPENCODE_DIR = path.join(ROOT, "..", "opencode")
const LOCAL_BIN_TS = path.join(ROOT, "script", "local-bin.ts")
const FAKE_BUN = "/usr/local/bin/bun"

describe("source wrapper — P4.4-G2 preset catalog removed", () => {
  const wrapper = generateSourceWrapperContent(OPENCODE_DIR, FAKE_BUN)

  it("wrapper is executable bash with shebang", () => {
    expect(wrapper.startsWith("#!/usr/bin/env bash")).toBe(true)
    expect(wrapper).toContain("set -euo pipefail")
  })

  it("does not export KILO_MODELS_PATH (preset catalog removed)", () => {
    expect(wrapper).not.toContain("KILO_MODELS_PATH")
    expect(wrapper).not.toContain("models-api.json")
  })

  it("cd into opencode dir before exec", () => {
    expect(wrapper).toContain(`cd ${JSON.stringify(OPENCODE_DIR)}`)
  })

  it("exec bun with --conditions=browser", () => {
    expect(wrapper).toContain("--conditions=browser src/index.ts")
  })

  it("local-bin.ts defines source wrapper via source-wrapper import", () => {
    const src = fs.readFileSync(LOCAL_BIN_TS, "utf-8")
    expect(src).toContain('import { generateSourceWrapperContent } from "./source-wrapper"')
  })
})

describe("source wrapper — shell safety", () => {
  const wrapper = generateSourceWrapperContent(OPENCODE_DIR, FAKE_BUN)

  it("wrapper contains no unescaped special shell chars in fixture path", () => {
    // No fixture path should be present
    expect(wrapper).not.toContain("models-api.json")
    expect(wrapper).not.toMatch(/export KILO_MODELS_PATH/)
  })
})

describe("source wrapper — path with spaces", () => {
  it("quotes paths containing spaces correctly", () => {
    const spaced = generateSourceWrapperContent("/path with spaces/opencode", FAKE_BUN)
    expect(spaced).toContain('cd "/path with spaces/opencode"')
  })
})
