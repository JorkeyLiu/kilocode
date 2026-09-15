/**
 * Permission provenance projector (webview-only, redacted).
 *
 * Pending requests carry evaluator provenance via `args.provenance`
 * (backend `PermissionV1.Request.metadata.provenance`, schemaVersion "1").
 * This module is the only reader of that shape in the webview. It accepts
 * only known enums/shapes and produces a minimal display model with no
 * raw paths, patterns, scopes, or identity strings. Unknown, malformed,
 * or future versions return null (fail closed) without breaking
 * permission handling.
 */

export type ProvenanceSource =
  | "runtime-safety"
  | "global-file"
  | "global-override"
  | "project-file"
  | "agent-manifest"
  | "session-restriction"
  | "approval"
  | "protected-file"

export type ProvenanceDecision = "deny" | "ask" | "ask-ceiling" | "allow" | "no-ceiling"

export type ProvenanceResult = "deny" | "ask" | "ask-ceiling" | "allow"

export type ProvenanceCeiling = "(a)" | "(b)" | "(c)"

export interface ProvenanceLayer {
  source: ProvenanceSource
  decision: ProvenanceDecision
}

export interface ProvenanceDisplay {
  result: ProvenanceResult
  layers: ProvenanceLayer[]
  ceiling: ProvenanceCeiling | null
}

const SOURCES: ReadonlySet<string> = new Set([
  "runtime-safety",
  "global-file",
  "global-override",
  "project-file",
  "agent-manifest",
  "session-restriction",
  "approval",
  "protected-file",
])

const DECISIONS: ReadonlySet<string> = new Set(["deny", "ask", "ask-ceiling", "allow", "no-ceiling"])

const RESULTS: ReadonlySet<string> = new Set(["deny", "ask", "ask-ceiling", "allow"])

const CEILINGS: ReadonlySet<string> = new Set(["(a)", "(b)", "(c)"])

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Fixed safe label mapping: 8 evaluator sourceKinds collapse to 7 scope labels. */
export const SOURCE_LABEL_KEYS: Record<ProvenanceSource, string> = {
  "runtime-safety": "ui.permission.provenance.source.runtime",
  "global-file": "ui.permission.provenance.source.global",
  "global-override": "ui.permission.provenance.source.global",
  "project-file": "ui.permission.provenance.source.project",
  "agent-manifest": "ui.permission.provenance.source.agent",
  "session-restriction": "ui.permission.provenance.source.session",
  approval: "ui.permission.provenance.source.approval",
  "protected-file": "ui.permission.provenance.source.protectedFile",
}

export const DECISION_LABEL_KEYS: Record<ProvenanceDecision, string> = {
  deny: "ui.permission.provenance.decision.deny",
  ask: "ui.permission.provenance.decision.ask",
  "ask-ceiling": "ui.permission.provenance.decision.askCeiling",
  allow: "ui.permission.provenance.decision.allow",
  "no-ceiling": "ui.permission.provenance.decision.noCeiling",
}

export const REASON_KEYS: Record<ProvenanceResult, string> = {
  ask: "ui.permission.provenance.reason.ask",
  "ask-ceiling": "ui.permission.provenance.reason.askCeiling",
  deny: "ui.permission.provenance.reason.deny",
  allow: "ui.permission.provenance.reason.allow",
}

export const CEILING_KEYS: Record<ProvenanceCeiling, string> = {
  "(a)": "ui.permission.provenance.ceiling.a",
  "(b)": "ui.permission.provenance.ceiling.b",
  "(c)": "ui.permission.provenance.ceiling.c",
}

/**
 * Project `args.provenance` to a redacted display model.
 * Returns null when provenance is absent, malformed, or a future version.
 * Never returns raw canonicalPath, rule patterns, approval scope,
 * session/agent identities, or operation IDs.
 */
export function projectProvenance(args: Record<string, unknown> | undefined): ProvenanceDisplay | null {
  if (!record(args)) return null
  const raw = args.provenance
  if (!record(raw)) return null
  if (raw.schemaVersion !== "1") return null
  const decisive = raw.decisive
  if (!record(decisive)) return null
  const result = decisive.result
  if (typeof result !== "string" || !RESULTS.has(result)) return null
  const rawCeiling = (decisive as Record<string, unknown>).ceilingId
  let ceiling: ProvenanceCeiling | null = null
  if (rawCeiling === null || rawCeiling === undefined) ceiling = null
  else if (typeof rawCeiling === "string" && CEILINGS.has(rawCeiling)) ceiling = rawCeiling as ProvenanceCeiling
  else return null
  const list = (raw as Record<string, unknown>).contributingLayers
  if (!Array.isArray(list) || list.length === 0) return null
  const layers: ProvenanceLayer[] = []
  for (const entry of list) {
    if (!record(entry)) return null
    const source = entry.sourceKind
    const decision = entry.decision
    if (typeof source !== "string" || !SOURCES.has(source)) return null
    if (typeof decision !== "string" || !DECISIONS.has(decision)) return null
    layers.push({ source: source as ProvenanceSource, decision: decision as ProvenanceDecision })
  }
  return { result: result as ProvenanceResult, layers, ceiling }
}
