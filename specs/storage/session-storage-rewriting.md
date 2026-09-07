# Bounded Private-Runtime Storage (Canonical Storage Foundation)

## Goal

Internal technical specification for the storage foundation that replaces the
obsolete multi-client checkpoint/resync target with a bounded private-runtime
canonical storage foundation: canonical aggregate storage with invisible
automatic byte-budget retention, an artifact field/owner/retention registry,
and an offline archive cutover at P4.2. This document is the durable
cross-session context: a fresh session must be able to read this file and
continue the work without rediscovering the problem, the measurements, the
locked decisions, or the architecture.

The durable architecture decision is recorded in
[ADR-0005: Bounded Private-Runtime Storage](../adr/0005-bounded-private-runtime-storage.md)
(Status: Active), which supersedes
[ADR-0001: Lossless Session Storage Rewriting](../adr/0001-lossless-session-storage-rewriting.md)
(checkpoint + resync / multi-client transport target; Status: Superseded) for
the final product. This document is the implementation source of truth: it owns
current state, operational containment, the target model, the cutover, storage
work units, gates/tests, and open decisions. ADR-0005 owns the durable decision;
ADR-0001's historical decision body is preserved unchanged.

This is an internal specification under the existing `specs/storage/`
convention (same as `remove-opencode-db.md` and `effect-sqlite-package.md`). It
is not itself an ADR and is not a public feature proposal. It does not change
any source code, docs/nav, or generated artifacts.

## 1. Document Status And Durable Decisions

### 1.1 Document status

Rewritten 2026-08-14. The previous checkpoint + resync design (ADR-0001) is
superseded by ADR-0005; this rewrite is the implementation source of truth for
the new target and does not append contradictions to the old direction. The
current-state evidence below (sections 2-3) is preserved because it still
describes the implemented system; the target (sections 5-7) is new.

### 1.2 Durable decisions

| ID | Decision |
|---|---|
| LOCK-016 | Canonical bounded storage: the private runtime is the sole owner of session/event/artifact persistence and maintenance; canonical durable truth is transactionally maintained normalized session aggregates/read models plus explicitly registered artifacts, with every mutation committing canonical state and a monotonic aggregate/session revision atomically; R9 may use a bounded derived changefeed/outbox for reconnect deltas (not authoritative history, not required for reconstruction, truncatable after authoritative hydration state); no permanent duplicate full-payload event snapshots, generic full-object update history, multi-client sync/warp replay protocol, old-peer capability negotiation, or removed-client compatibility; R11 Failure/Outcome durable fields live in the canonical aggregate storage/registered artifact model (diagnostic and panel projections do not create competing stores); automatic retention is invisible private-runtime maintenance under internal byte-budget high/low watermarks with hysteresis (ADR-0005 I-1..I-7, section 5 below) |
| LOCK-017 | Legacy archive/cutover: at the P4.2 storage cutover, stop the sole runtime, verify and archive the legacy DB plus session-owned sidecars as an opaque offline artifact with checksum/integrity evidence, boot a fresh canonical DB, and retain rollback authority until archive deletion is separately authorized; no old-session migration/import, no dual-reader, no runtime archive reader (ADR-0005 I-8, section 6 below) |

### 1.3 Retained ADR-0001 principles and explicit rejections

Retained (still valid for the target), scoped to canonical-era sessions
(sessions created or retained by the fresh canonical runtime after the P4.2
cutover): lossless logical content and continuation for runtime-retained
sessions; monotonic integrity; crash-safe maintenance; complete-session/family
deletion; no silent lossy compaction. The temporary last-week containment set
(section 4) is legacy-archive retention only, not runtime-retained sessions,
and is not usable by the runtime after the cutover.

Explicitly rejected (ADR-0005 I-4): building `/sync/checkpoint`; sync/warp
peer resync; released-client capability negotiation; the former cross-client
storage verification phase (old spec P6); any permanent duplicate full-payload
event snapshot or generic full-object update history; any multi-client
sync/warp replay protocol.

### 1.4 Bounded decisions (open)

| ID | Bounded by | Required by | Status |
|---|---|---|---|
| R15 | Automatic retention bounds: byte-budget high/low watermarks with hysteresis, recent-retention floor, family eligibility/ordering, diagnostics | P4.2 (P4.2a). Not a P1-P3 blocker | Resolved 2026-08-20 — high 8 GiB, low 6 GiB, 7-day floor, complete-family deletion, incremental auto-vacuum/checkpoint, per-run diagnostics; 25% hysteresis; resource bound not performance SLA; values change only via later architecture decision |
| R16 | Canonical aggregate schema/revision model and bounded outbox/changefeed disposition; artifact ownership/retention registry | P4.2 (P4.2a). Not a P1-P3 blocker | Resolved 2026-08-20 — normalized session/message/part/todo/share + registered operation/outcome/failure aggregates; `SessionTable.revision` monotonic; payload-free tombstone on delete; bounded changefeed 50,000 rows/64 MiB; closed artifact registry; S2 materializes, S3 closes/audits |
| R17 | Offline archive format/location/integrity/checksum; fresh-DB cutover identity; rollback and archive-deletion authority | P4.2 (P4.2a). Not a P1-P3 blocker | Resolved 2026-08-20 — offline versioned dir `<data-basename>-archive/p4.2/<UTC>-<uuid>/` under same-filesystem sibling; manifest v1 with SHA-256; fixed member set with `session-export.db` included/absent recorded and `snapshot` excluded; singleton storage identity; offline rollback; deletion requires separate maintainer authorization |

R15-R17 are recorded in this spec (sections 5-6) under ADR-0005.

### 1.5 Relationship to orchestrator phases

- Storage is not a P1-P3 code prerequisite after operational containment
  (section 4); P1-P3 may proceed on the legacy store.
- Within P4.2, the storage foundation and cutover is the first sub-boundary:
  **P4.2a storage** (this spec, work units S0..S5 in section 7) lands before
  the **P4.2b** private-wire/schema freeze for the observation and
  Failure/Outcome target in `../vscode-orchestrator/direction.md`. The S0..S5 labels are namespaced under orchestrator
  P4.2 and collide with no orchestrator phase.
- P4.2 cannot exit until the canonical schema/revision model, automatic
  retention, artifact registry, R15-R17, clean-DB cutover, and H-10/H-11
  persistence/lifecycle evidence pass (section 8).
- P4.4/P4.5 remove old sync/warp/event replay/public server surfaces and
  legacy storage writers/readers.

## 2. Current State And Measured Evidence

All statements in this section describe the implemented system today, grounded
in repository evidence and read-only measurement. None of them claim the target
architecture exists.

### 2.1 Logical content vs physical event log

Kilo keeps two representations of a session:

- **Logical content**: the final-state read models. `session` rows, `message`
  rows, `part` rows, V2 projections (`session_message`, `session_input`,
  `session_context_epoch`, `todo`), and file-backed artifacts (`session_diff`,
  `session_diff_base`, snapshot references). This is what the user sees and what
  continuation needs.
- **Physical event log**: the `event` table. Every synchronized update is
  appended as a new row carrying the full payload of what changed. The `event`
  table is append-only: rows are written once and never rewritten. A message
  that is updated ten times produces ten `message.updated` rows, each a
  complete copy of the message at that moment.

The read models are maintained by projectors that upsert on every event, so the
`message` and `part` tables hold the *latest* version while the event log holds
*every* version. The event log is therefore physically redundant with the read
models for final-state content, yet it is the only place that records
per-aggregate sequence, and it is the transport for workspace sync and session
warp today. In the target, that transport role disappears: the final product is
one private runtime with no multi-client sync/warp, so the event log's
authoritative-history and transport roles are both obsolete (sections 5.1, 5.5).

### 2.2 Measured evidence

Measured on one local installation (2026-08-07, `~/.local/share/kilo/kilo.db`,
read-only queries; file-backed dirs via `du`).

| Store | Rows | Payload | Share of growth |
|---|---|---|---|
| `event` table `data` column | 1,597,938 | 11,356 MB | dominant |
| `part` table `data` column | 640,243 | 1,842 MB | secondary |
| `message` table `data` column | 137,827 | 1,302 MB | secondary |
| `storage/session_diff` files | - | 1.1 GB | lifecycle bug, fixed at deletion |
| `storage/session_diff_base` files | - | 37 MB | lifecycle bug, fixed at deletion |
| `session` table (all text columns) | 5,978 | ~1 MB | negligible |

The `kilo.db` file itself was ~16.9 GB including free pages on 2026-08-07; the
payload numbers above are the logical `length(data)` sums.

Read-only aggregate update (2026-08-14, same installation, `~/.local/share/kilo/kilo.db`,
metadata/length-sum queries only; **no content was read**):

| Metric | 2026-08-14 value |
|---|---|
| `kilo.db` file size | ~24.56 GB |
| `event` rows | 2,290,000 (~2.29M) |
| Event payload (logical `length(data)` sum) | ~17.96 GB |
| Full message/part update snapshots share of event payload | ~99.2% |
| `message` + `part` payload | ~4 GB |
| SQLite freelist | 0 |
| WAL | negligible (~2 MB) |
| Disk usage | ~91-92% |
| Growth | ~7.5 GB / 7 days (derived: 24.56 GB on 2026-08-14 minus 16.9 GB on 2026-08-07 ≈ 7.7 GB over seven days); ~1 MB/min from a separate short active sample, not a sustained rate |

Two extension-owned backends currently write the DB. A 2026-08-14
current-state probe (experimental flags disabled on a local install) observed
growth continuing; recorded as probe evidence with date/method, not a
repo-cited proof. The 2026-08-14 numbers are an aggregate update of the
2026-08-07 evidence, not a replacement of it; both dates remain on record, and
the derived interval/rate method is stated in the Growth row above.

### 2.3 Where the growth comes from

The event payloads are dominated by two event types:

| Event type | Rows | Payload | Avg payload | Meaning |
|---|---|---|---|---|
| `message.updated.1` | 366,983 | 7,126 MB | 19.9 KB | full message info per update |
| `message.part.updated.1` | 1,116,368 | 4,136 MB | 3.8 KB | full part content per update |
| `session.updated.1` | 101,582 | 90 MB | 0.9 KB | full session info per update |
| `session.created.1` | 3,033 | 2 MB | 0.8 KB | full session info at creation |

`message.updated` carries `info: Info` (the complete message: role metadata,
summary/diffs, editor context, tokens, cost, time). `message.part.updated`
carries `part: Part` (complete part content). Every mutation during a run —
each streamed part settlement, each usage/cost update, each summary recompute —
publishes one of these events with a full copy of the current value, and the
projector then upserts the same value into the read model. The event log keeps
every version forever.

Writer locations (current behavior, not a design change):

- `packages/opencode/src/session/session.ts` `updateMessage` publishes
  `SessionV1.Event.MessageUpdated` with the full message.
- Same module `updatePart` publishes `SessionV1.Event.PartUpdated` with a
  structured clone of the full part.
- `packages/core/src/session/context-epoch.ts` publishes
  `session.next.context.updated` carrying the full rendered context `text` per
  context change (part of the V2 family; bounded by context size but still a
  repeated full snapshot).
- Projectors in `packages/core/src/session/projector.ts` upsert these events
  into `message` / `part` / `session`.

The V2 `session.next.*` durable events (`Step`, `Text`, `Reasoning`, `Tool`,
`Compaction`, etc.) are append-only too, but their payloads are mostly small;
the full-content `text` fields (`session.next.text.ended`,
`session.next.reasoning.ended`, `session.next.context.updated`) and tool output
(`session.next.tool.progress`, `session.next.tool.success`) grow with content
size and repetition. Ephemeral deltas (`Text.Delta`, `Reasoning.Delta`,
`Tool.Input.Delta`) are live-only and already excluded from durable storage.

### 2.4 Growth mechanics summary

- One logical update = one appended event row = one full-content payload = one
  projector upsert.
- The read model converges to final state; the event log monotonically
  accumulates.
- Nothing rewrites, compacts, or prunes the event log today. Complete-session
  deletion (`events.remove`) is the only path that removes event rows, and it
  removes an entire aggregate.

## 3. Storage Inventory And Ownership Boundaries (current state)

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
`session_context_epoch`, and `todo` rows cascade on `session` deletion. The
`event` and `event_sequence` tables cascade on aggregate deletion through
`events.remove`.

### 3.2 File storage (`~/.local/share/kilo/storage/`)

Key-value JSON files addressed by path arrays via
`packages/opencode/src/storage/storage.ts` (per-key `TxReentrantLock`, ENOENT
treated as NotFound).

| Key prefix | Role | Owner |
|---|---|---|
| `session/<projectID>/<sessionID>.json` | legacy session info files; no longer written by current code, retained only for legacy compatibility (read/rewritten by storage migrations) | session service (legacy) |
| `message/<sessionID>/<messageID>.json` | legacy message files; no longer written by current code, retained only for legacy compatibility (copied by storage migration 1) | session service (legacy) |
| `part/<messageID>/<partID>.json` | legacy part files; no longer written by current code, retained only for legacy compatibility (copied by storage migration 1) | session service (legacy) |
| `session_diff/<sessionID>.json` | cumulative file diff list used by summary/share/portability | session-owned artifact; removed on session deletion |
| `session_diff_base/<sessionID>.json` | cumulative diff base for fork/import portability | session-owned artifact; removed on session deletion |
| `session_share/<sessionID>.json` | share state cache | share service |
| `migration` | storage migration marker | `Storage` layer |

Current code no longer writes the `session/`, `message/`, or `part/` file
prefixes: session, message, and part state lives in the SQLite read models
(section 3.1), and these JSON files are legacy lineage only. `Storage.migration.1`
copies the older `storage/session/info|message|part` layout into these prefixes
and `Storage.migration.2` rewrites `session/<projectID>/<sessionID>.json` with a
`summary`; after migration they are retained but not maintained. Live `Storage`
writes are limited to `session_diff`, `session_diff_base`, and `session_share`.

Commit `8034c970dd` added removal of `session_diff` / `session_diff_base` in
`Session.remove` (with `Storage.remove` idempotency for missing files), closing
the orphan lifecycle issue. `session_diff` still accumulates for retained
sessions by design (it is cumulative logical content, see
`packages/opencode/src/kilocode/session-portability/`), so its 1.1 GB footprint
on this machine is expected retained content, not orphans.

### 3.3 Other data stores

| Store | Role |
|---|---|
| `~/.local/share/kilo/snapshot/` | git repos per project/worktree holding filesystem snapshots for revert/undo (`packages/opencode/src/snapshot/`). Parts reference snapshots by git commit string. Distinct from the event log; in the target these are revert-snapshot storage used by SessionRevert + Snapshot (section 9 terminology) and are part of the artifact registry scope (section 5.4). They are project-scoped/shared, not owned by one session family: ownership/GC (project-level reachability/refcount) is assigned separately from session-family deletion (section 5.4), so no silent orphaning occurs. |
| `~/.local/share/kilo/log/` | CLI/server logs. Out of scope. |
| `~/.local/share/kilo/session-export.db` | export/share bookkeeping (`SessionExport`). Inert at the P4.2 cutover (no export reader is retained after the cutover); its cutover disposition — included in the cutover archive or excluded by recorded decision — is an R17 item (section 6.4); it is never silently deleted. |
| `~/.local/share/kilo/kilo-local.db` | local/instance database. Out of scope. |

### 3.4 Consumers that depend on the event log (legacy surfaces)

These surfaces exist today and depend on the event log. In the target they are
removed (ADR-0005 I-4; P4.4/P4.5), not preserved:
the final product is one private runtime with no multi-client sync/warp, no
old-peer capability negotiation, and no released-client compatibility.

| Consumer | Mechanism | Dependency | Target disposition |
|---|---|---|---|
| Historical session streaming | `EventV2.aggregateEvents(aggregateID, after)` reads `event` rows with `seq > after`, ordered by `seq` | seq continuity, full event payloads | Removed at P4.4/P4.5; reads go through the canonical aggregate model after P4.2a |
| Workspace sync (history) | `POST /sync/history` returns all `event` rows outside the requester's known `(aggregate, seq)` ranges; requester replays with `ownerID` | per-aggregate seq as cursor, full event payloads | Removed (no multi-client sync); P4.4/P4.5 |
| Workspace sync (live) | SSE `sync` events replayed via `events.replay(..., { publish: true, ownerID })` | versioned event types + registry decode | Removed (no multi-client sync); P4.4/P4.5; R9's bounded changefeed/outbox is the only reconnect-delta path in the target |
| Session warp | reads ALL `event` rows for a session, posts batches of 10 to `POST /sync/replay` (`replayAll` with `strictOwner`), then `POST /sync/steal` | full event log from seq 1, contiguous seq | Removed (no warp in a single private runtime); P4.4/P4.5 |
| Share/export | `share-next` watches `Session.Updated`, `MessageUpdated`, `PartUpdated`, `Diff`, `Deleted` events; `SessionExport` on close | event notification, message/part content | Retargeted at P4.2 to canonical aggregates + registered artifacts; share state remains registered (section 5.4) |
| Event bridge to clients | `EventV2Bridge` re-publishes events on `GlobalBus` + SSE; SDK consumers decode `message.updated.1`, `message.part.updated.1`, etc. | versioned event types, payload shapes | Removed with the public server surface at P4.4/P4.5; the private transport (R1) and R9 carry observation |
| Replay owner checks | `event_sequence.owner_id` + `claim` semantics: warp claims a session so the old workspace's later events are ignored | `owner_id` column semantics | Removed (no multi-owner warp); P4.4/P4.5 |

## 4. Operational Containment (pre-P4 manual, bounded)

### 4.1 Policy

Before the P4.2 cutover, the legacy store keeps growing (section 2.2: ~24.56 GB
DB, ~91-92% disk, ~7.5 GB/7 days derived from the two dated observations). The
user selected a bounded manual
containment operation to buy time: **full archive of the legacy data plus
keeping last-week-active sessions in the current legacy DB**. The mechanism,
cadence, and tooling for this operation are the user's manual choice; this spec
records the policy and its evidence slots only. The kept last-week-active set
exists only in the legacy store before the cutover and in the offline legacy
archive afterward; it is not migrated into or read by the fresh canonical
runtime (section 6.2).

### 4.2 Evidence slots (pending)

| Evidence | Slot | Status |
|---|---|---|
| Full legacy archive location and size | TBD | Pending manual execution |
| Archive integrity/checksum | TBD | Pending manual execution |
| Last-week-active session set | TBD | Pending manual execution |
| Disk headroom after containment | TBD | Pending manual execution |
| Post-containment growth rate | TBD | Pending manual execution |

### 4.3 Bounds

- Operational containment is **not target behavior** (the target is the
  canonical model with automatic retention, section 5) and **not a phase gate**:
  no P1-P3 phase waits on it, and no phase claims completion from it.
- It does not change the P4.2 cutover: the legacy DB is still archived offline
  and a fresh canonical DB is booted empty (section 6). The operational
  containment archive is distinct from the P4.2 cutover archive; the cutover
  archive is the rollback authority (section 6.3; R17).
- It is a bounded manual operation: no new product surface, no settings, no UI,
  no migration tooling, and no automatic mechanism is added for it (LOCK-016).
- Completion is not claimed until the evidence slots above record execution
  evidence (LOCK-013).

## 5. Target Model (LOCK-016)

### 5.1 Canonical aggregate storage

- **Canonical durable truth** is normalized session/message/part/todo/share and registered operation/outcome/failure aggregates as R11 fields land, plus registered artifacts (R16 resolved 2026-08-20). The `session`, `message`, `part`, V2 projections, and registered artifacts are the canonical state; the full-payload append-only event log is not a target mechanism for history. Legacy `event`/`event_sequence` is not required for reconstruction and remains removal scope.
- **Atomic revision commits**: `SessionTable.revision` is the per-session monotonic revision; every semantic mutation and its revision commit in one immediate transaction, so readers observe either the old revision or the new one, never a torn state (crash-safe maintenance; ADR-0001's monotonic-integrity retained). Deletion obtains final revision=current+1 and atomically writes a payload-free delete tombstone to the changefeed before hard-deleting the aggregate in the same transaction; feed rows have no FK cascade to session.
- **Lossless logical content and continuation** for runtime-retained
  canonical-era sessions (ADR-0001 principle retained, scoped per section 1.3):
  continuing a retained session after the rewrite (new turn, retry, revert,
  share, export) behaves identically to continuation before the rewrite;
  runtime-retained sessions' read models and file artifacts stay
  byte-equivalent (after schema normalization). This applies only to sessions
  retained by the fresh canonical runtime after the cutover — not to the
  archived legacy set, which is not migrated into or read by the new runtime.
- **R11 Failure/Outcome durable fields** live in the canonical aggregate
  storage / registered artifact model; diagnostic and panel projections are
  derived and never create competing stores (ADR-0005 I-5; sections 5.1 and 5.4).
- Rationale: payload-free bounded deltas avoid recreating full-object event growth while allowing reconnect efficiency; hard-cap gaps safe because canonical snapshot hydration is authoritative.

### 5.2 Bounded changefeed/outbox (R9/R16)

- A **bounded derived payload-free changefeed/outbox** serves reconnect deltas for the runtime observation and hydration contract in `../vscode-orchestrator/direction.md` (R16 resolved 2026-08-20). It has global monotonic sequence, session ID, session revision, kind, runtime-owned occurrence time; uniqueness/idempotency is `(session_id, revision, kind)`.
- It is **not authoritative history**, is **not required for reconstruction** (reconstruction reads the canonical aggregates), and is **eligible for automatic truncation** after the consumer holds an authoritative hydration state (an observation snapshot, section 9 terminology). It is derived, never reconstruction authority. Canonical snapshot hydration establishes a sequence cursor; acknowledged rows are truncatable.
- Hard cap is both 50,000 rows and 64 MiB; exceeding either may evict oldest rows even if unacknowledged. Any cursor gap forces full rehydration. Exact wire handshake remains R9/P4.2b. Rationale: payload-free bounded deltas avoid recreating full-object event growth while allowing reconnect efficiency; hard-cap gaps safe because canonical snapshot hydration is authoritative.
- Deletion writes a payload-free tombstone atomically before hard-delete in the same transaction (section 5.1); feed rows have no FK cascade to session.

### 5.3 Automatic retention (R15 resolved 2026-08-20)

- **Invisible private-runtime maintenance**, not a product/UI/config surface:
  no user-visible setting, no per-session pin UI, no storage dashboard, and no
  manual cleanup product. No setting/pin/dashboard/manual cleanup/UI exists or will be added.
- **Byte-budget policy**: high watermark 8 GiB, low watermark 6 GiB — 25% hysteresis over a fresh canonical store; a resource bound, not a performance SLA; values change only via later recorded architecture decision, never user config. Budget scope is physical bytes of the active canonical DB main file + WAL and registered session-family artifacts; excludes offline archives, logs/cache, and project-owned snapshot storage. When high is exceeded, the runtime prunes eligible root families until at/below low or no eligible family remains. Physical accounting must include WAL.
- **Family = root + descendants + owned messages/parts/outcomes/events/diffs/
  shares/registered artifacts**; pruning is complete-family deletion;
  never partial transcript truncation. Project-scoped/shared revert snapshots (section 3.3 `snapshot/`) are not owned by one session family and are never deleted as part of family pruning; their ownership/GC (project-level reachability/refcount) is assigned in the artifact registry separately (section 5.4), with no silent orphaning.
- **Eligibility and ordering**: protect every root family whose maximum runtime-owned activity across root+descendants is within 7 days; additionally requires all members terminal/idle and no active/in-flight operation or maintenance/read lease. Revalidate protections in the deletion transaction. Order eligible roots by activity ascending then root ID. Active/in-flight and maintenance-leased/read families cannot be pruned. No partial transcript/tool/output truncation, no logical loss inside runtime-retained sessions, no deletion inline with a user-visible request, and no silent orphaning (ADR-0001's complete-session/family deletion and no-silent-lossy-compaction retained).
- **Maintenance timing and crash safety**: maintenance is coalesced after boot and canonical commits, runs only off the generation hot path when idle and high is exceeded. Canonical DB deletion is one immediate transaction; filesystem artifact cleanup uses a durable idempotent cleanup obligation so crash recovery cannot expose a partially retained canonical family.
- **Reclamation**: fresh canonical DB is created with incremental auto-vacuum. After pruning, checkpoint/reclaim incrementally off hot path. If floor/protections prevent low, stop safely and emit pressure diagnostics.
- **Diagnostics**: per-run diagnostic facts: trigger, before/after physical bytes, selected/deleted/skipped family counts with reasons, canonical rows and artifact bytes reclaimed, checkpoint/vacuum result, failures. These are descriptive maintenance facts, never a user-facing surface and never a numeric performance gate.
- Rationale: 8/6 separates normal operation from measured ~24.56 GiB legacy emergency; 7 days preserves recent continuity while bounding growth.

### 5.4 Artifact field/owner/retention registry (R16 resolved 2026-08-20)

- Closed registry entries: canonical DB aggregate rows (including SessionShare/todo/message/part/context and future registered outcome/failure rows) are schema-owned and cascade/transaction governed, not file artifacts; `session_diff`, `session_diff_base`, `session_share` are session-family-owned file artifacts, retained/deleted with family; `snapshot` is project-owned and collected only by project reachability/refcount, never family pruning; `session-export.db` is legacy cutover material under R17, not canonical artifact. New runtime artifact writes require a registry entry before landing.
- Every session-owned sidecar/artifact has a registry entry with owner and retention disposition; session-family deletion removes exactly the session-owned artifacts of the deleted family, nothing else. Project-scoped/shared revert snapshot storage (`~/.local/share/kilo/snapshot/`, section 3.3) is registered with project-level ownership via reachability/refcount, separate from session-family deletion, with no silent orphaning.
- Unregistered session-owned artifacts **block the storage phase exit** (R16; section 8 gate).
- The registry covers artifacts that survive the cutover (section 6) and the canonical model's new artifact surface.
- Sequencing: R16 registry definition is available to S2; S2 materializes/consumes the registry for deletion. S3 is registry closure/audit: verify every writer/class is registered, project snapshot ownership is correct, and zero unregistered artifacts remain. Thus S2→S3 is preserved.

### 5.5 Explicitly rejected mechanisms

Rejected in the target (ADR-0005 I-4): `/sync/checkpoint`; sync/warp peer
resync; released-client capability negotiation; the former cross-client storage
verification phase (old spec P6); permanent duplicate full-payload event
snapshots; generic full-object update history; any multi-client sync/warp
replay protocol; and any removed-client compatibility boundary.

## 6. Cutover (LOCK-017; R17 resolved 2026-08-20)

### 6.1 Offline archive procedure

At the P4.2 storage cutover (P4.2a, work unit S5):

1. Cutover archive is an offline versioned directory under the same-filesystem sibling derived from `Global.Path.data`: `<data-basename>-archive/p4.2/<UTC>-<uuid>/`. Temporary archive is created under the same `p4.2` parent; EXDEV/cross-device fallback is forbidden/fails closed. It has manifest schema v1 and preserved POSIX relative paths. No runtime archive reader.
2. Stop the sole runtime and close handles; run `wal_checkpoint(TRUNCATE)`, `integrity_check`, and `foreign_key_check`. Fixed members are `kilo.db` plus `kilo.db-wal`/`kilo.db-shm` if present after checkpoint, `storage/session_diff`, `storage/session_diff_base`, `storage/session_share`; explicitly include `session-export.db` and its WAL/SHM when present, otherwise record absence. Explicitly exclude project-owned `snapshot` and explain it is not rollback material under this cutover decision. Nothing else is archived.
3. Manifest v1 records archive ID, UTC creation, source data root, each sorted file path with bytes and SHA-256, present/absent fixed members, and deterministic aggregate SHA-256 over sorted path/bytes/hash records. Preserve empty fixed directories. Fsync files/directories, reverify, atomically rename temp to final, fsync parent; any failure leaves legacy active and aborts cutover.
4. Boot a fresh canonical DB, empty, and continue on the canonical model (section 5).
5. Retain **rollback authority** until archive deletion is separately authorized; the archive is not deleted by the cutover itself.

### 6.2 Fresh canonical DB boot

The fresh canonical DB starts **empty** — from the canonical schema/revision
model (R16) with the artifact registry (R16) and automatic retention (R15)
active — and contains no pre-cutover sessions. It has singleton storage identity: UUID, schema version, creation time, cutover archive ID. Boot gate verifies identity and zero sessions/registered family artifacts before activation. The last-week containment set kept by operational containment (section 4) remains only in the offline legacy archive; it is not migrated into, read by, or usable from the fresh canonical runtime. No old-session migration or import occurs at boot. Fresh DB uses incremental auto-vacuum (R15).

### 6.3 Rollback authority and archive deletion

- Rollback is offline only: stop/close, verify archive, separately archive the current canonical store under a distinct rollback ID, atomically restore legacy members, rerun integrity checks, then boot legacy path. Never dual-read. The rollback authority is the P4.2 cutover archive, distinct from the pre-P4 operational containment archive (section 4).
- Archive deletion requires separate explicit maintainer authorization after cutover and is never a cutover side effect; no runtime/UI/API automatic deletion path exists; after deletion, rollback is no longer possible.

### 6.4 R17 decisions (resolved 2026-08-20)

R17 is resolved 2026-08-20 (section 6.1-6.3): location `<data-basename>-archive/p4.2/<UTC>-<uuid>/` with temp under same parent and EXDEV forbidden; manifest v1 with deterministic SHA-256; fixed members `kilo.db`(+WAL/SHM), `storage/session_diff`, `storage/session_diff_base`, `storage/session_share`, plus `session-export.db`(+WAL/SHM) when present else recorded absence; `snapshot` excluded; fsync+atomic rename+reverify; singleton storage identity (UUID, schema version, creation time, cutover archive ID) with boot gate; offline rollback with separate current-store archive; deletion requires separate maintainer authorization, never a side effect; no runtime archive reader. Rationale: directory+manifest permits transparent offline integrity/restore without runtime compatibility reader; same-parent atomic rename and explicit optional members fail closed. R17 distinguishes the pre-P4 operational containment archive (section 4) from the P4.2 cutover archive, which is the rollback authority.

## 7. Storage Work Units (S0..S5, under orchestrator P4.2)

The storage foundation lands inside orchestrator P4.2a. Dependencies run top to
bottom; each unit ships its exit criteria before the next starts. The S-labels
are namespaced storage work units and collide with no orchestrator phase.

| Unit | Scope | Exit criteria | Test / verification |
|---|---|---|---|
| S0 Baseline and fixtures | Freeze the read-only aggregate measurement queries (section 10) as reproducible commands; build lossless-family fixtures (retained family; active/in-flight family; maintenance-leased/read family); record storage baseline metrics in section 8 | Reproducible commands + fixture tests pass; baseline recorded (2026-08-14 values, section 2.2) | Measurement queries from section 10; fixture tests in `packages/opencode` |
| S1 Canonical aggregate schema and revision commit model | Define the canonical aggregate/read-model schema and the atomic monotonic aggregate/session revision commit (section 5.1); crash-safe maintenance transactions | Every mutation commits canonical state + revision atomically; crash injection leaves no torn state; no unbounded replay log is written | Round-trip and crash-injection tests |
| S2 Automatic retention engine | Byte-budget high 8 GiB/low 6 GiB with hysteresis, 7-day floor, family eligibility/ordering, atomic family pruning with cleanup obligation, protections, incremental vacuum/checkpoint, diagnostics (section 5.3; R15 resolved 2026-08-20) | Retention engine passes with normative values; protects 7-day families and active/leased families, ordering activity asc then root ID, complete-family deletion only, WAL-inclusive accounting, pressure diagnostics when floor prevents low | Retention engine tests; family-protection tests |
| S3 Artifact field/owner/retention registry | Register every session-owned sidecar/artifact with owner and retention; S2 materializes/consumes registry, S3 closes/audits (section 5.4; R16 resolved 2026-08-20) | Registry definition available to S2; S2 materializes for deletion; S3 verifies every writer/class registered, snapshot ownership correct, zero unregistered; unregistered blocks exit; S2→S3 preserved | Registry audit test |
| S4 Bounded changefeed/outbox | Bounded payload-free feed for reconnect deltas with global seq, `(session_id, revision, kind)` idempotency, 50,000 rows/64 MiB caps, cursor-gap full rehydration (section 5.2; R16 resolved 2026-08-20) | Storage-side feed verified: bounded ordering, hard-cap eviction, truncation, idempotency, gap→rehydration; payload-free tombstone on delete; feed never affects reconstruction | Storage-side feed tests (ordering/truncation/idempotency/caps); wire-level convergence at P4.2b under the direction target |
| S5 Offline cutover | Stop sole runtime, checkpoint/integrity, archive fixed members with manifest v1+SHA-256 under `<data-basename>-archive/p4.2/<UTC>-<uuid>/`, boot fresh DB with singleton identity, retain rollback authority (section 6; R17 resolved 2026-08-20) | Archive integrity verified with manifest+aggregate SHA-256 and atomic rename; fresh DB boots clean with identity gate and zero sessions/artifacts; offline rollback rehearsed; deletion requires separate authorization | Cutover rehearsal; archive integrity check |

## 8. Gates And Tests

### 8.1 P4.2 storage gates

P4.2 cannot exit until all of the following pass (ADR-0005 I-11):

- Canonical schema/revision model (S1, R16) — mutations commit canonical state
  and a monotonic revision atomically.
- Automatic retention (S2, R15) — invisible byte-budget pruning with
  hysteresis, family protections, complete-family deletion, diagnostics.
- Artifact field/owner/retention registry (S3, R16) — no unregistered
  session-owned artifact remains.
- R15-R17 resolved and recorded in this spec (sections 5-6).
- Clean-DB cutover (S5, R17) — offline archive with integrity evidence, fresh
  canonical DB boot, rollback authority retained.
- H-10/H-11 persistence and lifecycle evidence passes against the canonical
  storage foundation in this spec.

### 8.2 Tests

- Storage unit tests in `packages/opencode` (S0-S5 scope in section 7).
- Storage-side bounded changefeed tests (S4: ordering/truncation/idempotency);
  wire-level convergence is a P4.2b gate under the direction target, not an S4 exit.
- H-10/H-11 evidence from the target surface recorded against the canonical
  storage foundation.
- No cross-client or released-client storage tests exist or are planned
  (ADR-0005 I-4).

## 9. Terminology

| Term | Definition | Boundary |
|---|---|---|
| Canonical aggregate | The normalized session aggregate/read-model state that is canonical durable truth, plus its explicitly registered artifacts | The private runtime's canonical store (section 5.1); not a replay log |
| Bounded changefeed | A bounded derived feed of deltas for reconnect hydration (R9) | Not authoritative history; truncatable after authoritative hydration state (section 5.2) |
| Offline archive | The opaque archived legacy DB + session-owned sidecars with checksum/integrity evidence from the P4.2 cutover | No runtime archive reader; rollback authority until deletion is separately authorized (section 6) |
| Revert snapshot | Filesystem snapshot storage used by SessionRevert + Snapshot semantics | Distinct from canonical aggregates; part of the artifact registry scope (section 5.4) |
| Config generation snapshot | The immutable versioned config/runtime snapshot a generation consumes | Derived versioned value, not a second persisted store; distinct from storage artifacts |
| Observation snapshot | An observation of runtime operational facts under the observation contract | Distinct from the config generation snapshot; delivered over the bounded changefeed/outbox |

## 10. Verification Commands

Measurement (read-only, against a local install):

- `sqlite3 "file:$HOME/.local/share/kilo/kilo.db?mode=ro" "SELECT 'event', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM event;"` and the same for `message`, `part`, `session`.
- Event-type breakdown: `SELECT type, count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM event GROUP BY type ORDER BY 3 DESC;`
- File stores: `du -sh ~/.local/share/kilo/storage/* ~/.local/share/kilo/snapshot`

Markdown/table check for this file and the storage-related docs (must pass
without modifying anything):

- `bun run script/check-md-table-padding.ts specs/adr/0001-lossless-session-storage-rewriting.md specs/adr/0004-architecture-first-direct-reconstruction.md specs/adr/0005-bounded-private-runtime-storage.md specs/storage/session-storage-rewriting.md`

Test/typecheck guidance (from root AGENTS.md; run only the smallest relevant
layer when a storage work unit touches code):

- `bun test` from `packages/opencode/` (never from repo root)
- `bun run typecheck` from `packages/opencode/`

## 11. Open Decisions

- R15, R16, R17 (section 1.4) are resolved 2026-08-20, required by P4.2a, and not P1-P3 blockers. Operational containment archive remains distinct from cutover archive.
- The operational containment evidence slots (section 4.2) remain pending until manual execution evidence exists.
