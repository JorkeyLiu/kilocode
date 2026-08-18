/**
 * P4.1 Config foundation — composition and materialization tests.
 *
 * Tests all four composition operators and deterministic materialization.
 */

import { describe, expect, it, beforeEach } from "bun:test"
import { composeField, composeAll, type ComposedField } from "../../src/config/compose"
import {
  materialize,
  materializeWithPreservation,
  detectStaleWrite,
  resetVersion,
  type MaterializeInput,
} from "../../src/config/materialize"
import { contentHash } from "../../src/config/parse"
import type { RegistryEntry, ScopedContent } from "../../src/config/types"

beforeEach(() => {
  resetVersion()
})

// ── Helper entries ───────────────────────────────────────────────────

const singleEntry: RegistryEntry = {
  key: "model",
  description: "Default model",
  scopes: ["global", "project"],
  persistence: "jsonc",
  owner: "extension",
  composition: "single",
  secret: "none",
  snapshot: true,
  provenance: "file",
  removal: "remove",
  crossScopeConflict: true,
}

const keyedEntry: RegistryEntry = {
  key: "provider",
  description: "Provider configs",
  scopes: ["global", "project"],
  persistence: "jsonc",
  owner: "extension",
  composition: "keyed",
  secret: "none",
  snapshot: true,
  provenance: "file",
  removal: "remove",
  crossScopeConflict: true,
}

const orderedEntry: RegistryEntry = {
  key: "instructions",
  description: "Instruction files",
  scopes: ["global", "project"],
  persistence: "jsonc",
  owner: "extension",
  composition: "ordered",
  order: 0,
  secret: "none",
  snapshot: true,
  provenance: "file",
  removal: "remove",
}

const restrictiveEntry: RegistryEntry = {
  key: "permission",
  description: "Permission rules",
  scopes: ["global", "project"],
  persistence: "jsonc",
  owner: "extension",
  composition: "restrictive",
  secret: "none",
  snapshot: true,
  provenance: "file",
  removal: "preserve",
}

// ── Composition operators ────────────────────────────────────────────

describe("composeField", () => {
  describe("single operator", () => {
    it("returns conflict when both scopes have value", () => {
      const global: ScopedContent = { scope: "global", root: "/global", raw: { model: "g-model" }, provenance: "g" }
      const project: ScopedContent = { scope: "project", root: "/project", raw: { model: "p-model" }, provenance: "p" }
      const result = composeField(singleEntry, global, project)
      expect("path" in result).toBe(true)
      if ("path" in result) {
        expect(result.message).toContain("Conflicting values")
      }
    })

    it("returns global value when only global has it", () => {
      const global: ScopedContent = { scope: "global", root: "/global", raw: { model: "g-model" }, provenance: "g" }
      const result = composeField(singleEntry, global, null)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        expect(result.value).toBe("g-model")
        expect(result.source).toBe("global")
      }
    })

    it("returns project value when only project has it", () => {
      const project: ScopedContent = { scope: "project", root: "/project", raw: { model: "p-model" }, provenance: "p" }
      const result = composeField(singleEntry, null, project)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        expect(result.value).toBe("p-model")
        expect(result.source).toBe("project")
      }
    })

    it("returns undefined when neither scope has value", () => {
      const global: ScopedContent = { scope: "global", root: "/global", raw: {}, provenance: "g" }
      const result = composeField(singleEntry, global, null)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        expect(result.value).toBeUndefined()
      }
    })
  })

  describe("keyed operator", () => {
    it("merges records from both scopes", () => {
      const global: ScopedContent = {
        scope: "global",
        root: "/global",
        raw: { provider: { anthropic: { name: "Anthropic" } } },
        provenance: "g",
      }
      const project: ScopedContent = {
        scope: "project",
        root: "/project",
        raw: { provider: { openai: { name: "OpenAI" } } },
        provenance: "p",
      }
      const result = composeField(keyedEntry, global, project)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        const merged = result.value as Record<string, unknown>
        expect(merged.anthropic).toBeDefined()
        expect(merged.openai).toBeDefined()
        expect(result.source).toBe("merged")
      }
    })

    it("detects duplicate IDs across scopes", () => {
      const global: ScopedContent = {
        scope: "global",
        root: "/global",
        raw: { provider: { anthropic: { name: "Anthropic" } } },
        provenance: "g",
      }
      const project: ScopedContent = {
        scope: "project",
        root: "/project",
        raw: { provider: { anthropic: { name: "Anthropic Override" } } },
        provenance: "p",
      }
      const result = composeField(keyedEntry, global, project)
      expect("path" in result).toBe(true)
    })

    it("returns project record when only project has it", () => {
      const project: ScopedContent = {
        scope: "project",
        root: "/project",
        raw: { provider: { openai: { name: "OpenAI" } } },
        provenance: "p",
      }
      const result = composeField(keyedEntry, null, project)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        expect(result.source).toBe("project")
      }
    })
  })

  describe("ordered operator", () => {
    it("concatenates arrays (global first, then project)", () => {
      const global: ScopedContent = {
        scope: "global",
        root: "/global",
        raw: { instructions: ["global-instr.md"] },
        provenance: { scope: "global", canonicalPath: "/g", explicit: true, operator: "ordered" },
      }
      const project: ScopedContent = {
        scope: "project",
        root: "/project",
        raw: { instructions: ["project-instr.md"] },
        provenance: { scope: "project", canonicalPath: "/p", explicit: true, operator: "ordered" },
      }
      const result = composeField(orderedEntry, global, project)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        expect(result.value).toEqual(["global-instr.md", "project-instr.md"])
        expect(result.source).toBe("merged")
      }
    })

    it("unwraps single-element global array", () => {
      const global: ScopedContent = {
        scope: "global",
        root: "/global",
        raw: { instructions: ["global.md"] },
        provenance: { scope: "global", canonicalPath: "/g", explicit: true, operator: "ordered" },
      }
      const result = composeField(orderedEntry, global, null)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        // Single-element arrays are unwrapped to their element
        expect(result.value).toBe("global.md")
      }
    })
  })

  describe("restrictive operator", () => {
    it("preserves ordered layers as stack (not flat overlay)", () => {
      const global: ScopedContent = {
        scope: "global",
        root: "/global",
        raw: { permission: { read: "allow", edit: "ask" } },
        provenance: { scope: "global", canonicalPath: "/g", explicit: true, operator: "restrictive" },
      }
      const project: ScopedContent = {
        scope: "project",
        root: "/project",
        raw: { permission: { edit: "deny" } },
        provenance: { scope: "project", canonicalPath: "/p", explicit: true, operator: "restrictive" },
      }
      const result = composeField(restrictiveEntry, global, project)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        // Restrictive: preserved as ordered stack, NOT overlay
        const layers = result.value as { global?: Record<string, unknown>; project?: Record<string, unknown> }
        expect(layers.global).toEqual({ read: "allow", edit: "ask" })
        expect(layers.project).toEqual({ edit: "deny" })
        expect(result.source).toBe("merged")
      }
    })

    it("returns global layer when only global has it", () => {
      const global: ScopedContent = {
        scope: "global",
        root: "/global",
        raw: { permission: { read: "allow" } },
        provenance: { scope: "global", canonicalPath: "/g", explicit: true, operator: "restrictive" },
      }
      const result = composeField(restrictiveEntry, global, null)
      expect("path" in result).toBe(false)
      if (!("path" in result)) {
        expect(result.source).toBe("global")
      }
    })
  })
})

// ── Materialization ──────────────────────────────────────────────────

describe("materialize", () => {
  it("produces deterministic content hash", () => {
    const input: MaterializeInput = {
      global: { scope: "global", root: "/g", raw: { model: "test" }, provenance: "g" },
      project: null,
      entries: [singleEntry],
    }
    const r1 = materialize(input)
    resetVersion()
    const r2 = materialize(input)
    expect(r1.config.contentHash).toBe(r2.config.contentHash)
  })

  it("increments version monotonically", () => {
    const input: MaterializeInput = {
      global: { scope: "global", root: "/g", raw: { model: "test" }, provenance: "g" },
      project: null,
      entries: [singleEntry],
    }
    const r1 = materialize(input)
    const r2 = materialize(input)
    expect(r2.config.version).toBeGreaterThan(r1.config.version)
  })

  it("tracks provenance per field", () => {
    const input: MaterializeInput = {
      global: { scope: "global", root: "/g", raw: { model: "g-model" }, provenance: { scope: "global", canonicalPath: "/g/kilo.jsonc", explicit: true, operator: "single" } },
      project: { scope: "project", root: "/p", raw: {}, provenance: { scope: "project", canonicalPath: "/p/.kilo/kilo.jsonc", explicit: true, operator: "single" } },
      entries: [singleEntry],
    }
    const result = materialize(input)
    const prov = result.config.provenance.model
    expect(prov).toBeDefined()
    expect(prov.scope).toBe("global")
    expect(prov.canonicalPath).toBe("/g/kilo.jsonc")
  })

  it("returns errors for conflicts", () => {
    const input: MaterializeInput = {
      global: { scope: "global", root: "/g", raw: { model: "g" }, provenance: "g" },
      project: { scope: "project", root: "/p", raw: { model: "p" }, provenance: "p" },
      entries: [singleEntry],
    }
    const result = materialize(input)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("same content/schema/opaque secret refs yields same identity", () => {
    const input: MaterializeInput = {
      global: { scope: "global", root: "/g", raw: { model: "test", shell: "/bin/bash" }, provenance: "g" },
      project: null,
      entries: [
        singleEntry,
        { ...singleEntry, key: "shell", crossScopeConflict: false },
      ],
    }
    resetVersion()
    const r1 = materialize(input)
    resetVersion()
    const r2 = materialize(input)
    expect(r1.config.contentHash).toBe(r2.config.contentHash)
    expect(Object.keys(r1.config.value).sort()).toEqual(Object.keys(r2.config.value).sort())
  })
})

// ── Stale write detection ────────────────────────────────────────────

describe("detectStaleWrite", () => {
  it("returns null when hashes match", () => {
    const content = '{"model": "test"}'
    const hash = contentHash(content)
    const result = detectStaleWrite(hash, content, "/test.jsonc")
    expect(result).toBeNull()
  })

  it("returns conflict when hashes differ", () => {
    const original = '{"model": "test"}'
    const modified = '{"model": "changed"}'
    const hash = contentHash(original)
    const result = detectStaleWrite(hash, modified, "/test.jsonc")
    expect(result).not.toBeNull()
    expect(result!.expectedHash).toBe(hash)
    expect(result!.actualHash).toBe(contentHash(modified))
  })
})

// ── Materialize with preservation ────────────────────────────────────

describe("materializeWithPreservation", () => {
  it("preserves prior valid fields on error", () => {
    const entries: RegistryEntry[] = [
      singleEntry,
      {
        key: "other",
        description: "Other",
        scopes: ["global"],
        persistence: "jsonc",
        owner: "extension",
        composition: "single",
        secret: "none",
        snapshot: true,
        provenance: "file",
        removal: "remove",
      },
    ]

    // First materialization: no conflict (only global has model)
    const input1: MaterializeInput = {
      global: { scope: "global", root: "/g", raw: { model: "test", other: "value" }, provenance: "g" },
      project: null,
      entries,
    }
    const prior = materialize(input1)
    expect(prior.errors.length).toBe(0)

    // Second materialization: conflict in model, but other is preserved from prior
    const input2: MaterializeInput = {
      global: { scope: "global", root: "/g", raw: { model: "test" }, provenance: "g" },
      project: { scope: "project", root: "/p", raw: { model: "override" }, provenance: "p" },
      entries,
    }
    const result = materializeWithPreservation(input2, prior.config)
    expect(result.errors.length).toBeGreaterThan(0)
    // The conflicted field should be preserved from prior
    expect(result.config.value.model).toBe(prior.config.value.model)
  })
})
