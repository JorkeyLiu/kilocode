# 0004: Architecture-First Direct Reconstruction

- Status: Active
- Date: 2026-08-14
- Owner: Kilo maintainers

## Context

The migration documents currently describe a binary model: features are either
invariants (H-1..H-13, operationalizing ADR-0002 LOCK-005/007/008) or decided
removals (ADR-0002 LOCK-001, LOCK-002, LOCK-003, LOCK-004, LOCK-006, plus the
non-preservation clause of LOCK-005 for the existing compaction implementation;
runtime spec sections 8/8.1 legacy sources),
and the wording is over-strong in places — H-1..H-13 read as if every
intermediate phase must preserve the old implementation, and a compatibility
gate promises released-client behavior and stored-state compatibility without
scoping. Nothing answers how implementation should treat legacy features and
behaviors that neither closed set names.

The user clarified that exhaustive advance classification is not fundamental: a
complete pre-migration feature list is neither possible nor required.
Principles plus the two closed sets plus just-in-time evidence preservation
govern implementation.

A read-only investigation of the current error/retry stack found multiple retry
owners (the session prompt loop / LLM executor, the extension submit and SDK
call paths, and child/incomplete-session loops), Retry-After handling and
backoff ladders that can produce first waits of tens of seconds, no unified
operation/outcome/recovery ownership, and no canonical Failure/Outcome model.
The paused `jorkey/feature/error-system` branch is design/input evidence only:
it intentionally did not change retry policy, and its compatibility/versioning/
client scope is discarded under the current product removals.

This ADR complements ADR-0002 (product direction and removals) and ADR-0003
(runtime/config ownership) by deciding how the migration treats everything the
two closed sets do not name, and by bounding where failure/outcome/recovery
belongs.

## Decision

The migration is architecture-first and direct-reconstruction: it is
principle-first, not inventory-first. Two closed sets are already decided and
everything outside them has no default compatibility entitlement. When
implementation first touches a legacy feature or behavior, the responsible
phase may directly migrate it, remove/disable the old implementation and record
it as a reconstruction candidate, or discard it if clearly obsolete — every
intentional non-carry-forward, including a clearly-obsolete discard immediately
assigned `drop`, receives a just-in-time reconstruction-candidate entry
preserving user value/provenance/decision evidence — decided just in time,
never through advance enumeration. A reconstruction-candidate entry is evidence
preservation, never a compatibility promise, implementation backlog, phase
gate, or removal classification.

Failure/Outcome/Recovery is a bounded target section of the runtime technical
spec (`runtime-and-configuration-direction.md`, section 7.2), not a separate
technical spec and not an exhaustive new ADR. It establishes a runtime-owned
outcome and recovery foundation without importing the paused error branch as a
compatibility program. The foundation is independently valuable, not merely
retry support: one runtime-owned normalization boundary, a minimal
Failure/Outcome schema without taxonomy freeze, operation identity/outcome
facts, minimal field tiers, runtime-side redaction, structured redacted panel
projection, cancellation provenance, and schema ownership each earn their place
across provider/session/tool/permission/worker/UI errors, with recovery as one
consumer. The P4.2 foundation scope is deliberately minimal; richer error work
is separately planned as post-reconstruction maturity and never mixes into the
just-in-time reconstruction candidate registry (I-12).

Status Active means this is the current chosen direction: not completed
implementation and not formal external approval.

Direct reconstruction also applies to storage (2026-08-14): the P4.2 storage
cutover is a clean cutover — offline archive of the legacy DB and session-owned
sidecars, fresh canonical DB boot — with no migration/import, no dual-reader,
and no runtime archive reader (ADR-0005). The legacy event-log sync/warp
surfaces, old-peer capability negotiation, and released-client storage
compatibility have no default compatibility entitlement under the two closed
sets; they are removed like any other legacy implementation, and no
old-history storage compatibility is a final H parity requirement.

## Invariants / constraints

- I-1 (LOCK-014): the migration is principle-first, not inventory-first. No
  exhaustive pre-migration feature list and no complete suspension registry are
  required before P1/P2/P4 begin.
- I-2 (LOCK-014): the two closed sets are fixed. Final required capabilities
  are ADR-0002 LOCK-005/007/008 operationalized by H-1..H-13 — LOCK-005's
  minimal internal overflow safeguard remains in the final-required set through
  H-13; their user-level semantics must hold at final target acceptance, but
  existing implementations and uninterrupted intermediate availability are not
  invariants unless a phase explicitly requires them. Permanent removals are
  ADR-0002 LOCK-001, LOCK-002, LOCK-003, LOCK-004, LOCK-006, plus the
  non-preservation clause of LOCK-005 for the existing compaction
  implementation, and the runtime spec sections 8/8.1 legacy sources; they may
  not be reclassified as deferred, suspended, or rebuild candidates without a
  superseding ADR.
- I-3 (LOCK-014): everything outside the two closed sets has no default
  compatibility entitlement. First-touch disposition is direct migration,
  remove/disable with a reconstruction-candidate entry, or discard when clearly
  obsolete — every intentional non-carry-forward, including a clearly-obsolete
  discard immediately assigned `drop`, records a reconstruction-candidate entry;
  it is decided just in time, never by advance enumeration.
- I-4 (LOCK-014): H-1..H-13 are final target/parity gates, not a requirement
  that every intermediate commit or phase preserve the old implementation.
  Intermediate phases keep the workspace testable, keep migration evidence
  truthful, and avoid corrupting persisted state; they may explicitly record
  temporary capability absence.
- I-5 (LOCK-014): no compatibility shim, adapter, dual implementation, or old
  state owner may be added solely to preserve a reconstruction candidate;
  existing compatibility code may be deleted when it obstructs the target.
- I-6 (LOCK-015): a reconstruction-candidate entry is created only when an
  implemented behavior is actually disabled/removed or intentionally not
  carried forward. It records user value/observable behavior, provenance,
  architectural obstruction, date/phase, whether it maps to a final invariant,
  post-foundation decision point, and current disposition
  (`pending`, `rebuild`, or `drop`).
- I-7 (LOCK-015): entries do not need restore paths, startup isolation fields,
  intermediate parity waivers, or required-by dates unless a specific phase
  needs them, and they never block P1-P4 exits. Before P5 completion every
  pending entry receives `rebuild` or `drop`; optional rebuild implementation
  is separately planned and does not automatically block P5 unless promoted to
  an H invariant. An entry mapping to H-1..H-13 cannot remain dropped at final
  target acceptance; it may be reimplemented from scratch after the foundation
  stabilizes.
- I-8 (LOCK-015): known examples are recorded as observed candidates only when
  they are already confirmed likely to be touched by the new foundation; they
  are never marked disabled today and never create gates. The observed list
  stays separate from the actual registry.
- I-9: Failure/Outcome/Recovery is a bounded section of the runtime spec
  (section 7.2) with the normative target recorded there. It establishes a
  runtime-owned foundation with independent rationale — one normalization
  boundary, minimal schema without taxonomy freeze, operation identity/outcome
  facts, minimal field tiers, runtime-side redaction, structured redacted panel
  projection, cancellation provenance, and schema ownership — across
  provider/session/tool/permission/worker/UI errors; recovery is one consumer,
  not the only purpose. It does not preserve old retry/error implementation
  shapes, SDK/cloud/JetBrains/TUI projections, the existing error taxonomy,
  delay ladders, the environment retry flag, or the auto-continue
  implementation, and the P4.2 foundation does not require a complete taxonomy,
  a complete byte/depth sanitizer contract, rich causal-chain diagnostics,
  telemetry/logging redesign, a user-facing action catalog/notification UX,
  config-validation error unification, or SDK/cloud/JetBrains/TUI/public
  transport compatibility.
- I-10: four bounded implementation decisions — R11 operation/outcome identity,
  canonical record location, and minimal retention under existing storage (no
  new store mandate); R12 minimum private-runtime Failure/Outcome schema,
  runtime-owned normalization boundary, minimal field tiers, runtime-side
  redaction, cancellation provenance, and versioned private panel envelope/
  projection; R13 recovery accounting/coordination only (owner/scope, budget
  consumed/termination, next-at occurrence time, provenance, nested low-level
  attempt visibility) which may reuse current bounded behavior; R14 worker-crash
  in-flight disposition with resource cleanup and no silent client replay,
  without requiring resumability or a new persistent operation ledger — are
  recorded in runtime spec section 9 and required by P4.2. No 14-variant
  taxonomy, byte/depth sanitizer contract, or algorithm set is frozen now; maturity
  items are separately tracked (I-12).
- I-11: the paused `jorkey/feature/error-system` branch is design/input
  evidence only. Pure schema/normalizer/sanitizer/cancellation-provenance
  concepts may be selectively reused; the branch is not merged or adopted
  wholesale, and its compatibility/versioning/client scope is discarded under
  the current product removals.
- I-12: post-reconstruction error maturity — taxonomy refinement, diagnostic
  retention/sanitizer hardening, logs/telemetry keep-lists, rich error actions/
  notification routing, and domain-specific integrations — is separately
  planned after core reconstruction, tracked as a named backlog/decision note
  (runtime spec section 7.3; tracker section 7). It is not a reconstruction
  candidate, never creates just-in-time registry entries, and does not block
  P4/P5 unless separately promoted.

The detailed just-in-time rules, the candidate registry field contract, and the
observed-candidates note live in the migration tracker (sections 1 and 7); the
Failure/Outcome/Recovery normative target and the R11-R14 bounds live in the
runtime spec (sections 7.2 and 9).

## Alternatives considered

| Alternative | Why rejected or deferred |
|---|---|
| Exhaustive pre-migration inventory of every legacy feature before P1/P2/P4 | Rejected: the user confirmed complete advance enumeration is neither possible nor required; principles plus the two closed sets plus just-in-time evidence preservation govern implementation (LOCK-014) |
| Default compatibility entitlement for every legacy behavior outside the closed sets | Rejected: it would force compatibility detours for old implementations and make the migration unbounded; no default entitlement exists (LOCK-014) |
| Make reconstruction-candidate entries a phase gate or implementation backlog | Rejected: entries are evidence preservation; they never block P1-P4 exits and receive `rebuild` or `drop` before P5 completion (LOCK-015) |
| Require every intermediate phase to preserve the H-1..H-13 old implementations | Rejected: H-1..H-13 are final target/parity gates; intermediate phases may record temporary capability absence while keeping the workspace testable and evidence truthful (LOCK-014) |
| Record observed candidates as disabled today with gates | Rejected: observed candidates are not yet displaced; they are noted separately and become registry rows only when implementation displaces them (LOCK-015) |
| A separate Failure/Outcome/Recovery technical spec or exhaustive ADR | Rejected for now: a bounded section of the runtime spec owns it, with R11-R14 decided by P4.2 |
| Fold post-reconstruction error maturity into the P4.2 foundation now | Rejected: the P4.2 foundation freezes only the error decisions whose deferral would cause wire/security/ownership rework; richer maturity items stay separately planned so they do not block core reconstruction (I-12) |
| Track error maturity items as just-in-time reconstruction candidates | Rejected: maturity items are forward-looking work, not displaced legacy behaviors; they live in a named backlog/decision note (runtime spec section 7.3; tracker section 7), never in the just-in-time registry (I-12) |
| Adopt the paused `jorkey/feature/error-system` branch as the recovery program | Rejected: the branch is input evidence only; its compatibility/versioning/client scope is discarded under the current product removals |

## Consequences

Positive:

- The migration no longer depends on an impossible exhaustive inventory; work
  starts from principles and the two closed sets.
- Old implementations can be directly removed when they obstruct the target,
  with displaced behavior preserved as evidence — no compatibility detour is
  required.
- Final H parity and permanent removals cannot be weakened by registry entries
  or observed-candidate notes.
- Failure/Outcome/Recovery gets a bounded runtime-owned foundation that
  addresses the retry/error root causes without binding to old features,
  taxonomies, or projections, and it is independently valuable beyond retry —
  normalization, field classification, redaction, persistence/projection,
  cancellation provenance, and schema ownership — with maturity work bounded
  out of the reconstruction path.

Negative:

- Displaced behaviors are preserved as evidence only; users of those behaviors
  get no automatic compatibility window.
- The burden of showing a displaced behavior is obsolete or worth rebuilding
  sits with the phase that displaces it.
- Failure/Outcome/Recovery semantics are deliberately minimal until R11-R14
  resolve at P4.2; intermediate error/retry behavior stays as it is today, and
  post-reconstruction error maturity items wait for separate planning after
  core reconstruction (I-12).

## Follow-up artifacts

- Technical spec: `../vscode-orchestrator/agent-orchestration-direction.md` -
  owns product direction and the corrected H-1..H-13 final-gate language.
- Technical spec: `../vscode-orchestrator/runtime-and-configuration-direction.md`
  - owns the bounded Failure/Outcome/Recovery target (section 7.2), the
  post-reconstruction error maturity scope (section 7.3), and the R11-R14
  bounded implementation decisions (section 9).
- Migration tracker: `../vscode-orchestrator/migration-tracker.md` - owns the
  just-in-time maintenance rules, the reconstruction-candidate registry, the
  observed-candidates note, and the post-reconstruction error maturity backlog
  (sections 1, 7).
- Related decisions: ADR-0002 (product direction and removals) and ADR-0003
  (runtime/config ownership) are unchanged; this ADR complements them, and
  ADR-0005 (`../adr/0005-bounded-private-runtime-storage.md`, 2026-08-14)
  records the bounded private-runtime canonical storage foundation and the
  offline archive cutover, complementing this ADR's direct-reconstruction
  policy for storage — the clean P4.2 storage cutover carries no
  migration/import, no dual-reader, no archive reader, and no old-history
  compatibility entitlement.
- Canonical architecture docs: none yet. The implemented system is unchanged
  until implementation lands (LOCK-013).

## Supersession

- Supersedes: none.
- Superseded by: none.
