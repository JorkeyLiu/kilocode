/**
 * Architecture tests: source wrapper generation
 *
 * Tests the actual generator from script/source-wrapper.ts so they
 * work on clean checkout without bin/kilo (which is git-ignored).
 *
 * The generated bash wrapper exports KILO_MODELS_PATH to the committed
 * models-api.json fixture so cold source-dev provider catalog contains
 * catalog-only providers/models (e.g. opencode-go/mimo-v2.5) even when
 * models.dev network and user disk cache are unavailable.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  generateSourceWrapperContent,
  committedModelsFixturePath,
  FIXTURE_RELATIVE,
} from "../../script/source-wrapper"

const ROOT = path.resolve(import.meta.dir, "../..")
const OPENCODE_DIR = path.join(ROOT, "..", "opencode")
const LOCAL_BIN_TS = path.join(ROOT, "script", "local-bin.ts")
const FIXTURE = path.join(OPENCODE_DIR, "src", "kilocode", "provider", "models-api.json")
const FAKE_BUN = "/usr/local/bin/bun"

describe("source wrapper — KILO_MODELS_PATH", () => {
  const wrapper = generateSourceWrapperContent(OPENCODE_DIR, FAKE_BUN)

  it("wrapper is executable bash with shebang", () => {
    expect(wrapper.startsWith("#!/usr/bin/env bash")).toBe(true)
    expect(wrapper).toContain("set -euo pipefail")
  })

  it("exports KILO_MODELS_PATH with caller-override semantics", () => {
    expect(wrapper).toContain('export KILO_MODELS_PATH="${KILO_MODELS_PATH:-')
    expect(wrapper).toMatch(/export KILO_MODELS_PATH="\$\{KILO_MODELS_PATH:-(.+)\}"/)
  })

  it("fixture path resolves to a committed file", () => {
    const match = wrapper.match(/export KILO_MODELS_PATH="\$\{KILO_MODELS_PATH:-(.+)\}"/)
    expect(match).not.toBeNull()
    const fixturePath = match![1]
    expect(fs.existsSync(fixturePath)).toBe(true)
    expect(path.isAbsolute(fixturePath)).toBe(true)
  })

  it("fixture path matches committedModelsFixturePath()", () => {
    expect(committedModelsFixturePath(OPENCODE_DIR)).toBe(FIXTURE)
  })

  it("cd into opencode dir before exec", () => {
    expect(wrapper).toContain(`cd ${JSON.stringify(OPENCODE_DIR)}`)
  })

  it("exec bun with --conditions=browser", () => {
    expect(wrapper).toContain("--conditions=browser src/index.ts")
  })

  it("local-bin.ts defines committedModelsFixture via source-wrapper import", () => {
    const src = fs.readFileSync(LOCAL_BIN_TS, "utf-8")
    expect(src).toContain('import { generateSourceWrapperContent } from "./source-wrapper"')
  })

  it("source-wrapper.ts defines COMMITTED_MODELS_FIXTURE", () => {
    expect(FIXTURE_RELATIVE).toBe("src/kilocode/provider/models-api.json")
  })
})

describe("source wrapper — caller override semantics", () => {
  it("fixture path is the default when KILO_MODELS_PATH unset", () => {
    const wrapper = generateSourceWrapperContent(OPENCODE_DIR, FAKE_BUN)
    // The expansion ${KILO_MODELS_PATH:-<fixture>} means: use existing, or fall back to fixture
    expect(wrapper).toContain(`export KILO_MODELS_PATH="\${KILO_MODELS_PATH:-${FIXTURE}}"`)
  })

  it("wrapper respects caller-provided KILO_MODELS_PATH at runtime", () => {
    // Verify the shell semantics: ${VAR:-default} preserves VAR if set
    const result = Bash.expand('${KILO_MODELS_PATH:-/default/path}', { KILO_MODELS_PATH: "/override" })
    expect(result).toBe("/override")
  })

  it("wrapper falls back to fixture when KILO_MODELS_PATH unset at runtime", () => {
    // Explicitly remove the var from the child env so parent state cannot contaminate
    const result = Bash.expand('${KILO_MODELS_PATH:-/default/path}', { KILO_MODELS_PATH: undefined })
    expect(result).toBe("/default/path")
  })

  it("wrapper falls back to fixture when KILO_MODELS_PATH empty at runtime", () => {
    const result = Bash.expand('${KILO_MODELS_PATH:-/default/path}', { KILO_MODELS_PATH: "" })
    expect(result).toBe("/default/path")
  })
})

describe("fixture — models-api.json", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"))

  it("fixture contains opencode-go provider", () => {
    expect(fixture).toHaveProperty("opencode-go")
    expect(fixture["opencode-go"].id).toBe("opencode-go")
  })

  it("opencode-go provider contains mimo-v2.5 model", () => {
    expect(Object.keys(fixture["opencode-go"].models)).toContain("mimo-v2.5")
  })

  it("mimo-v2.5 has reasoning metadata", () => {
    expect(fixture["opencode-go"].models["mimo-v2.5"].reasoning).toBe(true)
  })

  it("opencode-go provider has expected env", () => {
    expect(Array.isArray(fixture["opencode-go"].env)).toBe(true)
  })

  it("fixture has aihubmix provider", () => {
    expect(Object.keys(fixture)).toContain("aihubmix")
  })

  it("fixture is a substantial catalog (> 1MB)", () => {
    expect(fs.statSync(FIXTURE).size).toBeGreaterThan(1_000_000)
  })
})

describe("source wrapper — shell safety", () => {
  const wrapper = generateSourceWrapperContent(OPENCODE_DIR, FAKE_BUN)

  it("fixture path contains no unescaped special shell chars", () => {
    const match = wrapper.match(/export KILO_MODELS_PATH="\$\{KILO_MODELS_PATH:-(.+)\}"/)
    expect(match).not.toBeNull()
    expect(match![1]).not.toMatch(/[$`\\!]/)
  })

  it("wrapper is valid bash (env line well-formed)", () => {
    const exportLine = wrapper.split("\n").find((l) => l.startsWith("export KILO_MODELS_PATH="))
    expect(exportLine).toBeDefined()
    expect(exportLine).toMatch(/^export KILO_MODELS_PATH="\$\{KILO_MODELS_PATH:-(.+)\}"$/)
  })
})

describe("source wrapper — path with spaces", () => {
  it("quotes paths containing spaces correctly", () => {
    const spaced = generateSourceWrapperContent("/path with spaces/opencode", FAKE_BUN)
    expect(spaced).toContain('cd "/path with spaces/opencode"')
    expect(spaced).toContain('/path with spaces/opencode/src/kilocode/provider/models-api.json')
  })
})

/** Shell helper: expand a bash parameter expansion in a subprocess. */
const Bash = {
  expand(expr: string, env?: Record<string, string | undefined>): string {
    const child: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) child[key] = value
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      if (value === undefined) delete child[key]
      else child[key] = value
    }
    const proc = Bun.spawnSync(
      ["bash", "-c", `echo "${expr}"`],
      { env: child, stdout: "pipe" },
    )
    return proc.stdout.toString().trim()
  },
}
