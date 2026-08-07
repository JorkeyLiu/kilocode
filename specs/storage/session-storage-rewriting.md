# Session Storage Rewriting (Lossless)

## Goal

Internal technical specification for the multi-phase project that rewrites how Kilo retains
sessions on disk so storage stops growing without bound, while preserving complete logical
session content and lossless continuation behavior. This document is the durable cross-session
context: a fresh session must be able to read this file and continue the work without
rediscovering the problem, the measurements, the locked decisions, or the architecture.

The durable architecture decision behind this project is recorded separately in
[ADR-0001: Lossless Session Storage Rewriting](../adr/0001-lossless-session-storage-rewriting.md)
(Status: Active). This document is the implementation source of truth: it owns the design,
migration, phased roadmap, tests, and open questions. ADR-0001 owns the chosen direction
(rewrite only while preserving complete logical content and lossless continuation; checkpoint +
resync selected) and does not duplicate this document's implementation detail.

This is an internal specification under the existing `specs/storage/` convention (same as
`remove-opencode-db.md` and `effect-sqlite-package.md`). It is not itself an ADR and is not a
public feature proposal. It does not change any source code, docs/nav, or generated artifacts.

## 1. Status And Decisions

### 1.1 Locked decisions

These decisions are already made and are non-negotiable for every phase of this project.

| ID | Decision |
|---|---|
| LOCK-001 | Kilo may rewrite the physical representation of retained sessions, but must preserve complete logical session content and lossless continuation behavior. |
| LOCK-002 | No lossy message/part cleanup is approved. Compaction/context management is a separate future concern and is out of scope. |
| LOCK-003 | Direct deletion of partial event/message/part rows is prohibited. Deletion is by complete session only, unless a future checkpoint/resync protocol explicitly makes historical event deletion safe. |
| LOCK-004 | The dominant problem is append-only repeated full snapshots in event storage. `session_diff` orphan accumulation is a separately fixed lifecycle issue, not part of this design. |
| LOCK-005 | The implementation must preserve workspace sync, session warp, historical session streaming, exports/shares, and cross-client compatibility, or provide an explicit migration/capability plan. |
| LOCK-006 | This is an internal technical specification under the existing `specs/storage/` convention; it is not itself an ADR (the durable decision is recorded in ADR-0001) and is not a public feature proposal. |

### 1.2 Implementation status (current)

| Area | Status |
|---|---|
| Complete-session deletion cleans `session_diff` / `session_diff_base` artifacts | Implemented (commit `8034c970dd`) |
| Append-only event log with full-content snapshot events | Current behavior, unchanged |
| Canonical session checkpoint / canonical state write | Not implemented |
| Event retention after checkpoint | Not implemented |
| Gap detection and snapshot resync | Not implemented |
| Workspace sync / warp over the full event log | Current behavior, unchanged |
| Lossy compaction of messages/parts | Not approved, out of scope (LOCK-002) |

## 2. Problem Statement And Measured Evidence

### 2.1 Logical content vs physical event log

Kilo keeps two representations of a session:

- **Logical content**: the final-state read models. `session` rows, `message` rows, `part` rows,
  V2 projections (`session_message`, `session_input`, `session_context_epoch`, `todo`), and
  file-backed artifacts (`session_diff`, `session_diff_base`, snapshot references). This is what
  the user sees and what continuation needs.
- **Physical event log**: the `event` table. Every synchronized update is appended as a new row
  carrying the full payload of what changed. The `event` table is append-only: rows are written
  once and never rewritten. A message that is updated ten times produces ten `message.updated`
  rows, each a complete copy of the message at that moment.

The read models are maintained by projectors that upsert on every event, so the `message` and
`part` tables hold the *latest* version while the event log holds *every* version. The event log
is therefore physically redundant with the read models for final-state content, yet it is the
only place that records per-aggregate sequence, and it is the transport for workspace sync and
session warp. That tension is the core of this project: the event log must shrink, but the
sequence semantics and the sync/warp transport must survive.

### 2.2 Measured evidence

Measured on one local installation (2026-08-07, `~/.local/share/kilo/kilo.db`, read-only
queries; file-backed dirs via `du`).

| Store | Rows | Payload | Share of growth |
|---|---|---|---|
| `event` table `data` column | 1,597,938 | 11,356 MB | dominant |
| `part` table `data` column | 640,243 | 1,842 MB | secondary |
| `message` table `data` column | 137,827 | 1,302 MB | secondary |
| `storage/session_diff` files | - | 1.1 GB | lifecycle bug, fixed at deletion |
| `storage/session_diff_base` files | - | 37 MB | lifecycle bug, fixed at deletion |
| `session` table (all text columns) | 5,978 | ~1 MB | negligible |

The `kilo.db` file itself is ~16.9 GB including free pages; the payload numbers above are the
logical `length(data)` sums.

### 2.3 Where the growth comes from

The event payloads are dominated by two event types:

| Event type | Rows | Payload | Avg payload | Meaning |
|---|---|---|---|---|
| `message.updated.1` | 366,983 | 7,126 MB | 19.9 KB | full message info per update |
| `message.part.updated.1` | 1,116,368 | 4,136 MB | 3.8 KB | full part content per update |
| `session.updated.1` | 101,582 | 90 MB | 0.9 KB | full session info per update |
| `session.created.1` | 3,033 | 2 MB | 0.8 KB | full session info at creation |

`message.updated` carries `info: Info` (the complete message: role metadata, summary/diffs,
editor context, tokens, cost, time). `message.part.updated` carries `part: Part` (complete part
content). Every mutation during a run - each streamed part settlement, each usage/cost update,
each summary recompute - publishes one of these events with a full copy of the current value,
and the projector then upserts the same value into the read model. The event log keeps every
version forever.

Writer locations (current behavior, not a design change):

- `packages/opencode/src/session/session.ts` `updateMessage` publishes `SessionV1.Event.MessageUpdated` with the full message.
- Same module `updatePart` publishes `SessionV1.Event.PartUpdated` with a structured clone of the full part.
- `packages/core/src/session/context-epoch.ts` publishes `session.next.context.updated` carrying the full rendered context `text` per context change (part of the V2 family; bounded by context size but still a repeated full snapshot).
- Projectors in `packages/core/src/session/projector.ts` upsert these events into `message` / `part` / `session`.

The V2 `session.next.*` durable events (`Step`, `Text`, `Reasoning`, `Tool`, `Compaction`, etc.)
are append-only too, but their payloads are mostly small; the full-content `text` fields
(`session.next.text.ended`, `session.next.reasoning.ended`, `session.next.context.updated`) and
tool output (`session.next.tool.progress`, `session.next.tool.success`) grow with content size
and repetition. Ephemeral deltas (`Text.Delta`, `Reasoning.Delta`, `Tool.Input.Delta`) are
live-only and already excluded from durable storage.

### 2.4 Growth mechanics summary

- One logical update = one appended event row = one full-content payload = one projector upsert.
- The read model converges to final state; the event log monotonically accumulates.
- Nothing rewrites, compacts, or prunes the event log today. Complete-session deletion
  (`events.remove`) is the only path that removes event rows, and it removes an entire aggregate.

## 3. Storage Inventory And Ownership Boundaries

### 3.1 SQLite database (`~/.local/share/kilo/kilo.db`)

Schema ownership lives in `packages/core/src/**/sql.ts`; migrations in
`packages/core/src/database/migration/`.

| Table | Role | Written by | Deleted by |
|---|---|---|---|
| `event` | append-only durable event log; per-aggregate `seq`, versioned `type`, JSON `data` | `EventV2` publish (core `event.ts` commit transaction) | complete-session deletion only |
| `event_sequence` | current `seq` per aggregate plus `owner_id` (sync claim) | `EventV2` commit transaction | complete-session deletion only |
| `session` | final-state session row (projector upsert) | session projector | `session.deleted` projector, FK cascade |
| `message` | final-state message row (projector upsert) | `message.updated` projector | `message.removed` projector, FK cascade |
| `part` | final-state part row (projector upsert) | `message.part.updated` projector | `message.part.removed` / `message.removed` projector, FK cascade |
| `session_message` | V2 projected transcript message (`msg_*` IDs, cursor `seq`) | V2 session projectors | FK cascade |
| `session_input` | V2 event-sourced prompt admission/promotion | V2 session projectors | FK cascade |
| `session_context_epoch` | context-epoch baseline + system-context snapshot | `SessionContextEpoch` | FK cascade |
| `todo` | session todo list | todo projection | FK cascade |
| `session_share` | share URL/secret registry (in `packages/core/src/share/sql.ts`) | share service | share service |

All `session.*`, `message.*`, `part.*`, `session_message`, `session_input`,
`session_context_epoch`, and `todo` rows cascade on `session` deletion. The `event` and
`event_sequence` tables cascade on aggregate deletion through `events.remove`.

### 3.2 File storage (`~/.local/share/kilo/storage/`)

Key-value JSON files addressed by path arrays via `packages/opencode/src/storage/storage.ts`
(per-key `TxReentrantLock`, ENOENT treated as NotFound).

| Key prefix | Role | Owner |
|---|---|---|
| `session/<projectID>/<sessionID>.json` | legacy session info files; no longer written by current code, retained only for legacy compatibility (read/rewritten by storage migrations) | session service (legacy) |
| `message/<sessionID>/<messageID>.json` | legacy message files; no longer written by current code, retained only for legacy compatibility (copied by storage migration 1) | session service (legacy) |
| `part/<messageID>/<partID>.json` | legacy part files; no longer written by current code, retained only for legacy compatibility (copied by storage migration 1) | session service (legacy) |
| `session_diff/<sessionID>.json` | cumulative file diff list used by summary/share/portability | session-owned artifact; removed on session deletion |
| `session_diff_base/<sessionID>.json` | cumulative diff base for fork/import portability | session-owned artifact; removed on session deletion |
| `session_share/<sessionID>.json` | share state cache | share service |
| `migration` | storage migration marker | `Storage` layer |

Current code no longer writes the `session/`, `message/`, or `part/` file prefixes: session,
message, and part state lives in the SQLite read models (section 3.1), and these JSON files are
legacy lineage only. `Storage.migration.1` copies the older `storage/session/info|message|part`
layout into these prefixes and `Storage.migration.2` rewrites `session/<projectID>/<sessionID>.json`
with a `summary`; after migration they are retained but not maintained. Live `Storage` writes
are limited to `session_diff`, `session_diff_base`, and `session_share`.

Commit `8034c970dd` added removal of `session_diff` / `session_diff_base` in
`Session.remove` (with `Storage.remove` idempotency for missing files), closing the orphan
lifecycle issue. `session_diff` still accumulates for retained sessions by design (it is
cumulative logical content, see `packages/opencode/src/kilocode/session-portability/`), so its
1.1 GB footprint on this machine is expected retained content, not orphans.

### 3.3 Other data stores

| Store | Role |
|---|---|
| `~/.local/share/kilo/snapshot/` | git repos per project/worktree holding filesystem snapshots for revert/undo (`packages/opencode/src/snapshot/`). Parts reference snapshots by git commit string. Distinct from the event log; not part of this project's scope. |
| `~/.local/share/kilo/log/` | CLI/server logs. Out of scope. |
| `~/.local/share/kilo/session-export.db` | export/share bookkeeping (`SessionExport`). Out of scope unless exports are affected by compaction. |
| `~/.local/share/kilo/kilo-local.db` | local/instance database. Out of scope. |

### 3.4 Consumers that depend on the event log

These are the surfaces LOCK-005 protects; any compaction must keep them correct or ship a
capability plan (see sections 5, 6, 8).

| Consumer | Mechanism | Dependency |
|---|---|---|
| Historical session streaming | `EventV2.aggregateEvents(aggregateID, after)` reads `event` rows with `seq > after`, ordered by `seq` | seq continuity, full event payloads |
| Workspace sync (history) | `POST /sync/history` returns all `event` rows outside the requester's known `(aggregate, seq)` ranges; requester replays with `ownerID` | per-aggregate seq as cursor, full event payloads |
| Workspace sync (live) | SSE `sync` events replayed via `events.replay(..., { publish: true, ownerID })` | versioned event types + registry decode |
| Session warp | reads ALL `event` rows for a session, posts batches of 10 to `POST /sync/replay` (`replayAll` with `strictOwner`), then `POST /sync/steal` | full event log from seq 1, contiguous seq |
| Share/export | `share-next` watches `Session.Updated`, `MessageUpdated`, `PartUpdated`, `Diff`, `Deleted` events; `SessionExport` on close | event notification, message/part content |
| Event bridge to clients | `EventV2Bridge` re-publishes events on `GlobalBus` + SSE; SDK consumers (CLI run, VS Code, JetBrains, TUI, ACP, claw) decode `message.updated.1`, `message.part.updated.1`, etc. | versioned event types, payload shapes |
| Replay owner checks | `event_sequence.owner_id` + `claim` semantics: warp claims a session so the old workspace's later events are ignored | `owner_id` column semantics |

## 4. Invariants And Acceptance Criteria

Every phase must preserve these. They are acceptance criteria, not aspirations.

| # | Invariant | Acceptance criterion |
|---|---|---|
| I-1 | Lossless logical content | After any storage rewrite, a session's `session` + `message` + `part` + `session_message` + `session_input` + `session_context_epoch` + `todo` rows and file artifacts (`session_diff`, `session_diff_base`, snapshot refs) are byte-equivalent (after schema normalization) to what they were before, for every retained session. |
| I-2 | Lossless continuation | Continuing a session after a rewrite (new turn, retry, revert, fork, warp, share, export) behaves identically to continuation before the rewrite. Test: run a scripted multi-turn session, rewrite storage, continue, and diff the resulting read models and emitted events. |
| I-3 | Event sequence integrity | For every retained aggregate, `event_sequence.seq` is monotonic and equals the highest retained `event.seq`; where no tail events are retained (purged below the checkpoint, or empty-tail restore), it equals the last verified checkpoint seq. Any checkpoint records the seq it covers; events above the checkpoint remain contiguous and gapless. |
| I-4 | Historical streaming survives | `aggregateEvents(aggregateID, after)` returns the same sequence of events as before for any `after` that a client can hold, or the client is explicitly told to resync via the new capability path. No silent truncation. Explicit failure/resync is guaranteed only for reads served by checkpoint-aware (new) code: a new-code read that needs events below the checkpoint must fail loudly, never return a truncated stream as if it were complete. An old build that directly opens an already-compacted DB has no such mechanism; it sees only the retained tail, which is the accepted, documented mixed-version capability boundary (section 8.3), not a path that can fail loudly without an additional mechanism. |
| I-5 | Sync/warp survive | `/sync/history`, `/sync/replay`, `/sync/steal`, live SSE sync, and warp move a session between workspaces with identical final read models and no divergent replay errors, including peers running pre-compaction builds (see section 8). |
| I-6 | Failure recovery | A crash at any point (mid-event append, mid-checkpoint, mid-purge, mid-warp) leaves the database usable: no partial rows, no checkpoint pointing past retained events, and the next start either repairs or refuses loudly. WAL + `behavior: "immediate"` transactions are the baseline. |
| I-7 | Deletion semantics | Only complete-session deletion removes rows. `Session.remove` removes the aggregate's events, sequence, cascaded rows, and `session_diff`/`session_diff_base` artifacts. Nothing else deletes. |
| I-8 | No unapproved lossy behavior | No phase may drop or rewrite `message`/`part`/`session` logical content, and no phase may delete event rows unless the checkpoint/resync protocol has been approved and verified per LOCK-003. |

## 5. Target Architecture (Decision Level)

The selected direction is **checkpoint + resync** (see section 6 for the comparison). The
architecture below is the target shape. Anything that names concrete new schema fields is a
proposal and is marked as such; do not treat proposed field names as committed.

### 5.1 Canonical session checkpoint

A checkpoint is a self-contained, verifiable capture of one aggregate's (session's) full logical
state at a specific event sequence. It must be reconstructable into the exact projector state
the session had at that sequence, so that replaying events *after* the checkpoint onto the
checkpoint reproduces the current state.

- **Content (proposal)**: the `session` row, all `message` rows, all `part` rows, `session_message`,
  `session_input`, `session_context_epoch`, `todo` rows, plus the cumulative `session_diff` value
  and a reference to the current filesystem snapshot string if one is active. Cost/token counters
  are included because the projector maintains them as absolute session-level totals (each
  `session.updated` event carries the full running total, see section 2.3) plus incremental
  removal adjustments when messages/parts are removed; they are not recomputable from a tail
  alone, because the events are cumulative totals rather than deltas and the removal adjustments
  are non-monotonic, so replaying only the tail would double-count or miss removals.
- **Artifact consistency**: `session_diff` / `session_diff_base` are file-backed cumulative
  artifacts maintained independently of the event log (see section 3.2); they are not
  reconstructable by replaying events. A checkpoint's consistency for them is therefore an
  independent artifact snapshot/version (its own version + checksum captured at checkpoint
  time), not something assumed reproducible from the event seq. If an artifact changes after a
  checkpoint without a new checkpoint, the checkpoint's artifact reference is stale and must be
  detected, not silently trusted; restore/warp copies each artifact as its own unit (see open
  question 4).
- **Location (proposal, undecided)**: a new `session_checkpoint` table keyed by aggregate id, or
  file-backed storage, or a dedicated checkpoint event. The table is the leading candidate
  because it can be written in the same SQLite transaction model as the event log.
- **Recorded position**: `(aggregate_id, seq)` of the last event the checkpoint covers, plus a
  checksum/hash of the serialized state (proposal) for corruption detection.
- **Write cadence (undecided)**: every N events, every M bytes, on session close, or on demand.
  Default proposal: write idempotently at a bounded cadence during active runs and once on
  session close, plus on-demand before destructive maintenance.
- **Consistency**: the checkpoint write must be atomic with respect to readers (single
  transaction or write-temp-then-rename), and must never claim a seq higher than the highest
  committed event. A checkpoint covering seq N is only valid if every event up to N is retained
  at the time the checkpoint is written, or the checkpoint itself is the source of truth for
  "state at N" and events below N may be purged only after verification.

### 5.2 Event retention after checkpoint

- Events at or below the last verified checkpoint seq become recoverable-from-checkpoint: the
  logical content they carried lives in the checkpoint + read models, and their remaining value
  is sequence continuity for sync cursors and warp transport.
- **Retention policy (undecided)**: keep the last N events below the checkpoint, or zero events
  below the checkpoint (mirrors open question 3). The window preserves cheap
  `aggregateEvents(after)` for recent cursors and cheap re-warp; the zero option maximizes
  savings. Decision required before implementation.
- **Purge boundary**: purging event rows below a checkpoint is only safe after the checkpoint
  is verified (checksum passes) and after LOCK-003's "checkpoint/resync protocol explicitly
  makes historical event deletion safe" condition is met by this spec's approval. Purge runs as
  explicit maintenance, never inline with a user-visible request, and only after the P4
  sync/warp resync + capability negotiation protocol is available (roadmap section 7); before
  P4 ships, no event row below a checkpoint may be deleted.

### 5.3 Gap detection

- Every event append already computes `seq = latest + 1` under an immediate transaction; that
  invariant stays. Gap detection is about *reads and resyncs*:
  - `aggregateEvents(aggregateID, after)`: if the first row found has `seq > after + 1`, the
    reader must not silently continue; it must either (a) read from the checkpoint and then the
    tail, or (b) fail with an explicit "events missing, resync required" error.
  - Checkpoint validation: a checkpoint whose covered seq is beyond the lowest retained event
    seq and below the highest is the only legitimate gap source; any other gap (missing seq
    inside the retained tail) is corruption and must be reported, not patched.
- **Resync trigger (proposal)**: when a reader or sync peer hits a gap it cannot bridge from
  retained events, it requests the checkpoint for the aggregate plus all events above the
  checkpoint seq. This is the "snapshot resync" path.

### 5.4 Snapshot resync

- New internal API (proposal): `checkpoint(aggregateID)` returning `{ state, seq, checksum }`
  and `tail(aggregateID, after)` returning events `> after`. Historical streaming and warp use
  checkpoint + tail when events below the checkpoint are gone.
- New sync surface (proposal): `/sync/checkpoint` (serve a checkpoint for an aggregate) and an
  extended `/sync/replay` that accepts a checkpoint prefix, or a versioned replay payload
  (proposal: add a `checkpoint` field to the existing `ReplayPayload` and keep the old payload
  for pre-compaction peers).
- **Restore materialization**: a checkpoint+tail restore must materialize `event_sequence` for
  the aggregate with `seq` = the checkpoint's covered seq, so invariant I-3 holds and the next
  event append continues at `checkpoint_seq + 1` with no gap. This applies even when the tail is
  empty (no events above the checkpoint) and when the target is fresh (no prior rows for the
  aggregate): the checkpoint is the bootstrap for the full state, and `event_sequence` is
  created (or overwritten) at the checkpoint seq, never left missing or at a stale seq.
- Owner semantics stay: warp claims the aggregate via `claim`/`owner_id` after a successful
  checkpoint+tail restore, exactly as it does today after full replay. A restore that does not
  claim does not steal the aggregate, so non-warp sync restores remain non-destructive.

### 5.5 Safe database maintenance

- `VACUUM`/`incremental_vacuum` after large purges to reclaim free pages; never while a sync or
  warp batch is in flight (see section 9).
- Maintenance is a single-owner background job gated on idle aggregates and on no active
  sync/warp/streaming for the affected aggregates (mirror the existing generation-admission
  fence pattern used by config cold saves in `packages/opencode/src/server/shared/fence.ts`).
- Every maintenance pass is idempotent, resumable, and reports bytes reclaimed + rows removed.

## 6. Option Comparison And Selected Direction

| Option | What it means | Verdict | Rationale |
|---|---|---|---|
| Full event retention (status quo) | Keep appending every full-content event forever | Rejected as target | Measured 11 GB and growing; no bound without user action |
| Lossy compaction | Drop old messages/parts or truncate them; keep summaries | Rejected | Violates LOCK-001/002; changes user-visible history semantics |
| Checkpoint + resync | Canonical state at seq N; retain events after N; gap detection; resync via checkpoint | Selected | Preserves full logical content and seq semantics, bounds event growth, keeps sync/warp correct with a capability path |
| Content deduplication / compression | Store identical payloads once, or compress event JSON | Deferred (complementary) | Reduces bytes but does not bound growth; may be layered onto checkpoint + resync later; not a substitute |
| Complete-session deletion / management | Delete whole sessions; clean per-session artifacts | Partially implemented, tooling deferred | `events.remove` + artifact cleanup exist (LOCK-003, commit `8034c970dd`); broader archive/stats tooling is a separate concern and does not fix retained-session growth |

Selected direction: **checkpoint + resync** with trailing-event retention (window size
undecided, see section 5.2), deletion strictly by complete session, and deduplication/compression
explicitly deferred to a later phase that layers on top. Lossy compaction stays out of scope
per LOCK-002.

## 7. Phased Implementation Roadmap

Dependencies run top to bottom. Each phase must satisfy the invariants in section 4 and ship
its exit criteria; a phase does not start until the previous phase's exit criteria pass.

Ordering guarantee: P4 (sync/warp resync protocol + capability negotiation) must ship and pass
before P5 (event retention) may purge any event row. No event purge occurs before
checkpoint-serving/resync and capability negotiation are available; P5 is the first phase that
may delete event rows below a checkpoint.

| Phase | Scope | Exit criteria | Test / verification |
|---|---|---|---|
| P0 Baseline harness | Freeze measurement queries and a lossless-continuation fixture harness (scripted session, storage snapshot, rewrite, continuation diff) | Reproducible baseline numbers and a failing-until-P5 test that asserts event rows below a checkpoint can be purged without changing read models | `bun test` focused tests in `packages/opencode`; measurement queries from section 10 |
| P1 Diff lifecycle completion | Confirm `session_diff`/`session_diff_base` cleanup on deletion (done in `8034c970dd`); add orphan detection + stats visibility | No orphans remain after deletion in the test suite; `session_diff` size is attributable to retained sessions | `test/session/session-remove-storage.test.ts`; `test/storage/storage.test.ts` |
| P2 Checkpoint writer | Define checkpoint format (5.1 proposal), write idempotently at bounded cadence + on close + on demand, behind a runtime flag | Checkpoint matches projector state at its seq; checksum verifies; crash mid-write leaves no bad checkpoint | Focused tests: checkpoint round-trip, crash injection, idempotent rewrite |
| P3 Gap-aware reads | `aggregateEvents` and replay bridge checkpoint+tail; explicit resync error when events are missing and no checkpoint exists | Reads return identical event streams for retained windows; missing-event error is explicit and actionable | `packages/core` event tests; `packages/opencode` session streaming tests |
| P4 Sync/warp resync protocol | `/sync/checkpoint` + extended replay (5.4); capability negotiation with pre-compaction peers (8.3); old-peer fallback; checkpoint+tail restore materializes `event_sequence` (5.4) | Warp and history sync produce identical read models whether source is compacted or not; old-peer fallback works; capability negotiation is live and gates the purge phase (P5) | Workspace sync tests (existing `control-plane/workspace.ts` paths), warp E2E-style test |
| P5 Event retention (purge) | Explicit maintenance purge of events below verified checkpoints; trailing window policy from 5.2; runs only after P4 protocol readiness + capability negotiation are available | P4 exit criteria met (protocol + capability negotiation live); P0 lossless-continuation test passes with purged history; seq integrity holds; bytes reclaimed reported | P0 harness + projector-replay equivalence tests; corruption-detection test |
| P6 Cross-client + migration | Verify VS Code, JetBrains, TUI, ACP, claw, share/export against compacted stores; additive schema migrations; docs | All cross-client surfaces from section 8 pass; no released-client DB incompatibility | SDK/SSE consumers; `bun run typecheck`; `bun test` in `packages/opencode`; JetBrains/VS Code smoke runs |

## 8. Migration And Compatibility Strategy

### 8.1 Old clients and cross-client surfaces

| Surface | Compatibility requirement | Plan |
|---|---|---|
| CLI `run` / `session-replay` / `event.ts` | Decodes `message.updated.1` and `message.part.updated.1` from SSE/SDK; reads historical events | Events above checkpoint still emitted via bridge; checkpoint restore synthesizes nothing new for live streams because live updates continue to be published normally. Historical read paths must accept the resync error and use the checkpoint path when available. |
| VS Code extension | Consumes events via SDK + SSE; Agent Manager uses shared backend | Backend-only change; extension sees unchanged event shapes. Verify webview renders after compaction. |
| JetBrains plugin | Uses SDK against a `kilo serve` backend | Same as VS Code; SDK types unchanged unless new endpoints are added (then regen via `script/generate.ts`). |
| TUI / ACP / claw | Consume `message.updated`, `message.part.updated` streams | Live streams unchanged; historical fetch must handle the resync error. |
| Workspace sync peers (older CLI) | `/sync/history` + `/sync/replay` payloads | Keep old replay payload working; serve checkpoint only to peers that advertise support (capability negotiation, section 8.3). |
| Share / export | `share-next` watches events; `SessionExport` snapshots on close | Unchanged: events continue to be published live; exports read the read models, not the event log. Verify share round-trip after compaction. |
| Released clients sharing a DB file | `session_message.seq` is already nullable to let released clients share newer schemas | All new columns must be additive (nullable or defaulted) and all new tables must not be touched by old code paths. |

### 8.2 DB schema rules for this project

- New tables and columns are additive only. No ALTER that breaks a released client's reads.
- The event table's versioned `type` and encoded payload shape is a public contract (the
  `syncRegistry` encode/decode boundary). Checkpoint transport introduces new shapes as new
  endpoints/payload fields, never by reinterpreting existing rows.
- If a checkpoint is stored in a new table, old builds ignore it; the event log remains the
  source of truth until the first compaction, and compaction only happens under the new code
  (so old builds never see a compacted log unless they open a DB compacted by a newer build -
  that is the documented capability boundary).

### 8.3 Capability negotiation (proposal)

- Peers advertise checkpoint support (new endpoint or an explicit field in `/sync/start` or the
  replay payload). A peer that does not advertise support always receives full event history;
  the source keeps enough retained events to serve it, or refuses compaction for aggregates that
  an active old peer is syncing (pragmatic default until all peers upgrade).
- Mixed-version DB sharing: a compacted DB opened by an old build must still boot; old build
  reads of the event log return the retained tail only, and the read models remain intact, so
  the old build continues to function for live work even though historical replay below the
  checkpoint is unavailable until the new build's resync path is used. This is the accepted,
  documented capability boundary, not a path that fails loudly on its own: an old build has no
  gap-detection or resync mechanism, so it cannot emit the explicit resync error - it simply
  sees the retained tail. The failure/resync guarantee applies only where checkpoint-aware (new)
  code serves the read.
- **I-4 carve-out (explicit failure/resync is a new-code guarantee)**: the explicit resync
  error is guaranteed only for reads served by checkpoint-aware (new) code. A new-code
  historical read (`aggregateEvents` / `/sync/history` / warp) that needs events below the
  checkpoint must fail loudly, never return a truncated stream as if it were complete. An old
  build that directly opens a compacted DB has no such mechanism and is not expected to have
  one: it can only see the retained tail (the capability boundary above), and restoring history
  below the checkpoint requires the new build's checkpoint path. New code must never rely on an
  old build failing loudly to protect it - the operational gate below is what protects old
  peers.
- **Operational gate for old peers**: compaction of an aggregate is permitted only when no
  active pre-capability peer depends on serving its full history. The source must either retain
  enough events below the checkpoint to serve an active old peer, or refuse compaction for
  aggregates an old peer is actively syncing (pragmatic default until all peers upgrade); it
  must never serve a partial stream silently. Compaction is a maintenance-time decision
  evaluated per aggregate, never a silent background rewrite of an aggregate with an active old
  peer.

## 9. Operational Safety

| Concern | Rule |
|---|---|
| Crash consistency | All event appends keep the existing `behavior: "immediate"` transaction. Checkpoint writes are single transactions (or temp-write-then-rename for file storage). A crash before checkpoint commit leaves no checkpoint (safe); a crash after event append but before checkpoint means the checkpoint lags, never exceeds, the event seq. |
| Concurrent readers/writers | Checkpoint reads take the same per-key lock discipline used by `Storage`; DB reads/writes stay in the Effect/Drizzle transaction model. Maintenance must not interleave with event appends for the same aggregate; use per-aggregate fencing. |
| Maintenance ownership | One owner (background job or explicit CLI maintenance command). No two maintenance passes run concurrently; passes are resumable and idempotent. |
| WAL / VACUUM boundaries | `VACUUM` and `incremental_vacuum` run only when no sync/warp/streaming is active for the affected aggregates and no writer is mid-commit. Do not VACUUM inside a user-visible request. |
| Rollback / abort | An aborted purge leaves the checkpoint in place and all events retained; next pass retries. An aborted warp replay leaves the target DB unchanged (transactional replay). `Session.remove` stays the only destructive operation and remains all-or-nothing per aggregate. |
| Failure reporting | Every maintenance pass and resync logs rows removed, bytes reclaimed, seq ranges covered, and any corruption detection (checksum mismatch, seq gap) as errors with the aggregate id. |

## 10. Open Questions And Required Decisions

These must be decided before implementation of the affected phase. Unknown protocol/schema
details are deliberately left open rather than silently decided.

1. Checkpoint storage: new `session_checkpoint` table vs file-backed storage vs a special
   checkpoint event? (Phase P2)
2. Checkpoint write cadence: every N events, byte threshold, on close, on demand, or a
   combination? (Phase P2)
3. Trailing-event retention window: keep the last N events below the checkpoint, or zero events
   below it? What is the default for sync peers that have not re-synced? (Phase P5)
4. Does the checkpoint include `session_diff`/`session_diff_base` content, or are those left in
   file storage and copied by warp separately? In either case they need an independent artifact
   snapshot/version (own version + checksum, per section 5.1), since they are not reproducible
   from the event seq. (Phase P2, warp)
5. Are `session_context_epoch` snapshots part of the checkpoint? They are required for context
   continuation, so the default is yes, but the format is unresolved. (Phase P2)
6. Capability negotiation shape: new endpoint, new payload field, or versioned replay protocol?
   How does an active old-peer sync inhibit compaction for an aggregate? (Phase P4)
7. Does any released client read the `event` table directly (not via server endpoints)? If yes,
   compaction is only safe behind the additive-table boundary. Needs a consumer audit of
   `packages/sdk/js` and `packages/kilo-vscode` before Phase P5. (Phase P5)
8. Cost/token counters live on `session` and are maintained incrementally; confirm checkpoint
   inclusion is the only safe reconstruction (it is the working assumption, section 5.1). (P2)
9. Should legacy aggregates with no checkpoint ever be backfilled, or is checkpoint creation
   forward-only (new writes only, legacy data left un-compacted)? (Phase P5)
10. Does the ephemeral-delta exclusion (Text/Reasoning/Tool.Input deltas already live-only)
    extend to a policy of not durably storing any stream-fragment boundary? Default: no change,
    fragments stay live-only. (Phase P0, no action expected)

## 11. Current Status Summary

- Implemented: complete-session deletion cleans `session_diff`/`session_diff_base` artifacts
  (commit `8034c970dd`, covered by `test/session/session-remove-storage.test.ts`).
- Current behavior (unchanged by this project): append-only `event` log with full-content
  `message.updated` / `message.part.updated` snapshots; projector-upserted read models; sync,
  warp, historical streaming, share/export all over the full event log.
- Not implemented: canonical checkpoint, event retention below checkpoint, gap detection,
  snapshot resync, `/sync/checkpoint`, capability negotiation. None of these exist yet; the
  target architecture in section 5 is the design direction, not shipped behavior.

## Verification Commands

Measurement (read-only, against a local install):

- `sqlite3 "file:$HOME/.local/share/kilo/kilo.db?mode=ro" "SELECT 'event', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM event;"` and the same for `message`, `part`, `session`.
- Event-type breakdown: `SELECT type, count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM event GROUP BY type ORDER BY 3 DESC;`
- File stores: `du -sh ~/.local/share/kilo/storage/* ~/.local/share/kilo/snapshot`

Markdown/table check for this file (must pass without modifying anything):

- `bun run script/check-md-table-padding.ts specs/storage/session-storage-rewriting.md`

Test/typecheck guidance (from root AGENTS.md; run only the smallest relevant layer):

- `bun test` from `packages/opencode/` (never from repo root)
- Focused: `bun test ./test/session/session-remove-storage.test.ts` from `packages/opencode/`
- `bun run typecheck` from `packages/opencode/`
