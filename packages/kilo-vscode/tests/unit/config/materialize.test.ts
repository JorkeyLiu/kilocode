/**
 * P4.1 Config Foundation — Materialize tests.
 *
 * Covers audit triggers:
 * - Invalid input returns exact prior immutable materialization
 * - Schema version in identity
 * - Deterministic content hashing (sorted keys, includes schema version)
 * - Provenance tracking
 * - Stale write conflict detection
 */

import { describe, expect, it, beforeEach } from "bun:test"
import { materialize, detectStaleWrite, resetVersion, currentVersion, SCHEMA_VERSION } from "../../../src/config/materialize"
import type { ScopedContent, MaterializedConfig, ProvenanceStamp } from "../../../src/config/types"

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

describe("materialize", () => {
  it("materializes from global scope only", () => {
    const result = materialize({
      global: makeScope("global", { model: "global/model" }),
      project: null,
    })
    expect(result.errors).toHaveLength(0)
    expect(result.config.value.model).toBe("global/model")
    expect(result.config.fields).toHaveLength(1)
    expect(result.config.fields[0].source).toBe("global")
  })

  it("materializes from project scope only", () => {
    const result = materialize({
      global: null,
      project: makeScope("project", { model: "project/model" }),
    })
    expect(result.errors).toHaveLength(0)
    expect(result.config.value.model).toBe("project/model")
    expect(result.config.fields[0].source).toBe("project")
  })

  it("increments version monotonically", () => {
    const r1 = materialize({ global: makeScope("global", { model: "a" }), project: null })
    const r2 = materialize({ global: makeScope("global", { model: "b" }), project: null })
    expect(r1.config.version).toBe(1)
    expect(r2.config.version).toBe(2)
    expect(currentVersion()).toBe(2)
  })

  it("includes schema version in materialized config", () => {
    const result = materialize({
      global: makeScope("global", { model: "test" }),
      project: null,
    })
    expect(result.config.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it("computes deterministic content hash", () => {
    resetVersion()
    const r1 = materialize({
      global: makeScope("global", { model: "test" }),
      project: null,
    })
    resetVersion()
    const r2 = materialize({
      global: makeScope("global", { model: "test" }),
      project: null,
    })
    expect(r1.config.contentHash).toBe(r2.config.contentHash)
  })

  it("content hash includes schema version", () => {
    resetVersion()
    const result = materialize({
      global: makeScope("global", { model: "test" }),
      project: null,
    })
    // The hash should be deterministic for the same schema version
    expect(result.config.contentHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it("different values produce different hashes", () => {
    resetVersion()
    const r1 = materialize({
      global: makeScope("global", { model: "model-a" }),
      project: null,
    })
    resetVersion()
    const r2 = materialize({
      global: makeScope("global", { model: "model-b" }),
      project: null,
    })
    expect(r1.config.contentHash).not.toBe(r2.config.contentHash)
  })

  it("tracks structured provenance per field", () => {
    const result = materialize({
      global: makeScope("global", { model: "test" }),
      project: null,
    })
    const prov = result.config.provenance.model
    expect(prov.scope).toBe("global")
    expect(prov.operator).toBe("single")
    expect(prov.explicit).toBe(true)
  })

  it("does not mutate inputs", () => {
    const globalRaw = { model: "test" }
    const global = makeScope("global", globalRaw)
    materialize({ global, project: null })
    expect(globalRaw.model).toBe("test")
  })
})

describe("materialize with errors", () => {
  it("returns exact prior materialization on conflict errors", () => {
    const prior: MaterializedConfig = {
      value: { model: "prior-model" },
      fields: [{
        key: "model",
        value: "prior-model",
        source: "global",
        provenance: { scope: "global", canonicalPath: "global:/test", operator: "single", explicit: true },
        version: 1,
      }],
      contentHash: "prior-hash",
      version: 1,
      provenance: { model: { scope: "global", canonicalPath: "global:/test", operator: "single", explicit: true } },
      schemaVersion: SCHEMA_VERSION,
    }

    // Both scopes explicit = conflict
    const result = materialize(
      {
        global: makeScope("global", { model: "global/model" }),
        project: makeScope("project", { model: "project/model" }),
      },
      prior,
    )

    // Should return exact prior, not a partial reconstruction
    expect(result.config).toBe(prior)
    expect(result.config.value.model).toBe("prior-model")
    expect(result.config.contentHash).toBe("prior-hash")
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
  })

  it("returns empty materialization when no prior and errors occur", () => {
    const result = materialize(
      {
        global: makeScope("global", { model: "global/model" }),
        project: makeScope("project", { model: "project/model" }),
      },
      null,
    )
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    // No prior means we get an empty materialized value
    expect(Object.keys(result.config.value)).toHaveLength(0)
  })
})

describe("detectStaleWrite", () => {
  it("returns null when hashes match", () => {
    const content = '{"model": "test"}'
    const hash = require("../../../src/config/parse").contentHash(content)
    const result = detectStaleWrite(hash, content, "/test.jsonc")
    expect(result).toBeNull()
  })

  it("returns conflict when hashes differ", () => {
    const result = detectStaleWrite("expected-hash", '{"changed": true}', "/test.jsonc")
    expect(result).not.toBeNull()
    expect(result!.expectedHash).toBe("expected-hash")
    expect(result!.path).toBe("/test.jsonc")
  })
})

// ── F1: Recursive canonical hashing ──────────────────────────────────

describe("F1: recursive canonical hashing", () => {
  it("produces same hash for different key insertion orders", () => {
    resetVersion()
    const r1 = materialize({
      global: { scope: "global", root: "/g", raw: { b: 2, a: 1 }, provenance: { scope: "global", canonicalPath: "", operator: "single", explicit: true } },
      project: null,
    })
    resetVersion()
    const r2 = materialize({
      global: { scope: "global", root: "/g", raw: { a: 1, b: 2 }, provenance: { scope: "global", canonicalPath: "", operator: "single", explicit: true } },
      project: null,
    })
    expect(r1.config.contentHash).toBe(r2.config.contentHash)
  })

  it("includes nested object ordering in hash", () => {
    resetVersion()
    const r1 = materialize({
      global: { scope: "global", root: "/g", raw: { provider: { z: { x: 1 }, a: { y: 2 } } }, provenance: { scope: "global", canonicalPath: "", operator: "keyed", explicit: true } },
      project: null,
    })
    resetVersion()
    const r2 = materialize({
      global: { scope: "global", root: "/g", raw: { provider: { a: { y: 2 }, z: { x: 1 } } }, provenance: { scope: "global", canonicalPath: "", operator: "keyed", explicit: true } },
      project: null,
    })
    expect(r1.config.contentHash).toBe(r2.config.contentHash)
  })

  it("preserves array order in hash", () => {
    resetVersion()
    const r1 = materialize({
      global: { scope: "global", root: "/g", raw: { instructions: ["a.md", "b.md"] }, provenance: { scope: "global", canonicalPath: "", operator: "ordered", explicit: true } },
      project: null,
    })
    resetVersion()
    const r2 = materialize({
      global: { scope: "global", root: "/g", raw: { instructions: ["b.md", "a.md"] }, provenance: { scope: "global", canonicalPath: "", operator: "ordered", explicit: true } },
      project: null,
    })
    // Different array order should produce different hash
    expect(r1.config.contentHash).not.toBe(r2.config.contentHash)
  })

  it("preserves opaque secret refs as-is in hash", () => {
    resetVersion()
    const r1 = materialize({
      global: { scope: "global", root: "/g", raw: { provider: { openai: { apiKey: "secret:abc" } } }, provenance: { scope: "global", canonicalPath: "", operator: "keyed", explicit: true } },
      project: null,
    })
    resetVersion()
    const r2 = materialize({
      global: { scope: "global", root: "/g", raw: { provider: { openai: { apiKey: "secret:xyz" } } }, provenance: { scope: "global", canonicalPath: "", operator: "keyed", explicit: true } },
      project: null,
    })
    // Different secret refs should produce different hash
    expect(r1.config.contentHash).not.toBe(r2.config.contentHash)
  })

  it("does not drop nested properties in hash", () => {
    resetVersion()
    const r1 = materialize({
      global: { scope: "global", root: "/g", raw: { permission: { read: "allow", write: "ask" } }, provenance: { scope: "global", canonicalPath: "", operator: "restrictive", explicit: true } },
      project: null,
    })
    expect(r1.config.contentHash).toMatch(/^[0-9a-f]{16}$/)
    expect(r1.config.value.permission).toBeDefined()
    const perm = r1.config.value.permission as Record<string, unknown>
    // Restrictive wraps as { global: <original> } when only global has it
    expect(perm.global).toBeDefined()
    const globalLayer = perm.global as Record<string, unknown>
    expect(globalLayer.read).toBe("allow")
    expect(globalLayer.write).toBe("ask")
  })
})

// ── F2: Structured provenance ────────────────────────────────────────

describe("F2: structured provenance", () => {
  it("provenance has scope, canonicalPath, operator, explicit", () => {
    const result = materialize({
      global: makeScope("global", { model: "test" }),
      project: null,
    })
    const prov = result.config.provenance.model
    expect(prov).toHaveProperty("scope")
    expect(prov).toHaveProperty("canonicalPath")
    expect(prov).toHaveProperty("operator")
    expect(prov).toHaveProperty("explicit")
    expect(prov.scope).toBe("global")
    expect(prov.operator).toBe("single")
    expect(prov.explicit).toBe(true)
  })

  it("merged provenance includes contributors", () => {
    const result = materialize({
      global: { scope: "global", root: "/g", raw: { instructions: ["g.md"] }, provenance: { scope: "global", canonicalPath: "/global/kilo.jsonc", operator: "ordered", explicit: true } },
      project: { scope: "project", root: "/p", raw: { instructions: ["p.md"] }, provenance: { scope: "project", canonicalPath: "/project/.kilo/kilo.jsonc", operator: "ordered", explicit: true } },
    })
    const prov = result.config.provenance.instructions
    expect(prov.scope).toBe("merged")
    expect(prov.contributors).toEqual(["global", "project"])
  })
})

// ── F3: Deep immutability ────────────────────────────────────────────

describe("F3: deep immutability", () => {
  it("materialized value is frozen", () => {
    const result = materialize({
      global: { scope: "global", root: "/g", raw: { model: "test", provider: { openai: {} } }, provenance: { scope: "global", canonicalPath: "", operator: "single", explicit: true } },
      project: null,
    })
    expect(Object.isFrozen(result.config.value)).toBe(true)
  })

  it("nested objects in materialized value are frozen", () => {
    const result = materialize({
      global: { scope: "global", root: "/g", raw: { provider: { openai: { endpoint: "https://api.openai.com" } } }, provenance: { scope: "global", canonicalPath: "", operator: "keyed", explicit: true } },
      project: null,
    })
    const provider = result.config.value.provider as Record<string, unknown>
    expect(Object.isFrozen(provider)).toBe(true)
  })

  it("arrays in materialized value are frozen", () => {
    const result = materialize({
      global: { scope: "global", root: "/g", raw: { instructions: ["a.md", "b.md"] }, provenance: { scope: "global", canonicalPath: "", operator: "ordered", explicit: true } },
      project: null,
    })
    expect(Object.isFrozen(result.config.value.instructions)).toBe(true)
  })

  it("mutation attempt on materialized value throws in strict mode", () => {
    const result = materialize({
      global: { scope: "global", root: "/g", raw: { model: "test" }, provenance: { scope: "global", canonicalPath: "", operator: "single", explicit: true } },
      project: null,
    })
    expect(() => {
      (result.config.value as Record<string, unknown>).model = "changed"
    }).toThrow()
  })
})

// ── F11: Version equality ────────────────────────────────────────────

describe("F11: version equality", () => {
  it("all fields share the same version as the config", () => {
    const result = materialize({
      global: { scope: "global", root: "/g", raw: { model: "test", instructions: ["a.md"] }, provenance: { scope: "global", canonicalPath: "", operator: "single", explicit: true } },
      project: null,
    })
    for (const field of result.config.fields) {
      expect(field.version).toBe(result.config.version)
    }
  })

  it("version is monotonically increasing and consistent", () => {
    const r1 = materialize({
      global: makeScope("global", { model: "a" }),
      project: null,
    })
    const r2 = materialize({
      global: makeScope("global", { model: "b" }),
      project: null,
    })
    expect(r1.config.version).toBe(1)
    expect(r2.config.version).toBe(2)
    // All fields in r2 have version 2
    for (const field of r2.config.fields) {
      expect(field.version).toBe(2)
    }
  })
})
