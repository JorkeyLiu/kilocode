/**
 * P4.1 Config foundation — registry tests.
 *
 * Verifies the closed registry: known keys, unknown key rejection,
 * scope validation, composition operators, and cross-scope conflict.
 *
 * The exact closed set of 11 JSONC fields:
 *   model, model_variant, model_variant_overrides,
 *   subagent_model, subagent_variant, subagent_variant_overrides,
 *   default_agent, provider, mcp, permission, instructions
 */

import { describe, expect, it } from "bun:test"
import {
  getEntry,
  getAllEntries,
  isKnownKey,
  keysForScope,
  keysByComposition,
  keysWithCrossScopeConflict,
  snapshotKeys,
  validateRegistryKeys,
  CLOSED_JSONC_FIELDS,
} from "../../src/config/registry"

describe("registry", () => {
  describe("closed registry", () => {
    it("rejects unknown keys", () => {
      expect(isKnownKey("unknown_field")).toBe(false)
      expect(isKnownKey("compaction")).toBe(false)
      expect(isKnownKey("indexing")).toBe(false)
      expect(isKnownKey("preset_provider")).toBe(false)
      expect(isKnownKey("agent")).toBe(false)
      expect(isKnownKey("command")).toBe(false)
      expect(isKnownKey("shell")).toBe(false)
      expect(isKnownKey("logLevel")).toBe(false)
    })

    it("accepts all known config keys", () => {
      for (const key of CLOSED_JSONC_FIELDS) {
        expect(isKnownKey(key)).toBe(true)
      }
      expect(isKnownKey("model")).toBe(true)
      expect(isKnownKey("provider")).toBe(true)
      expect(isKnownKey("mcp")).toBe(true)
      expect(isKnownKey("permission")).toBe(true)
      expect(isKnownKey("instructions")).toBe(true)
    })
  })

  describe("getEntry", () => {
    it("returns entry for known key", () => {
      const entry = getEntry("model")
      expect(entry).toBeDefined()
      expect(entry!.key).toBe("model")
      expect(entry!.composition).toBe("single")
      expect(entry!.secret).toBe("none")
    })

    it("returns undefined for unknown key", () => {
      expect(getEntry("unknown")).toBeUndefined()
    })

    it("returns provider entry with keyed composition", () => {
      const entry = getEntry("provider")
      expect(entry).toBeDefined()
      expect(entry!.composition).toBe("keyed")
      expect(entry!.crossScopeConflict).toBe(true)
    })

    it("returns permission entry with restrictive composition", () => {
      const entry = getEntry("permission")
      expect(entry).toBeDefined()
      expect(entry!.composition).toBe("restrictive")
      expect(entry!.removal).toBe("preserve")
    })
  })

  describe("getAllEntries", () => {
    it("returns all registry entries", () => {
      const entries = getAllEntries()
      expect(entries.length).toBe(11)
      // Check some representative entries exist
      const keys = entries.map((e) => e.key)
      expect(keys).toContain("model")
      expect(keys).toContain("provider")
      expect(keys).toContain("mcp")
      expect(keys).toContain("permission")
    })
  })

  describe("keysForScope", () => {
    it("returns global-scope keys", () => {
      const keys = keysForScope("global")
      expect(keys).toContain("model")
      expect(keys).toContain("instructions")
      // All 11 fields are valid in both scopes
      expect(keys.length).toBe(11)
    })

    it("returns project-scope keys", () => {
      const keys = keysForScope("project")
      expect(keys).toContain("model")
      expect(keys).toContain("permission")
      // All 11 fields are valid in both scopes
      expect(keys.length).toBe(11)
    })
  })

  describe("keysByComposition", () => {
    it("returns single-composition keys", () => {
      const entries = keysByComposition("single")
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.some((e) => e.key === "model")).toBe(true)
      expect(entries.some((e) => e.key === "default_agent")).toBe(true)
    })

    it("returns keyed-composition keys", () => {
      const entries = keysByComposition("keyed")
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.some((e) => e.key === "provider")).toBe(true)
      expect(entries.some((e) => e.key === "mcp")).toBe(true)
    })

    it("returns ordered-composition keys", () => {
      const entries = keysByComposition("ordered")
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.some((e) => e.key === "instructions")).toBe(true)
    })

    it("returns restrictive-composition keys", () => {
      const entries = keysByComposition("restrictive")
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.some((e) => e.key === "permission")).toBe(true)
    })
  })

  describe("keysWithCrossScopeConflict", () => {
    it("returns keys that conflict across scopes", () => {
      const keys = keysWithCrossScopeConflict()
      expect(keys.some((e) => e.key === "model")).toBe(true)
      expect(keys.some((e) => e.key === "provider")).toBe(true)
    })
  })

  describe("snapshotKeys", () => {
    it("returns keys included in snapshots", () => {
      const keys = snapshotKeys()
      expect(keys).toContain("model")
      expect(keys).toContain("permission")
      // All 11 fields appear in snapshots
      expect(keys.length).toBe(11)
    })
  })

  describe("validateRegistryKeys", () => {
    it("accepts valid keys for the scope", () => {
      const result = validateRegistryKeys({ model: "anthropic/claude-sonnet" }, "global")
      expect(result.ok).toBe(true)
    })

    it("rejects unknown keys", () => {
      const result = validateRegistryKeys({ model: "test", unknown_key: "value" }, "global")
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.unknownKeys).toContain("unknown_key")
      }
    })
  })
})
