# P4-G8 Storage Offline Foundation Evidence

## Status and scope

This record closes the repository-evidence portion of P4-G8's offline storage
foundation. It aggregates the existing S0-S5 and R15-R17 implementation/test
pointers without changing their implementation or historical claims.

P4-G8 remains **Active**. The evidence below is isolated offline evidence only:
it does not represent a live production cutover, live retention run, or a
mutation of `Global.Path.data`. The legacy-compatible runtime path remains
outside this record's execution scope, and no unconditional startup gate is
introduced.

## Requirement mapping

The normative requirements are [storage specification §7](../../storage/session-storage-rewriting.md#7-storage-work-units-s0s5-under-orchestrator-p42),
[§8.1](../../storage/session-storage-rewriting.md#81-p42-storage-gates), and
the resolved [R15-R17 decisions](../../storage/session-storage-rewriting.md#14-bounded-decisions-open).

| Requirement | Existing repository evidence | Evidence boundary |
|---|---|---|
| S0 — baseline commands and deterministic family fixtures | [test: packages/opencode/test/storage/s0-baseline-measurement.test.ts](../../../packages/opencode/test/storage/s0-baseline-measurement.test.ts) | Fixture and measurement proof in isolated test instances; the test documents the separate `:memory:` SQLite architecture. |
| S1 — canonical aggregates and atomic monotonic revisions | [test: packages/core/test/session-revision.test.ts](../../../packages/core/test/session-revision.test.ts), [test: packages/opencode/test/session/session-revision.test.ts](../../../packages/opencode/test/session/session-revision.test.ts), [test: packages/core/test/database-migration.test.ts](../../../packages/core/test/database-migration.test.ts), [test: packages/opencode/test/kilocode/session-import-service.test.ts](../../../packages/opencode/test/kilocode/session-import-service.test.ts), [test: packages/opencode/test/kilocode/server/session-import-http.test.ts](../../../packages/opencode/test/kilocode/server/session-import-http.test.ts), [test: packages/opencode/test/project/project.test.ts](../../../packages/opencode/test/project/project.test.ts), [test: packages/opencode/test/cli/import.test.ts](../../../packages/opencode/test/cli/import.test.ts), [test: packages/opencode/test/kilocode/storage/json-migration.test.ts](../../../packages/opencode/test/kilocode/storage/json-migration.test.ts) | Existing migration, service, HTTP, writer, and rollback coverage; no live-store operation is inferred. |
| S2 / R15 — byte-budget retention, family protection, cleanup, and diagnostics | [test: packages/opencode/test/storage/s2-retention-engine.test.ts](../../../packages/opencode/test/storage/s2-retention-engine.test.ts), [test: packages/opencode/test/storage/s2-production.test.ts](../../../packages/opencode/test/storage/s2-production.test.ts), [test: packages/core/test/retention-s2.test.ts](../../../packages/core/test/retention-s2.test.ts) | Existing isolated retention-engine and production-path test evidence for the resolved 8 GiB/6 GiB, seven-day-floor, family-protection, WAL-accounting, and diagnostic behavior. This does not claim live retention deletion. |
| S3 / R16 — artifact ownership and registered write boundary | [test: packages/opencode/test/storage/s3-audit.test.ts](../../../packages/opencode/test/storage/s3-audit.test.ts), [test: packages/opencode/test/storage/s3-write-boundary.test.ts](../../../packages/opencode/test/storage/s3-write-boundary.test.ts), [test: packages/opencode/test/snapshot/snapshot-prune-live.test.ts](../../../packages/opencode/test/snapshot/snapshot-prune-live.test.ts), [test: packages/opencode/test/snapshot/snapshot-live-db.test.ts](../../../packages/opencode/test/snapshot/snapshot-live-db.test.ts), [test: packages/opencode/test/snapshot/snapshot-cleanup-decision.test.ts](../../../packages/opencode/test/snapshot/snapshot-cleanup-decision.test.ts) | Existing static, boundary, and project-owned snapshot evidence; `snapshot` remains outside session-family pruning and `session-export.db` remains legacy cutover material. |
| S4 / R16 — bounded payload-free changefeed and reconstruction independence | [test: packages/core/test/changefeed-s4.test.ts](../../../packages/core/test/changefeed-s4.test.ts) | Existing storage-side ordering, idempotency, cap, truncation, gap/rehydration, tombstone, rollback, and reconstruction-independence evidence; wire-level R9 remains separate P4.2b work. |
| S5 / R17 — offline archive, fresh identity/zero gate, rollback rehearsal, and lease/marker safety | [test: packages/opencode/test/cutover-s5-production.test.ts](../../../packages/opencode/test/cutover-s5-production.test.ts), [test: packages/opencode/test/kilocode/session-export/lease.test.ts](../../../packages/opencode/test/kilocode/session-export/lease.test.ts), [test: packages/opencode/test/kilocode/session-export/respawn.test.ts](../../../packages/opencode/test/kilocode/session-export/respawn.test.ts), [test: packages/opencode/test/kilocode/session-export/lease-refcount.test.ts](../../../packages/opencode/test/kilocode/session-export/lease-refcount.test.ts) | Existing run-owned temporary-root, isolated `KILO_DB`, archive-integrity, fresh-identity, rollback-recovery, lease, marker, and spawned-server evidence. The test explicitly keeps the parent database at `:memory:` and asserts the run-owned root is not `Global.Path.data`. |

The S5 repository evidence is also summarized by the existing tracker history
entry for the offline cutover work unit:
[doc: archive/migration-tracker-history-2026-08-28.md](../archive/migration-tracker-history-2026-08-28.md).
That historical entry remains unchanged.

## H-10/H-11 relationship

The existing H-10/H-11 evidence is cited as supporting canonical-foundation
persistence/lifecycle evidence only:
[doc: evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/](p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/),
including its redacted manifests and provenance records. It does not assert a
live `Global.Path.data` cutover, live archive operation, or production
retention execution. The separate R9 observation record remains governed by its
existing tracker entry.

## Isolation and explicit non-claims

- The inspected foundation tests use isolated stores: `:memory:` database
  layers where the tests specify them, test-instance temporary directories for
  service fixtures, and run-owned `mkdtemp` roots for S5 production-path
  rehearsal.
- The S5 spawned-server evidence points `KILO_DB` at a run-owned temporary
  database and uses isolated home/XDG paths; it does not point the child at
  `Global.Path.data`.
- This record does **not** claim a live archive, live retention deletion, or a
  production rollback manifest.
- This record does not claim mutation, retention, deletion, rollback, or
  high-watermark trimming against the live `Global.Path.data` store.
- No live production cutover command was run for this evidence closure, and no
  production manifest, production log, real-data retention result, or live
  rollback artifact is present in this record.

## Deferred operational work

The following remain outside the offline closure and keep P4-G8 Active:

1. Any live operational cutover of the configured production store.
2. Live automatic retention wiring/execution and high-watermark trimming on
   real retained data.
3. A production rollback manifest and real-data rollback run.
4. Any claim that the live legacy-compatible store was mutated or replaced.
