/**
 * P4.1 Persisted derived selector indexes.
 *
 * Derived only from the last valid canonical materialization and agent manifests.
 * Stored in VS Code state with schema version, materialization identity/version,
 * provenance/stale/invalid diagnostics, provider IDs/models, agent IDs/display
 * metadata, and selected IDs as appropriate.
 *
 * Selector-only payloads: IDs, display labels, model IDs, selected IDs,
 * version/hash/provenance status/diagnostics. No provider endpoint/protocol,
 * variant override maps, effective permission/config, or secrets (Blocker 13).
 *
 * Key registry:
 * - globalState: `kilo.canonicalIndex.providers` and `kilo.canonicalIndex.globalModel`
 * - workspaceState: `kilo.canonicalIndex.agents` and `kilo.canonicalIndex.projectModel`
 */

import type { MaterializedConfig, ProvenanceStamp, StateAdapter, CanonicalProviderPayload } from "./types"
import { parseCanonicalProviderRecord, isValidModelsMap, parseOwnedCredentialRef } from "./types"
import type { ConfigSnapshot } from "./snapshot"

// ── Schema version ───────────────────────────────────────────────────

/**
 * Schema version for persisted selector indexes.
 * Increment when the persisted shape changes.
 */
export const SELECTOR_INDEX_VERSION = 1

// ── Provider index ───────────────────────────────────────────────────

export interface ProviderIndexEntry {
  /** Provider ID (key from the provider record). */
  readonly id: string
  /** Whether this provider has a stored credential ref. */
  readonly hasCredential: boolean
  readonly displayName: string
  readonly modelIds: readonly string[]
  readonly modelLabels: Readonly<Record<string, string>>
}

export interface ProviderIndex {
  readonly version: number
  /** Materialization version this index was derived from. */
  readonly materializationVersion: number
  /** Content hash of the source materialization. */
  readonly materializationHash: string
  /** Structured diagnostics if the source had errors. */
  readonly diagnostics: SelectorDiagnostics
  /** Provider entries derived from the materialized config. */
  readonly providers: readonly ProviderIndexEntry[]
  /** Selected provider ID (UI state, persisted for convenience). */
  readonly selectedId: string | null
  /** Timestamp of index creation/update. */
  readonly timestamp: number
}

// ── Agent index ──────────────────────────────────────────────────────

export interface AgentIndexEntry {
  /** Agent ID (filename without .md extension). */
  readonly id: string
  /** Display name from frontmatter or id fallback. */
  readonly displayName: string
  /** Description from frontmatter. */
  readonly description?: string
  /** Mode from frontmatter. */
  readonly mode?: "primary" | "secondary" | "specialized"
  /** Whether the agent is hidden. */
  readonly hidden: boolean
  /** Color from frontmatter. */
  readonly color?: string
  /** Source scope. */
  readonly source: "global" | "project"
  readonly filePath?: string
  readonly frontmatter?: Readonly<Record<string, unknown>>
  readonly body?: string
  readonly assetHash?: string
}

export interface AgentIndex {
  readonly version: number
  /** Materialization version this index was derived from. */
  readonly materializationVersion: number
  /** Content hash of the source materialization. */
  readonly materializationHash: string
  /** Structured diagnostics if the source had errors. */
  readonly diagnostics: SelectorDiagnostics
  /** Agent entries from both scopes. */
  readonly agents: readonly AgentIndexEntry[]
  /** Selected agent ID (UI state, persisted for convenience). */
  readonly selectedId: string | null
  /** Default agent from config. */
  readonly defaultId: string | null
  /** Timestamp of index creation/update. */
  readonly timestamp: number
}

// ── Model index ──────────────────────────────────────────────────────

export interface ModelIndex {
  readonly version: number
  /** Materialization version this index was derived from. */
  readonly materializationVersion: number
  /** Content hash of the source materialization. */
  readonly materializationHash: string
  /** Structured diagnostics if the source had errors. */
  readonly diagnostics?: SelectorDiagnostics
  /** The resolved model string (provider/model). */
  readonly model: string | null
  /** The resolved variant string. */
  readonly variant: string | null
  /** Selected model (UI state). */
  readonly selectedModel: string | null
  /** Selected variant (UI state). */
  readonly selectedVariant: string | null
  /** Timestamp of index creation/update. */
  readonly timestamp: number
}

// ── Diagnostics ──────────────────────────────────────────────────────

export interface SelectorDiagnostics {
  /** Whether the source materialization had validation errors. */
  readonly invalid: boolean
  /** Whether the source materialization is stale (retained prior valid). */
  readonly stale: boolean
  /** Conflict details from cross-scope composition. */
  readonly conflicts: readonly SelectorConflict[]
  /** Provenance stamps for diagnostic traceability. */
  readonly provenance: Record<string, ProvenanceStamp>
}

export interface SelectorConflict {
  readonly field: string
  readonly id?: string
  readonly scopes: readonly ("global" | "project" | "merged")[]
  readonly message: string
}

// ── State key constants ──────────────────────────────────────────────

export const STATE_KEYS = {
  providers: "kilo.canonicalIndex.providers",
  agents: "kilo.canonicalIndex.agents",
  globalModel: "kilo.canonicalIndex.globalModel",
  projectModel: "kilo.canonicalIndex.projectModel",
} as const

// ── Index builders ───────────────────────────────────────────────────

/**
 * Build a provider index from a materialized config snapshot.
 * Selector-only payload: IDs, credential status, diagnostics (Blocker 13).
 * No endpoint/protocol fields.
 *
 * Credential status is derived from each record's exact `credential` ref
 * via parseOwnedCredentialRef — never from a SecretStorage prefix scan.
 * The credentialStatus map provides per-ID boolean indicating whether the
 * record's exact ref is valid and stored. When omitted, all providers
 * report hasCredential: false (synchronous callers with no SecretStorage).
 */
export function buildProviderIndex(
  snapshot: ConfigSnapshot,
  existingSelectedId: string | null,
  credentialStatus?: ReadonlyMap<string, boolean>,
): ProviderIndex {
  const config = snapshot.config
  const parsedProviders = parseCanonicalProviderRecord(config.value.provider)
  const providers: ProviderIndexEntry[] = []

  if (parsedProviders) {
    for (const [id, entry] of Object.entries(parsedProviders)) {
      const models = entry.models
      const modelLabels: Record<string, string> = {}
      const modelIds = models ? Object.keys(models) : []
      if (models) {
        for (const [modelId, model] of Object.entries(models)) {
          if (typeof model.name === "string") {
            modelLabels[modelId] = model.name
          }
        }
      }
      providers.push({
        id,
        hasCredential: credentialStatus?.get(id) ?? (typeof entry.credential === "string" && parseOwnedCredentialRef(entry.credential) !== null),
        displayName: typeof entry.name === "string" ? entry.name : id,
        modelIds,
        modelLabels,
      })
    }
  }

  return {
    version: SELECTOR_INDEX_VERSION,
    materializationVersion: config.version,
    materializationHash: config.contentHash,
    diagnostics: buildDiagnostics(config),
    providers,
    selectedId: existingSelectedId,
    timestamp: Date.now(),
  }
}

/**
 * Build an agent index from agent frontmatter entries and materialization.
 */
export function buildAgentIndex(
  snapshot: ConfigSnapshot,
  agentEntries: Array<{ id: string; displayName: string; description?: string; mode?: "primary" | "secondary" | "specialized"; hidden?: boolean; color?: string; source: "global" | "project"; filePath?: string; frontmatter?: Record<string, unknown>; body?: string; assetHash?: string }>,
  existingSelectedId: string | null,
): AgentIndex {
  const config = snapshot.config
  const defaultAgent = typeof config.value.default_agent === "string" ? config.value.default_agent : null

  return {
    version: SELECTOR_INDEX_VERSION,
    materializationVersion: config.version,
    materializationHash: config.contentHash,
    diagnostics: buildDiagnostics(config),
    agents: agentEntries.map((e) => ({
      id: e.id,
      displayName: e.displayName || e.id,
      description: e.description,
      mode: e.mode,
      hidden: e.hidden ?? false,
      color: e.color,
       source: e.source,
       filePath: e.filePath,
      frontmatter: e.frontmatter,
      body: e.body,
      assetHash: e.assetHash,
    })),
    selectedId: existingSelectedId,
    defaultId: defaultAgent,
    timestamp: Date.now(),
  }
}

/**
 * Build a model index from a materialized config snapshot.
 * Selector-only payload: model/variant IDs and selected state (Blocker 13).
 * No variant override maps.
 */
export function buildModelIndex(
  snapshot: ConfigSnapshot,
  scope: "global" | "project",
  existingSelectedModel: string | null,
  existingSelectedVariant: string | null,
): ModelIndex {
  const config = snapshot.config
  const model = typeof config.value.model === "string" ? config.value.model : null
  const variant = typeof config.value.model_variant === "string" ? config.value.model_variant : null

  return {
    version: SELECTOR_INDEX_VERSION,
    materializationVersion: config.version,
    materializationHash: config.contentHash,
    diagnostics: buildDiagnostics(config),
    model,
    variant,
    selectedModel: existingSelectedModel,
    selectedVariant: existingSelectedVariant,
    timestamp: Date.now(),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildDiagnostics(config: MaterializedConfig): SelectorDiagnostics {
  const conflicts: SelectorConflict[] = []
  for (const [field, prov] of Object.entries(config.provenance)) {
    if (prov.conflict) {
      conflicts.push({
        field,
        scopes: prov.conflict.scopes as ("global" | "project" | "merged")[],
        message: prov.conflict.resolution,
      })
    }
  }

  return {
    invalid: false,
    stale: false,
    conflicts,
    provenance: config.provenance,
  }
}

// ── Persist / Rehydrate ──────────────────────────────────────────────

/**
 * Persist a provider index to globalState.
 * Stores last valid canonical state plus diagnostic status; never secrets/effective config.
 */
export async function persistProviderIndex(state: StateAdapter, index: ProviderIndex): Promise<void> {
  await state.update(STATE_KEYS.providers, index)
}

/**
 * Rehydrate a provider index from globalState.
 * Returns null if no persisted index or if the schema version is incompatible.
 */
export function rehydrateProviderIndex(state: StateAdapter): ProviderIndex | null {
  const stored = state.get<ProviderIndex>(STATE_KEYS.providers)
  if (!stored) return null
  if (stored.version !== SELECTOR_INDEX_VERSION) return null
  return stored
}

/**
 * Persist an agent index to workspaceState.
 */
export async function persistAgentIndex(state: StateAdapter, index: AgentIndex): Promise<void> {
  await state.update(STATE_KEYS.agents, index)
}

/**
 * Rehydrate an agent index from workspaceState.
 */
export function rehydrateAgentIndex(state: StateAdapter): AgentIndex | null {
  const stored = state.get<AgentIndex>(STATE_KEYS.agents)
  if (!stored) return null
  if (stored.version !== SELECTOR_INDEX_VERSION) return null
  return stored
}

/**
 * Persist a model index to the appropriate state adapter (globalModel or projectModel).
 */
export async function persistModelIndex(state: StateAdapter, index: ModelIndex, scope: "global" | "project"): Promise<void> {
  const key = scope === "global" ? STATE_KEYS.globalModel : STATE_KEYS.projectModel
  await state.update(key, index)
}

/**
 * Rehydrate a model index from the appropriate state adapter.
 */
export function rehydrateModelIndex(state: StateAdapter, scope: "global" | "project"): ModelIndex | null {
  const key = scope === "global" ? STATE_KEYS.globalModel : STATE_KEYS.projectModel
  const stored = state.get<ModelIndex>(key)
  if (!stored) return null
  if (stored.version !== SELECTOR_INDEX_VERSION) return null
  return stored
}

/**
 * Mark an index as stale/invalid while retaining last valid entries.
 * Invalid edits do not replace persisted valid index data.
 */
export function markIndexStale<T extends { readonly diagnostics: SelectorDiagnostics; readonly version: number }>(
  index: T,
): T {
  return {
    ...index,
    diagnostics: {
      ...index.diagnostics,
      invalid: true,
      stale: true,
    },
  } as T
}
