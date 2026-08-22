/**
 * P4.1 Canonical config foundation — closed field registry.
 *
 * The registry is closed and rejects unknown/deprecated fields. Every
 * accepted field class has a complete registry entry with owner, persistence,
 * legal scope, operator, validation, secret handling, snapshot inclusion,
 * provenance, and removal disposition.
 *
 * LOCK-004/006/009: server, console, share, enterprise, cloud, org,
 * preset-provider catalog/onboarding/filtering, compaction, indexing,
 * autocomplete, top-level legacy tools, mode, and all deprecated aliases
 * are rejected.
 *
 * R10: canonical JSONC files are `<globalRoot>/kilo.jsonc` and
 * `<workspaceRoot>/.kilo/kilo.jsonc`.
 *
 * The exact closed set of JSONC field classes:
 *   $schema, model, model_variant, model_variant_overrides,
 *   subagent_model, subagent_variant, subagent_variant_overrides,
 *   default_agent, provider, mcp, permission, instructions
 *
 * `$schema` is a benign meta-key injected into kilo.jsonc by the CLI backend;
 * it is valid in both scopes but never composed — it is excluded from the
 * materialized value, content hash, and snapshots.
 *
 * Agent, command, tool, skill, plugin, rules exist only as typed markdown
 * assets in their singular directories — never as top-level JSONC records.
 */

import type { RegistryEntry } from "./types"

// ── Registry: the exact closed set ───────────────────────────────────

const entries: RegistryEntry[] = [
  // ── Model selection fields ───────────────────────────────────────

  {
    key: "$schema",
    description: "JSON schema meta-key injected by CLI tooling; benign, excluded from materialization and snapshots",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "backend",
    composition: "meta",
    secret: "none",
    snapshot: false,
    provenance: "file",
    removal: "preserve",
  },
  {
    key: "model",
    description: "Default model in provider/model format",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "single",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
    crossScopeConflict: true,
  },
  {
    key: "model_variant",
    description: "Default reasoning variant for the configured model",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "single",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
  },
  {
    key: "model_variant_overrides",
    description: "Model-specific variant overrides keyed by provider/model",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "keyed",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
  },

  // ── Subagent model fields ────────────────────────────────────────

  {
    key: "subagent_model",
    description: "Default model for task-tool subagents in provider/model format",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "single",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
    crossScopeConflict: true,
  },
  {
    key: "subagent_variant",
    description: "Default variant for task-tool subagents",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "single",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
  },
  {
    key: "subagent_variant_overrides",
    description: "Model-specific variant overrides for subagents keyed by provider/model",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "keyed",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
  },

  // ── Agent default ────────────────────────────────────────────────

  {
    key: "default_agent",
    description: "Default agent asset ID when none specified",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "single",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
  },

  // ── Keyed record fields ──────────────────────────────────────────

  {
    key: "provider",
    description: "Custom provider configurations keyed by user-defined provider ID (endpoint/protocol/model + opaque credential refs only)",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "keyed",
    secret: "secret-ref",
    snapshot: true,
    provenance: "file",
    removal: "remove",
    crossScopeConflict: true,
  },
  {
    key: "mcp",
    description: "MCP server configurations keyed by name (opaque credential refs only)",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "keyed",
    secret: "secret-ref",
    snapshot: true,
    provenance: "file",
    removal: "remove",
    crossScopeConflict: true,
  },

  // ── Policy / instructions ────────────────────────────────────────

  {
    key: "permission",
    description: "Global permission rules as ordered restrictive layers",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "restrictive",
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "preserve",
  },
  {
    key: "instructions",
    description: "Additional instruction file paths or glob patterns",
    scopes: ["global", "project"],
    persistence: "jsonc",
    owner: "extension",
    composition: "ordered",
    order: 0,
    secret: "none",
    snapshot: true,
    provenance: "file",
    removal: "remove",
  },
]

// ── Registry API ─────────────────────────────────────────────────────

const registryMap = new Map<string, RegistryEntry>()
for (const entry of entries) {
  registryMap.set(entry.key, entry)
}

/** Get a registry entry by dot-path key. Returns undefined for unknown keys. */
export function getEntry(key: string): RegistryEntry | undefined {
  return registryMap.get(key)
}

/** Get all registry entries. */
export function getAllEntries(): readonly RegistryEntry[] {
  return entries
}

/** Check if a key is in the closed registry. */
export function isKnownKey(key: string): boolean {
  return registryMap.has(key)
}

/**
 * Check if a key is a GUI-facing field: known to the closed registry and not
 * composition "meta". Meta keys ($schema) are validation-only metadata owned
 * by the backend — they never enter GUI payloads or write-path filters.
 */
export function isGuiField(key: string): boolean {
  const entry = registryMap.get(key)
  return entry !== undefined && entry.composition !== "meta"
}

/** Get all keys that belong to a specific scope. */
export function keysForScope(scope: "global" | "project"): string[] {
  return entries.filter((e) => e.scopes.includes(scope)).map((e) => e.key)
}

/** Get all keys that use a specific composition operator. */
export function keysByComposition(operator: "single" | "keyed" | "ordered" | "restrictive" | "meta"): RegistryEntry[] {
  return entries.filter((e) => e.composition === operator)
}

/** Get all keys that have cross-scope conflict detection. */
export function keysWithCrossScopeConflict(): RegistryEntry[] {
  return entries.filter((e) => e.crossScopeConflict === true)
}

/** Get all keys that appear in snapshots. */
export function snapshotKeys(): string[] {
  return entries.filter((e) => e.snapshot).map((e) => e.key)
}

/** Get all keys that use secret references. */
export function secretRefKeys(): RegistryEntry[] {
  return entries.filter((e) => e.secret === "secret-ref")
}

/** Validate that a raw config only contains known keys (closed registry). */
export function validateRegistryKeys(
  raw: Record<string, unknown>,
  scope: "global" | "project",
): { ok: true } | { ok: false; unknownKeys: string[] } {
  const unknownKeys: string[] = []
  for (const key of Object.keys(raw)) {
    if (!isKnownKey(key)) {
      unknownKeys.push(key)
      continue
    }
    const entry = getEntry(key)
    if (entry && !entry.scopes.includes(scope)) {
      unknownKeys.push(key)
    }
  }
  return unknownKeys.length === 0 ? { ok: true } : { ok: false, unknownKeys }
}

// ── Closed set constant (for external verification) ──────────────────

/** The exact 12 accepted JSONC top-level field names. */
export const CLOSED_JSONC_FIELDS = [
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
  "instructions",
] as const

// ── Canonical field type ─────────────────────────────────────────────

/** The closed set of accepted JSONC top-level field names, derived from the constant. */
export type CanonicalField = (typeof CLOSED_JSONC_FIELDS)[number]
