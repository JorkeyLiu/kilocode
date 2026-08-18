/**
 * P4.1 Canonical config foundation — typed composition operators.
 *
 * Four operators per LOCK-011 / R10:
 * - single: field exists in exactly one scope; both explicit = conflict
 * - keyed: record merge by stable ID; duplicate IDs = conflict
 * - ordered: registry-declared global-then-project ordering
 * - restrictive: ordered layers preserved (global array + project array);
 *   NEVER overlays. Permission evaluator consumes the ordered stack.
 */

import type {
  RegistryEntry,
  ScopedContent,
  ValidationError,
  ProvenanceStamp,
  CompositionOperator,
} from "./types"

// ── Result types ─────────────────────────────────────────────────────

export interface ComposedField {
  readonly key: string
  readonly value: unknown
  readonly source: "global" | "project" | "merged"
  readonly provenance: ProvenanceStamp
}

export interface ComposeResult {
  readonly fields: ComposedField[]
  readonly conflicts: ValidationError[]
}

// ── Provenance helpers ───────────────────────────────────────────────

function makeProvenance(
  scope: "global" | "project" | "merged",
  canonicalPath: string,
  operator: CompositionOperator,
  explicit: boolean,
): ProvenanceStamp {
  return { scope, canonicalPath, operator, explicit }
}

function makeMergedProvenance(
  globalPath: string,
  projectPath: string,
  operator: CompositionOperator,
): ProvenanceStamp {
  return {
    scope: "merged",
    canonicalPath: `${globalPath}+${projectPath}`,
    operator,
    explicit: true,
    contributors: ["global", "project"],
  }
}

function makeConflictProvenance(
  field: string,
  scopes: ("global" | "project")[],
  operator: CompositionOperator,
): ProvenanceStamp {
  return {
    scope: "merged",
    canonicalPath: "",
    operator,
    explicit: true,
    conflict: {
      field,
      scopes,
      resolution: "conflict",
    },
  }
}

// ── Operators ────────────────────────────────────────────────────────

/**
 * Compose a "single" field: value exists in exactly one scope.
 * When both scopes are explicit, it is a conflict.
 */
function composeSingle(
  entry: RegistryEntry,
  global: ScopedContent | null,
  project: ScopedContent | null,
): ComposedField | ValidationError {
  const gVal = global?.raw[entry.key]
  const pVal = project?.raw[entry.key]
  const gExplicit = gVal !== undefined
  const pExplicit = pVal !== undefined

  if (gExplicit && pExplicit) {
    return {
      path: [entry.key],
      message: `Conflicting values for single field "${entry.key}" in global and project scopes`,
      scope: "global",
      file: entry.key,
    }
  }

  if (pExplicit) {
    return {
      key: entry.key,
      value: pVal,
      source: "project",
      provenance: makeProvenance("project", project!.provenance.canonicalPath, entry.composition, true),
    }
  }

  if (gExplicit) {
    return {
      key: entry.key,
      value: gVal,
      source: "global",
      provenance: makeProvenance("global", global!.provenance.canonicalPath, entry.composition, true),
    }
  }

  // Neither scope has the field — omitted from materialized value.
  return {
    key: entry.key,
    value: undefined,
    source: "global",
    provenance: makeProvenance("global", "", entry.composition, false),
  }
}

/**
 * Compose a "keyed" field: merge records by stable ID.
 * F9: Keyed stable IDs always conflict across authored scopes; no silent replacement.
 */
function composeKeyed(
  entry: RegistryEntry,
  global: ScopedContent | null,
  project: ScopedContent | null,
): ComposedField | ValidationError {
  const gVal = global?.raw[entry.key]
  const pVal = project?.raw[entry.key]
  const gRecord = isRecord(gVal) ? gVal : undefined
  const pRecord = isRecord(pVal) ? pVal : undefined

  if (!gRecord && !pRecord) {
    return {
      key: entry.key,
      value: undefined,
      source: "global",
      provenance: makeProvenance("global", "", entry.composition, false),
    }
  }

  if (!gRecord) {
    return {
      key: entry.key,
      value: pVal,
      source: "project",
      provenance: makeProvenance("project", project!.provenance.canonicalPath, entry.composition, true),
    }
  }

  if (!pRecord) {
    return {
      key: entry.key,
      value: gVal,
      source: "global",
      provenance: makeProvenance("global", global!.provenance.canonicalPath, entry.composition, true),
    }
  }

  // Both scopes have records — merge by key
  // F9: ALL keyed stable IDs conflict across scopes (no silent replacement)
  const merged: Record<string, unknown> = { ...gRecord }

  for (const [id, pEntry] of Object.entries(pRecord)) {
    if (id in merged) {
      return {
        path: [entry.key, id],
        message: `Duplicate keyed ID "${id}" in field "${entry.key}" across global and project scopes`,
        scope: "project",
        file: entry.key,
      }
    }
    merged[id] = pEntry
  }

  return {
    key: entry.key,
    value: merged,
    source: "merged",
    provenance: makeMergedProvenance(
      global!.provenance.canonicalPath,
      project!.provenance.canonicalPath,
      entry.composition,
    ),
  }
}

/**
 * Compose an "ordered" field: registry-declared global-then-project order.
 * Arrays are concatenated (global first, then project). Values that are
 * not arrays are wrapped in one-element arrays.
 */
function composeOrdered(
  entry: RegistryEntry,
  global: ScopedContent | null,
  project: ScopedContent | null,
): ComposedField | ValidationError {
  const gVal = global?.raw[entry.key]
  const pVal = project?.raw[entry.key]
  const gArr = Array.isArray(gVal) ? gVal : gVal !== undefined ? [gVal] : undefined
  const pArr = Array.isArray(pVal) ? pVal : pVal !== undefined ? [pVal] : undefined

  if (!gArr && !pArr) {
    return {
      key: entry.key,
      value: undefined,
      source: "global",
      provenance: makeProvenance("global", "", entry.composition, false),
    }
  }

  if (!gArr) {
    return {
      key: entry.key,
      value: pArr!.length === 1 ? pArr![0] : pArr,
      source: "project",
      provenance: makeProvenance("project", project!.provenance.canonicalPath, entry.composition, true),
    }
  }

  if (!pArr) {
    return {
      key: entry.key,
      value: gArr.length === 1 ? gArr[0] : gArr,
      source: "global",
      provenance: makeProvenance("global", global!.provenance.canonicalPath, entry.composition, true),
    }
  }

  // Both have values — concatenate global first, then project
  const merged = [...gArr, ...pArr]
  return {
    key: entry.key,
    value: merged.length === 1 ? merged[0] : merged,
    source: "merged",
    provenance: makeMergedProvenance(
      global!.provenance.canonicalPath,
      project!.provenance.canonicalPath,
      entry.composition,
    ),
  }
}

/**
 * Compose a "restrictive" field: preserve ordered layers.
 *
 * Per the spec: permission output preserves ordered global/project layers
 * as a restrictive policy stack, NEVER overlays them.
 *
 * The result is { global: ..., project: ... } so the permission evaluator
 * can process each layer independently.
 */
function composeRestrictive(
  entry: RegistryEntry,
  global: ScopedContent | null,
  project: ScopedContent | null,
): ComposedField | ValidationError {
  const gVal = global?.raw[entry.key]
  const pVal = project?.raw[entry.key]
  const gObj = isRecord(gVal) ? gVal : undefined
  const pObj = isRecord(pVal) ? pVal : undefined

  if (!gObj && !pObj) {
    return {
      key: entry.key,
      value: undefined,
      source: "global",
      provenance: makeProvenance("global", "", entry.composition, false),
    }
  }

  if (!gObj) {
    return {
      key: entry.key,
      value: { project: pObj },
      source: "project",
      provenance: makeProvenance("project", project!.provenance.canonicalPath, entry.composition, true),
    }
  }

  if (!pObj) {
    return {
      key: entry.key,
      value: { global: gObj },
      source: "global",
      provenance: makeProvenance("global", global!.provenance.canonicalPath, entry.composition, true),
    }
  }

  // Both layers exist — preserve as ordered stack, NOT overlay
  return {
    key: entry.key,
    value: { global: gObj, project: pObj },
    source: "merged",
    provenance: makeMergedProvenance(
      global!.provenance.canonicalPath,
      project!.provenance.canonicalPath,
      entry.composition,
    ),
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Compose values from two scopes using the operator declared in the registry.
 * Returns the composed field or a conflict error.
 */
export function composeField(
  entry: RegistryEntry,
  global: ScopedContent | null,
  project: ScopedContent | null,
): ComposedField | ValidationError {
  switch (entry.composition) {
    case "single":
      return composeSingle(entry, global, project)
    case "keyed":
      return composeKeyed(entry, global, project)
    case "ordered":
      return composeOrdered(entry, global, project)
    case "restrictive":
      return composeRestrictive(entry, global, project)
  }
}

/**
 * Compose all registry fields from two scoped contents.
 */
export function composeAll(
  entries: readonly RegistryEntry[],
  global: ScopedContent | null,
  project: ScopedContent | null,
): ComposeResult {
  const fields: ComposedField[] = []
  const conflicts: ValidationError[] = []

  for (const entry of entries) {
    const result = composeField(entry, global, project)
    if ("path" in result) {
      conflicts.push(result)
    } else if (result.value !== undefined) {
      fields.push(result)
    }
  }

  return { fields, conflicts }
}

// ── Helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
