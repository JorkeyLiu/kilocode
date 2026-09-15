import { PROVIDER_EXECUTE_PROTOCOLS, isProviderExecuteProtocol, type ProviderExecuteProtocol } from "@opencode-ai/core/kilocode/provider-execute"
import {
  parseOwnedCredentialRef as parseOwnedCredentialRefCore,
  isOwnedCredentialRef as isOwnedCredentialRefCore,
} from "@opencode-ai/core/kilocode/credential-ref"
import {
  isValidCanonicalProviderEntry as isValidCanonicalProviderEntryCore,
  isValidModelEntry as isValidModelEntryCore,
  isValidModelsMap as isValidModelsMapCore,
  isValidVariantEntry as isValidVariantEntryCore,
  APPROVED_VARIANT_KEYS as APPROVED_VARIANT_KEYS_CORE,
  type CanonicalProviderPayload as CoreCanonicalProviderPayload,
  type CanonicalProviderModelPayload as CoreCanonicalProviderModelPayload,
  type CanonicalProviderVariantPayload as CoreCanonicalProviderVariantPayload,
} from "@opencode-ai/core/kilocode/canonical-record"

/**
 * P4.1 Canonical config foundation — core types.
 *
 * Every type in this module is vscode-free and testable with plain
 * filesystem operations. The types define the shape of the registry,
 * scope model, composition operators, and materialization results.
 */

// ── Scopes ───────────────────────────────────────────────────────────

/** Disposable interface (decoupled from vscode). */
export interface Disposable {
  dispose(): void
}

/** The two authored scopes per LOCK-010. */
export type Scope = "global" | "project"

/** Scoped content parsed from a canonical root. */
export interface ScopedContent {
  readonly scope: Scope
  readonly root: string
  readonly raw: Record<string, unknown>
  readonly provenance: ProvenanceStamp
}

// ── Composition operators ────────────────────────────────────────────

/**
 * Composition operator per LOCK-011 / R10.
 * - single: field exists in exactly one scope; both explicit = conflict
 * - keyed: record merge by stable ID; duplicate IDs = conflict
 * - ordered: registry-declared global-then-project ordering
 * - restrictive: ordered layers preserved for later permission evaluation; never overlays
 * - meta: benign tooling metadata (e.g. $schema); valid in both scopes,
 *   never composed, never enters the materialized value or content hash
 */
export type CompositionOperator = "single" | "keyed" | "ordered" | "restrictive" | "meta"

// ── Persistence & ownership ──────────────────────────────────────────

export type Persistence = "jsonc" | "markdown" | "secret" | "derived"
export type Owner = "extension" | "backend" | "shared"

// ── Secret handling ──────────────────────────────────────────────────

export type SecretHandling =
  /** No secret; plain value. */
  | "none"
  /** Opaque SecretStorage reference; plaintext rejected/diagnosed. */
  | "secret-ref"

// ── Removal disposition ──────────────────────────────────────────────

export type RemovalDisposition =
  /** Remove from materialized value; reverts to default. */
  | "remove"
  /** Keep in materialized value even when unset (restrictive layers). */
  | "preserve"

// ── Registry entry ───────────────────────────────────────────────────

export interface RegistryEntry {
  /** Dot-path key in the JSONC config (e.g. "model", "provider.openai"). */
  readonly key: string
  /** Human-readable description. */
  readonly description: string
  /** Which scope(s) can own this field. */
  readonly scopes: Scope[]
  /** How this field is persisted. */
  readonly persistence: Persistence
  /** Who writes this field. */
  readonly owner: Owner
  /** Composition operator when merging across scopes. */
  readonly composition: CompositionOperator
  /** For ordered composition: precedence order (lower = earlier). */
  readonly order?: number
  /** Secret handling: "secret-ref" means the value is an opaque ref, not plaintext. */
  readonly secret: SecretHandling
  /** Whether this field appears in the immutable snapshot. */
  readonly snapshot: boolean
  /** Provenance stamp format. */
  readonly provenance: "file" | "computed" | "inherited"
  /** What happens when the field is removed. */
  readonly removal: RemovalDisposition
  /** If true, duplicate IDs across scopes are validation errors. */
  readonly crossScopeConflict?: boolean
}

// ── Validation ───────────────────────────────────────────────────────

export interface ValidationError {
  readonly path: string[]
  readonly message: string
  readonly scope?: Scope
  readonly file?: string
}

// ── Structured provenance ────────────────────────────────────────────

/**
 * Machine-inspectable provenance stamp per LOCK / R10.
 * Every materialized field carries a full stamp, not a flat string.
 */
export interface ProvenanceStamp {
  /** Which authored scope produced this value. */
  readonly scope: Scope | "merged"
  /** Canonical config or asset file path. */
  readonly canonicalPath: string
  /** Whether the value was explicitly set or is a default/absent. */
  readonly explicit: boolean
  /** The registry operator that produced this field. */
  readonly operator: CompositionOperator
  /** Source key or ID within the scope (e.g. provider ID). */
  readonly sourceKey?: string
  /** Ordered contributors when merged across scopes. */
  readonly contributors?: readonly (Scope | "merged")[]
  /** Conflict details when the value was resolved from a conflict. */
  readonly conflict?: {
    readonly field: string
    readonly scopes: readonly Scope[]
    readonly resolution: string
  }
}

// ── Materialization ──────────────────────────────────────────────────

export interface MaterializedField {
  readonly key: string
  readonly value: unknown
  readonly source: Scope | "merged"
  readonly provenance: ProvenanceStamp
  readonly version: number
}

export interface MaterializedConfig {
  /** The fully resolved config value (deep-frozen). */
  readonly value: Readonly<Record<string, unknown>>
  /** Per-field materialization info. */
  readonly fields: readonly MaterializedField[]
  /** Content hash of the materialized value (includes schema version). */
  readonly contentHash: string
  /** Version stamp (monotonic integer). */
  readonly version: number
  /** Structured provenance chain for each top-level key. */
  readonly provenance: Record<string, ProvenanceStamp>
  /** Schema version used for this materialization identity. */
  readonly schemaVersion: number
}

// ── Write operations ─────────────────────────────────────────────────

export interface WriteResult {
  readonly path: string
  readonly contentHash: string
  readonly version: number
  readonly provenance: string
}

export interface StaleWriteConflict {
  readonly expectedHash: string
  readonly actualHash: string
  readonly path: string
}

// ── Asset discovery ──────────────────────────────────────────────────

/** Canonical asset directory names per R10. */
export const ASSET_DIRECTORIES = ["agent", "command", "skill", "tool", "plugin", "rules"] as const
export type AssetDirectory = (typeof ASSET_DIRECTORIES)[number]

// ── Canonical paths ──────────────────────────────────────────────────

export interface CanonicalPaths {
  readonly globalRoot: string
  readonly globalConfigFile: string
  readonly projectRoot: string | undefined
  readonly projectConfigFile: string | undefined
  readonly globalAssetDirs: Record<AssetDirectory, string>
  readonly projectAssetDirs: Record<AssetDirectory, string> | undefined
}

// ── File read results ────────────────────────────────────────────────

/** Discriminated file read result per LOCK-001. */
export type FileReadResult =
  | { readonly type: "present"; readonly bytes: string; readonly hash: string }
  | { readonly type: "absent" }
  | { readonly type: "failure"; readonly code: string; readonly message: string }

// ── Injected adapters ────────────────────────────────────────────────

/** Simple event emitter interface (decoupled from vscode). */
export interface TypedEmitter<T> {
  readonly event: (listener: (e: T) => void) => { dispose(): void }
  fire(event: T): void
  dispose(): void
}

/** Factory for typed event emitters (production uses vscode.EventEmitter). */
export interface EmitterFactory {
  create<T>(): TypedEmitter<T>
}

/** VS Code state adapter for persisting/rehydrating derived indexes. */
export interface StateAdapter {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Promise<void>
}

/** File system watcher adapter for testability. */
export interface WatcherAdapter {
  /**
   * Watch a file or directory for changes. Returns a disposable to stop watching.
   * The callbacks receive the changed file path when available (VS Code provides it),
   * enabling per-file own-write coalescing without scanning the whole directory.
   * @param dir The directory containing the target
   * @param pattern Glob pattern or filename to watch
   * @param onChange Called when an existing file changes (receives changed path if available)
   * @param onCreate Called when a new file is created (receives created path if available)
   * @param onDelete Called when a file is deleted (receives deleted path if available)
   */
  watch(dir: string, pattern: string, onChange: (changedPath?: string) => void, onCreate: (createdPath?: string) => void, onDelete: (deletedPath?: string) => void): { dispose(): void }
}

/** Scan result for a single asset file. */
export interface AssetScanEntry {
  readonly id: string
  readonly filePath: string
  readonly contentHash: string
  readonly scope: "global" | "project"
  /** Validated parsed frontmatter used to build AgentIndex.
   *  Retained on malformed/unreadable replacement so the index
   *  is built from the last known good metadata. */
  readonly frontmatter?: Record<string, unknown>
  readonly body?: string
}

/** Authoritative stamp carried across the extension/webview boundary. */
export interface CanonicalStamp {
  readonly globalHash: string | null
  readonly projectHash: string | null
  readonly materializationVersion: number
  /** Null for config/provider mutations; "absent" is the asset create state. */
  readonly assetHash: string | null
}

/** JSONC values allowed in the canonical webview config boundary. */
export type CanonicalConfigValue = string | number | boolean | null | CanonicalConfigValue[] | { readonly [key: string]: CanonicalConfigValue }

/**
 * Per-KiloProvider host-owned cleanup retry record (LOCK-5).
 * The opaque retryID is the map key; kind+scope+id namespace provider vs MCP
 * so they cannot collide. state "available" → reservable; "inFlight" → a retry
 * is currently executing (concurrent duplicates must see inFlight/absent).
 * ref must be an exact extension-owned SecretStorage ref validated at store time.
 * stamp is the complete service stamp captured when the record was created.
 */
export type CleanupRetryRecord = {
  readonly kind: "provider" | "mcp"
  readonly scope: "global" | "project"
  /** Provider ID or MCP server name. */
  readonly id: string
  readonly mode: "delete" | "restore"
  /** Exact validated owned credential ref — never reconstructed from webview fields. */
  readonly ref?: string
  /** Prior provider record for restore mode (exact, lossless). */
  readonly priorRecord?: Record<string, unknown>
  /** Prior secret value for restore mode (exact, lossless). */
  readonly priorValue?: string
  /** Complete operation stamp (config/asset identity) captured at store time. */
  readonly stamp: CanonicalStamp
  readonly state: "available" | "inFlight"
}

/** The exact closed canonical JSONC payload; secrets stay extension-host only. */
export type CanonicalConfigPayload = Partial<{
  model: string | null
  model_variant: string | null
  model_variant_overrides: { readonly [key: string]: string | null } | null
  subagent_model: string | null
  subagent_variant: string | null
  subagent_variant_overrides: { readonly [key: string]: string | null } | null
  default_agent: string | null
  provider: { readonly [id: string]: CanonicalProviderPayload }
  mcp: { readonly [name: string]: CanonicalMcpPayload }
  permission: { readonly [key: string]: CanonicalConfigValue }
  instructions: string | readonly string[]
  terminal_command_display: "expanded" | "collapsed"
  auto_collapse_reasoning: boolean
}>

/** Provider metadata persisted in canonical JSONC. Credential is extension-host-only (never sent to webview). */
export type CanonicalProviderPayload = CoreCanonicalProviderPayload
export type CanonicalProviderModelPayload = CoreCanonicalProviderModelPayload
export type CanonicalProviderVariantPayload = CoreCanonicalProviderVariantPayload

/** MCP metadata exposed to the webview. Credential-bearing values are host-only. */
export interface CanonicalMcpPayload {
  readonly type?: "local" | "remote"
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
  readonly enabled?: boolean
  /** Opaque SecretStorage reference — persisted in JSONC but excluded from webview payload. */
  readonly credential?: string
}

export function sameStamp(a: CanonicalStamp, b: CanonicalStamp): boolean {
  return a.globalHash === b.globalHash &&
    a.projectHash === b.projectHash &&
    a.materializationVersion === b.materializationVersion &&
    a.assetHash === b.assetHash
}

/** Allowed scalar types for CanonicalConfigPayload values. */
type Scalar = string | number | boolean | null

/** Validate that a value is a legal CanonicalConfigPayload recursively. */
function isValidPayloadValue(v: unknown): v is CanonicalConfigValue {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return true
  if (Array.isArray(v)) return v.every(isValidPayloadValue)
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return Object.values(v).every(isValidPayloadValue)
  }
  return false
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key))
}

// ── Shared canonical schema validators ─────────────────────────────
// Single source is @opencode-ai/core/kilocode/canonical-record for
// provider/model/variant validation and payload types. VS Code re-exports
// the shared validator with context {providerId, scope} support; only MCP
// validation stays host-local.

/** Approved protocol values for canonical provider entries. */
export const CANONICAL_PROVIDER_PROTOCOLS = PROVIDER_EXECUTE_PROTOCOLS
export type CanonicalProviderProtocol = ProviderExecuteProtocol

export function isCanonicalProviderProtocol(v: unknown): v is CanonicalProviderProtocol {
  return isProviderExecuteProtocol(v)
}

// Re-export shared variant/model/provider validators from core (single source).
export const APPROVED_VARIANT_KEYS = APPROVED_VARIANT_KEYS_CORE

/** @deprecated use shared core validator — preserved for public export compatibility */
const APPROVED_MODEL_KEYS = new Set(["name", "reasoning", "modalities", "variants"])
/** @deprecated use shared core validator — preserved for public export compatibility */
const APPROVED_PROVIDER_KEYS = new Set(["name", "endpoint", "protocol", "models", "credential"])

/** Approved MCP-level keys — must match CanonicalMcpPayload exactly. */
const APPROVED_MCP_KEYS = new Set(["type", "command", "args", "url", "enabled", "credential"])

export function isOwnedCredentialRef(ref: string): boolean {
  return isOwnedCredentialRefCore(ref)
}

export function parseOwnedCredentialRef(ref: string): { scope: "global" | "project"; kind: "provider" | "mcp"; id: string } | null {
  return parseOwnedCredentialRefCore(ref)
}

export function isValidVariantEntry(v: unknown): boolean {
  return isValidVariantEntryCore(v)
}

/** Shared: validate an MCP credential ref — owned format plus kind/id context when provided. */
function isValidMcpCredential(v: unknown, contextName?: string): boolean {
  if (typeof v !== "string" || !isOwnedCredentialRef(v)) return false
  if (contextName === undefined) return true
  const parsed = parseOwnedCredentialRef(v)
  return parsed !== null && parsed.kind === "mcp" && parsed.id === contextName
}

export function isValidModelEntry(v: unknown): boolean {
  return isValidModelEntryCore(v)
}

export function isValidModelsMap(v: unknown): boolean {
  return isValidModelsMapCore(v)
}

export function isValidCanonicalProviderEntry(
  v: unknown,
  context?: string | { providerId?: string; scope?: "global" | "project" },
): v is CanonicalProviderPayload {
  if (context === undefined) return isValidCanonicalProviderEntryCore(v)
  if (typeof context === "string") return isValidCanonicalProviderEntryCore(v, context)
  return isValidCanonicalProviderEntryCore(v, { providerId: context.providerId, scope: context.scope })
}

/**
 * Shared: validate a single MCP entry against the canonical schema.
 * Exact keys: type?, command?, args?, url?, enabled?, credential?.
 * credential must be an exact extension-owned ref when present.
 * When contextName is provided, the credential ref must carry kind "mcp"
 * and an id equal to contextName.
 */
export function isValidCanonicalMcpEntry(v: unknown, contextName?: string): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  if (!hasOnlyKeys(r, APPROVED_MCP_KEYS)) return false
  if (r.type !== undefined && r.type !== "local" && r.type !== "remote") return false
  if (r.command !== undefined && typeof r.command !== "string") return false
  if (r.args !== undefined && (!Array.isArray(r.args) || !r.args.every((item) => typeof item === "string"))) return false
  if (r.url !== undefined && typeof r.url !== "string") return false
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") return false
  if (r.credential !== undefined && !isValidMcpCredential(r.credential, contextName)) return false
  return true
}

// ── Canonical payload type guards (using shared validators) ───────

function isCanonicalMcpPayload(v: unknown): v is CanonicalMcpPayload {
  return isValidCanonicalMcpEntry(v)
}

const CANONICAL_KEYS = new Set(["model", "model_variant", "model_variant_overrides", "subagent_model", "subagent_variant", "subagent_variant_overrides", "default_agent", "provider", "mcp", "permission", "instructions", "terminal_command_display", "auto_collapse_reasoning"])

/**
 * Validate and narrow a plain object into a CanonicalConfigPayload.
 * Returns undefined if any field contains an unexpected key or wrong type.
 * No broad casts — every field is validated before inclusion.
 */
export function toCanonicalPayload(value: unknown): CanonicalConfigPayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const result: CanonicalConfigPayload = {}
  for (const [key, val] of Object.entries(value)) {
    if (!CANONICAL_KEYS.has(key)) return undefined
    if (val === undefined) continue
    const field = canonicalField(key, val)
    if (field === undefined) return undefined
    Object.assign(result, field)
  }
  return result
}

function canonicalField(key: string, value: unknown): CanonicalConfigPayload | undefined {
  const scalar = new Map<string, (value: unknown) => CanonicalConfigPayload | undefined>([
    ["model", (item) => typeof item === "string" || item === null ? { model: item } : undefined],
    ["model_variant", (item) => typeof item === "string" || item === null ? { model_variant: item } : undefined],
    ["subagent_model", (item) => typeof item === "string" || item === null ? { subagent_model: item } : undefined],
    ["subagent_variant", (item) => typeof item === "string" || item === null ? { subagent_variant: item } : undefined],
    ["default_agent", (item) => typeof item === "string" || item === null ? { default_agent: item } : undefined],
    ["model_variant_overrides", (item) => item === null || isStringMap(item) ? { model_variant_overrides: item } : undefined],
    ["subagent_variant_overrides", (item) => item === null || isStringMap(item) ? { subagent_variant_overrides: item } : undefined],
    ["provider", (item) => isProviderMap(item) ? { provider: item } : undefined],
    ["mcp", (item) => isMcpMap(item) ? { mcp: item } : undefined],
    ["permission", (item) => isConfigValueMap(item) ? { permission: item } : undefined],
    ["instructions", (item) => typeof item === "string" || isStringArray(item) ? { instructions: item } : undefined],
    ["terminal_command_display", (item) => item === "expanded" || item === "collapsed" ? { terminal_command_display: item } : undefined],
    ["auto_collapse_reasoning", (item) => typeof item === "boolean" ? { auto_collapse_reasoning: item } : undefined],
  ])
  return scalar.get(key)?.(value)
}

function isStringArray(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === "string") }
function isStringMap(value: unknown): value is { readonly [key: string]: string | null } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string" || item === null)
}
function isConfigValueMap(value: unknown): value is { readonly [key: string]: CanonicalConfigValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isValidPayloadValue(value)
}
function isProviderMap(value: unknown): value is { readonly [key: string]: CanonicalProviderPayload } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return Object.entries(r).every(([id, entry]) => isValidCanonicalProviderEntry(entry, id))
}
function isMcpMap(value: unknown): value is { readonly [key: string]: CanonicalMcpPayload } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return Object.entries(r).every(([name, entry]) => isValidCanonicalMcpEntry(entry, name))
}

// ── Typed canonical provider record accessor ────────────────────────

/**
 * Parse a provider record from the canonical config service's getScopeConfig
 * into a keyed map of validated CanonicalProviderPayload entries.
 * Uses the same exact validation as toCanonicalPayload — no broad casts.
 * Returns undefined if the provider value is not a valid keyed record.
 */
export function parseCanonicalProviderRecord(value: unknown): { readonly [id: string]: CanonicalProviderPayload } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const result: Record<string, CanonicalProviderPayload> = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidCanonicalProviderEntry(entry, id)) return undefined
    result[id] = entry
  }
  return result
}

/**
 * Narrow a single provider entry from a canonical config scope into
 * CanonicalProviderPayload. Returns undefined if not valid.
 * No id context is available here, so credential refs are format-checked only.
 */
export function narrowProviderEntry(entry: unknown): CanonicalProviderPayload | undefined {
  return isValidCanonicalProviderEntry(entry) ? entry : undefined
}

/** Result of scanning all six asset directories in both scopes. */
export interface AssetScanResult {
  readonly entries: readonly AssetScanEntry[]
  readonly errors: readonly ValidationError[]
  readonly duplicateIds: readonly { type: AssetDirectory; id: string; scopeA: string; scopeB: string; fileA: string; fileB: string }[]
}
