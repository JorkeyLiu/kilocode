# 0001: Lossless Session Storage Rewriting

- Status: Superseded
- Date: 2026-08-07
- Owner: Kilo maintainers

## Context

Kilo's durable `event` table is append-only: every synchronized update appends a new row
carrying the full payload of what changed. The read models (`session`, `message`, `part`, V2
projections, file-backed artifacts) converge to final state, but the event log keeps every
version forever, so retained-session storage grows without bound. Measured on one local install
(2026-08-07), the `event` table alone holds the dominant share of a tens-of-gigabytes database,
driven by `message.updated` and `message.part.updated` full-content snapshots. Exact row and
payload figures are mutable measurement evidence and live in the technical spec, section 2.

The event log is also the only record of per-aggregate sequence and the transport for workspace
sync and session warp. The fix must shrink the log without breaking sequence semantics or the
sync/warp transport. Full measurements and mechanics live in the technical spec
(`../storage/session-storage-rewriting.md`); this ADR records only the durable decision.

## Decision

Kilo may rewrite the physical storage representation of retained sessions, but only while
preserving complete logical session content and lossless continuation behavior: continuing a
session after a rewrite (new turn, retry, revert, fork, warp, share, export) must behave
identically to continuation before the rewrite.

Status Active means this is the current chosen direction: not completed implementation and not
formal external approval.

The selected direction is **checkpoint + resync**: a canonical session checkpoint captures an
aggregate's full logical state at a specific event sequence, events below a verified checkpoint
may later be purged, gap detection serves reads from checkpoint plus retained tail, and
sync/warp peers resync via the checkpoint. The trailing-event retention window size is an
undecided implementation detail owned by the technical spec.

Lossy message/part compaction and direct unsafe truncation of event rows are rejected. Deletion
remains complete-session only unless the checkpoint/resync protocol explicitly makes historical
event deletion safe.

## Invariants / constraints

- Lossless logical content: retained sessions' read models and file artifacts stay
  byte-equivalent (after schema normalization) across any rewrite.
- Lossless continuation: post-rewrite continuation behaves identically to pre-rewrite
  continuation on every supported surface.
- Event sequence integrity: per-aggregate `seq` stays monotonic and gapless in the retained
  tail; a checkpoint records the seq it covers; a restore materializes `event_sequence` at the
  checkpoint seq.
- No silent truncation: a checkpoint-aware read that needs events below a checkpoint fails
  loudly (explicit resync), never serving a truncated stream as complete. Old builds that open
  an already-compacted DB see only the retained tail; that is the accepted, documented
  mixed-version capability boundary, and compaction must not silently strand an active old peer.
- Deletion semantics: only complete-session deletion removes rows; no phase drops or rewrites
  logical `message`/`part`/`session` content.

The full invariant set (I-1..I-8) with acceptance criteria lives in the technical spec, section 4.

## Alternatives considered

| Alternative | Why rejected or deferred |
|---|---|
| Full event retention (status quo) | Rejected: unbounded growth; event payload reaches tens of GB on one install and keeps growing (measurements in the technical spec, section 2). |
| Lossy compaction (drop or truncate old messages/parts) | Rejected: violates lossless content and continuation; changes user-visible history semantics. |
| Content deduplication / compression | Deferred (complementary): reduces bytes but does not bound growth; may layer onto checkpoint + resync later. |
| Complete-session deletion / management | Complementary, not a competing architecture: removes whole sessions only, so it does not fix retained-session growth; partially implemented, tooling deferred. |

## Consequences

Positive:

- Bounds event-log growth for retained sessions while preserving full logical content.
- Keeps sequence semantics, workspace sync, session warp, historical streaming, and
  share/export on a defined path: checkpoint + resync with explicit capability negotiation.
- Rejected lossy alternatives are on record, so they will not be re-litigated from scratch.

Negative:

- Adds a checkpoint/storage component, gap detection, and a resync protocol; real
  implementation complexity over the status quo.
- Introduces a mixed-version capability boundary: pre-compaction peers must be served from
  retained history, or compaction refused for aggregates an active old peer is syncing.
- Old builds opening an already-compacted DB see only the retained tail for historical replay;
  restoring history below the checkpoint requires the new code's checkpoint path.
- Checkpoint correctness becomes an operational requirement (verified checksums, no checkpoint
  past the committed event seq, maintenance-time purge only).

## Follow-up artifacts

- Technical spec: `../storage/session-storage-rewriting.md` - owns implementation design,
  migration, phased roadmap, tests, and open questions. It remains the implementation source of
  truth; this ADR records the durable decision only.
- Canonical architecture docs: none yet. The implemented system is unchanged until the project
  ships; when implementation changes reality, the architecture pages are updated separately.

## Supersession

- Supersedes: none.
- Superseded by: [ADR-0005: Bounded Private-Runtime Storage](0005-bounded-private-runtime-storage.md)
  (2026-08-14).

Status is Superseded: ADR-0005 replaces ADR-0001's checkpoint + resync /
multi-client transport target for the final product. The decision body above is
historical and is not rewritten; ADR-0005 records which ADR-0001 principles
remain valid (lossless logical content and continuation for canonical-era
runtime-retained sessions, monotonic integrity, crash-safe maintenance,
complete-session/family deletion, no silent lossy compaction) and which
mechanisms are explicitly rejected.
