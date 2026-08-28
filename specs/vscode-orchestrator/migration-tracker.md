# VS Code Agent Orchestrator - Migration Tracker

> Current-state index (mutable). Durable sources — ADRs, `agent-orchestration-direction.md`, `runtime-and-configuration-direction.md` — own decisions and target semantics. This tracker owns only changing phase status, evidence pointers, blockers, and next actions. Historical narratives and completed phase detail live in the archive and linked evidence; do not duplicate them here.

Purpose and maintenance rules:

- This tracker is the mutable current-state index; linked evidence/ADRs/specs are the durable sources of truth.
- No phase, row, or decision is marked `Complete` without objective evidence recorded as an explicit pointer (`issue: #NNN`, `PR: #NNN`, `test: <path>`, `doc: <path>`). A checkbox without a pointer is not evidence.
- No technical narrative duplication: this index links to evidence; it does not retell it. Performance claims require objective evidence.
- Every entry carries a date. See §9 Write Rules for required fields and pointer-over-prose discipline.
- All historical amendments, completed phase narratives, duplicated matrices, and old change-log rows are preserved verbatim in the archive; superseded index entries are archived, not deleted.

## 1. Status Vocabulary

| Status | Meaning |
|---|---|
| Not started | No work and no evidence recorded |
| Active | Work in progress; evidence accrues here |
| Blocked | Stalled on a decision/dependency recorded in §7 |
| Complete | All exit criteria met with objective evidence recorded |
| Deferred | Scope moved out per recorded decision |
| Reconstruction candidate | Registry entry for a legacy behavior actually disabled/removed or intentionally not carried forward (LOCK-015). Evidence preservation only — never a promise, backlog, gate, or removal classification |

Scope note: phase/row statuses above are the only controlled statuses. Qualified display labels `Active/residual` and `Active/open` map to base `Active` (e.g., P4.4 residual rows) and are not new vocabulary. Decision/risk rows use scoped labels `Open`/`Monitored`/`Resolved` (§7) and bounded-gate qualifiers `open`/`MET` (e.g., bounded subgate MET) — neither extends the status vocabulary. Evidence pointers use `test:` and/or `doc:` with package-qualified paths and relative Markdown links per §9.

## 2. Decision Locks

Non-negotiable for every phase. Full text in `agent-orchestration-direction.md` §1.1, `runtime-and-configuration-direction.md` §10 for LOCK-PERF, and ADR-0002/0003. Archive preserves full historical wording.

| ID | Invariant (concise) | Pointer |
|---|---|---|
| LOCK-001 | VS Code Agent Orchestrator is the only product; ordinary single-chat sidebar is removed | direction §1.1, tracker §3/§6 |
| LOCK-002 | Remove all worktree infrastructure and custom Diff Viewer surfaces | direction §1.1 |
| LOCK-003 | Remove cloud sessions, JetBrains, Console, KiloClaw completely | direction §1.1 |
| LOCK-004 | Remove indexing, semantic search, project memory/tools, user-visible context management/compaction, autocomplete | direction §1.1 |
| LOCK-005 | Retain minimal invisible internal context-overflow safeguard only (H-13) | direction §1.1 |
| LOCK-006 | Retain only user-defined/custom providers; remove preset catalogs/onboarding/org sources | direction §1.1, runtime §4 |
| LOCK-007 | Checkpoint = SessionRevert + Snapshot semantics | direction §1.1, ADR-0005 |
| LOCK-008 | Preserve harness capabilities (agents, delegation, tools, skills, MCP, permissions/questions, parent-child, background/parallel, custom models, persistence, rollback, overflow) | direction §1.1 |
| LOCK-009 | Eliminate CLI/TUI/Console as products; private headless worker for isolation; `kilo serve` HTTP/SSE/SDK is bridge-only, not target | ADR-0003, direction §1.1 |
| LOCK-010 | File-authoritative config: two canonical scopes (global root, `<workspaceRoot>/.kilo/`), field registry, WYSIWYG, bidirectional editing, no migration tool | ADR-0003, runtime §3 |
| LOCK-011 | Generation pinning; config update creates new version without interrupting active generations; version-scoped resource disposal | runtime §5 |
| LOCK-012 | Selectors render from extension-owned persisted indexes before worker readiness; action-specific readiness, no global `extensionDataReady` | runtime §6 |
| LOCK-013 | Canonical architecture docs describe implemented reality; tracker records migration truth | ADR-0004 |
| LOCK-014 | Principle-first (no exhaustive pre-inventory), two closed sets (H-1..H-13 and permanent removals), no default compatibility | ADR-0004 |
| LOCK-015 | Reconstruction candidate is evidence preservation only; created only when behavior actually displaced; never blocks P1-P4 | ADR-0004 |
| LOCK-PERF-1 | Performance simplification is structural removal, not per-phase numeric demand | runtime §10 |
| LOCK-PERF-2 | CLI/TUI/Console are not products; private worker costs measured | runtime §10 |
| LOCK-PERF-3 | Removed features must not contribute to startup/readiness | runtime §10 |
| LOCK-PERF-4 | Persisted selector choices renderable before worker readiness | runtime §10 |
| LOCK-PERF-5 | Preserve harness semantics and performance correctness | runtime §10 |
| LOCK-PERF-6 | No performance claim without runtime evidence | runtime §10 |
| LOCK-PERF-7 | Localhost transport not presumed dominant latency | runtime §10 |

## 3. Current State

- Date: `2026-08-28`
- Worktree: detached HEAD from `3c2dbddcc5` (expected). Base `75678ba8e7` `fix(vscode): align permission dock config paths` (parent `70d0e8922e` `fix(opencode): remove legacy opencode migration notification`); worktree has uncommitted documentation changes (this tracker, `archive/migration-tracker-history-2026-08-28.md`, and companion doc-reference corrections) — not yet committed; no final commit assumed.
- Source of truth for statuses below is this index; durable detail lives in linked evidence/ADRs/specs and the archive.

| Phase | Title | Status | Evidence pointer (summary) |
|---|---|---|---|
| P0 | Baseline inventory | Complete (2026-08-12) | [doc: p0-current-state-inventory.md](p0-current-state-inventory.md); [doc: evidence/p0-baseline/](evidence/p0-baseline/); [test: packages/opencode/test/kilocode/p0-harness-baseline.test.ts](../../packages/opencode/test/kilocode/p0-harness-baseline.test.ts) |
| P1 | Orchestration-first navigation | Complete (2026-08-14) | [test: packages/kilo-vscode/tests/unit/topics.test.ts](../../packages/kilo-vscode/tests/unit/topics.test.ts), [test: packages/kilo-vscode/tests/topic-navigation.spec.ts](../../packages/kilo-vscode/tests/topic-navigation.spec.ts), `test:e2e:topic-navigation` |
| P2 | Harness surface parity | Complete (2026-08-15) | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/) 135 entries/127 hashes, 28/28 `e2e-local/e2e-model`, §5 H-1..H-13 |
| P3 | Product removal | Complete (2026-08-17) | P3.1-P3.4 subphases below |
| P3.1 | Ordinary single-chat sidebar (LOCK-001) | Complete (2026-08-15) | [test: packages/kilo-vscode/tests/unit/sidebar-removal.test.ts](../../packages/kilo-vscode/tests/unit/sidebar-removal.test.ts), `test:e2e:sidebar-removal` |
| P3.2 | Worktree + custom Diff Viewer (LOCK-002) | Complete (2026-08-16) | [test: packages/kilo-vscode/tests/unit/worktree-removal.test.ts](../../packages/kilo-vscode/tests/unit/worktree-removal.test.ts), [test: packages/kilo-vscode/tests/unit/diff-viewer-removal.test.ts](../../packages/kilo-vscode/tests/unit/diff-viewer-removal.test.ts), `test:e2e:worktree-removal` |
| P3.3 | Cloud/JetBrains/Console/KiloClaw (LOCK-003) | Complete (2026-08-16) | [test: packages/kilo-vscode/tests/unit/cloud-claw-removal.test.ts](../../packages/kilo-vscode/tests/unit/cloud-claw-removal.test.ts), [test: packages/opencode/test/kilocode/cloud-claw-removal.test.ts](../../packages/opencode/test/kilocode/cloud-claw-removal.test.ts), [test: packages/opencode/test/kilocode/console-removed.test.ts](../../packages/opencode/test/kilocode/console-removed.test.ts), `test:e2e:cloud-claw-removal` |
| P3.4 | Indexing/memory/context-mgmt/autocomplete (LOCK-004) | Complete (2026-08-17) | [test: packages/opencode/test/kilocode/p3-4-removal-absence.test.ts](../../packages/opencode/test/kilocode/p3-4-removal-absence.test.ts), [test: packages/kilo-vscode/tests/unit/p3-4-removal.test.ts](../../packages/kilo-vscode/tests/unit/p3-4-removal.test.ts), `test:e2e:p3-4-removal` |
| P4 | Private runtime and configuration | Active | P4.1 Complete; P4.2/P4.3 detail below; **P4.4 Active/residual**; **P4.5 Not started** |
| P4.1 | File-authoritative GUI config | Complete (2026-08-18) | [test: packages/kilo-vscode/tests/unit/config-audit-blockers.test.ts](../../packages/kilo-vscode/tests/unit/config-audit-blockers.test.ts), [test: packages/kilo-vscode/tests/unit/config-audit-closure.test.ts](../../packages/kilo-vscode/tests/unit/config-audit-closure.test.ts), [doc: packages/kilo-docs/pages/contributing/architecture/vscode-extension.md#canonical-config-p4-1](../../packages/kilo-docs/pages/contributing/architecture/vscode-extension.md#canonical-config-p4-1); full 606-test checklist/provenance [doc: archive/migration-tracker-history-2026-08-28.md](archive/migration-tracker-history-2026-08-28.md) |
| P4.2 | Storage + private runtime | Active | S0-S5 Complete (offline cutover 2026-08-21); H-10/H-11 convergence Complete (2026-08-22); R1/R9/R11-R14 Resolved (see §7) |
| P4.2a | Storage cutover S0-S5 | Complete (S0 2026-08-19, S1 2026-08-19, S2 2026-08-20, S3 2026-08-20, S4 2026-08-20, S5 2026-08-21) | [doc: ../storage/session-storage-rewriting.md](../storage/session-storage-rewriting.md) §7/§8.1; checklist [doc: archive/migration-tracker-history-2026-08-28.md](archive/migration-tracker-history-2026-08-28.md); [test: packages/opencode/test/storage/s0-baseline-measurement.test.ts](../../packages/opencode/test/storage/s0-baseline-measurement.test.ts), [test: packages/core/test/changefeed-s4.test.ts](../../packages/core/test/changefeed-s4.test.ts), [test: packages/opencode/test/cutover-s5-production.test.ts](../../packages/opencode/test/cutover-s5-production.test.ts) (representative S0/S4/S5; full set in archive) |
| P4.2b | Private transport + observation | Active (R9 Resolved 2026-08-23) | [test: packages/kilo-vscode/tests/unit/private-observation-service.test.ts](../../packages/kilo-vscode/tests/unit/private-observation-service.test.ts), [doc: evidence/p0-baseline/2026-08-23T13-59-07Z-r9-observation/](evidence/p0-baseline/2026-08-23T13-59-07Z-r9-observation/) |
| P4.3 | Legacy-reader cutover | Complete (2026-08-25) | [doc: evidence/p4.3-cutover-evidence.md](evidence/p4.3-cutover-evidence.md); [doc: evidence/p4.3-pre-cutover-reconciliation-checklist.md](evidence/p4.3-pre-cutover-reconciliation-checklist.md) |
| P4.4 | Evidence + transport narrowing | Active/residual | 13-row matrix [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md); per-row §6 |
| P4.5 | Old CLI/server product deletion | Not started | — |
| P5 | Startup and selector readiness | Not started | runtime §6 criteria; §4 P5 gates |

P4.4 is **Active/residual** — bounded T27-T30 canonical loader (`resolveWorktree`/`canonicalRoot` + `ConfigPaths.fileInDirectory(root, "tui")` + `path.join(root, ".kilo")`) is complete; residual machinery, storage, and transport rows remain open per §6. P4.5 and P5 are **Not started** (LOCK-001).

## 4. Active Gates

Completed phases: one-line pointer only (detail in archive/evidence). Active gates below are actionable and unchecked; each has a stable gate ID.

| ID | Phase | Gate (concise) | Status | Evidence pointer |
|---|---|---|---|---|
| P4-G1 | P4 | Every datum has one owner and one persistence path (runtime §3) | Active | runtime §3; P4.1 evidence only — storage convergence pending |
| P4-G2 | P4 | Custom-provider-only boundary enforced (runtime §4) | Active | [doc: p0-current-state-inventory.md](p0-current-state-inventory.md) §6.2; P4.4 provider rows residual |
| P4-G3 | P4 | Config update semantics: atomic version, generation pinning, no interruption, version-scoped disposal, validation/rollback (runtime §5) | Active | runtime §5; P4.1 WYSIWYG only — private runtime pending |
| P4-G4 | P4 | WYSIWYG acceptance evidenced (runtime §5.4) | Active | `CanonicalConfigService` P4.1; full R11-R14 observation pending |
| P4-G5 | P4 | P4.4 source removal proves removed-feature initialization absent and records deltas (LOCK-PERF-3, runtime §10) | Active | §6 rows; [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) |
| P4-G6 | P4 | Each legacy effective-config source proven inactive; active set is closed taxonomy only (runtime §3.1/§8.1) | Active | §6; P4.3 cutover complete, P4.4 rows residual |
| P4-G7 | P4 | Failure/Outcome/Recovery contract evidence recorded (runtime §7.2, R11-R14) | Active | [doc: evidence/p4.2-r11-r14-contract-evidence.md](evidence/p4.2-r11-r14-contract-evidence.md) pure modules only — no production wiring |
| P4-G8 | P4 | Storage foundation and cutover landed (ADR-0005, storage §5-8, R15-R17) — S0-S5 offline only, offline archive, zero-state gate | Active | S0-S5 Complete offline; production cutover and retention wiring pending |
| P4-G9 | P4 | CLI/TUI/Console products and public interfaces deleted (LOCK-009) | Active | P4.5 Not started |

Completed P4 gates (one-line pointers): Permission evaluator restrictive stack — bounded spec + bounded production-path subgate MET via `permission/evaluator.ts` + [doc: evidence/p4-permission-evaluator-semantics.md](evidence/p4-permission-evaluator-semantics.md) + [test: packages/opencode/test/permission/r18-production-path.test.ts](../../packages/opencode/test/permission/r18-production-path.test.ts) ([doc: evidence/r18-production-path-evidence.md](evidence/r18-production-path-evidence.md)); full implementation/test gate remains OPEN (R18 — see §7 R18 status; H-6) — no transport/P4.4 closure claimed; Legacy-reader cutover at P4.3 — MET (2026-08-25) via [doc: evidence/p4.3-cutover-evidence.md](evidence/p4.3-cutover-evidence.md); Lifecycle-boundary convergence (five boundaries) — MET (2026-08-22/23) via [doc: evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/](evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/) and [doc: evidence/p0-baseline/2026-08-23T13-59-07Z-r9-observation/](evidence/p0-baseline/2026-08-23T13-59-07Z-r9-observation/).

| ID | Phase | Gate | Status | Evidence pointer |
|---|---|---|---|---|
| P4.4-G1 | P4.4 | 13 legacy effective-config source classes per-row inactive proofs (runtime §8.1) | Active/residual | §6 table; [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) |
| P4.4-G2 | P4.4 | Residual machinery removal: convergence, preset provider loaders/catalog, backend-gated fetch chain | Active/residual | matrix rows 9-11; T1b-T23 deltas |
| P4.4-G3 | P4.4 | Transport narrowing: private transport; SDK/public server ceases to be public | Active | LOCK-009 bridge remains; T1a/T31 health poll removed |
| P4.4-G4 | P4.4 | `tui-migrate.ts` + `Flag.KILO_TUI_CONFIG` deleted; canonical TUI loader only | Active/open | [test: packages/opencode/test/kilocode/p4-4-tui-canonical-source-removal.test.ts](../../packages/opencode/test/kilocode/p4-4-tui-canonical-source-removal.test.ts) (row remains open per LOCK-001; residual) |

| ID | Phase | Gate | Status | Evidence pointer |
|---|---|---|---|---|
| P4.5-G1 | P4.5 | Old CLI/server product deletion (CLI/TUI/Console) | Not started | — |
| P5-G1 | P5 | Selectors render/interactive from persisted indexes while worker not started/unavailable (runtime §6 c1) | Not started | — |
| P5-G2 | P5 | Selecting never disabled by runtime readiness; action-gated individually (c2) | Not started | — |
| P5-G3 | P5 | Reconciliation preserves selector availability; no worker-readiness regression (c3) | Not started | — |
| P5-G4 | P5 | Structural absence of `extensionDataReady`/port/health/SSE fetch chain after P4.4/P4.5 (c4) | Not started | — |
| P5-G5 | P5 | Worker-withheld/killed/failed scenario + paint-before-ready timing (c5) | Not started | — |
| P5-G6 | P5 | Cold/warm UI vs runtime readiness distinguished (c6) | Not started | — |
| P5-G7 | P5 | Every pending reconstruction candidate receives `rebuild` or `drop` (LOCK-015) | Not started | §6.4 |

## 5. Capability Parity

Target-surface criterion per `agent-orchestration-direction.md` §6. Statuses: `Proven at P2` means current-behavior capability on migration bridge; final-parity contracts (typed-manifest, policy stack, WYSIWYG) gate at P4. Archive holds per-H falsifiable paths for P2/P3.2/P3.4 re-proofs.

| ID | Capability | Status | Evidence pointer |
|---|---|---|---|
| H-1 | Custom agents | Proven at P2 (2026-08-15); typed-manifest gates at P4 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/) |
| H-2 | Sub-task delegation | Proven at P2 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/) |
| H-3 | Extensible tools | Proven at P2 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/) |
| H-4 | Skills | Proven at P2 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/) |
| H-5 | MCP | Proven at P2 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/) |
| H-6 | Permission/question flows | Proven at P2 (current behavior); restrictive stack gates at P4 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/) + [doc: evidence/p4-permission-evaluator-semantics.md](evidence/p4-permission-evaluator-semantics.md) + [doc: evidence/r18-production-path-evidence.md](evidence/r18-production-path-evidence.md) |
| H-7 | Parent-child sessions | Proven at P2 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-completed/) |
| H-8 | Background/parallel execution | Proven at P2; re-evidenced at P3.2 | [doc: evidence/p0-baseline/p3-2-final-2026-08-16T03-09-32-000Z/](evidence/p0-baseline/p3-2-final-2026-08-16T03-09-32-000Z/) |
| H-9 | User-selected custom-provider models | Proven at P2 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-session/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-session/) |
| H-10 | Persistence | Proven at P2; re-proved at P4.2 (2026-08-22) | [doc: evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/](evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/) |
| H-11 | Lifecycle correctness (five boundaries) | Proven at P2; re-proved at P4.2 | [doc: evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/](evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/); [doc: evidence/p0-baseline/2026-08-23T13-59-07Z-r9-observation/](evidence/p0-baseline/2026-08-23T13-59-07Z-r9-observation/) |
| H-12 | Checkpoint rollback (SessionRevert+Snapshot) | Proven at P2; re-evidenced at P3.2 | [doc: evidence/p0-baseline/p3-2-final-2026-08-16T03-09-32-000Z/](evidence/p0-baseline/p3-2-final-2026-08-16T03-09-32-000Z/) |
| H-13 | Internal context-overflow safeguard | Proven at P2; re-proved at P3.4 | [doc: evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-overflow/](evidence/p0-baseline/2026-08-15T08-35-00Z-p2/real-overflow/); [test: packages/opencode/test/kilocode/p3-4-removal-absence.test.ts](../../packages/opencode/test/kilocode/p3-4-removal-absence.test.ts) |

## 6. Removal And Reconstruction Index

Product removals: completed rows are aggregated; per-category detail lives in archive and `p0-current-state-inventory.md` §5. Effective-config and storage rows list only active/residual/open rows; completed rows are aggregated with a pointer.

### 6.1 Product removals — completed (aggregate pointer)

All LOCK-001/002/003/004 rows are **Complete** with per-category evidence. Detail in archive [migration-tracker-history-2026-08-28.md](archive/migration-tracker-history-2026-08-28.md) §7 and evidence/p0-baseline/p3-1..p3-4 campaigns. No row reclassified as deferred.

| Removal | LOCK | Phase | Disposition |
|---|---|---|---|
| Ordinary single-chat sidebar | LOCK-001 | P3.1 Complete 2026-08-15 | Complete |
| Worktree infrastructure | LOCK-002 | P3.2 Complete 2026-08-16 | Complete |
| Custom Diff Viewer surfaces | LOCK-002 | P3.2 Complete 2026-08-16 | Complete |
| Cloud sessions | LOCK-003 | P3.3 Complete 2026-08-16 | Complete |
| JetBrains | LOCK-003 | P3.3 Complete 2026-08-16 | Complete |
| Console | LOCK-003 | P3.3 Complete 2026-08-16 | Complete |
| KiloClaw | LOCK-003 | P3.3 Complete 2026-08-16 | Complete |
| Indexing | LOCK-004 | P3.4 Complete 2026-08-17 | Complete |
| Project memory | LOCK-004 | P3.4 Complete 2026-08-17 | Complete |
| User-visible context management/compaction | LOCK-004 | P3.4 Complete 2026-08-17 | Complete |
| Autocomplete | LOCK-004 | P3.4 Complete 2026-08-17 | Complete |

### 6.2 Effective-config source removal — active/residual (P4.4, Active/residual)

13 classes per runtime §8.1. Each row maps one P0 enumerated source to a retained legal class or removal class. Archive §7 preserves pre-cutover source/tests/docs evidence; matrix [evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) is the source of truth for per-row evidence. No row is marked complete beyond its stated disposition; do not silently reclassify.

| ID | Source class (runtime §8.1) | Disposition | Evidence pointer |
|---|---|---|---|
| S1 | `KILO_CONFIG` env override | residual — `Flag.KILO_CONFIG` deleted P4.4-T13/T21 | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 1 |
| S2 | `KILO_CONFIG_DIR` env override | residual — `ConfigPaths` global-only; TUI no `KILO_CONFIG_DIR` reader (T27-T30) | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 2 |
| S3 | `KILO_CONFIG_CONTENT` env override | residual — wrapper `KILO_CONFIG_CONTENT` forwarding deleted P4.4-T9/T21 | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 3 |
| S4 | `KILO_PERMISSION` env override | residual — `Flag.KILO_PERMISSION` deleted T21; sandbox deny preserved | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 4 |
| S5 | Legacy `opencode.*` keys, `.opencode`/`.kilocode` locations | residual — `ConfigPaths` `.kilocode` removed T14; helper deleted 2026-08-27 | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 5 |
| S6 | Global project-asset sources | residual — `primary-worktree.ts` deleted P4.4-T2 | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 6 |
| S7 | Ancestor directory walks | residual — ancestor walk + dead guard removed T16; TUI legacy walk removed T27 | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 7 |
| S8 | Primary-worktree mirror reads | removed (helper deleted 2026-08-25) — residual P4.4 remains open per LOCK-001 | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 8 |
| S9 | Cloud/org/managed config sources | residual — `managed.ts`/`well-known`/`metadata`/`bundled`/`model-cache` removed T3-T23; LOCK-006 remains open | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 9 |
| S10 | Top-level `mode`/`tools` conversions | residual — wrapper `mergeConfig` deleted T9 | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 10 |
| S11 | Arbitrary CLI/env override layers | residual — wrapper forwarding deleted T9; sandbox deny preserved | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 11 |
| S12 | Legacy global config filenames/readers | residual/open — `tui-migrate.ts` + `Flag.KILO_TUI_CONFIG` deleted 2026-08-27 (row remains open per LOCK-001) | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 12 |
| S13 | Legacy migration readers/import tooling | residual/open — extension importer/Roo + TUI helper deleted 2026-08-27 (row remains open per LOCK-001) | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) row 13 |

Inactive proof for S1-S13: [test: packages/opencode/test/kilocode/p4-3-cutover.test.ts](../../packages/opencode/test/kilocode/p4-3-cutover.test.ts) canonical-loader absence + `ConfigPaths` global-only (`unique([Global.Path.config])`) and T27-T30 TUI canonical loader (`resolveWorktree`/`canonicalRoot` + `ConfigPaths.fileInDirectory`) — full detail in matrix. P4.3 cutover deleted legacy readers together (no dual-read); P4.4 records per-row evidence.

### 6.3 Legacy storage / sync removals — active (P4.4/P4.5)

| ID | Removal | Phase | Disposition |
|---|---|---|---|
| ST1 | Multi-client sync/warp replay (`/sync/history`, `/sync/replay`, `/sync/steal`, live SSE sync) | P4.4/P4.5 | Active/open |
| ST2 | Old-peer capability negotiation / released-client storage compatibility | P4.4/P4.5 | Active/open |
| ST3 | Unbounded full-payload event log as authoritative history | P4.4/P4.5 | Active/open |
| ST4 | Legacy storage writers/readers (event-log full-snapshot writers, legacy `session/` prefixes) | P4.4/P4.5 | Active/open |

### 6.4 Reconstruction candidates

Pending entries must receive `rebuild` or `drop` before P5 (LOCK-015). `drop` entries are evidence preservation only.

| ID | Behavior | Disposition | Pointer |
|---|---|---|---|
| RC-P3.1-001 | Sidebar-title button telemetry `TITLE_BUTTON_CLICKED` | drop | [archive §7](archive/migration-tracker-history-2026-08-28.md) |
| RC-P3.2-001 | Root-local one-click run script subsystem | drop | [archive §7](archive/migration-tracker-history-2026-08-28.md) |
| RC-P3.2-002 | Sibling-worktree `kilo_local_recall` family | drop | [archive §7](archive/migration-tracker-history-2026-08-28.md) |
| RC-P3.2-003 | Agent Manager overview/targeted-prompt bridge + list-prompt request-reply | drop | [archive §7](archive/migration-tracker-history-2026-08-28.md) |
| RC-P4.4-001 | Legacy effective-config source-inventory diagnostics `/config/sources` | drop | [doc: evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md), [archive §7](archive/migration-tracker-history-2026-08-28.md) |

Observed candidates (not yet displaced, no disposition): partial-output auto-continuation (`session/prompt/auto-continue.ts`); elapsed session timer display (`agent-manager/session-timing.ts`, `WorkingIndicator.tsx`). See archive §7.

## 7. Decisions And Risks

### 7.1 Open decisions

Resolved R/Q point to archive and durable specs; they are not repeated here.

| ID | Question | Owner | Required by | Status |
|---|---|---|---|---|
| Q5 | Which consolidated configuration surface replaces settings/profile/marketplace panels, and how does it present custom provider records? | Hub | P3/P4.1 | Open |
| R3 | Numeric startup SLA | Hub | P5 | Open |

Resolved: Q1 (2026-08-14), Q2/Q4/R4 (2026-08-15), Q3/R1/R2/R5/R6/R8 (2026-08-12), R7 (2026-08-14), R10 (2026-08-18), R11-R14 (2026-08-23), R15-R17 (2026-08-20), R9 (2026-08-23), R18 (2026-08-24 bounded spec + bounded production-path subgate; implementation/test gate remains open) — see archive §9 and `runtime-and-configuration-direction.md` §9.

R18 status: specification [doc: evidence/p4-permission-evaluator-semantics.md](evidence/p4-permission-evaluator-semantics.md) complete; bounded production-path integration [test: packages/opencode/test/permission/r18-production-path.test.ts](../../packages/opencode/test/permission/r18-production-path.test.ts) 12 pass (`Global.Path.config` + `<workspace>/.kilo/` → `Permission.ask` → `evaluator` → `provenance`) — no transport/P4.4 closure claimed; gate remains open pending full matrix.

### 7.2 Active risks / blockers

Active risks only; resolved/closed rows point to archive §10. `Monitored` = known condition tracked; `Open` = blocks a gate.

| Date | Phase | Risk | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| 2026-08-10 | All | Removed features remain implemented for P4.4/P4.5 | Cleanup scope misread as retained | Removal inventory §6 + P4 gates; LOCK-013 | Manifestor | Monitored |
| 2026-08-10 | P4 | Dual authority could outlive bridge | Contract drift | P4.3 atomic cutover (R6), P4.5 deletion | Manifestor | Monitored |
| 2026-08-10 | P4 | Config authority change could interrupt active generations | Snapshot instability | Atomic version + pinning (LOCK-011, runtime §5) | Manifestor | Monitored |
| 2026-08-10 | P5 | Selector gated on backend could regress | Startup degraded | Persisted indexes before worker readiness (LOCK-012) | Manifestor | Monitored |
| 2026-08-10 | P3-P5 | Removed features might still initialize at startup | Startup not declining | Structural absence per subphase + deltas (LOCK-PERF-3) | Manifestor | Monitored |
| 2026-08-13 | P1-P5 | Presentation vs runtime facts diverge across five boundaries | Stale presentation, orphans | Runtime authority (runtime §7.1); convergence per phase; R9 | Manifestor | Monitored |
| 2026-08-13 | P4 | Source competition / dual-read permanence | Effective config merges from removed sources | Closed taxonomy/registry (runtime §3); per-row proofs §6 | Manifestor | Monitored |
| 2026-08-13 | P4 | File and UI config divergence | Lost edits / broken WYSIWYG | Bidirectional contract (runtime §5.4); P4.1 gate | Manifestor | Monitored |
| 2026-08-14 | P1-P5 | Unrecorded feature loss | Displaced behavior with no trail | Just-in-time candidate registration (LOCK-015) §6.4 | Manifestor | Monitored |
| 2026-08-14 | P4 | DB exhaustion (~24.56 GB, ~7.5 GB/7d, ~91-92% disk) before cutover | Disk exhaustion before P4.2a | Containment manual; P4.2a canonical empty DB (ADR-0005) | Manifestor | Monitored |
| 2026-08-15 | P5 | Reconciliation could reintroduce worker dependency or P5 exits without scenario | Selector UX regresses | P5 criteria c1-c6 + structural absence (runtime §6) | Manifestor | Monitored |

Resolved risks (pointers): performance estimates, OOM, stderr tail, benchmark drift, contamination/copy-race, P2 parity overclaims, P3 delta misreads, baseline baselines — see archive §10. Storage legacy metric rows (2026-08-14 ~24.56 GB etc.) preserved in storage spec §2.2 and archive §8.

## 8. Evidence And Links

Canonical sources of truth (durable). This index links; it does not duplicate.

| Kind | Path | Role |
|---|---|---|
| ADR | [specs/adr/0002-focus-vscode-on-agent-orchestration.md](../adr/0002-focus-vscode-on-agent-orchestration.md) | Product boundaries LOCK-001..008 |
| ADR | [specs/adr/0003-replace-cli-configuration-with-private-gui-runtime.md](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md) | Runtime/config LOCK-009..012, R2/R6/R10 |
| ADR | [specs/adr/0004-architecture-first-direct-reconstruction.md](../adr/0004-architecture-first-direct-reconstruction.md) | Principle-first LOCK-014/015 |
| ADR | [specs/adr/0005-bounded-private-runtime-storage.md](../adr/0005-bounded-private-runtime-storage.md) | Storage LOCK-016/017, R15-R17 |
| Direction | [specs/vscode-orchestrator/agent-orchestration-direction.md](agent-orchestration-direction.md) | Product target, H-1..H-13, P3 inventory, lifecycle §11 |
| Direction | [specs/vscode-orchestrator/runtime-and-configuration-direction.md](runtime-and-configuration-direction.md) | Runtime/config target §3-7, storage §5-8, decisions §9 |
| Inventory | [specs/vscode-orchestrator/p0-current-state-inventory.md](p0-current-state-inventory.md) | P0 residue (§5), baseline counts (§4.4/§9) |
| Evidence | [specs/vscode-orchestrator/evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) | 13-row source-removal matrix (P4.4 source of truth) |
| Evidence | [specs/vscode-orchestrator/evidence/p4.3-cutover-evidence.md](evidence/p4.3-cutover-evidence.md) | P4.3 atomic cutover proof |
| Evidence | [specs/vscode-orchestrator/evidence/p4.3-pre-cutover-reconciliation-checklist.md](evidence/p4.3-pre-cutover-reconciliation-checklist.md) | Manual reconciliation (15→4/13 mapping) |
| Evidence | [specs/vscode-orchestrator/evidence/p4-permission-evaluator-semantics.md](evidence/p4-permission-evaluator-semantics.md) | R18 spec-only semantics (ceiling catalog) |
| Evidence | [specs/vscode-orchestrator/evidence/p4.2-r11-r14-contract-evidence.md](evidence/p4.2-r11-r14-contract-evidence.md) | R11-R14 pure-module contracts |
| Evidence | [specs/vscode-orchestrator/evidence/p4.4-t19-runtime-evidence.md](evidence/p4.4-t19-runtime-evidence.md) | P4.4 T13-T18 runtime observations |
| Evidence | [specs/vscode-orchestrator/evidence/r18-production-path-evidence.md](evidence/r18-production-path-evidence.md) | R18 production-path 12-test integration |
| Archive | [specs/vscode-orchestrator/archive/migration-tracker-history-2026-08-28.md](archive/migration-tracker-history-2026-08-28.md) | Full verbatim history to 2026-08-28 (1,879 lines, ~625 KB) |

Provenance / update record (compact — authoritative schema: `Date`, `ID`, `Status`, `Change`, `Evidence`, `Impact/next action`; `Commit` is optional provenance metadata):

| Date | ID | Status | Change | Evidence | Impact/next action | Commit |
|---|---|---|---|---|---|---|
| 2026-08-28 | P4.4 | Active/residual | Remove unused `SyncEvent` import from `packages/opencode/src/server/routes/instance/httpapi/server.ts` (no runtime/behavior change; sync routes/handlers, EventV2/EventV2Bridge, storage, SDK/OpenAPI, V2 permission rules preserved) | [doc: packages/opencode/src/server/routes/instance/httpapi/server.ts](../../packages/opencode/src/server/routes/instance/httpapi/server.ts), `bunx prettier --check packages/opencode/src/server/routes/instance/httpapi/server.ts specs/vscode-orchestrator/migration-tracker.md` + `grep -rn SyncEvent packages/opencode/src/server/routes/instance/httpapi/server.ts` (no remaining reference) | P4.4 remains Active/residual; ST1-ST4 remain open; no phase/row/P4.5/P5 closure; no sync/storage/SDK/OpenAPI/V2 permission change | — |
| 2026-08-28 | P4.4 | Active/residual | legacy V1/CLI plan-mode `.opencode/plans/*.md` allow removed (`packages/opencode/src/kilocode/agent/index.ts`, `packages/opencode/src/agent/agent.ts`); canonical `.kilo/plans`, `plans`, `.plans`, global data plan path preserved; core V2 `packages/core/src/plugin/agent.ts` `.opencode/plans` allow remains separate residual not changed | [test: packages/opencode/test/agent/agent.test.ts](../../packages/opencode/test/agent/agent.test.ts) | P4.4 remains Active/residual; no row/phase/P4.5/P5 closure; no sync/warp/provider/catalog/DB change; core V2 plan permission separately tracked as residual follow-up | — |
| 2026-08-28 | P4.4 | Active/residual | legacy `opencode-${safe}.db` fallback observability (warn + regression hardening; no behavior/migration/copy) | [test: packages/core/test/database-fallback-observability.test.ts](../../packages/core/test/database-fallback-observability.test.ts), [test: packages/opencode/test/kilocode/storage/db-fallback-observability.test.ts](../../packages/opencode/test/kilocode/storage/db-fallback-observability.test.ts) | P4.4 remains Active/residual; fallback measured before deprecation decision; no row/phase/P4.5/P5 closure; no sync/warp/provider/catalog change | — |
| 2026-08-28 | P4.4 | Active/residual | `permission-dock-utils.ts` `.kilocode`/`opencode.*` removed; canonical `.kilo` only | [test: packages/kilo-vscode/tests/unit/permission-dock-utils.test.ts](../../packages/kilo-vscode/tests/unit/permission-dock-utils.test.ts) | P4.4 remains Active/residual; no row/phase closure | `75678ba8e7` |
| 2026-08-28 | P4.4 | Active/residual | `detectOpencodeConfig`/`opencodeConfigNotification` scanner removed | [test: packages/opencode/test/kilocode/p4-4-legacy-filesystem-discovery-removal.test.ts](../../packages/opencode/test/kilocode/p4-4-legacy-filesystem-discovery-removal.test.ts) | P4.4 remains Active/residual; no row/phase closure | `70d0e8922e` |
| 2026-08-28 | P4.4 | Active/residual | `config-paths.ts` `opencode.*` removed | [test: packages/opencode/test/kilocode/permission/config-paths.test.ts](../../packages/opencode/test/kilocode/permission/config-paths.test.ts) | P4.4 remains Active/residual; no row/phase closure | `bc54a7781a` |
| 2026-08-28 | R18 | Active | R18 bounded production-path 12-test integration | [test: packages/opencode/test/permission/r18-production-path.test.ts](../../packages/opencode/test/permission/r18-production-path.test.ts) | Bounded spec + bounded production-path subgate MET; full implementation/test gate remains open (see §7) | `01b7a46bfc` |
| 2026-08-25 | P4.3 | Complete | Atomic legacy-reader deletion (no dual-read) | [doc: evidence/p4.3-cutover-evidence.md](evidence/p4.3-cutover-evidence.md) | P4.3 Complete; P4.4 remains Active/residual | — |
| 2026-08-23 | R9 | Complete | Five-boundary observation convergence | [doc: evidence/p0-baseline/2026-08-23T13-59-07Z-r9-observation/](evidence/p0-baseline/2026-08-23T13-59-07Z-r9-observation/) | R9 Resolved; P4.2 remains Active | — |
| 2026-08-22 | P4.2 | Complete | H-10/H-11 post-cutover convergence | [doc: evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/](evidence/p0-baseline/2026-08-22T09-00-53Z-p4.2-h10h11/) | H-10/H-11 convergence MET; P4 remains Active | — |
| 2026-08-21 | P4.2a | Complete | Storage cutover S0-S5 offline | [doc: ../storage/session-storage-rewriting.md](../storage/session-storage-rewriting.md) §7/§8.1; [test: packages/opencode/test/storage/s0-baseline-measurement.test.ts](../../packages/opencode/test/storage/s0-baseline-measurement.test.ts), [test: packages/core/test/changefeed-s4.test.ts](../../packages/core/test/changefeed-s4.test.ts), [test: packages/opencode/test/cutover-s5-production.test.ts](../../packages/opencode/test/cutover-s5-production.test.ts) (representative S0/S4/S5); full checklist/provenance [doc: archive/migration-tracker-history-2026-08-28.md](archive/migration-tracker-history-2026-08-28.md) | S0-S5 Complete offline; P4 remains Active (H-10/H-11 convergence separate); no new execution claimed | — |
| 2026-08-18 | P4.1 | Complete | File-authoritative GUI config | [test: packages/kilo-vscode/tests/unit/config-audit-blockers.test.ts](../../packages/kilo-vscode/tests/unit/config-audit-blockers.test.ts), [test: packages/kilo-vscode/tests/unit/config-audit-closure.test.ts](../../packages/kilo-vscode/tests/unit/config-audit-closure.test.ts), [doc: packages/kilo-docs/pages/contributing/architecture/vscode-extension.md#canonical-config-p4-1](../../packages/kilo-docs/pages/contributing/architecture/vscode-extension.md#canonical-config-p4-1); full 606-test checklist/provenance [doc: archive/migration-tracker-history-2026-08-28.md](archive/migration-tracker-history-2026-08-28.md) | P4.1 Complete; P4 remains Active (P4.2-P4.5 pending); no new execution claimed | — |

Historical provenance before 2026-08-18: see archive §11 change log.

## 9. Standardized Write Rules

These rules govern all future writes to this tracker. Violations are scope violations.

1. One update unit per entry: one bounded work unit = one index entry. Do not batch unrelated phases/rows.
2. Required fields per entry (authoritative schema — single source, used in §8 provenance and §9 template): `Date` (YYYY-MM-DD), `ID` (Gate/Phase/Row/Candidate, e.g. `P4.4-G1`, `S5`, `RC-P4.4-002`, `R18`), `Status` (allowed values below), `Change` (one sentence + scope), `Evidence` (explicit `test:` and/or `doc:` pointer(s) — at least one of `test: <package-qualified path>` or `doc: <path>` when evidence exists; bare `TBD`/`-` means no evidence), `Impact/next action` (what remains open, no silent closure). `Commit` is optional provenance metadata in §8 only and never substitutes for required fields.
3. Allowed statuses (phase/row): `Not started`, `Active`, `Blocked`, `Complete`, `Deferred`, `Reconstruction candidate`. Qualified display labels `Active/residual` and `Active/open` map to base `Active` and are not new vocabulary (see §1 Scope note). Scoped decision/risk labels `Open`/`Monitored`/`Resolved` (§7) and gate qualifiers `open`/`MET` (bounded subgate) are orthogonal and do not extend the phase/row status vocabulary.
4. Pointer-over-prose: link to durable evidence/ADRs/specs; do not duplicate narrative, matrices, or metrics. Completed phase detail is a one-line pointer, not a narrative.
5. No repeated lock boilerplate: reference lock IDs (e.g. `LOCK-001`); do not restate lock text.
6. No duplicate evidence tables: the matrix `evidence/p4.4-source-removal-evidence-matrix.md` owns per-row evidence; this index owns status and pointer.
7. No performance claims without objective evidence: `LOCK-PERF-6`; descriptive stats only with explicit scope/provenance; no invented thresholds (R7).
8. Archive policy: superseded index entries are moved verbatim to `archive/migration-tracker-history-2026-08-28.md` or a future dated slice; historical content is never deleted without verbatim archival. Keep the canonical path `specs/vscode-orchestrator/migration-tracker.md` as the concise index. Future slices use exact path `archive/migration-tracker-history-YYYY-MM-DD.md`; header must state historical snapshot and pointer to canonical `migration-tracker.md`; content is verbatim preservation of superseded index text (no rewrite); slice is immutable after creation; same change must add the slice to §10 Archive Map.
9. Bounded current-state amendment format (when a bounded unit closes — includes all required fields):
   ```
   Current-state amendment — Date: YYYY-MM-DD | ID: <ID> | Status: <status> | Change: <one-sentence change> — <scope> | Evidence: test: <path>, doc: <path> | Impact/next action: <what remains open>
   ```
   Example (includes all required fields; `Commit` optional in §8): `Date: 2026-08-28 | ID: R18 | Status: Active | Change: bounded production-path integration | Evidence: test: packages/opencode/test/permission/r18-production-path.test.ts, doc: evidence/r18-production-path-evidence.md | Impact/next action: bounded subgate MET; full gate remains open`. Amendment lives as the latest row in §8 provenance, not as a preamble block. Preamble blocks of 45 historical amendments are archived.
10. Verification before claim: `git diff --check`, markdown table padding check on changed files, and for UI-affecting changes browser verification per manifestor principles. No phase marked `Complete` without evidence recorded in §8.
11. Stable identifiers preserved: statuses, phases P0-P5/P3.1-P3.4/P4.1-P4.5, capability IDs H-1..H-13, storage/runtime IDs S0-S5/R1-R18, decision locks, removal IDs S1-S13/ST1-ST4, reconstruction IDs RC-*.
12. Link convention (compact): in tables use `[test: <package-qualified path>](../../packages/<...>)` and `[doc: <path>](<relative path>)` with repository-relative package-qualified paths for tests and valid relative Markdown links for local docs/tests; keep one link per evidence item and reference the canonical §8 table or matrix where repetition would bloat the index. Unresolvable local pointers must be marked explicit unresolved pointer, not guessed.
13. Do not change technical implementation or evidence contents in this tracker change; this tracker changes governance and references only (LOCK-005).

### 9.1 Migration-scoped commit batching (P4.4/P4.5/P5 only — not repository-wide)

This subsection applies only to this VS Code orchestrator migration (future P4.4/P4.5/P5 work) and is not repository-wide Git policy.

- Group implementation, callers, tests, generated artifacts, and tracker evidence by one substantive cohesive behavior or residual boundary.
- Do not give isolated mechanical cleanup (unused import, single constant, comment) a standalone migration commit; include it with its owning substantive batch.
- Do not batch unrelated phases or rows.
- Tracker entries and Git commits are independent: one entry may span implementation, audit-fix, and validation commits, and related work may share a commit when it remains one cohesive boundary.
- Create a migration commit when the batch produces a recognizable behavior change, materially advances a row/gate, or completes a cohesive residual package.
- Existing tracker write rules, evidence requirements, and architecture/quality gates remain authoritative.

## 10. Archive Map

What moved to [archive/migration-tracker-history-2026-08-28.md](archive/migration-tracker-history-2026-08-28.md) (verbatim, 1,879 lines):

- 45 current-state amendment preambles (2026-08-25 through 2026-08-28 bounded units) — now superseded; provenance summarized in §8.
- Repeated phase narratives and per-phase checklists for P0-P3.4 and P4.1/P4.2a/S0-S5 — now one-line pointers in §3/§4.
- Duplicated effective-config 13-row matrix detail — now owned by [evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) with status pointers in §6.2.
- Repeated performance metric rows and storage baseline duplication — now owned by [p0-current-state-inventory.md](p0-current-state-inventory.md) and [storage/session-storage-rewriting.md](../storage/session-storage-rewriting.md); §6.1 aggregates completed product removals.
- Verbose change log (2026-08-10 to 2026-08-28, ~80 rows) — now compact provenance in §8; full log in archive §11.
- Resolved decisions/risks detail (Q1-Q4, R1-R17) — now pointers in §7; full text in [runtime-and-configuration-direction.md](runtime-and-configuration-direction.md) §9 and archive §9/§10.

Future slices: `archive/migration-tracker-history-YYYY-MM-DD.md` per §9 rule 8 — header with historical snapshot + pointer to canonical [migration-tracker.md](migration-tracker.md), verbatim preservation, immutable after creation, and added to this map in the same change.

How to find historical content:

| Historical interest | Where to find |
|---|---|
| Full prior tracker text | [archive/migration-tracker-history-2026-08-28.md](archive/migration-tracker-history-2026-08-28.md) (verbatim) |
| Completed phase exit evidence | Archive §5 (P0-P3.4, P4.1) + evidence directories cited in §8 |
| P4.2a S0-S5 work-unit detail | Archive §5 (P4 checklist S0-S5) |
| Effective-config per-row evidence | [evidence/p4.4-source-removal-evidence-matrix.md](evidence/p4.4-source-removal-evidence-matrix.md) + archive §7 |
| Historical amendments (2026-08-25..28) | Archive top preambles (45 entries) |
| Old performance metrics / storage snapshots | Archive §8 + [p0-current-state-inventory.md](p0-current-state-inventory.md) |
| Resolved decisions (Q1-3, R1-17) | [runtime-and-configuration-direction.md](runtime-and-configuration-direction.md) §9 + archive §9 |
| Resolved risks | Archive §10 |
| Change log | Archive §11 |
