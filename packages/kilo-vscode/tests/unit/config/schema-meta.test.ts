/**
 * $schema meta-key — benign closed-registry member.
 *
 * The CLI backend injects `$schema` into kilo.jsonc in both scopes
 * (project seed and global seed). The extension's closed registry must
 * accept it while every other closure guarantee stays intact.
 *
 * Covers:
 * - validateConfig accepts `$schema` in global and project scopes
 * - Non-string `$schema` is rejected
 * - Regression: the exact E2E failure sequence (seeded files without
 *   `$schema` → backend-injected bytes with `$schema` → full parse +
 *   validate + materialize) passes with zero errors
 * - Materialization semantics: `$schema` never enters the materialized
 *   value; content hash is identical whether it is present or absent
 * - Closure guarantee: all other unknown keys remain rejected
 */

import { describe, expect, it, beforeEach } from "bun:test"
import { validateConfig } from "../../../src/config/validate"
import { materialize, resetVersion } from "../../../src/config/materialize"
import type { ScopedContent } from "../../../src/config/types"

const SCHEMA_URL = "https://app.kilo.ai/config.json"

function makeScope(scope: "global" | "project", raw: Record<string, unknown>): ScopedContent {
  return {
    scope,
    root: scope === "global" ? "/global" : "/project",
    raw,
    provenance: {
      scope,
      canonicalPath: `${scope}:/test`,
      operator: "single",
      explicit: true,
    },
  }
}

beforeEach(() => {
  resetVersion()
})

describe("$schema accepted in both scopes", () => {
  it("accepts $schema in global scope", () => {
    const result = validateConfig(
      JSON.stringify({ $schema: SCHEMA_URL, model: "anthropic/claude-sonnet-4-20250514" }),
      "global",
      "kilo.jsonc",
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("accepts $schema in project scope", () => {
    const result = validateConfig(
      JSON.stringify({ $schema: SCHEMA_URL, model: "anthropic/claude-sonnet-4-20250514" }),
      "project",
      ".kilo/kilo.jsonc",
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("accepts $schema alone with no other fields", () => {
    const result = validateConfig(JSON.stringify({ $schema: SCHEMA_URL }), "global", "kilo.jsonc")
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe("$schema value validation", () => {
  it("rejects non-string number", () => {
    const result = validateConfig(JSON.stringify({ $schema: 42 }), "global", "kilo.jsonc")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path[0] === "$schema")).toBe(true)
  })

  it("rejects non-string object", () => {
    const result = validateConfig(JSON.stringify({ $schema: { url: SCHEMA_URL } }), "project", "kilo.jsonc")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path[0] === "$schema")).toBe(true)
  })

  it("rejects empty string", () => {
    const result = validateConfig(JSON.stringify({ $schema: "" }), "global", "kilo.jsonc")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path[0] === "$schema")).toBe(true)
  })
})

describe("closure guarantees intact alongside $schema", () => {
  it("still rejects unrelated unknown keys when $schema is present", () => {
    const result = validateConfig(
      JSON.stringify({ $schema: SCHEMA_URL, server: {}, compaction: {} }),
      "global",
      "kilo.jsonc",
    )
    expect(result.valid).toBe(false)
    const unknownKeys = result.errors.filter((e) => e.message.includes("Unknown config key"))
    expect(unknownKeys).toHaveLength(2)
  })
})

describe("E2E regression: backend injection sequence", () => {
  it("seeded files without $schema pass, then injected bytes pass end-to-end", () => {
    // Step 1 — seeded state (no $schema): parses and validates cleanly
    const seedGlobal = '{\n  "model": "anthropic/claude-sonnet-4-20250514"\n}\n'
    const seedProject = '{\n  "permission": { "bash": "allow" }\n}\n'
    const seededGlobal = validateConfig(seedGlobal, "global", "kilo.jsonc")
    const seededProject = validateConfig(seedProject, "project", ".kilo/kilo.jsonc")
    expect(seededGlobal.valid).toBe(true)
    expect(seededProject.valid).toBe(true)

    // Step 2 — the CLI backend injects $schema into both files. These are
    // the exact byte shapes that previously produced exactly 2 errors:
    // `Unknown config key "$schema" — registry is closed`.
    const injectedGlobalText = `{\n  "$schema": "${SCHEMA_URL}",\n  "model": "anthropic/claude-sonnet-4-20250514"\n}\n`
    const injectedProjectText = `{\n  "$schema": "${SCHEMA_URL}",\n  "permission": { "bash": "allow" }\n}\n`
    const injectedGlobal = validateConfig(injectedGlobalText, "global", "kilo.jsonc")
    const injectedProject = validateConfig(injectedProjectText, "project", ".kilo/kilo.jsonc")

    // Step 3 — full initialize-equivalent: parse + validate + materialize
    expect(injectedGlobal.valid).toBe(true)
    expect(injectedGlobal.errors).toHaveLength(0)
    expect(injectedProject.valid).toBe(true)
    expect(injectedProject.errors).toHaveLength(0)

    const result = materialize({
      global: makeScope("global", injectedGlobal.parsed!),
      project: makeScope("project", injectedProject.parsed!),
    })
    expect(result.errors).toHaveLength(0)
    // $schema is present in both scopes yet never conflicts and never
    // appears in the materialized value
    expect(result.config.value.$schema).toBeUndefined()
    expect(Object.keys(result.config.value).sort()).toEqual(["model", "permission"])
  })
})

describe("materialization/hash semantics for $schema presence", () => {
  it("hash is identical whether $schema is present or absent", () => {
    resetVersion()
    const withSchema = materialize({
      global: makeScope("global", { $schema: SCHEMA_URL, model: "a/m" }),
      project: null,
    })
    resetVersion()
    const withoutSchema = materialize({
      global: makeScope("global", { model: "a/m" }),
      project: null,
    })
    expect(withSchema.config.value.$schema).toBeUndefined()
    expect(withoutSchema.config.value.$schema).toBeUndefined()
    // Deterministic identity ignores the meta-key entirely
    expect(withSchema.config.contentHash).toBe(withoutSchema.config.contentHash)
    expect(withSchema.config.fields.map((f) => f.key)).toEqual(["model"])
  })

  it("different $schema values do not change the hash", () => {
    resetVersion()
    const a = materialize({
      global: makeScope("global", { $schema: "https://a.example/schema.json", model: "a/m" }),
      project: null,
    })
    resetVersion()
    const b = materialize({
      global: makeScope("global", { $schema: "https://b.example/schema.json", model: "a/m" }),
      project: null,
    })
    expect(a.config.contentHash).toBe(b.config.contentHash)
  })

  it("$schema in both scopes does not conflict during composition", () => {
    const result = materialize({
      global: makeScope("global", { $schema: SCHEMA_URL, model: "a/m" }),
      project: makeScope("project", { $schema: SCHEMA_URL }),
    })
    expect(result.errors).toHaveLength(0)
    expect(result.config.contentHash).toMatch(/^[0-9a-f]{16}$/)
  })
})
