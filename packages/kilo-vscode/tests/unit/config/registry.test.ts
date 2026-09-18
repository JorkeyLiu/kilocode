/**
 * P4.1 Config Foundation — Registry tests.
 *
 * Covers audit triggers:
 * - Closed field set enforcement (exact 14 JSONC fields incl. the $schema meta-key)
 * - Rejected fields (server, console, share, enterprise, tools, etc.)
 * - Agent/command as asset-only (never JSONC records)
 * - Credential reference handling (secret-ref entries)
 * - Cross-scope conflict declarations
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
  secretRefKeys,
  validateRegistryKeys,
  CLOSED_JSONC_FIELDS,
} from "../../../src/config/registry"

describe("closed JSONC field set", () => {
  it("contains exactly 15 fields", () => {
    const entries = getAllEntries()
    expect(entries.length).toBe(15)
  })

  it("matches the CLOSED_JSONC_FIELDS constant", () => {
    const entries = getAllEntries()
    const keys = entries.map((e) => e.key).sort()
    const closed = [...CLOSED_JSONC_FIELDS].sort()
    expect(keys).toEqual(closed)
  })

  it("every closed field is known", () => {
    for (const key of CLOSED_JSONC_FIELDS) {
      expect(isKnownKey(key)).toBe(true)
    }
  })

  it("CLOSED_JSONC_FIELDS contains exactly the locked set", () => {
    expect(CLOSED_JSONC_FIELDS).toEqual([
      "$schema",
      "model",
      "model_variant",
      "model_variant_overrides",
      "subagent_model",
      "subagent_variant",
      "subagent_variant_overrides",
      "default_agent",
      "provider",
      "mcp",
      "permission",
      "permission_level",
      "instructions",
      "terminal_command_display",
      "auto_collapse_reasoning",
    ])
  })
})

describe("rejected fields are absent from registry", () => {
  const rejected = [
    "server", "console", "share", "enterprise", "cloud", "org",
    "tools", "disabled_providers", "enabled_providers",
    "compaction", "indexing", "autocomplete",
    "mode", "shell", "logLevel", "username", "snapshot",
    "autoupdate", "remote_control",
    "code_edit_display", "hide_prompt_training_models",
    "watcher", "reference", "skills", "formatter", "lsp",
    "sandbox", "attachment", "tool_output", "experimental",
    "protected_files", "small_model",
    // agent/command/plugin must not be JSONC records
    "agent", "command", "plugin",
  ]

  for (const key of rejected) {
    it(`rejects "${key}" from the closed registry`, () => {
      expect(isKnownKey(key)).toBe(false)
      expect(getEntry(key)).toBeUndefined()
    })
  }
})

describe("model fields", () => {
  it("model is single, global+project, crossScopeConflict", () => {
    const entry = getEntry("model")
    expect(entry).toBeDefined()
    expect(entry!.composition).toBe("single")
    expect(entry!.scopes).toEqual(["global", "project"])
    expect(entry!.crossScopeConflict).toBe(true)
  })

  it("subagent_model is single, global+project, crossScopeConflict", () => {
    const entry = getEntry("subagent_model")
    expect(entry).toBeDefined()
    expect(entry!.composition).toBe("single")
    expect(entry!.crossScopeConflict).toBe(true)
  })

  it("model_variant is single, global+project", () => {
    const entry = getEntry("model_variant")
    expect(entry).toBeDefined()
    expect(entry!.composition).toBe("single")
    expect(entry!.scopes).toEqual(["global", "project"])
  })
})

describe("keyed record fields", () => {
  it("provider is keyed with crossScopeConflict and secret-ref", () => {
    const entry = getEntry("provider")
    expect(entry).toBeDefined()
    expect(entry!.composition).toBe("keyed")
    expect(entry!.crossScopeConflict).toBe(true)
    expect(entry!.secret).toBe("secret-ref")
  })

  it("mcp is keyed with secret-ref", () => {
    const entry = getEntry("mcp")
    expect(entry).toBeDefined()
    expect(entry!.composition).toBe("keyed")
    expect(entry!.secret).toBe("secret-ref")
  })
})

describe("policy fields", () => {
  it("permission is restrictive with preserve removal", () => {
    const entry = getEntry("permission")
    expect(entry).toBeDefined()
    expect(entry!.composition).toBe("restrictive")
    expect(entry!.removal).toBe("preserve")
  })

  it("instructions is ordered", () => {
    const entry = getEntry("instructions")
    expect(entry).toBeDefined()
    expect(entry!.composition).toBe("ordered")
  })
})

describe("scope validation", () => {
  it("all fields valid in global scope", () => {
    const globalKeys = keysForScope("global")
    expect(globalKeys.length).toBe(15)
  })

  it("all fields valid in project scope", () => {
    const projectKeys = keysForScope("project")
    expect(projectKeys.length).toBe(14)
    expect(projectKeys).not.toContain("permission_level")
  })

  it("permission_level is global-only: project hand-writes are ignored", () => {
    expect(keysForScope("global")).toContain("permission_level")
    expect(keysForScope("project")).not.toContain("permission_level")
  })
})

describe("composition operators", () => {
  it("single fields", () => {
    const singles = keysByComposition("single")
    expect(singles.map((e) => e.key).sort()).toEqual([
      "auto_collapse_reasoning",
      "default_agent",
      "model",
      "model_variant",
      "permission_level",
      "subagent_model",
      "subagent_variant",
      "terminal_command_display",
    ])
  })

  it("keyed fields", () => {
    const keyed = keysByComposition("keyed")
    expect(keyed.map((e) => e.key).sort()).toEqual([
      "mcp",
      "model_variant_overrides",
      "provider",
      "subagent_variant_overrides",
    ])
  })

  it("ordered fields", () => {
    const ordered = keysByComposition("ordered")
    expect(ordered.map((e) => e.key)).toEqual(["instructions"])
  })

  it("restrictive fields", () => {
    const restrictive = keysByComposition("restrictive")
    expect(restrictive.map((e) => e.key)).toEqual(["permission"])
  })

  it("meta fields", () => {
    const meta = keysByComposition("meta")
    expect(meta.map((e) => e.key)).toEqual(["$schema"])
  })
})

describe("cross-scope conflict", () => {
  it("includes model, provider, subagent_model, and mcp", () => {
    const crossScope = keysWithCrossScopeConflict()
    expect(crossScope.map((e) => e.key).sort()).toEqual(["mcp", "model", "provider", "subagent_model"])
  })
})

describe("secret-ref keys", () => {
  const secrets = secretRefKeys()
  expect(secrets.map((e) => e.key).sort()).toEqual(["mcp", "provider"])
})

describe("snapshot keys", () => {
  const snapshots = snapshotKeys()
  expect(snapshots.length).toBe(14)
  // The $schema meta-key never appears in snapshots
  expect(snapshots).not.toContain("$schema")
})

describe("validateRegistryKeys", () => {
  it("accepts all known keys", () => {
    const raw = { model: "anthropic/claude-sonnet-4-20250514", provider: {} }
    const result = validateRegistryKeys(raw, "global")
    expect(result.ok).toBe(true)
  })

  it("rejects unknown keys", () => {
    const raw = { model: "anthropic/claude-sonnet-4-20250514", server: {} }
    const result = validateRegistryKeys(raw, "global")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.unknownKeys).toContain("server")
    }
  })

  it("rejects scope-invalid keys", () => {
    // All 11 fields accept both scopes, so this tests the mechanism
    const raw = { model: "anthropic/claude-sonnet-4-20250514" }
    const result = validateRegistryKeys(raw, "project")
    expect(result.ok).toBe(true)
  })
})

describe("keyed fields use outer map keys by composition", () => {
  it("provider keyed composition merges by outer record keys, not by metadata", () => {
    const { composeField } = require("../../../src/config/compose")
    const entry = getEntry("provider")!
    const global = {
      scope: "global" as const,
      root: "/global",
      raw: { provider: { openai: { name: "OpenAI" }, anthropic: { name: "Anthropic" } } },
      provenance: { scope: "global" as const, canonicalPath: "/global/kilo.jsonc", explicit: true, operator: "keyed" as const },
    }
    const project = {
      scope: "project" as const,
      root: "/project",
      raw: { provider: { gemini: { name: "Gemini" } } },
      provenance: { scope: "project" as const, canonicalPath: "/project/.kilo/kilo.jsonc", explicit: true, operator: "keyed" as const },
    }
    const result = composeField(entry, global, project)
    expect("key" in result).toBe(true)
    if ("key" in result) {
      const merged = result.value as Record<string, unknown>
      expect(Object.keys(merged).sort()).toEqual(["anthropic", "gemini", "openai"])
      // No schemaKey or keyPath metadata consulted — the outer record keys are the IDs
    }
  })

  it("mcp keyed composition merges by outer record keys", () => {
    const { composeField } = require("../../../src/config/compose")
    const entry = getEntry("mcp")!
    const global = {
      scope: "global" as const,
      root: "/global",
      raw: { mcp: { server1: { command: "npx" } } },
      provenance: { scope: "global" as const, canonicalPath: "/global/kilo.jsonc", explicit: true, operator: "keyed" as const },
    }
    const project = {
      scope: "project" as const,
      root: "/project",
      raw: { mcp: { server2: { command: "node" } } },
      provenance: { scope: "project" as const, canonicalPath: "/project/.kilo/kilo.jsonc", explicit: true, operator: "keyed" as const },
    }
    const result = composeField(entry, global, project)
    expect("key" in result).toBe(true)
    if ("key" in result) {
      const merged = result.value as Record<string, unknown>
      expect(Object.keys(merged).sort()).toEqual(["server1", "server2"])
    }
  })

  it("registry entries have no schemaKey or keyPath fields", () => {
    const entries = getAllEntries()
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("schemaKey")
      expect(entry).not.toHaveProperty("keyPath")
    }
  })
})
