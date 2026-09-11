// kilocode_change - scope-aware canonical provider provenance snapshot
import type { CanonicalProviderPayload } from "@opencode-ai/core/kilocode/canonical-record"

export type ProvenanceScope = "global" | "project"

export type CanonicalProviderEntry = {
  readonly id: string
  readonly scope: ProvenanceScope
  readonly source: string
  readonly record: CanonicalProviderPayload
}

export type CanonicalConflictReason =
  | "duplicate"
  | "missing-credential"
  | "malformed-credential"
  | "scope-mismatch"
  | "id-mismatch"
  | "invalid-record"
  | "invalid-endpoint"
  | "unknown-protocol"
  | "invalid-models"

export type CanonicalConflict = {
  readonly id: string
  readonly reason: CanonicalConflictReason
  /** Human-readable safe message without plaintext secret */
  readonly message: string
  /** Scopes involved, e.g. ["global","project"] for duplicate */
  readonly scopes?: readonly ProvenanceScope[]
  /** Source file paths involved */
  readonly sources?: readonly string[]
}

export type CanonicalProvenance = {
  readonly providers: Readonly<Record<string, CanonicalProviderEntry>>
  readonly conflicts: readonly CanonicalConflict[]
}

export const emptyProvenance: CanonicalProvenance = {
  providers: Object.create(null) as Record<string, CanonicalProviderEntry>,
  conflicts: [],
}

export function isEmptyProvenance(p: CanonicalProvenance): boolean {
  return Object.keys(p.providers).length === 0 && p.conflicts.length === 0
}

export function hasProvider(provenance: CanonicalProvenance, id: string): boolean {
  return Object.hasOwn(provenance.providers, id)
}

export function getProvider(provenance: CanonicalProvenance, id: string): CanonicalProviderEntry | undefined {
  return Object.hasOwn(provenance.providers, id) ? provenance.providers[id] : undefined
}
