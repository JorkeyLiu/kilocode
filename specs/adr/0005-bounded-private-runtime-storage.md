# 0005: Bounded Private-Runtime Storage

- Status: Active
- Date: 2026-08-14
- Owner: Kilo maintainers

## Context

ADR-0001 (2026-08-07) chose **checkpoint + resync** for session storage
rewriting: a canonical session checkpoint at a verified event sequence, a
retained event tail, gap detection, and a snapshot resync path, designed to
preserve workspace sync, session warp, and cross-client compatibility. The
final product decided since then removes exactly those transports: ADR-0002
removes the multi-client products (cloud sessions, JetBrains, Console,
KiloClaw) and ADR-0003/0004 establish one extension-owned private runtime with
no released-client compatibility entitlement. ADR-0001's checkpoint + resync,
old-peer capability negotiation, and mixed-version DB sharing boundary were
built for a multi-client sync/warp world the final product does not have, so
they must be superseded rather than implemented.

The growth problem ADR-0001 addressed is real and is measured (storage spec
section 2): the append-only `event` table keeps every full-payload update
forever, dominated by `message.updated` / `message.part.updated` snapshots. A
read-only 2026-08-14 aggregate measurement found the live `kilo.db` at
~24.56 GB (2.29M events; event payload ~17.96 GB, of which ~99.2% is full
message/part update snapshots; message/part payload ~4 GB; freelist 0; WAL
negligible; disk ~91-92%). No content was read. Growth is derived from the two
dated observations on record — ~16.9 GB (2026-08-07) to ~24.56 GB
(2026-08-14), i.e. ~7.5 GB / 7 days (a ~7.7 GB delta over seven days); ~1
MB/min is a separate short active sample and is labeled as such, not a
sustained rate. Two extension-owned backends currently write the DB, and a
2026-08-14 current-state probe (experimental flags disabled on a local
install) observed growth continuing; recorded as probe evidence with
date/method, not a repo-cited proof.

The user selected an offline archive at cutover: no old-session migration or
import, no dual-reader, no runtime archive reader, and an invisible automatic
byte-budget bound in the target.

## Decision

The final product's durable storage is a **bounded private-runtime canonical
storage foundation** (LOCK-016): the private runtime is the sole owner of
session/event/artifact persistence and maintenance; canonical durable truth is
transactionally maintained normalized session aggregates/read models plus
explicitly registered artifacts, with every mutation committing canonical state
and a monotonic aggregate/session revision atomically; automatic retention is
invisible private-runtime maintenance under internal byte-budget high/low
watermarks with hysteresis; and the legacy database is archived offline at the
P4.2 storage cutover with a fresh canonical database boot (LOCK-017) — no
migration, no dual-read, no archive reader.

Status Active means this is the current chosen direction: not completed
implementation and not formal external approval.

## Invariants / constraints

- I-1 (LOCK-016): the private runtime is the sole owner of session/event/
  artifact persistence and maintenance. No second store, client store, or
  external store is authoritative for runtime session state.
- I-2 (LOCK-016): canonical durable truth is transactionally maintained
  normalized session aggregates/read models plus explicitly registered
  artifacts — not an unbounded replay log. Every mutation commits canonical
  state and a monotonic aggregate/session revision atomically.
- I-3 (LOCK-016): a bounded derived changefeed/outbox may serve reconnect
  deltas (R9); it is not authoritative history, is not required for
  reconstruction, and is eligible for automatic truncation after authoritative
  hydration state exists.
- I-4 (LOCK-016): no permanent duplicate full-payload event snapshots, no
  generic full-object update history, no multi-client sync/warp replay
  protocol, no old-peer capability negotiation, and no removed-client
  compatibility. `/sync/checkpoint`, sync/warp peer resync, released-client
  capability negotiation, and the former cross-client storage verification
  phase are explicitly rejected.
- I-5 (LOCK-016): R11 Failure/Outcome durable fields live in the canonical
  aggregate storage / registered artifact model; diagnostic and panel
  projections are derived and never create competing stores.
- I-6 (LOCK-016): automatic retention is invisible private-runtime
  maintenance, not a product/UI/config surface: internal byte-budget high/low
  watermarks with hysteresis (exact values and the recent-retention floor are
  R15), family pruning at the high watermark down to the low watermark, no
  user-visible setting, no per-session pin UI, no storage dashboard, no manual
  cleanup product, and no deletion inline with a user-visible request. Pruning
  is complete-family deletion (root + descendants + owned
  messages/parts/outcomes/events/diffs/shares/registered artifacts); active/
  in-flight families and maintenance-leased/read families are never pruned; no
  partial transcript/tool/output truncation; no silent orphaning. Project-
  scoped/shared revert snapshots are not owned by one session family and are
  never deleted as part of family pruning; their ownership/GC (project-level
  reachability/refcount) is assigned in the artifact registry separately, with
  no silent orphaning. The runtime
  records aggregate rows/bytes reclaimed and failures diagnostically.
- I-7 (LOCK-016): session-owned sidecars/artifacts are registered in a
  field/owner/retention registry analogous to the config field registry
  (runtime spec section 3.2); unregistered session-owned artifacts block the
  storage phase exit (R16).
- I-8 (LOCK-017): the P4.2 storage cutover is offline: stop the sole runtime,
  verify and archive the legacy DB plus session-owned sidecars as an opaque
  offline artifact with checksum/integrity evidence, boot a fresh canonical
  DB that is empty — no pre-cutover sessions are migrated into or read by the
  new runtime — and retain rollback authority until archive deletion is
  separately authorized. No old-session migration/import, no dual-reader, no
  runtime archive reader. Exact archive format/location/cutover identity and
  the rollback procedure are R17, required by P4.2; R17 distinguishes the
  pre-P4 operational containment archive (I-10) from the P4.2 cutover
  archive, which is the rollback authority.
- I-9: retained ADR-0001 principles that remain valid, scoped to
  canonical-era sessions (sessions created or retained by the fresh canonical
  runtime after the P4.2 cutover): lossless logical content and continuation
  for runtime-retained sessions; monotonic integrity; crash-safe maintenance;
  complete-session/family deletion; no silent lossy compaction. Legacy-archive
  retention (the archived legacy DB) is archive retention, not
  runtime-retained sessions, and the temporary one-week containment set
  (I-10) is not usable by the runtime after the cutover.
- I-10: pre-P4 operational containment (full archive + keep last-week-active
  sessions in the current legacy DB) is a bounded manual operation, not target
  behavior and not a phase gate; its policy and evidence slots are recorded in
  the storage spec without claiming completion. The kept last-week-active set
  exists only in the legacy store before the cutover and in the offline legacy
  archive afterward; it is not migrated into or read by the fresh canonical
  runtime.
- I-11: storage is not a P1-P3 code prerequisite after operational containment;
  P1-P3 may proceed on the legacy store. Within P4.2, the storage foundation
  and cutover (P4.2a) is the first sub-boundary and lands before the R9 and
  R11-R14 private-wire/schema freeze (P4.2b). P4.2 cannot exit until the
  canonical schema/revision model, automatic retention, artifact registry,
  R15-R17, clean-DB cutover, and H-10/H-11 persistence/lifecycle evidence
  pass. P4.4/P4.5 remove old sync/warp/event replay/public server surfaces and
  legacy storage writers/readers.

## Alternatives considered

| Alternative | Why rejected or deferred |
|---|---|
| Checkpoint + resync with old-peer capability negotiation (ADR-0001 target) | Superseded: built for multi-client workspace sync/session warp and released-client compatibility that the final product removes (ADR-0002/0003/0004); the gap-detection/resync/negotiation machinery is not justified for one private runtime |
| Keep the unbounded full-payload event log as authoritative history | Rejected: unbounded growth (~24.56 GB DB, ~7.5 GB/7 days derived from the two dated observations, 99.2% full update snapshots); no bound without user action |
| User-visible storage management (settings, pin UI, dashboard, manual cleanup) | Rejected: retention is invisible private-runtime maintenance; no user-facing storage product |
| Online migration / dual-reader / runtime archive reader | Rejected: the user selected offline archive; no old-session migration/import, no dual-read, no runtime archive reader (LOCK-017) |
| Lossy compaction of old messages/parts | Rejected (retained ADR-0001 principle): changes user-visible history semantics |
| Partial transcript/tool/output truncation inside retained sessions | Rejected: pruning is complete-family deletion only; runtime-retained sessions keep full logical content |

## Consequences

Positive:

- Bounds storage for a single private runtime without any user-facing storage
  product: canonical aggregates plus invisible automatic retention.
- Removes the checkpoint/gap-detection/resync/capability-negotiation machinery
  that existed only to serve multi-client sync/warp.
- The legacy DB is preserved as an opaque offline archive with integrity
  evidence, keeping rollback authority without dual-read complexity.
- R11 Failure/Outcome durable fields share the canonical storage model, so
  diagnostic and panel projections stay derived and never compete with the
  canonical store.

Negative:

- The legacy event log must continue to serve P1-P3 until the P4.2 cutover;
  storage growth is contained manually in the meantime (bounded operation, not
  a phase gate).
- The cutover is a hard offline event: the sole runtime stops, the legacy DB is
  archived, and a fresh canonical DB boots; rollback authority depends on the
  archive being retained until deletion is separately authorized.
- Automatic retention silently removes whole inactive session families; users
  get no pin UI, by design.

## Follow-up artifacts

- Technical spec: `../storage/session-storage-rewriting.md` - owns the
  implementation source of truth: current state, operational containment,
  target model, cutover, storage work units S0..S5 under orchestrator P4.2,
  gates/tests, and open decisions.
- Runtime spec: `../vscode-orchestrator/runtime-and-configuration-direction.md`
  - owns P4.2 ordering/gates, the R9 changefeed and R11 storage interaction
  (sections 7.1-7.2), R15-R17 (section 9), maintenance performance guardrails
  (section 10), and the legacy storage reader/writer removal inventory
  (section 8.2).
- Migration tracker: `../vscode-orchestrator/migration-tracker.md` - owns
  P4.2a/P4.2b status, storage metrics, DB-exhaustion and containment risk rows,
  and storage removal evidence.
- Related decisions: ADR-0004 (architecture-first direct reconstruction)
  governs the just-in-time treatment of the legacy event-log sync/warp
  surfaces; this ADR supersedes ADR-0001's checkpoint + resync / multi-client
  transport target for the final product while retaining its still-valid
  principles.
- Canonical architecture docs: none yet. The implemented system is unchanged
  until implementation lands (LOCK-013).

## Supersession

- Supersedes: [ADR-0001: Lossless Session Storage Rewriting](0001-lossless-session-storage-rewriting.md)
  (its checkpoint + resync / multi-client transport target for the final
  product; ADR-0001 remains as historical decision evidence with its still-valid
  principles retained above).
- Superseded by: none.
