/**
 * P4.1 Canonical config foundation — deterministic immutable materialization.
 *
 * Materialization computes a single immutable value from two scoped
 * contents, with content/version stamps and structured provenance.
 *
 * On invalid input: the EXACT prior immutable materialization is returned
 * unchanged. No partial value/field/provenance reconstruction.
 *
 * Identity includes schema version + canonical source content normalized
 * recursively without dropping nested properties + opaque secret reference
 * identities (F1).
 *
 * Materialized values are deep-cloned and deep-frozen (F3).
 *
 * One allocated committed version is used for snapshot and all fields (F11).
 *
 * Per LOCK-011: immutable monotonic materializations, typed operators,
 * exact snapshot pinning semantics; active bridge generations are not
 * interrupted.
 */

import type {
  RegistryEntry,
  ScopedContent,
  MaterializedConfig,
  MaterializedField,
  ProvenanceStamp,
  ValidationError,
  StaleWriteConflict,
} from "./types"
import { composeAll, type ComposedField } from "./compose"
import { contentHash } from "./parse"

// ── Schema version ───────────────────────────────────────────────────

/**
 * Monotonic schema version. Increment when the materialization identity
 * format changes (e.g. adding a new field class changes the canonical form).
 * One committed version is used consistently across all materializations.
 */
export const SCHEMA_VERSION = 1

// ── Version counter ──────────────────────────────────────────────────

/**
 * Service-owned version counter. Each CanonicalConfigService instance
 * owns its own counter; there is no module-global version owner.
 * Rehydrated indexes are not authoritative materializations; new disk
 * materializations get coherent service-owned monotonic versions.
 */
export class MaterializeVersionCounter {
  private v = 0
  /** Monotonically increment and return the new version. */
  next(): number { return ++this.v }
  /** Current value without incrementing. */
  current(): number { return this.v }
  /** Reset (test only). */
  reset(): void { this.v = 0 }
}

/**
 * Shared counter for standalone callers (tests, non-service paths).
 * The service injects its own counter; this exists only for backward
 * compatibility with tests that call materialize() directly.
 */
const sharedCounter = new MaterializeVersionCounter()
export const resetVersion = () => sharedCounter.reset()
export const currentVersion = () => sharedCounter.current()

// ── Recursive canonical hashing (F1) ─────────────────────────────────

/**
 * Recursively canonicalize a value for deterministic hashing.
 * - Objects: sorted keys at every nesting level
 * - Arrays: preserved in order (no reordering)
 * - Opaque secret refs: preserved as-is (identity matters)
 * - No nested properties dropped
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === "object") {
    const sorted = Object.keys(value as Record<string, unknown>).sort()
    const result: Record<string, unknown> = {}
    for (const key of sorted) {
      result[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return result
  }
  return value
}

// ── Deep clone + freeze (F3) ─────────────────────────────────────────

/**
 * Deep clone and freeze a value recursively.
 * All objects and arrays become immutable.
 */
function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || value === undefined) return value as Readonly<T>
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value as Readonly<T>
  }
  if (Array.isArray(value)) {
    const cloned = value.map((el) => deepFreeze(el)) as unknown[]
    Object.freeze(cloned)
    return cloned as unknown as Readonly<T>
  }
  if (typeof value === "object") {
    const cloned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      cloned[k] = deepFreeze(v)
    }
    Object.freeze(cloned)
    return cloned as unknown as Readonly<T>
  }
  return value as Readonly<T>
}

// ── Materialization ──────────────────────────────────────────────────

export interface MaterializeInput {
  readonly global: ScopedContent | null
  readonly project: ScopedContent | null
  /** Override entries for test isolation. */
  readonly entries?: readonly RegistryEntry[]
  /** Per-service version counter override. When omitted, a shared counter is used. */
  readonly versionCounter?: MaterializeVersionCounter
}

export interface MaterializeResult {
  readonly config: MaterializedConfig
  readonly errors: readonly ValidationError[]
}

/**
 * Deterministically materialize a single immutable config value from
 * two scoped contents. Never mutates inputs.
 *
 * Returns the materialized config plus any validation errors.
 * On errors, the EXACT prior valid materialization is returned unchanged.
 */
export function materialize(
  input: MaterializeInput,
  prior: MaterializedConfig | null = null,
): MaterializeResult {
  const entries = input.entries ?? require("./registry").getAllEntries()
  const counter = input.versionCounter ?? sharedCounter
  const { fields, conflicts } = composeAll(entries, input.global, input.project)

  // If there are validation errors, return exact prior materialization
  if (conflicts.length > 0 && prior !== null) {
    return { config: prior, errors: conflicts }
  }

  // F11: Allocate a single committed version for snapshot and all fields
  const committedVersion = counter.next()

  // Build the materialized value
  const value: Record<string, unknown> = {}
  const materializedFields: MaterializedField[] = []
  const provenance: Record<string, ProvenanceStamp> = {}

  for (const field of fields) {
    value[field.key] = field.value
    materializedFields.push({
      key: field.key,
      value: field.value,
      source: field.source,
      provenance: field.provenance,
      version: committedVersion, // F11: same version for all fields
    })
    provenance[field.key] = field.provenance
  }

  // F1: Compute content hash using recursive canonical form
  const canonicalObj = canonicalize({ schemaVersion: SCHEMA_VERSION, ...value })
  const canonical = JSON.stringify(canonicalObj)
  const hash = contentHash(canonical)

  // F3: Deep-clone and deep-freeze the materialized value
  const frozenValue = deepFreeze(value)

  const config: MaterializedConfig = {
    value: frozenValue as Readonly<Record<string, unknown>>,
    fields: materializedFields,
    contentHash: hash,
    version: committedVersion, // F11: same version as fields
    provenance,
    schemaVersion: SCHEMA_VERSION,
  }

  return { config, errors: conflicts }
}

/**
 * Materialize with field-level preservation: when a conflict occurs,
 * the exact value from the prior valid materialization is preserved for
 * that field rather than being dropped entirely.
 *
 * Non-conflicting fields are computed fresh. The result carries the new
 * materialization version for non-conflicting fields and the prior
 * version for preserved fields.
 */
export function materializeWithPreservation(
  input: MaterializeInput,
  prior: MaterializedConfig,
): MaterializeResult {
  const entries = input.entries ?? require("./registry").getAllEntries()
  const counter = input.versionCounter ?? sharedCounter
  const { fields, conflicts } = composeAll(entries, input.global, input.project)

  if (conflicts.length === 0) {
    // No conflicts — normal materialization
    return materialize(input)
  }

  // Identify which keys had conflicts
  const conflictedKeys = new Set(conflicts.map((e) => e.path[0]))

  // Build the materialized value, preserving prior for conflicted fields
  const value: Record<string, unknown> = {}
  const materializedFields: MaterializedField[] = []
  const provenance: Record<string, ProvenanceStamp> = {}

  const committedVersion = counter.next()

  // Non-conflicted fields are computed fresh
  for (const field of fields) {
    value[field.key] = field.value
    materializedFields.push({
      key: field.key,
      value: field.value,
      source: field.source,
      provenance: field.provenance,
      version: committedVersion,
    })
    provenance[field.key] = field.provenance
  }

  // Preserve conflicted fields from prior — they don't appear in `fields`
  // (composeAll puts conflicts in the `conflicts` array, not `fields`)
  for (const key of conflictedKeys) {
    const priorField = prior.fields.find((f) => f.key === key)
    if (priorField) {
      value[key] = priorField.value
      materializedFields.push(priorField)
      provenance[key] = priorField.provenance
    }
  }

  // Also preserve fields from prior that were not in the new fields
  for (const priorField of prior.fields) {
    if (!value.hasOwnProperty(priorField.key) && !conflictedKeys.has(priorField.key)) {
      value[priorField.key] = priorField.value
      materializedFields.push(priorField)
      provenance[priorField.key] = priorField.provenance
    }
  }

  const canonicalObj = canonicalize({ schemaVersion: SCHEMA_VERSION, ...value })
  const canonical = JSON.stringify(canonicalObj)
  const hash = contentHash(canonical)

  const frozenValue = deepFreeze(value)

  const config: MaterializedConfig = {
    value: frozenValue as Readonly<Record<string, unknown>>,
    fields: materializedFields,
    contentHash: hash,
    version: committedVersion,
    provenance,
    schemaVersion: SCHEMA_VERSION,
  }

  return { config, errors: conflicts }
}

// ── Stale write conflict detection ───────────────────────────────────

/**
 * Detect a stale-write conflict: the file on disk has a different
 * content hash than what we expected (meaning another writer modified it).
 */
export function detectStaleWrite(
  expectedHash: string,
  actualContent: string,
  filePath: string,
): StaleWriteConflict | null {
  const actualHash = contentHash(actualContent)
  if (actualHash === expectedHash) return null
  return {
    expectedHash,
    actualHash,
    path: filePath,
  }
}
