/**
 * P4.1 Config Foundation — Compose tests.
 *
 * Covers audit triggers:
 * - Single field conflict detection
 * - Keyed record merge by stable ID
 * - Ordered composition (global-then-project)
 * - Restrictive composition preserves ordered layers (never overlays)
 * - Cross-scope conflict for provider
 */

import { describe, expect, it } from "bun:test"
import { composeField, composeAll } from "../../../src/config/compose"
import type { RegistryEntry, ScopedContent, ProvenanceStamp } from "../../../src/config/types"
import { getAllEntries } from "../../../src/config/registry"

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

describe("single composition", () => {
  const entry: RegistryEntry = {
    key: "model",
    description: "test",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "single",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
  }

  it("returns project value when only project has it", () => {
    const result = composeField(entry, null, makeScope("project", { model: "project/model" }))
    expect("key" in result).toBe(true)
    if ("key" in result) {
      expect(result.value).toBe("project/model")
      expect(result.source).toBe("project")
    }
  })

  it("returns global value when only global has it", () => {
    const result = composeField(entry, makeScope("global", { model: "global/model" }), null)
    expect("key" in result).toBe(true)
    if ("key" in result) {
      expect(result.value).toBe("global/model")
      expect(result.source).toBe("global")
    }
  })

  it("returns conflict when both scopes have it", () => {
    const result = composeField(
      entry,
      makeScope("global", { model: "global/model" }),
      makeScope("project", { model: "project/model" }),
    )
    expect("path" in result).toBe(true)
    if ("path" in result) {
      expect(result.message).toContain("Conflicting")
    }
  })

  it("omits field when neither scope has it", () => {
    const result = composeField(entry, null, null)
    expect("key" in result).toBe(true)
    if ("key" in result) {
      expect(result.value).toBeUndefined()
    }
  })
})

describe("keyed composition", () => {
  const entry: RegistryEntry = {
    key: "provider",
    description: "test",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "keyed",
    secret: "secret-ref",
    snapshot: true,
    provenance: "file",
    removal: "remove",
    crossScopeConflict: true,
  }

  it("merges providers from both scopes", () => {
    const result = composeField(
      entry,
      makeScope("global", { provider: { openai: { endpoint: "https://api.openai.com" } } }),
      makeScope("project", { provider: { anthropic: { endpoint: "https://api.anthropic.com" } } }),
    )
    expect("key" in result).toBe(true)
    if ("key" in result) {
      const merged = result.value as Record<string, unknown>
      expect(merged.openai).toBeDefined()
      expect(merged.anthropic).toBeDefined()
    }
  })

  it("conflicts on duplicate IDs with crossScopeConflict", () => {
    const result = composeField(
      entry,
      makeScope("global", { provider: { openai: { endpoint: "https://api.openai.com" } } }),
      makeScope("project", { provider: { openai: { endpoint: "https://other.com" } } }),
    )
    expect("path" in result).toBe(true)
    if ("path" in result) {
      expect(result.message).toContain("Duplicate")
    }
  })
})

describe("ordered composition", () => {
  const entry: RegistryEntry = {
    key: "instructions",
    description: "test",
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

  it("concatenates global first, then project", () => {
    const result = composeField(
      entry,
      makeScope("global", { instructions: ["global.md"] }),
      makeScope("project", { instructions: ["project.md"] }),
    )
    expect("key" in result).toBe(true)
    if ("key" in result) {
      expect(result.value).toEqual(["global.md", "project.md"])
      expect(result.source).toBe("merged")
    }
  })

  it("returns only global when project is absent", () => {
    const result = composeField(
      entry,
      makeScope("global", { instructions: ["global.md"] }),
      null,
    )
    expect("key" in result).toBe(true)
    if ("key" in result) {
      expect(result.value).toBe("global.md")
    }
  })

  it("returns only project when global is absent", () => {
    const result = composeField(
      entry,
      null,
      makeScope("project", { instructions: ["project.md"] }),
    )
    expect("key" in result).toBe(true)
    if ("key" in result) {
      expect(result.value).toBe("project.md")
    }
  })
})

describe("restrictive composition", () => {
  const entry: RegistryEntry = {
    key: "permission",
    description: "test",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "restrictive",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "preserve",
  }

  it("preserves ordered layers (global + project) without overlay", () => {
    const result = composeField(
      entry,
      makeScope("global", { permission: { read: "allow", write: "ask" } }),
      makeScope("project", { permission: { read: "deny", delete: "deny" } }),
    )
    expect("key" in result).toBe(true)
    if ("key" in result) {
      const layers = result.value as Record<string, unknown>
      expect(layers.global).toBeDefined()
      expect(layers.project).toBeDefined()
      // Global layer is NOT overlaid by project
      const globalLayer = layers.global as Record<string, unknown>
      expect(globalLayer.read).toBe("allow")
      expect(globalLayer.write).toBe("ask")
      // Project layer is separate
      const projectLayer = layers.project as Record<string, unknown>
      expect(projectLayer.read).toBe("deny")
      expect(projectLayer.delete).toBe("deny")
      // Critical: global.read is still "allow", NOT "deny"
      expect(globalLayer.read).not.toBe("deny")
    }
  })

  it("returns only global layer when project absent", () => {
    const result = composeField(
      entry,
      makeScope("global", { permission: { read: "allow" } }),
      null,
    )
    expect("key" in result).toBe(true)
    if ("key" in result) {
      const layers = result.value as Record<string, unknown>
      expect(layers.global).toBeDefined()
      expect(layers.project).toBeUndefined()
    }
  })

  it("returns only project layer when global absent", () => {
    const result = composeField(
      entry,
      null,
      makeScope("project", { permission: { read: "deny" } }),
    )
    expect("key" in result).toBe(true)
    if ("key" in result) {
      const layers = result.value as Record<string, unknown>
      expect(layers.project).toBeDefined()
      expect(layers.global).toBeUndefined()
    }
  })
})

describe("composeAll", () => {
  it("composes all 11 registry entries", () => {
    const entries = getAllEntries()
    const global = makeScope("global", {
      model: "global/model",
      provider: { openai: {} },
    })
    const project = makeScope("project", {
      model: "project/model",
    })

    const result = composeAll(entries, global, project)
    // model conflicts (both scopes explicit)
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1)
    const modelConflict = result.conflicts.find((c) => c.path[0] === "model")
    expect(modelConflict).toBeDefined()
  })
})

// ── F9: Keyed ID always conflicts ────────────────────────────────────

describe("F9: keyed ID always conflicts", () => {
  const mcpEntry: RegistryEntry = {
    key: "mcp",
    description: "MCP server configs",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "keyed",
    secret: "secret-ref",
    snapshot: true,
    provenance: "file",
    removal: "remove",
    crossScopeConflict: true,
  }

  it("MCP duplicate IDs conflict across scopes", () => {
    const result = composeField(
      mcpEntry,
      makeScope("global", { mcp: { myserver: { command: "npx" } } }),
      makeScope("project", { mcp: { myserver: { command: "node" } } }),
    )
    expect("path" in result).toBe(true)
    if ("path" in result) {
      expect(result.message).toContain("Duplicate")
      expect(result.path).toContain("myserver")
    }
  })

  it("MCP different IDs merge without conflict", () => {
    const result = composeField(
      mcpEntry,
      makeScope("global", { mcp: { server1: { command: "a" } } }),
      makeScope("project", { mcp: { server2: { command: "b" } } }),
    )
    expect("key" in result).toBe(true)
    if ("key" in result) {
      const merged = result.value as Record<string, unknown>
      expect(merged.server1).toBeDefined()
      expect(merged.server2).toBeDefined()
    }
  })

  it("model_variant_overrides duplicate keys conflict", () => {
    const overrideEntry: RegistryEntry = {
      key: "model_variant_overrides",
      description: "Overrides",
      scopes: ["global", "project"],
      persistence: "jsonc",
      owner: "extension",
      composition: "keyed",
      secret: "none",
      snapshot: true,
      provenance: "file",
      removal: "remove",
    }

    const result = composeField(
      overrideEntry,
      makeScope("global", { model_variant_overrides: { "openai/gpt-4": "thinking" } }),
      makeScope("project", { model_variant_overrides: { "openai/gpt-4": "extended" } }),
    )
    expect("path" in result).toBe(true)
    if ("path" in result) {
      expect(result.message).toContain("Duplicate")
    }
  })
})
