# VS Code Agent Orchestrator - Migration Tracker

Mutable progress and evidence tracker for the VS Code Agent Orchestrator
migration. Durable decisions stay in [ADR-0002](../adr/0002-focus-vscode-on-agent-orchestration.md)
and [ADR-0003](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md);
product target and acceptance semantics stay in
[`agent-orchestration-direction.md`](agent-orchestration-direction.md); runtime
and configuration target and acceptance semantics stay in
[`runtime-and-configuration-direction.md`](runtime-and-configuration-direction.md).
This tracker owns changing phase status, evidence, blockers, issue/PR links, and
next actions.

## Session Bootstrap

A fresh session on this work continues from the durable artifacts, not from this
tracker alone: read [ADR-0002](../adr/0002-focus-vscode-on-agent-orchestration.md),
[ADR-0003](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md),
[ADR-0004](../adr/0004-architecture-first-direct-reconstruction.md), and
[ADR-0005](../adr/0005-bounded-private-runtime-storage.md) (bounded
private-runtime canonical storage foundation; supersedes ADR-0001's
checkpoint + resync / multi-client transport target) for the locked decisions,
the [direction spec](agent-orchestration-direction.md) for product target,
ownership, and acceptance semantics, the
[runtime spec](runtime-and-configuration-direction.md) for runtime/config
semantics including the file-authoritative hybrid — the legal source taxonomy
(two canonical authored scopes: one global config root and
`<workspaceRoot>/.kilo/`), field registry, typed composition, materialization,
the bidirectional file-editing/WYSIWYG contract, permission composition, and
source-removal disposition (runtime spec sections 3, 5.1-5.4, 8.1) — plus the
runtime observation and hydration contract (runtime spec section 7.1), the
bounded Failure/Outcome/Recovery target (runtime spec section 7.2 — an
independently valuable P4.2 foundation, with post-reconstruction error maturity
separately scoped in section 7.3 and the R11-R14 bounded implementation
decisions in section 9), the storage foundation integration (ADR-0005; the
[storage spec](../storage/session-storage-rewriting.md) — current state,
operational containment, target model, P4.2a storage work units S0..S5,
cutover, gates/tests; R15-R17 bounded in runtime spec section 9), the
no-threshold performance comparison policy (R7
resolved 2026-08-14; runtime spec sections 9-10), and the
atomic legacy-reader cutover at P4.3 (no dual-read window, no import; runtime
spec sections 7, 9 R6). This tracker then supplies current progress truth: P0 is
Complete (2026-08-12) with recorded evidence; R2 and R6 were revised by a
post-P0 user clarification on 2026-08-13 (section 9); R7 resolved 2026-08-14
(section 9); R15-R17 added open 2026-08-14, required by P4.2 and not P1-P3
blockers (section 9); P1-P5 are Not started. No
phase claims completion without objective evidence recorded in the sections
below.
Lifecycle-boundary convergence evidence is a per-phase acceptance input
(direction spec section 11), observed under the runtime observation contract
(runtime spec section 7.1): P1 records the extension-owned view boundaries
(panel close/reopen, reload, session switch) on the migration bridge; P2
records the complete five-boundary behavior (those three plus transport
reconnect and worker restart) on harness-parity flows; P4 records all five
against the private-worker observation surface. R9 (runtime spec section 9) is
the open bounded implementation decision required by P4.2 only — not a P1-P3
blocker; testing current
behavior at P1/P2 does not require deciding future private handshake mechanics.

## 1. Purpose And Maintenance Rules

Purpose:

- Record, per phase, the scope, status, exit checklist, and the objective evidence
  that gates completion (issue/PR/test/doc links).
- Keep the ADRs and the direction specs durable: they are not edited to record
  progress.
- Make the migration auditable over time: any reader can see what is done, what is
  proven, what is blocked, and what is next, including the removal inventory and
  the runtime/config migration evidence.

Maintenance rules:

- This tracker is the source of truth for phase status, evidence, blockers, issue/PR
  links, and next actions. The ADRs and the direction specs are not updated to
  record progress.
- No phase is marked `Complete` without objective exit evidence recorded here. A
  checkbox without a link/ID is not evidence.
- Status changes, evidence additions, metric updates, risk log entries, and change
  log entries for a given phase ship in the same change that the phase ships.
- Every entry records a date. Evidence fields use the formats: `issue: #NNN`,
  `PR: #NNN`, `test: <path>`, `doc: <path>`.
- When evidence is a link, the field holds the concrete issue/PR/test/doc
  reference; a bare "TBD" or "-" means no evidence exists.
- Open decisions carry an owner and a required-by phase (section 9); they stay open
  until the hub decides. No phase may exit while a decision it requires is open.
- Do not claim capability parity, baseline counts, removals, or reductions that
  have no recorded evidence.
- No performance claim is accepted without runtime evidence (LOCK-PERF-6); all
  performance metrics stay `Not proven` until measurements with evidence links
  are recorded here. Estimates are hypotheses, never acceptance claims.
- Removed features are never reclassified as deferred; a removal row's evidence
  categories must be filled for every category that exists for the item.
- The migration is principle-first, not inventory-first (LOCK-014): no
  exhaustive pre-migration feature list and no complete suspension registry are
  required before P1/P2/P4 begin; legacy features/behaviors are disposed just in
  time when implementation first touches them, and this tracker never pretends a
  feature is already disabled.
- The two closed sets are non-negotiable (LOCK-014): final required capabilities
  (ADR-0002 LOCK-005/007/008 via H-1..H-13 — LOCK-005's minimal internal
  overflow safeguard remains in the final-required set through H-13) and
  permanent removals (ADR-0002 LOCK-001/002/003/004/006 plus the
  non-preservation clause of LOCK-005 for the existing compaction
  implementation; runtime spec sections 8/8.1 legacy sources). Anything else has
  no default compatibility entitlement; old implementations may be directly
  removed, disabled, or discarded when they obstruct the target, and every
  intentional non-carry-forward — including a clearly-obsolete discard
  immediately assigned `drop` — records a reconstruction-candidate entry
  preserving user value/provenance/decision evidence.
- Reconstruction-candidate entries are evidence preservation only (LOCK-015):
  they never create a compatibility promise, implementation backlog, phase
  gate, or removal classification, and they never block P1-P4 exits. Before P5
  completion every pending entry receives `rebuild` or `drop`; optional rebuild
  implementation is separately scoped and does not block P5 unless promoted to
  an H invariant. Final H-1..H-13 parity is never waived by an entry or an
  observed-candidate note (LOCK-014).
- This tracker records progress and evidence; it does not restate spec content.
  Exit checklists link to their owning spec sections (direction spec, runtime
  spec) for criterion text and acceptance semantics.

## 2. Status Vocabulary

| Status | Meaning |
|---|---|
| Not started | No work and no evidence recorded for this phase |
| Active | Work is in progress; evidence accrues here as it lands |
| Blocked | Work is stalled on a decision, dependency, or issue recorded in section 10 |
| Complete | All exit criteria met and objective exit evidence recorded in this tracker |
| Deferred | Scope moved out of the current migration per a recorded decision |
| Reconstruction candidate | A registry entry recording a legacy feature/behavior actually disabled, removed, or intentionally not carried forward (LOCK-015). Evidence preservation only — never a compatibility promise, implementation backlog, phase gate, or removal classification |

## 3. Decision Locks

These are non-negotiable for every phase (full text in the direction spec, section
1.1, the runtime spec performance section (section 10) for LOCK-PERF-1..7, and
ADR-0002/0003).

| ID | Decision |
|---|---|
| LOCK-001 | The only product is the VS Code Agent Orchestrator. The ordinary single-chat sidebar is not co-equal and remains on the deprecation/removal path. |
| LOCK-002 | Remove all worktree infrastructure and all custom Diff Viewer surfaces. Native VS Code diff APIs may still be used for checkpoint review where needed. |
| LOCK-003 | Remove cloud sessions, JetBrains, Console, and KiloClaw completely; they are not deferred. |
| LOCK-004 | Remove indexing, semantic indexing/search integration, project memory, memory tools/system-prompt injection, user-visible context management/compaction settings, and autocomplete completely. |
| LOCK-005 | Retain a minimal internal context-overflow safeguard for long-running agents. It is an invisible harness reliability mechanism, not a user-facing context-management product. Do not require preserving the existing compaction implementation. |
| LOCK-006 | Retain only user-defined/custom providers. Remove preset provider identities/catalogs, bundled gateway/provider onboarding/auth flows, the models.dev catalog dependency, and organization/cloud provider sources. Generic protocol adapters required to connect a user-defined provider may remain. |
| LOCK-007 | Retain checkpoint behavior defined as SessionRevert + Snapshot semantics: withdrawing/reverting a message restores affected code, with unrevert/cleanup and lifecycle correctness. Do not conflate this with the ADR-0005 canonical storage foundation (or ADR-0001's historical storage checkpoint/resync). |
| LOCK-008 | Preserve core harness capabilities: custom agents, sub-task delegation, extensible tools, skills, MCP, permissions/questions, parent-child sessions, background/parallel execution, user-selected custom-provider models, persistence, lifecycle correctness, checkpoint rollback, and internal context-overflow reliability. Worktrees are not a harness invariant. |
| LOCK-009 | Eliminate CLI/TUI/Console as products and public interfaces. Keep the agent runtime out of the VS Code Extension Host as an extension-owned private headless worker process for crash/resource/lifecycle isolation. The existing `kilo serve` HTTP/SSE/generated-SDK path may be a migration bridge, but it is not a target compatibility contract. The private transport remains an internal implementation choice. |
| LOCK-010 | GUI-managed file authority is authoritative (revised 2026-08-13: file-authoritative hybrid). All user-authored effective configuration is file-authoritative and WYSIWYG through the UI under exactly two canonical authored scopes — one global config root and `<workspaceRoot>/.kilo/` — with the field registry deciding global-only/project-only/both-with-typed-composition; the UI is a bidirectional editor/read model over canonical files/assets, not a separate config store. Product/UI configuration and persisted selector indexes are extension-owned (VS Code state is UI-local/derived only, never effective-config authority); secrets use VS Code SecretStorage; project-versioned harness assets use the one canonical explicit project boundary with no multi-source precedence merge; the runtime consumes immutable versioned snapshots. No migration/import tool and no dual-read compatibility window (runtime spec sections 3, 5.4, 7, 9). |
| LOCK-011 | A generation keeps the exact config/runtime snapshot it starts with. A configuration update atomically creates a new version for later generations and must not interrupt active generations. Resource replacement (provider/MCP/tool resources) is version-scoped/lazy and old resources are disposed only after owners release them; avoid process-global rebuild/convergence as the target model. |
| LOCK-012 | Model and agent selectors render from extension-owned persisted indexes before the private worker is ready. Runtime connection/validation is separate readiness and must not globally disable selection. Startup gates are action-specific, not one global `extensionDataReady` barrier. |
| LOCK-013 | Canonical architecture docs continue to describe implemented reality and are updated only as implementation lands. The mutable tracker records current migration evidence truthfully. |
| LOCK-014 | The migration is principle-first, not inventory-first (ADR-0004): no exhaustive pre-migration feature list and no complete suspension registry are required before P1/P2/P4 begin. Two closed sets are fixed: final required capabilities (ADR-0002 LOCK-005/007/008 operationalized by H-1..H-13 — user-level semantics hold at final target acceptance; existing implementations and uninterrupted intermediate availability are not invariants unless a phase explicitly requires them) and permanent removals (ADR-0002 LOCK-001/002/003/004/006, plus the non-preservation clause of LOCK-005 for the existing compaction implementation — LOCK-005's minimal internal overflow safeguard remains in the final-required set through H-13; runtime spec sections 8/8.1 legacy sources — never reclassified as deferred/suspended/rebuild candidates without a superseding ADR). Everything outside them has no default compatibility entitlement: when implementation first touches a legacy feature/behavior, the responsible phase directly migrates it, removes/disables the old implementation and records it as a reconstruction candidate, or discards it if clearly obsolete — every intentional non-carry-forward, including a clearly-obsolete discard immediately assigned `drop`, records a reconstruction-candidate entry; decided just in time, never through advance enumeration. H-1..H-13 are final target/parity gates, not a per-phase preservation obligation; intermediate phases keep the workspace testable, keep migration evidence truthful, and avoid corrupting persisted state, and may record temporary capability absence. No compatibility shim/adapter/dual implementation/old state owner is added solely to preserve a reconstruction candidate; existing compatibility code may be deleted when it obstructs the target. |
| LOCK-015 | A reconstruction-candidate entry is created only when an implemented behavior is actually disabled/removed or intentionally not carried forward (ADR-0004). It records user value/observable behavior, provenance, architectural obstruction, date/phase, whether it maps to a final invariant, post-foundation decision point, and disposition (`pending`, `rebuild`, or `drop`). Entries are evidence preservation — never a compatibility promise, implementation backlog, phase gate, or removal classification — and never block P1-P4 exits. Before P5 completion every pending entry receives `rebuild` or `drop`; optional rebuild implementation is separately scoped and does not block P5 unless promoted to an H invariant. Known examples may be recorded as observed candidates only when confirmed likely to be touched, never marked disabled today, and stay separate from the actual registry. |
| LOCK-PERF-1 | Performance simplification is a primary objective alongside product coherence. Remove redundant architecture from the hot path as a structural objective — eliminating redundant architecture, not per-phase optimization or a numeric improvement demand. |
| LOCK-PERF-2 | CLI/TUI/Console are not products. A private headless worker may remain for isolation; its startup and runtime costs must be measured. |
| LOCK-PERF-3 | Removed features must not contribute to startup/readiness: worktree/Diff Viewer, cloud sessions, JetBrains, Console, KiloClaw, indexing, memory, user-visible context management, autocomplete, preset provider catalog/onboarding. |
| LOCK-PERF-4 | Persisted custom-provider/model/agent choices must be renderable before worker readiness; action-specific readiness replaces global `extensionDataReady` gating. |
| LOCK-PERF-5 | Preserve harness semantics and performance correctness: custom agents, delegation, tools, skills, MCP, permissions/questions, parent-child/background/parallel sessions, persistence, SessionRevert+Snapshot rollback, invisible internal context-overflow safeguard. |
| LOCK-PERF-6 | No performance claim is accepted without runtime evidence. Static reachability identifies candidates; benchmarks/profiles establish magnitude. |
| LOCK-PERF-7 | Prompt submission/streaming transport on localhost is not presumed to be the dominant generation latency. Model/network/tool/user approval costs must be measured separately from transport/event overhead. |

## 4. Phase Overview

Current phase: **P0 Complete (2026-08-12)**; **P1 Not started** (final state per the 2026-08-12 decisions; this change does not start P1).

| Phase | Title | Status | Exit evidence recorded | Notes |
|---|---|---|---|---|
| P0 | Baseline inventory | Complete (2026-08-12) | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md`; test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (all H-1..H-13 executed as live tests; no gap records remain), `packages/opencode/test/kilocode/p0-instrument.test.ts`, `packages/opencode/test/kilocode/p0-bench-seed-config-schema.test.ts`, `packages/opencode/test/benchmark/`, `packages/kilo-vscode/script/p0-bench/`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/` (six formal accepted campaigns: Extension Host cold-start `2026-08-11T11-51-16-883Z/benchmark.jsonl`, Extension Host many-agent-MCP `many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl`, historical backend `2026-08-11T04-46-19-926Z/backend.jsonl`, Extension Host warm-view/no-provider/custom-provider `2026-08-12T05-52-07-672Z/benchmark.jsonl`, current-tier backend `2026-08-12T06-08-27-792Z/backend.jsonl`, Extension Host session-switch `2026-08-12T07-21-22-201Z/benchmark.jsonl`) | Static inventory, H-1..H-13 baseline fixture executing all 13 flows as live tests (parity still unproven), opt-in `KILO_P0_PERF` instrumentation, backend/extension benchmark harnesses, and six formal repeated baseline campaigns recorded as objective evidence with exact paths and scope caveats (two pre-fix partial artifacts retained but excluded: `2026-08-12T04-30-39-069Z/benchmark.jsonl`, `2026-08-12T06-05-12-356Z/backend.jsonl`); Q3 and R1/R2/R5/R6/R8 resolved and recorded (section 9); target-surface parity remains unproven, no performance threshold/SLA is claimed, and R7 was resolved on 2026-08-14 (no numeric performance thresholds; section 9); P0 marked Complete 2026-08-12 |
| P1 | Orchestration-first navigation | Not started | - | Gated on P0 |
| P2 | Harness surface parity | Not started | - | Gated on P1; requires H-1..H-13 criteria and named evidence. P2 establishes target-surface product/harness behavior for what is in scope; temporary capability absence may be recorded explicitly but must be resolved before P2 exits, and final H parity under the private runtime is proven at P4 — never waived by a tracker or reconstruction-candidate entry (LOCK-014) |
| P3 | Product removal | Not started | - | Subphases P3.1-P3.4 (sidebar, worktree/diff, cloud/JetBrains/Console/KiloClaw, indexing/memory/context-management/autocomplete) |
| P4 | Private runtime and configuration | Not started | - | Subphases P4.1-P4.5 (file-authoritative read/write model, private runtime entrypoint, legacy-reader cutover, removal evidence + transport narrowing, old CLI/server deletion); owned by runtime spec section 7. P4.2 splits into P4.2a (storage foundation and cutover — canonical aggregate storage, automatic retention, artifact registry, offline archive; ADR-0005; storage spec work units S0..S5) which must land before the P4.2b private-wire/schema freeze for R9 and R11-R14, and P4.2 cannot exit until the canonical schema/revision model, automatic retention, artifact registry, R15-R17, clean-DB cutover, and H-10/H-11 persistence/lifecycle evidence pass (storage spec section 8). P4.2 additionally requires the Failure/Outcome/Recovery contract evidence and the R decisions R11-R14 (runtime spec sections 7.2, 9); post-reconstruction error maturity (runtime spec section 7.3) is separately planned and is not a P4.2 gate |
| P5 | Startup and selector readiness | Not started | - | Startup acceptance per runtime spec section 6. P5 additionally requires every pending reconstruction-candidate entry to receive `rebuild` or `drop`; optional rebuild implementation is separately scoped and does not block P5 unless promoted to an H invariant (LOCK-015) |

P0 activation rationale (2026-08-10): the ADRs, both direction specs, this
tracker, and all product/runtime/config/performance decisions
(LOCK-001..013, LOCK-PERF-1..7) were already recorded. P0 work has now
started and durable artifacts exist in the working tree: the static
current-state inventory
([`p0-current-state-inventory.md`](p0-current-state-inventory.md)), the
runnable H-1..H-13 baseline fixture
(`packages/opencode/test/kilocode/p0-harness-baseline.test.ts`, executing
H-1/H-2/H-7/H-8/H-9/H-10/H-11/H-12/H-13 with H-3..H-6 recorded as explicit
gaps), opt-in `KILO_P0_PERF` instrumentation (extension
`packages/kilo-vscode/src/perf/perf-instrument.ts`, backend
`packages/opencode/src/kilocode/perf/instrument.ts`, webview
`packages/kilo-vscode/webview-ui/src/utils/perf.ts`), the backend benchmark
harness under `packages/opencode/test/benchmark/` (scenarios 6,7,8,9,11,12,13)
with runner `packages/opencode/script/p0-benchmark.ts`, and the VS Code
Extension Host benchmark harness under `packages/kilo-vscode/script/p0-bench/`
(scenarios 1,2,3,4,5,10) with entry points
`packages/kilo-vscode/script/e2e-p0-bench.ts` /
`e2e-p0-bench-launch.mjs` and runner
`packages/kilo-vscode/tests/e2e/p0-bench-runner.ts`. These are P0 progress
evidence only: the fixture is not a target-surface parity suite, no H
criterion is parity-proven, and no performance metric has changed from
`Not proven` (LOCK-PERF-6). Baseline smoke runs exist but are not durable
baseline measurements and are not cited as such.

P0 evidence update (2026-08-12): three formal repeated baseline campaigns are
accepted as objective P0 baseline evidence and recorded with exact paths under
`specs/vscode-orchestrator/evidence/p0-baseline/`: (1) Extension Host cold-start
(`2026-08-11T11-51-16-883Z/benchmark.jsonl`; fresh VS Code profile + fresh
scratch XDG, no seeded config; 1 warmup + 5 measured, status ok, scoped
memory-guard/backend-identity evidence); (2) Extension Host many-agent-MCP
(`many-agent-mcp-merged-2026-08-12T00-27-49-435Z/`; seeded scratch XDG kilo.json
with 20 real custom agents + one real local stdio MCP server fixture; exactly 1
warmup + 5 measured, status ok, `baselineComplete: true`, merge manifest with
per-segment sha256/hash record mapping, environment drift explicitly recorded
for `backendCli` temp paths only with one shared `cliSnapshotSha256`); and (3)
backend in-process `Server.listen`/`AppLayer` (`2026-08-11T04-46-19-926Z/backend.jsonl`;
scenarios 6,7,8,9,11,12,13, each 1 warmup + 5 measured, 42/42 ok, 79 n=5
summaries, status ok; CLI-side harness evidence only — `serve_cli_entry` is
CLI-process-tier and not emitted, and CLI process-tier files changed after this
run, so it must not be overclaimed as target-surface or private-worker
evidence). The H-3..H-6 fixture gaps are closed: the baseline fixture now
executes all H-1..H-13 as live tests through real production services and
run-owned fixtures (no gap records remain). These artifacts are P0 progress
evidence only: no H criterion is parity-proven (section 6), and section 8
records the measured values as descriptive n=5 sample statistics only — not SLA
or threshold claims (R7 Open).

P0 evidence update (2026-08-12, harness-fix campaign set): two more formal
repeated baseline campaigns are accepted as objective P0 baseline evidence,
bringing the accepted set to five: (4) Extension Host warm-view/no-provider/
custom-provider (`2026-08-12T05-52-07-672Z/benchmark.jsonl`, git 7a768502dd,
gitDirty true, run status ok, 19 samples — warm-view 2 warmup + 5 measured with
one lifecycle/shared live worker across panel close/reopen cycles and no seeded
config, no-provider 1 warmup + 5 measured on a seeded-empty persisted
providerless state (seeded scratch XDG kilo.json with explicit empty
provider/agent records) distinct from the fresh no-seed cold-start condition,
custom-provider 1 warmup + 5 measured with one real custom provider
(`@ai-sdk/openai-compatible`, loopback baseURL, 1 model); 27 n=5 summaries) and
(5) current-tier backend in-process `Server.listen`/`AppLayer`
(`2026-08-12T06-08-27-792Z/backend.jsonl`, git 7a768502dd, gitDirty true, run
status ok, 42/42 samples, 79 n=5 summaries, scenarios 6,7,8,9,11,12,13) — the
current CLI-side in-process tier for later-phase comparison; the older
`2026-08-11T04-46-19-926Z/backend.jsonl` (git 461781ffc0) is retained as
historical evidence for the 2026-08-11 tier only. Two pre-fix partial artifacts
are retained but never cited as baseline:
`2026-08-12T04-30-39-069Z/benchmark.jsonl` (no run-finish record, no
custom-provider samples; pre-harness-fix) and
`2026-08-12T06-05-12-356Z/backend.jsonl` (no run-finish record, scenarios
6/7/8 only; environmental first attempt). Harness fixes landed in the working
tree as P0 progress evidence (not product parity): scenario 4 fixture schema
correction, shared fixture schema test
(`test: packages/opencode/test/kilocode/p0-bench-seed-config-schema.test.ts`),
early `runTests` failure observation, and bounded blocked-sample fallback
(`test: packages/kilo-vscode/tests/unit/p0-bench-launch-failure.test.ts`).
These artifacts are P0 progress evidence only: no H criterion is parity-proven
(section 6), the backend campaigns remain CLI-side in-process harness evidence
(`serve_cli_entry` is CLI-process-tier and not emitted; neither target-surface
nor private-worker evidence), and section 8 records all values as descriptive
n=5 sample statistics only — not SLA or threshold claims (R7 Open).

P0 evidence update (2026-08-12, session-switch campaign): a sixth formal
repeated baseline campaign is accepted, closing the last unmeasured Extension
Host benchmark scenario (scenario 10): Extension Host session switch
(`2026-08-12T07-21-22-201Z/benchmark.jsonl`, git 7a768502dd, gitDirty true, run
status ok; one lifecycle, 5 seeded deterministic sessions, real Playwright
tab-strip clicks, settled when the active tab id and header title match; 1
warmup + 5 measured, all ok, one n=5 summary, memory-guard/backend-identity
evidence per sample). Section 8 records `switchSettleMs` as descriptive n=5
sample statistics only — not an SLA or threshold claim, and no P1 navigation
parity is claimed (R7 Open); session-switch is removed from the unmeasured P0
rows.

P0 decisions and closure (2026-08-12): Q3 and R1/R2/R5/R6/R8 are resolved and
recorded in section 9 (decisions) and in the owning artifacts (inventory
section 9 for the Q3 counts; runtime spec section 9 for R1/R2/R5/R6/R8). R7
remains Open by design and is **not** a P0 blocker: its required-by is clarified
to "before the first P3/P4/P5 performance gate that uses thresholds (and the
P1/P2 no-regression gate if applicable)", not the P0 baseline recording — P0
satisfies its component by recording descriptive runtime baselines
(LOCK-PERF-6 forbids inventing numeric thresholds from current
underpowered/noisy evidence; threshold policy must be recorded before each
affected phase starts/claims its gate, using comparable same-environment
control evidence). The five remaining `Not proven` metric rows are re-scoped to
later-phase gates, not P0 blockers: persisted-selector paint gates at P5 (no
extension-owned persisted indexes exist before P4.1); cost attribution and
per-event transport/webview flush gate at P2 (harness-parity/streaming);
removed-feature initialization count and startup-work net reduction gate at
P3/P4.4 (removal). P0 is marked **Complete** with the objective evidence above
(all 13 scenarios accepted, H-1..H-13 live baseline fixture with parity still
unproven, inventories, instrumentation, six accepted campaigns, exact paths
recorded in section 8); **P1 remains Not started** (this change does not start
P1). No GitHub issue is required; no target-surface parity, SLA, or removal
completion is claimed; canonical architecture docs are unchanged (LOCK-013).

## 5. Phase Details And Exit Checklists

Exit criteria below are taken from the direction spec (section 10) and the runtime
spec (sections 5-7). Each checkbox is complete only when objective evidence
(issue/PR/test/doc) is recorded alongside it.

### P0 - Baseline inventory

- Status: Complete (2026-08-12; started Active 2026-08-10)
- Scope: Freeze the surface inventory (direction spec 1.3), message protocol
  inventory, removal inventory (direction spec section 9, tracker section 7), and
  runtime/config root-cause inventory (runtime spec section 2: config sources,
  provider sources/loaders, readiness chain stages, convergence machinery); build
  a runnable baseline fixture/inventory for the named H-1..H-13 flows; resolve the
  bounded implementation decisions required by P0/P1 (runtime spec section 9).
- Exit checklist (2026-08-10 state, evidence updated 2026-08-12; closed 2026-08-12):
  - [x] Runnable baseline fixture/inventory covering the named H-1..H-13 harness flows — MET (2026-08-12): fixture executes all H-1..H-13 as live tests through real production services/run-owned fixtures; H-3..H-6 gap records removed (H-3 real ToolRegistry, H-4 Skill.Service + SkillTool, H-5 production MCP transport with a run-owned stdio server cleaned by exact PID, H-6 Permission/Question ask -> reply with pending-state observation) (`test: packages/opencode/test/kilocode/p0-harness-baseline.test.ts`); fixture is baseline evidence only — no target-surface parity claimed for any H (section 6)
  - [x] Reproducible surface inventory (direction spec 1.3) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 3)
  - [x] Message protocol inventory (used/unused per the P0 protocol inventory) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 4; static classification only, runtime dispatch still Unknown, U-1)
  - [x] Removal inventory for all LOCK-002/003/004/006 removals with source paths (section 7) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 5; residual current-state evidence; no removal claimed complete)
  - [x] Runtime/config root-cause inventory: enumerated config sources, provider sources/loaders, readiness chain stages, convergence machinery paths (runtime spec section 2) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 6; 15 merge sources enumerated, readiness chain stages 1-10, convergence machinery file set)
  - [x] Baseline counts recorded in section 8 — MET (2026-08-12): Q3 approved; counts recorded in inventory (sections 4.4/9, reproducible commands in section 10) and reflected in tracker section 8 (webview message types 332, provider methods 250, webview entry points 6)
  - [x] Open question 3 resolved (exact baseline metric definitions) — MET (2026-08-12): Q3 resolved — 332 distinct webview message `type:` literals (WebviewMessage 189 + ExtensionMessage 143, disjoint sets); 250 generated v2 SDK `KiloClient` public methods (the extension imports `@kilocode/sdk/v2/client`); 6 HTML/webview esbuild entries, excluding the shiki worker asset (section 9)
  - [x] Bounded implementation decisions required by P0/P1 recorded (runtime spec section 9) — MET (2026-08-12): R1 (private transport = JSON-RPC 2.0 over child-process stdio, Content-Length framing, `vscode-jsonrpc` precedent; one extension-owned worker child; initialize handshake replaces port detection/health; requests carry commands, notifications carry normalized event envelopes; stderr bounded diagnostics; EOF/process exit owns lifecycle; HTTP/SSE/generated SDK remains bridge-only and is deleted; no retained-terminal protocol commitment), R2 (extension-owned product/UI config + persisted selector indexes in VS Code `globalState`; per-workspace runtime-tracking state in `workspaceState`; secrets in `SecretStorage`; runtime-owned session/event/artifact persistence remains runtime-owned; immutable worker snapshots are derived versioned values, not a second persisted store), R5 (one canonical project boundary = first VS Code workspace root; project-versioned harness assets only under `<workspaceRoot>/.kilo/`; P4.1 migrates root/legacy sources; P4.4 deletes ancestor walk, `.kilocode`/`.opencode`, global project-asset sources, primary-worktree mirror reads; no multi-source precedence remains), R6 (explicit deadline = the P4.3 phase boundary: dual-read opens only during P4.3, shrinks monotonically, gains no new bridge consumers, fully closed before P4.3 exits / P4.4 begins; P4.4/P4.5 delete source/transport/product code; no fallback read survives into P4.4), R8 (retain the existing two-harness tooling as the P0 and later comparison harness: Extension Host scenarios 1/2/3/4/5/10 under `packages/kilo-vscode/script/p0-bench/` + runner/merge/safety/provenance tools, backend scenarios 6/7/8/9/11/12/13 under `packages/opencode/test/benchmark/` + runner; limitations recorded: manual-only, platform/environment/provenance scoped, backend in-process `Server.listen`/`AppLayer` only, n=5 descriptive); R7 stays Open but is not a P0 blocker (required-by clarified, section 9). **Post-P0 decision revision (2026-08-13):** R2 and R6 were revised by a durable user clarification — file-authoritative hybrid configuration (canonical files/assets own effective config; `globalState`/`workspaceState` own only UI-local/derived state) and an atomic legacy-reader cutover at P4.3 (no dual-read window, no import tool). The original 2026-08-12 wording above remains the historical P0 record; the revised texts are current in section 9 and the runtime spec. P0 stays Complete; its recorded evidence is unchanged
  - [x] Performance instrumentation executed at the runtime spec (section 10.8) instrumentation points; per-stage cold/warm timings recorded in section 8 — MET (2026-08-12): opt-in `KILO_P0_PERF` instrumentation exists for backend/extension/webview (`test: packages/opencode/test/kilocode/p0-instrument.test.ts`, `test: packages/kilo-vscode/tests/unit/p0-perf-instrument.test.ts`); per-stage cold/warm timings are recorded in section 8 from the formal cold-start, many-agent-MCP, warm-view/no-provider/custom-provider, session-switch, and backend campaigns; target-only stages without an accepted campaign or an existing extension-owned index are re-scoped to later-phase gates (persisted-selector paint → P5; attribution + per-event transport/webview flush → P2; removed-feature init count + startup-work reduction → P3/P4.4)
  - [x] P0 performance baseline metrics recorded in section 8 with evidence links (all performance evidence Not proven until recorded; LOCK-PERF-6) — MET (2026-08-12): rows for worker cold start, server->SSE connect, UI fetch chain -> data ready, warm view, no-provider startup (fresh no-seed and seeded-empty persisted conditions), custom-provider startup, many-agent/MCP startup, backend prompt-submit, tool/permission round-trip, parallel sessions, hot/cold/burst config updates, and session switch now record measured n=5 values with evidence links and explicit scope (descriptive p95=max at n=5, not SLA/threshold); the five remaining `Not proven` rows are re-scoped later-phase gates, not P0 blockers (persisted-selector paint → P5; attribution + per-event transport/webview flush → P2; removed-feature init count + startup-work reduction → P3/P4.4)
  - [x] Benchmark scenarios (runtime spec section 10.9) runnable and reproducible — MET (2026-08-12): backend harness (scenarios 6,7,8,9,11,12,13) under `packages/opencode/test/benchmark/` with runner `packages/opencode/script/p0-benchmark.ts`; Extension Host harness (scenarios 1,2,3,4,5,10) under `packages/kilo-vscode/script/p0-bench/`; both have passing unit/integration tests, including harness-fix tests (`test: packages/kilo-vscode/tests/unit/p0-bench-launch-failure.test.ts`, `test: packages/opencode/test/kilocode/p0-bench-seed-config-schema.test.ts`). Full repeated baselines now recorded for all 13 defined scenarios: backend all seven scenarios (1 warmup + 5 measured each, 42/42 ok) in the historical `2026-08-11T04-46-19-926Z/backend.jsonl` and the current-tier rerun `2026-08-12T06-08-27-792Z/backend.jsonl`; Extension Host cold-start (`2026-08-11T11-51-16-883Z`); Extension Host many-agent-MCP (`many-agent-mcp-merged-2026-08-12T00-27-49-435Z`, baselineComplete); Extension Host warm-view/no-provider/custom-provider (`2026-08-12T05-52-07-672Z`, 19 samples, 27 n=5 summaries); Extension Host session-switch (`2026-08-12T07-21-22-201Z`, 1 warmup + 5 measured, one n=5 summary, status ok). Two pre-fix partial artifacts are retained but excluded and never cited as baseline: `2026-08-12T04-30-39-069Z/benchmark.jsonl` (no run finish, no custom-provider samples) and `2026-08-12T06-05-12-356Z/backend.jsonl` (no run finish, scenarios 6/7/8 only)
  - [x] Static redundancy candidate inventory recorded (module-scope AppRuntime handle + AppLayer graph construction at listener build, per-instance bootstrap, feature-layer startup, removed-feature startup contributions; runtime spec section 10.4) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 7, R-1..R-10)
  - Evidence: issue: - | PR: - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts`, `packages/opencode/test/kilocode/p0-instrument.test.ts`, `packages/opencode/test/kilocode/p0-bench-seed-config-schema.test.ts`, `packages/opencode/test/benchmark/`, `packages/kilo-vscode/tests/unit/connection-service-model-first.test.ts`, `packages/kilo-vscode/tests/unit/p0-perf-instrument.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-capture.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-parse.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-stats.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-cleanup.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-launch-failure.test.ts`, `packages/kilo-vscode/tests/unit/stderr-tail.test.ts` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md`, `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-11T11-51-16-883Z/benchmark.jsonl`, `specs/vscode-orchestrator/evidence/p0-baseline/many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl` + `merge-manifest.json`, `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-11T04-46-19-926Z/backend.jsonl`, `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T05-52-07-672Z/benchmark.jsonl`, `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl`, `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T07-21-22-201Z/benchmark.jsonl`
- Next actions: none for P0 (complete). Keep the harness-fix regression tests green (scenario 4 fixture schema correction, shared fixture schema test, early `runTests` failure observation, bounded blocked-sample fallback). The five re-scoped metric rows are later-phase gates owned by their phases: persisted-selector paint → P5; cost attribution + per-event transport/webview flush → P2; removed-feature initialization count + startup-work net reduction → P3/P4.4. P1 is Not started by hub decision and must not start in this change. P0 closure uses tracker-local objective test/doc evidence and recorded decisions; no GitHub issue is required.

### P1 - Orchestration-first navigation

- Status: Not started (P0 is Complete 2026-08-12; P1 remains Not started by hub decision — this change does not start P1)
- Scope: Topic/session navigation as the main view over the migration bridge
  backend; session picker; ordinary single-chat sidebar keeps working unchanged.
- Exit checklist:
  - [ ] Topic/session navigation works across sessions without worktree dependency (LOCK-002)
  - [ ] No ordinary single-chat sidebar capability change
  - [ ] Open question 1 (topic meaning) decided
  - [ ] Affected-path performance comparison recorded on the navigation/session-switch path against the P0 baseline — descriptive, same-environment (same scripts/scenario, machine/OS class, profile type, seeded/provider conditions, instrumentation mode, recorded git SHA/dirty/drift); record med/p95/sample/provenance and investigate obvious structural anomalies; measurement noise alone does not block and there is no requirement to improve (R7 resolved 2026-08-14; runtime spec section 10.9)
  - [ ] Lifecycle-boundary convergence evidence recorded for the extension-owned view boundaries — panel close/reopen, reload, session switch/navigation — on the migration bridge (direction spec section 11; runtime spec section 7.1)
  - Evidence: issue: - | PR: - | test: - | doc: -
- Next actions: none until P0 exits.

### P2 - Harness surface parity

- Status: Not started
- Scope: Every H-1..H-13 capability reachable from orchestration panels
  (agent/model selectors, delegation, tools/skills/MCP, permission rendering,
  checkpoint review).
- Exit checklist:
  - [ ] Every H-1..H-13 target-surface acceptance criterion (direction spec section 6) passes from the target surface
  - [ ] Named evidence inventory for each H-1..H-13 criterion recorded in section 6
  - [ ] Affected-path performance comparison recorded on harness-parity flows (prompt submit, streaming, tool/permission) against the P0 baseline — descriptive, same-environment; record med/p95/sample/provenance and investigate obvious structural anomalies; no numeric threshold and no requirement to improve (R7 resolved 2026-08-14; runtime spec section 10.9). Cost attribution (LOCK-PERF-7) and per-event transport/webview render-flush measurements are descriptive evidence recorded here, not an independent P2 exit blocker (runtime spec section 10.11)
  - [ ] Lifecycle-boundary convergence evidence recorded for all five boundaries — panel close/reopen, reload, session switch (view) plus transport reconnect and worker restart (runtime) — on harness-parity flows over the current bridge (direction spec section 11; runtime spec section 7.1)
  - [ ] Target-surface product/harness behavior established for what is in scope; temporary capability absence explicitly recorded and every recorded absence resolved before P2 exits; final H parity not waived by a tracker or reconstruction-candidate entry (LOCK-014)
  - Evidence: issue: - | PR: - | test: - | doc: -
- Next actions: none until P1 exits.

### P3 - Product removal

- Status: Not started
- Scope: Remove the decided product surfaces.
  - P3.1: ordinary single-chat sidebar deprecation then removal (LOCK-001)
  - P3.2: worktree infrastructure + custom Diff Viewer surfaces (LOCK-002)
  - P3.3: cloud sessions, JetBrains, Console, KiloClaw (LOCK-003)
  - P3.4: indexing, project memory, user-visible context management/compaction,
    autocomplete (LOCK-004); retain only the internal overflow safeguard (LOCK-005)
- Exit checklist:
  - [ ] Each removal's evidence recorded in section 7 per category (source/tests/docs/generated SDK/config/i18n/build/package)
  - [ ] H-1..H-13 parity intact (P2 evidence; direction spec section 11)
  - [ ] Documented rollback/revert path shipped with each removal subphase
  - [ ] No removed feature reclassified as deferred
  - [ ] Each removal subphase proves the removed feature's initialization/readers/listeners/resources are absent from worker startup and records affected startup/session-switch/memory/worker-lifecycle deltas against the P0 baseline; zero or positive noisy delta is allowed if no removed work remains and no structurally unbounded growth/resource leak appears (LOCK-PERF-3; runtime spec section 10.9-10.10)
  - [ ] Harness semantics unregressed on every removal (LOCK-PERF-5)
  - Evidence: issue: - | PR: - | test: - | doc: -
- Next actions: none until P2 exits.

### P4 - Private runtime and configuration

- Status: Not started
- Scope (owned by runtime spec sections 3-7):
  - P4.1: file-authoritative GUI read/write model (bidirectional editor over
    canonical config files/assets — one global config root and
    `<workspaceRoot>/.kilo/`; SecretStorage for secrets; canonical two-level
    authored scopes; VS Code state is UI-local/derived only; no migration);
    canonical schema, field registry covering every configurable field class,
    and the deterministic materializer (runtime spec sections 3.2, 5.1);
    WYSIWYG acceptance semantics (runtime spec section 5.4); R10 resolved
  - P4.2: private runtime entrypoint and snapshot API (extension-owned headless
    worker; immutable versioned snapshots; generation pinning; observation
    surface per runtime spec section 7.1); Failure/Outcome/Recovery foundation
    per runtime spec section 7.2 with R11-R14 resolved (section 9). P4.2a is
    the storage foundation and cutover sub-boundary — canonical aggregate
    storage, invisible automatic retention, artifact field/owner/retention
    registry, and the offline archive cutover (ADR-0005; storage spec sections
    5-8, work units S0..S5) — landing before the P4.2b private-wire/schema
    freeze for R9 and R11-R14; R15-R17 resolved (runtime spec section 9)
  - P4.3: legacy-reader cutover — no dual-read compatibility window and no
    import tool; old sources may be used only by the current implementation
    before the cutover; at the P4.3 boundary all legacy readers are deleted
    together and cannot influence effective config; the sole user manually
    reconciles any desired current configuration into canonical files before
    the cutover, evidenced by a pre-cutover reconciliation checklist (manual
    only; no migration tooling), and an explicit mapping records each of the 15
    P0 enumerated sources onto a retained legal class or one of the 13 removal
    classes (runtime spec sections 5.1, 7, 8.1; R6 revised 2026-08-13)
  - P4.4: evidence and transport narrowing — records and verifies per-row
    inactive/removal evidence for all 13 legacy effective-config source classes
    per runtime spec section 8.1 (including legacy global config
    filenames/readers and legacy migration readers; the legacy readers were
    deleted together at the P4.3 cutover, each with no target reader), removes
    the residual legacy machinery (12-source merge, preset provider
    loaders/catalog, convergence machinery, backend-gated fetch chain), and
    narrows the public transport (private transport; SDK/public server surface
    ceases to be public); removal exits only on structural absence of
    removed-feature initialization/readers/listeners/resources and recorded
    affected startup/session-switch/memory/worker-lifecycle deltas against the
    P0 baseline — zero or positive noisy delta is allowed if no removed work
    remains and no structurally unbounded growth/resource leak appears
    (LOCK-PERF-3, runtime spec section 10.9-10.10)
  - P4.5: old CLI/server product deletion (CLI/TUI/Console products and public
    interfaces)
- Exit checklist:
  - [ ] Every datum has one owner and one persistence path (runtime spec section 3 table)
  - [ ] Field registry covers every configurable field class — canonical schema path, owner/storage, legal scope (global-only/project-only/both-with-typed-composition), composition operator, validation, secret handling, generation-snapshot inclusion, provenance, removal disposition (runtime spec section 3.2); R10 resolved with the schema layout and exact persistence assignments recorded in section 9; effective config composes only through schema-declared operators (runtime spec section 5.1)
  - [ ] Custom-provider-only boundary enforced (runtime spec section 4)
  - [ ] Config update semantics verified: atomic version creation, generation snapshot pinning, no active-generation interruption, resource version ownership/disposal, validation before commit, rollback/error behavior (runtime spec section 5)
  - [ ] WYSIWYG acceptance semantics evidenced (runtime spec section 5.4): file-to-UI external edits observed without manual reload; atomic validated UI-to-file writes preserving JSONC/markdown formatting where possible; visible stale-draft conflicts (never silent overwrite); invalid external edits never partially apply and never fall back to legacy values; predictable deletion/unset; active generations pinned while new readers use the new valid snapshot (LOCK-011)
  - [ ] Permission evaluator implements the restrictive policy stack (runtime spec section 5.3): monotonic deny/ask/allow composition, no widening, enclosing parent denies/session restrictions for children with no parent-allow inheritance, runtime-owned per-session approval records, question-flow vs `question`-tool distinction; target semantics evidenced by a permission-evaluator test surface (permission-evaluator gate)
  - [ ] P4.4 source removal proves removed-feature initialization/readers/listeners/resources are absent from worker startup and records affected startup/session-switch/memory/worker-lifecycle deltas against the P0 baseline; zero or positive noisy delta is allowed if no removed work remains and no structurally unbounded growth/resource leak appears (LOCK-PERF-1, LOCK-PERF-3; runtime spec section 10.9-10.10)
  - [ ] Each legacy effective-config source (runtime spec section 8.1, including legacy global config filenames/readers and legacy migration readers) records per-row removal evidence and is proven inactive; the active effective-config source set is the closed legal taxonomy only (tracker section 8 counting method; runtime spec sections 3.1, 5.1)
  - [ ] Legacy-reader cutover completed at P4.3: no dual-read window and no import; after the cutover legacy sources cannot affect effective config because their readers are deleted together; old path deleted (runtime spec sections 5.1, 7; R6 revised 2026-08-13)
  - [ ] Lifecycle-boundary convergence evidence recorded for all five boundaries against the private-worker observation surface (runtime spec section 7.1); R9 resolved with the handshake/revision decision recorded in section 9
  - [ ] Failure/Outcome/Recovery contract evidence recorded (runtime spec section 7.2): runtime-owned normalization boundary; operation/outcome identity for generation-path operations under the observation contract; minimal field tiers (durable vs diagnostic vs panel-visible); runtime-side redaction before persistence/projection; structured redacted panel projection through a versioned private envelope; cancellation provenance (user stop/steering/timeout/network disconnect/unknown); private runtime as sole semantic recovery authority with no client replay of accepted operations; recovery accounting/coordination (owner/scope, budget consumed/termination, next-at occurrence time, provenance, nested low-level attempt visibility); worker-crash in-flight disposition converging under section 7.1 with resource cleanup and no silent client replay; R11-R14 resolved in section 9. Post-reconstruction error maturity (runtime spec section 7.3) is not a P4.2 gate
  - [ ] Storage foundation and cutover landed (P4.2a, before the P4.2b wire/schema freeze): canonical aggregate schema/revision model with atomic revision commits; invisible automatic byte-budget retention with hysteresis and family protections; artifact field/owner/retention registry with no unregistered session-owned artifacts (project-scoped/shared revert snapshots assigned project-level ownership/GC separately from session-family deletion); bounded changefeed/outbox per R9 (storage-side ordering/truncation/idempotency in S4; wire-level R9 convergence at P4.2b); clean-DB cutover with offline archive, checksum/integrity evidence, empty fresh canonical DB boot (no pre-cutover sessions), and rollback authority retained; R15-R17 resolved (ADR-0005; storage spec sections 5-8; runtime spec sections 7.1-7.2, 9)
  - [ ] H-10/H-11 persistence and lifecycle evidence passes against the canonical storage foundation after the P4.2 cutover (direction spec section 6; runtime spec section 7.1; storage spec section 8)
  - [ ] CLI/TUI/Console products and public interfaces deleted (LOCK-009)
  - Evidence: issue: - | PR: - | test: - | doc: -
- Next actions: none until P3 exits.

### P5 - Startup and selector readiness

- Status: Not started
- Scope: Startup acceptance per runtime spec section 6: persisted custom
  providers/models/agents rendered before worker readiness; selectors not globally
  disabled; invalid/stale entries visibly reconciled; cold/warm instrumentation;
  no autocomplete prewarm dependency; no global `extensionDataReady` barrier.
- Exit checklist:
  - [ ] Persisted custom providers/models/agents render before the worker is ready
  - [ ] No selector globally disabled by backend connection state; gates are action-specific (LOCK-012)
  - [ ] Invalid/stale entries visibly reconcile without erasing user choice
  - [ ] Cold/warm startup stages instrumented (runtime spec section 6)
  - [ ] No autocomplete prewarm dependency; autocomplete removed (LOCK-004)
  - [ ] Every pending reconstruction-candidate entry (section 7) receives `rebuild` or `drop`; optional rebuild implementation is separately scoped and does not block P5 unless promoted to an H invariant (LOCK-015)
  - Evidence: issue: - | PR: - | test: - | doc: -
- Next actions: none until P4 exits.

## 6. Capability Parity Evidence (H-1..H-13)

Criterion text is the falsifiable target-surface acceptance criterion from the
direction spec (section 6). Status is `Not proven` until objective evidence is
recorded here. The P0 baseline fixture
(`packages/opencode/test/kilocode/p0-harness-baseline.test.ts`) executes all
H-1..H-13 against the real harness services (CLI-side) through production
services and run-owned fixtures (H-3 real ToolRegistry, H-4 Skill.Service +
SkillTool with a run-owned SKILL.md, H-5 production MCP transport with a
run-owned stdio server, H-6 Permission/Question ask -> reply with pending-state
observation); no gap records remain, and every entry carries
`parity: "unproven"`. The fixture is baseline evidence, not a target-surface
parity suite: no orchestration-panel acceptance criterion is claimed as
passing. Baseline smoke only; H parity remains Not proven for all 13.
H-11 lifecycle evidence additionally spans the extension-owned view boundaries
(panel close/reopen, reload, session switch) and the runtime boundaries
(transport reconnect, worker restart) per the direction spec (section 6, H-11)
and the runtime observation and hydration contract (runtime spec section 7.1);
H-11 parity stays Not proven until that boundary evidence is recorded.

Target-contract split (avoids a P2 deadlock): P2 proves the current
behavior/capability behind each criterion (a session runs under the selected
agent; a permission/question resolves inline and the outcome applies). The
target contracts the harness does not implement today — typed-manifest
validation and canonical provenance (runtime spec section 5.2), the restrictive
policy-stack semantics (runtime spec section 5.3), and file-authoritative WYSIWYG
editing (runtime spec section 5.4) — are proven at P4 through the
field-registry/schema gate, the permission-evaluator gate, and the WYSIWYG
acceptance gate (runtime spec section 10.9; direction spec section 11), never at
P2.

| # | Capability | Target-surface acceptance criterion | Status | Issue/PR | Test/Doc |
|---|---|---|---|---|---|
| H-1 | Custom agents | From an orchestration panel, a user can spawn a session selecting a user-defined custom agent by name, and the session runs under that agent's manifest (P2 proves this current capability). The typed-manifest contract — one canonical manifest per ID, duplicate/conflict validation, canonical file/asset provenance — is proven at P4 via the field-registry/schema gate (runtime spec sections 3.2, 5.2), not at P2 | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-2 | Sub-task delegation | From an orchestration panel, a session can delegate a defined sub-task to a child session and the result flows back to the parent, visible in navigation | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-3 | Extensible tools | A session spawned from a panel exposes the full tool registry, and a user-defined tool is invocable in that session | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (live: user-defined tool loaded/executed through the real ToolRegistry; no core-service mocks) |
| H-4 | Skills | A skill is loadable and runnable from a panel-hosted session, with selection remaining harness-owned | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (live: run-owned SKILL.md discovered and executed through Skill.Service + SkillTool) |
| H-5 | MCP | A session spawned from a panel with MCP configured has its MCP tools available and usable | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (live: production MCP transport connects a run-owned stdio server, tool executes in the real session loop, child cleaned by exact PID); Extension Host many-agent-MCP repeated campaign exercises real MCP at startup (doc: `specs/vscode-orchestrator/evidence/p0-baseline/many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl`) |
| H-6 | Permission/question flows | A tool permission or question raised by a panel-hosted session resolves inline through the permission flow, and the outcome is applied to that session (P2 proves this current behavior/capability). The restrictive-policy-stack semantics — monotonic deny/ask/allow composition, no widening, enclosing parent denies/session restrictions for children, bounded per-session approval records (runtime spec section 5.3) — are proven at P4 via the permission-evaluator gate, not at P2 | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (live: real Permission and Question ask -> reply flows with pending-state observation) |
| H-7 | Parent-child sessions | Topic/session navigation shows parent/child session hierarchy, and relations persist across panel restarts | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-8 | Background/parallel execution | Two or more panel-hosted sessions run concurrently in the background, and each remains controllable, without worktree isolation | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-9 | User-selected custom-provider models | Each panel-hosted session selects its own model and reasoning variant from a user-defined provider independently, and the selection applies | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-10 | Persistence | A panel-hosted session's transcript and registered artifacts persist across an extension restart and resume in place; the bounded changefeed is non-authoritative and is not H-10 history | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-11 | Lifecycle correctness | Panel-driven create/pause/resume/close drives the harness lifecycle API and releases processes/resources correctly, with no bypass, and presentation state converges to runtime operational facts across panel close/reopen, reload, session switch, transport reconnect, and worker restart (runtime spec section 7.1) | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-12 | Checkpoint rollback | From a panel-hosted session, withdrawing/reverting a message restores the affected code state, the revert can be un-reverted or cleaned up, and lifecycle stays correct; distinct from the ADR-0005 canonical storage foundation and ADR-0001's historical checkpoint/resync | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-13 | Internal context-overflow safeguard | A long-running panel-hosted session remains functional at context overflow with no user-facing context-management UI, and the safeguard never surfaces as a context-management product | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |

## 7. Removal Inventory Evidence

Each removal row records evidence per category that exists for the item: `source`,
`tests`, `docs`, `generated SDK`, `config`, `i18n`, `build/package`. A `-` in a
category means no evidence exists; a removal is complete only when every existing
category has recorded evidence. No removal is reclassified as deferred. The static
current-state inventory records the residual evidence for every row below
([`p0-current-state-inventory.md`](p0-current-state-inventory.md), section 5);
`doc:` cells cite that artifact, which records current residue only — **no
removal is claimed complete or executed**. `Unknown` means the category may exist
but was not verifiable by the static search; those cells stay open.

| Removal (LOCK) | Phase | Source | Tests | Docs | Generated SDK | Config | i18n | Build/package |
|---|---|---|---|---|---|---|---|---|
| Ordinary single-chat sidebar (LOCK-001) | P3.1 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| Worktree infrastructure (LOCK-002) | P3.2 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| Custom Diff Viewer surfaces (LOCK-002) | P3.2 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| Cloud sessions (LOCK-003) | P3.3 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - |
| JetBrains (LOCK-003) | P3.3 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - | - | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| Console (LOCK-003) | P3.3 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | Unknown | Unknown | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| KiloClaw (LOCK-003) | P3.3 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | Unknown | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| Indexing (LOCK-004) | P3.4 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| Project memory (LOCK-004) | P3.4 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| User-visible context management/compaction (LOCK-004) | P3.4 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - |
| Autocomplete (LOCK-004) | P3.4 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` |
| Preset providers/catalog/onboarding/org sources (LOCK-006) | P4.4 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` | - | - |

### Effective-config source removal evidence

Per runtime spec section 8.1, each of the 13 legacy effective-config source
classes below records removal evidence per category that exists for the item
(same `source`/`tests`/`docs`/`generated SDK`/`config`/`i18n`/`build/package`
rules as the product removals above) plus an **inactive proof**: no read of that
source affects effective config after the P4.3 cutover, because its reader is
deleted together at the cutover. There is no import tool and no dual-read
compatibility window; the sole user manually recreates any desired current
configuration in the canonical files before the cutover. A row is complete only
when every existing category records evidence and the inactive proof is
recorded. The P0 baseline enumerates 15 current merge sources (inventory §6.1);
each maps onto a retained legal source class (runtime spec section 3.1) or
exactly one of the 13 removal classes below, so no baseline source remains
unclassified after P4.4. The P4.4 evidence phase (runtime spec section 8.1;
tracker section 8) counts each row as one source class and verifies per-row
inactive/removal evidence; P4.4 exits with zero rows active.

| Source class (runtime spec section 8.1) | Evidence phase | Source | Tests | Docs | Generated SDK | Config | i18n | Build/package | Inactive proof |
|---|---|---|---|---|---|---|---|---|---|
| `KILO_CONFIG` env override | P4.4 | - | - | - | - | - | - | - | - |
| `KILO_CONFIG_DIR` env override | P4.4 | - | - | - | - | - | - | - | - |
| `KILO_CONFIG_CONTENT` env override | P4.4 | - | - | - | - | - | - | - | - |
| `KILO_PERMISSION` env override | P4.4 | - | - | - | - | - | - | - | - |
| Legacy `opencode.*` keys, `.opencode` / `.kilocode` locations | P4.4 | - | - | - | - | - | - | - | - |
| Global project-asset sources | P4.4 | - | - | - | - | - | - | - | - |
| Ancestor directory walks | P4.4 | - | - | - | - | - | - | - | - |
| Primary-worktree mirror reads | P4.4 | - | - | - | - | - | - | - | - |
| Cloud/org/managed config sources | P4.4 | - | - | - | - | - | - | - | - |
| Top-level `mode`/`tools` conversions | P4.4 | - | - | - | - | - | - | - | - |
| Arbitrary CLI/env override layers | P4.4 | - | - | - | - | - | - | - | - |
| Legacy global config filenames/readers | P4.4 | - | - | - | - | - | - | - | - |
| Legacy migration readers/import tooling | P4.4 | - | - | - | - | - | - | - | - |

### Legacy storage reader/writer removal

Old event-log and sync surfaces are removed with the old runtime surfaces
(ADR-0005 I-4/I-11; runtime spec section 8.2; storage spec sections 3.4, 5.5).
Evidence follows the same per-category rules as the product removals above; no
removal is claimed complete, and none is reclassified as deferred. The P4.2a
cutover stops legacy writes at runtime; P4.4/P4.5 record and verify the
removal of the legacy storage code and surfaces.

| Removal | Phase | Source | Tests | Docs | Generated SDK | Config | i18n | Build/package |
|---|---|---|---|---|---|---|---|---|
| Multi-client sync/warp replay protocol (`/sync/history`, `/sync/replay`, `/sync/steal`, live SSE sync replay, session warp) | P4.4/P4.5 | - | - | - | - | - | - | - |
| Old-peer capability negotiation / released-client storage compatibility (`/sync/checkpoint` rejected, never built) | P4.4/P4.5 | - | - | - | - | - | - | - |
| Unbounded full-payload event log as authoritative history (permanent duplicate full-payload snapshots; generic full-object update history) | P4.4/P4.5 | - | - | - | - | - | - | - |
| Legacy storage writers/readers (event-log full-snapshot writers, event-log read paths, legacy `session/`/`message/`/`part/` file prefixes) | P4.4/P4.5 | - | - | - | - | - | - | - |

### Reconstruction candidate registry

A reconstruction-candidate entry is created only when an implemented behavior is
actually disabled/removed or intentionally not carried forward during the
migration (LOCK-015; ADR-0004). It is evidence preservation — never a
compatibility promise, implementation backlog, phase gate, or removal
classification — and never blocks P1-P4 exits. Before P5 completion every
pending entry receives `rebuild` or `drop`; optional rebuild implementation is
separately scoped and does not automatically block P5 unless promoted to an H
invariant. An entry that maps to H-1..H-13 cannot remain dropped at final
target acceptance; it may be reimplemented from scratch after the foundation
stabilizes. The registry is initially empty: no legacy feature is marked
disabled today, and rows are added only when implementation displaces a
behavior.

| ID | Behavior / user value | Provenance | Architectural obstruction | Date / phase | Maps to final invariant | Post-foundation decision point | Disposition (`pending`, `rebuild`, `drop`) |
|---|---|---|---|---|---|---|---|
| (none yet — registry starts empty) | - | - | - | - | - | - | - |

### Observed candidates (not yet displaced)

Known examples that are already confirmed likely to be touched by the new
foundation. They are NOT marked disabled today and create no gates; they become
actual registry rows only when implementation displaces them (LOCK-015;
ADR-0004):

- Partial-output auto-continuation — same-session, same-turn continuation of
  truncated responses
  (`packages/opencode/src/session/prompt/auto-continue.ts`, introduced by commit
  `6f6e9cb177a4b79c84e67349db8d4a0bc9015606`). Likely touched by the private
  runtime outcome/recovery foundation (runtime spec section 7.2) and by the
  auto-continue non-preservation rule (ADR-0004).
- Elapsed session timer display —
  `packages/kilo-vscode/src/agent-manager/session-timing.ts` and the
  WorkingIndicator component
  (`packages/kilo-vscode/webview-ui/src/components/shared/WorkingIndicator.tsx`).
  Likely touched by the runtime-owned outcome/status facts (runtime spec
  sections 7.1-7.2) and the Agent Manager surface migration.

### Post-reconstruction error maturity backlog

Separately planned after core reconstruction (2026-08-14 decision; runtime spec
section 7.3). These are forward-looking maturity items, NOT reconstruction
candidates: they are not displaced legacy behaviors, they never create registry
rows above, and they do not block P4/P5 unless separately promoted:

- Taxonomy refinement — a complete error taxonomy; no freeze at P4.2.
- Diagnostic retention/sanitizer hardening — e.g. the paused error-system
  branch's byte/depth sanitizer contract is not a P4.2 requirement.
- Logs/telemetry keep-lists — which fields diagnostics/logs/telemetry retain.
- Rich error actions/notification routing — a user-facing action catalog and
  notification UX are not P4.2 requirements.
- Domain-specific error integrations — per provider/session/tool/permission/
  worker/UI domain, reusing the foundation's normalization boundary and schema.

Each item is promoted to scoped work by a recorded decision after core
reconstruction; promotion does not reopen the P4.2 foundation scope (runtime
spec section 7.2).

## 8. Baseline / Complexity / Runtime Metrics

P0 establishes the baselines; later phases record measured deltas. Counts are
counts, not aspirations (direction spec section 11). `TBD` values are not
evidence.

| Metric | P0 baseline | Delta at P3 | Delta at P4 | Delta at P5 | Measurement source |
|---|---|---|---|---|---|
| Webview message types | 332 distinct `type` literals (Q3 approved 2026-08-12; inventory §4.4/§9) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§4.4 reproducible count) |
| Provider methods | 250 v2 SDK public methods (Q3 approved 2026-08-12; inventory §4.3/§9) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§4.4 reproducible count) |
| Webview entry points | 6 esbuild webview entry points (Q3 approved 2026-08-12; inventory §4.4/§9) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§4.4 reproducible count) |
| Config sources merged | 15 enumerated sources (12+ floor; runtime-active count still Unknown, inventory §6.1, U-2) | TBD | 0 legacy classes active (each of the 13 tracker section 7 removal rows, mirroring runtime spec section 8.1, proven inactive; counting method = one row per source class, with each of the 15 P0 enumerated sources mapped to a retained legal class or exactly one removal row) | Closed legal taxonomy only (runtime spec section 3.1: the two canonical authored scopes — one global config root and `<workspaceRoot>/.kilo/` — plus SecretStorage credentials and schema defaults; every section 8.1 row removed) | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§6.1); tracker §7 (effective-config source removal evidence) |
| Provider source kinds (catalog/config/auth/org) | Enumerated in inventory §6.2 (runtime-active count Unknown, U-2) | TBD | TBD | 1 (custom records) | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§6.2) |
| Convergence/cold-rebuild passes | TBD (machinery enumerated in inventory §6.3; per-save durations measured in the performance rows below — `commitToConvergedMs`/`burstToConvergedMs` from backend scenarios 11/12/13; pass count per save not separately counted, U-5) | TBD | TBD | 0 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§6.3) |
| Startup readiness stages before UI enable | 10 enumerated stages (inventory §6.4; per-stage durations for the measured stages recorded in the performance rows below) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§6.4) |
| Removal items with full evidence | 0 (no removal complete; residue only, inventory §5) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§5); tracker §7 |

Counts above derive from the inventory and are reproducible (inventory
section 10 commands). Q3 is resolved (2026-08-12): the approved definitions are
the distinct webview message `type:` literals (332 = WebviewMessage 189 +
ExtensionMessage 143, disjoint sets), the 250 generated v2 SDK `KiloClient`
public methods imported by the extension (`@kilocode/sdk/v2/client`), and the 6
HTML/webview esbuild entry points excluding the shiki worker asset. The
decision is recorded in section 9 and in the inventory (section 9); current
counts stay in the inventory (sections 4.4/9) and are reused unchanged for all
later delta comparisons.

Repeated baseline campaigns (2026-08-12): six formal campaigns are accepted as
durable objective evidence under `specs/vscode-orchestrator/evidence/p0-baseline/`:
(1) Extension Host cold-start (`2026-08-11T11-51-16-883Z/benchmark.jsonl`;
fresh VS Code profile + fresh scratch XDG, no seeded config, agents 0 /
providers 0 / mcp null; 1 warmup + 5 measured, status ok, scoped
memory-guard/backend-identity evidence) — a fresh no-seed cold start; (2)
Extension Host many-agent-MCP
(`many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl` +
`merge-manifest.json`; seeded scratch XDG kilo.json with 20 real custom agents
+ one real local stdio MCP server fixture; exactly 1 warmup + 5 measured,
status ok, `baselineComplete: true`, per-segment sha256/hash record mapping,
environment drift limited to `backendCli` temp paths with one shared
`cliSnapshotSha256`); (3) historical backend in-process `Server.listen`/
`AppLayer` (`2026-08-11T04-46-19-926Z/backend.jsonl`, git 461781ffc0; scenarios
6 first-prompt, 7 large-stream, 8 parallel-sessions, 9 permission-heavy, 11
hot-config, 12 cold-during-generation, 13 burst-cold; each 1 warmup + 5
measured, 42/42 ok, 79 n=5 summaries, status ok) — retained as historical
evidence for the 2026-08-11 CLI process tier only, superseded for current-tier
comparison by campaign (5); (4) Extension Host warm-view/no-provider/
custom-provider (`2026-08-12T05-52-07-672Z/benchmark.jsonl`, git 7a768502dd,
gitDirty true, status ok, 19 samples, 27 n=5 summaries): warm-view (2 warmup +
5 measured, one lifecycle with a shared backend worker staying live across
panel close/reopen cycles, no seeded config), seeded-empty persisted
no-provider (1 warmup + 5 measured; seeded scratch XDG kilo.json with explicit
empty provider/agent records — a persisted providerless state, distinct from
the fresh no-seed condition of campaign (1)), and custom-provider (1 warmup + 5
measured; one real custom provider, `@ai-sdk/openai-compatible`, loopback
baseURL, 1 model); and (5) current-tier backend in-process `Server.listen`/
`AppLayer` (`2026-08-12T06-08-27-792Z/backend.jsonl`, git 7a768502dd, gitDirty
true, status ok; scenarios 6,7,8,9,11,12,13, each 1 warmup + 5 measured, 42/42
ok, 79 n=5 summaries) — the current CLI-side in-process tier for later-phase
comparison; and (6) Extension Host session-switch
(`2026-08-12T07-21-22-201Z/benchmark.jsonl`, git 7a768502dd, gitDirty true, run
status ok; one lifecycle, 5 seeded deterministic sessions, real Playwright
tab-strip clicks, settled when the active tab id and header title match; 1
warmup + 5 measured, all ok, one n=5 summary, memory-guard/backend-identity
evidence per sample). The backend campaigns are CLI-side harness evidence only — they run
the production `Server.listen`/`AppLayer` HTTP/SSE path in process
(`serve_cli_entry` is CLI-process-tier and not emitted) and are neither
target-surface nor private-worker evidence. Two pre-fix partial artifacts are
retained but never cited as baseline:
`2026-08-12T04-30-39-069Z/benchmark.jsonl` (no run-finish record, no
custom-provider samples; pre-harness-fix) and
`2026-08-12T06-05-12-356Z/backend.jsonl` (no run-finish record, scenarios
6/7/8 only; environmental first attempt). Earlier single-run smoke records,
incomplete partial runs, and stale `/tmp` JSONL runs are not cited as baseline.
All recorded values below are descriptive n=5 sample statistics (nearest-rank
p95 equals max at n=5) with explicit scope; they are NOT SLA or threshold
claims (R7 resolved 2026-08-14: no numeric performance thresholds, section 9).

Performance metrics (LOCK-PERF). P0 records the baseline with evidence links; no
performance metric is proven until then (LOCK-PERF-6). Rows below change from
`Not proven` to `Measured` only where a formal campaign above objectively
supports the metric with explicit scope. Rows that remain `Not proven` at P0 are
re-scoped to later-phase evidence, not P0 blockers: persisted-selector paint
gates at P5 (no extension-owned persisted indexes exist before P4.1); cost
attribution and per-event transport/webview flush are descriptive evidence at
P2 (harness-parity/streaming), not an independent P2 exit blocker;
removed-feature initialization absence and affected-path deltas gate at
P3/P4.4 (removal). No numeric performance threshold exists (R7 resolved
2026-08-14, section 9).

| Metric | P0 baseline | Delta at P3 | Delta at P4 | Delta at P5 | Measurement source |
|---|---|---|---|---|---|
| Worker cold start (extension spawn -> port detected) | Measured (n=5, descriptive p95=max; scope: Extension Host campaigns, git 461781ffc0 for cold-start/many-agent-MCP, git 7a768502dd for warm-view/no-provider/custom-provider): `spawnToPortMs` med 5382 / p95 6652 ms (cold-start, fresh no-seed); med 6331 / p95 7581 ms (many-agent-MCP, 20 agents + 1 MCP); med 11409 / p95 17305 ms (seeded-empty persisted no-provider); med 5898 / p95 6330 ms (custom-provider, 1 provider) — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-11T11-51-16-883Z/benchmark.jsonl`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T05-52-07-672Z/benchmark.jsonl` |
| Worker module graph + AppLayer graph construction | Measured (n=5, descriptive p95=max; scope: `backendEntryToListenerMs` = backend process entry -> HTTP listener, includes module graph + AppLayer graph construction, CLI-side tier of the Extension Host campaigns, git 461781ffc0 cold-start/many-agent-MCP, git 7a768502dd no-provider/custom-provider): med 644 / p95 700 ms (cold-start); med 500 / p95 641 ms (many-agent-MCP); med 1336 / p95 1444 ms (seeded-empty persisted no-provider); med 725 / p95 736 ms (custom-provider) — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-11T11-51-16-883Z/benchmark.jsonl`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T05-52-07-672Z/benchmark.jsonl` |
| Server listening -> SSE connected | Measured (n=5, descriptive p95=max; scope: Extension Host campaigns, git 461781ffc0 cold-start/many-agent-MCP, git 7a768502dd no-provider/custom-provider): `connectToSseConnectedMs` med 5442 / p95 6706 ms (cold-start); med 6380 / p95 7642 ms (many-agent-MCP); med 11586 / p95 17479 ms (seeded-empty persisted no-provider); med 5956 / p95 6430 ms (custom-provider) — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-11T11-51-16-883Z/benchmark.jsonl`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T05-52-07-672Z/benchmark.jsonl` |
| UI fetch chain -> `extensionDataReady` (current global gate) | Measured (n=5, descriptive p95=max; scope: harness data-ready signal `activateToDataReadyMs` / `loadToDataReadyMs` in the Extension Host campaigns, git 461781ffc0 cold-start/many-agent-MCP, git 7a768502dd no-provider/custom-provider; exact `extensionDataReady` gate identity not separately isolated): med 9231 / p95 10189 ms and med 7539 / p95 8534 ms (cold-start); med 9810 / p95 15051 ms and med 8144 / p95 13098 ms (many-agent-MCP); med 23043 / p95 26167 ms and med 19702 / p95 21787 ms (seeded-empty persisted no-provider); med 10517 / p95 11924 ms and med 8563 / p95 10148 ms (custom-provider) — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | Removed (action-specific gates) | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-11T11-51-16-883Z/benchmark.jsonl`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T05-52-07-672Z/benchmark.jsonl` |
| Persisted-selector paint -> worker ready | Not proven — P5 gate (no extension-owned persisted indexes exist before P4.1; cold-start campaign has no persisted selectors by design; `webviewLoadToPaintMs`/`dataReadySpanMs` recorded but not mapped to this span) | TBD | TBD | Gate | P0 performance instrumentation (LOCK-PERF-4); P5 startup acceptance (runtime spec section 6) |
| Warm view (extension reopen with live worker; webview restore path) | Measured (n=5, descriptive p95=max; scope: Extension Host warm-view scenario, one lifecycle with a shared backend worker staying live across panel close/reopen cycles, no seeded config, git 7a768502dd): `webviewLoadToPaintMs` med 119 / p95 120 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T05-52-07-672Z/benchmark.jsonl` |
| No-provider startup (fresh, no seeded config; startup without provider/auth records) | Measured (n=5, descriptive p95=max; scope: cold-start campaign condition = fresh VS Code profile + fresh scratch XDG, no seeded config, providers 0, git 461781ffc0): `spawnToPortMs` med 5382 / p95 6652 ms; `activateToDataReadyMs` med 9231 / p95 10189 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-11T11-51-16-883Z/benchmark.jsonl` |
| No-provider startup (seeded-empty persisted providerless state) | Measured (n=5, descriptive p95=max; scope: warm-view/no-provider/custom-provider campaign no-provider scenario = seeded scratch XDG kilo.json with explicit empty provider/agent records, persisted providerless state, providers 0, git 7a768502dd): `spawnToPortMs` med 11409 / p95 17305 ms; `connectToSseConnectedMs` med 11586 / p95 17479 ms; `activateToDataReadyMs` med 23043 / p95 26167 ms; `loadToDataReadyMs` med 19702 / p95 21787 ms; `backendEntryToListenerMs` med 1336 / p95 1444 ms; `webviewLoadToPaintMs` med 1326 / p95 1368 ms; `backendConfigLoadMs` med 2034 / p95 2397 ms; `backendProviderStateInitMs` med 1349 / p95 2414 ms; `backendInstanceBootstrapMs` med 2238 / p95 2734 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T05-52-07-672Z/benchmark.jsonl` |
| Custom-provider startup (one or more user-defined provider records; provider state build) | Measured (n=5, descriptive p95=max; scope: warm-view/no-provider/custom-provider campaign custom-provider scenario = seeded scratch XDG kilo.json with one real custom provider (`@ai-sdk/openai-compatible`, loopback baseURL, 1 model), git 7a768502dd): `spawnToPortMs` med 5898 / p95 6330 ms; `connectToSseConnectedMs` med 5956 / p95 6430 ms; `activateToDataReadyMs` med 10517 / p95 11924 ms; `loadToDataReadyMs` med 8563 / p95 10148 ms; `backendEntryToListenerMs` med 725 / p95 736 ms; `webviewLoadToPaintMs` med 1287 / p95 1313 ms; `backendConfigLoadMs` med 755 / p95 854 ms; `backendProviderStateInitMs` med 462 / p95 671 ms; `backendInstanceBootstrapMs` med 803 / p95 924 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T05-52-07-672Z/benchmark.jsonl` |
| Many-agent/MCP startup (large agent set and several MCP servers; bootstrap and tool resolution) | Measured (n=5, descriptive p95=max; scope: many-agent-MCP campaign = 20 real custom agents + one real local stdio MCP server (not several), seeded scratch XDG, git 461781ffc0, baselineComplete): `mcpConnectMs` med 1585 / p95 2092 ms; `activateToDataReadyMs` med 9810 / p95 15051 ms; `spawnToPortMs` med 6331 / p95 7581 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl` + `merge-manifest.json` |
| Prompt submit -> first model event/token | Measured (n=5, descriptive p95=max; scope: backend scenario 6 first-prompt, CLI-side in-process `Server.listen`/`AppLayer`, test-model/test-provider, current-tier rerun git 7a768502dd; the 2026-08-11 campaign (git 461781ffc0) remains historical tier evidence only): `startToFirstDeltaMs` med 2067 / p95 2166 ms; `totalMs` med 2628 / p95 2691 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl` |
| Model/network/tool/user-approval vs transport/event overhead | Not proven — descriptive evidence at P2, not an independent exit blocker (attribution requires separate measurement not isolated by the recorded campaigns; LOCK-PERF-7 attribution; record med/p95/sample/provenance, investigate obvious structural anomalies) | TBD | TBD | TBD | P0 performance instrumentation (LOCK-PERF-7 attribution); P2 harness-parity/streaming comparison |
| Per-event transport handling + webview render flush | Not proven — descriptive evidence at P2, not an independent exit blocker (no accepted per-event webview-side measurement yet; record med/p95/sample/provenance) | TBD | TBD | TBD | P0 performance instrumentation; P2 harness-parity/streaming comparison |
| Tool/permission round-trip | Measured (n=5, descriptive p95=max; scope: backend scenario 9 permission-heavy, CLI-side in-process harness, test permission/tool flows, current-tier rerun git 7a768502dd; the 2026-08-11 campaign (git 461781ffc0) remains historical tier evidence only): `startToFirstAskMs` med 407 / p95 501 ms; `reply1ToAsk2Ms` med 1332 / p95 1759 ms; `secondReplyToIdleMs` med 1614 / p95 2225 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl` |
| Session switch | Measured (n=5, descriptive p95=max; scope: Extension Host session-switch scenario, one lifecycle, 5 seeded deterministic sessions, real Playwright tab-strip clicks, settled when the active tab id and header title match, git 7a768502dd): `switchSettleMs` med 195 / p95=max 282 ms (min 115, max 282, mean 201.6) — descriptive n=5 only, not an SLA and no P1 navigation parity claim (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T07-21-22-201Z/benchmark.jsonl` |
| Parallel child sessions (concurrent generation with parent-child delegation) | Measured (n=5, descriptive p95=max; scope: backend scenario 8 parallel-sessions, 4 concurrent sessions, CLI-side in-process harness, current-tier rerun git 7a768502dd; parent-child hierarchy not separately attributed; the 2026-08-11 campaign (git 461781ffc0) remains historical tier evidence only): `totalMs` med 5578 / p95 5892 ms; `parallelToAcceptMs` med 452 / p95 581 ms; `acceptToAllIdleMs` med 5139 / p95 5440 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl` |
| Cold config commit -> convergence complete | Measured (n=5, descriptive p95=max; scope: backend scenario 12 cold-during-generation + 13 burst-cold, CLI-side in-process harness, current-tier rerun git 7a768502dd; the 2026-08-11 campaign (git 461781ffc0) remains historical tier evidence only): `commitToConvergedMs` med 1125 / p95 1833 ms (12); `burstToConvergedMs` med 1086 / p95 1259 ms (13) — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | 0 passes | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl` |
| Hot config update (persist + cache invalidation + `config-updated` without rebuild) | Measured (n=5, descriptive p95=max; scope: backend scenario 11 hot-config, CLI-side in-process harness, current-tier rerun git 7a768502dd; the 2026-08-11 campaign (git 461781ffc0) remains historical tier evidence only): `hotPatchMs` med 126 / p95 154 ms; `heldToReleaseMs` med 2845 / p95 2991 ms; `releaseToIdleMs` med 775 / p95 2264 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl` |
| Cold config update during active generation (no interruption) | Measured (n=5, descriptive p95=max; scope: backend scenario 12 cold-during-generation, CLI-side in-process harness, current-tier rerun git 7a768502dd; the 2026-08-11 campaign (git 461781ffc0) remains historical tier evidence only): `patchMs` med 501 / p95 659 ms; `commitToConvergedMs` med 1125 / p95 1833 ms; `convergedToFollowUpMs` med 1379 / p95 1461 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl` |
| Burst config updates (coalescing of overlapping cold saves) | Measured (n=5, descriptive p95=max; scope: backend scenario 13 burst-cold, CLI-side in-process harness, current-tier rerun git 7a768502dd; the 2026-08-11 campaign (git 461781ffc0) remains historical tier evidence only): `burstMs` med 1408 / p95 1769 ms; `burstToConvergedMs` med 1086 / p95 1259 ms; `convergedToAllModelsMs` med 4533 / p95 5246 ms — not an SLA or threshold (R7 resolved 2026-08-14) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl` |
| Startup-loaded services / removed-feature initialization count | Not proven — P3/P4.4 gate (backend boot-stage timing metrics `backendConfigLoadMs`/`backendProviderStateInitMs`/`backendInstanceBootstrapMs` are now recorded for the seeded-empty no-provider and custom-provider conditions — see those rows — and backend counts `config_load`/`instance_bootstrap`/`provider_state_init`/`processor_entry` exist per scenario; structural absence of removed-feature initialization remains to be proven per removal subphase) | TBD | Gate | TBD | P0 static inventory + runtime measurement (LOCK-PERF-3); P3/P4.4 removal gates |
| Startup-work delta vs baseline | Not proven — P3/P4.4 gate (descriptive, affected-path, same-environment deltas; zero or positive noisy delta is allowed if no removed work remains and no structurally unbounded growth/resource leak appears; no numeric threshold — R7 resolved 2026-08-14, section 9) | TBD | Gate | TBD | P0 baseline comparison (measured rows above); P3/P4.4 removal gates |

Estimates such as 20-40% or 30-50% startup reduction are hypotheses only and must
not be used as acceptance claims (LOCK-PERF-6). There are no numeric pass/fail
performance thresholds (R7 resolved 2026-08-14, section 9): P1/P2 compare
descriptive, affected-path, same-environment measurements; P3/P4 prove
structural absence of removed work and record affected-path deltas; only the
affected measured rows are rerun per phase. All measured values in the rows
above are descriptive n=5 sample statistics (nearest-rank p95 equals max at
n=5) with explicit scope; they are NOT SLA or threshold claims.

Storage metrics (ADR-0005; storage spec section 2). Current values are the
2026-08-14 read-only aggregate measurement of the live `kilo.db` (metadata/
length-sum queries only; no content was read). Post-cutover values are recorded
at P4.2a against the canonical storage foundation; reclaimed-byte figures are
descriptive maintenance diagnostics, not numeric gates (R15).

| Metric | Current baseline (2026-08-14) | Delta at P4.2a (post-cutover) | Measurement source |
|---|---|---|---|
| Legacy DB size (`kilo.db`) | ~24.56 GB (2.29M events; 2026-08-07 historical: ~16.9 GB, 1,597,938 events) | Fresh canonical DB; legacy DB archived offline with integrity evidence (R17) | doc: `specs/storage/session-storage-rewriting.md` (§2.2) |
| Event payload | ~17.96 GB (~99.2% full message/part update snapshots) | Canonical model: no permanent duplicate full-payload snapshots (LOCK-016) | doc: `specs/storage/session-storage-rewriting.md` (§2.2) |
| message/part payload | ~4 GB | Retained as canonical aggregates (R16) | doc: `specs/storage/session-storage-rewriting.md` (§2.2) |
| Growth rate | ~7.5 GB/7 days (derived: 24.56 GB on 2026-08-14 minus 16.9 GB on 2026-08-07 ≈ 7.7 GB over seven days); ~1 MB/min from a separate short active sample, not a sustained rate | Bounded by automatic retention (R15) | doc: `specs/storage/session-storage-rewriting.md` (§2.2) |
| Disk usage | ~91-92% | Monitored; automatic retention responds to the byte budget (R15) | doc: `specs/storage/session-storage-rewriting.md` (§2.2) |
| Rows/bytes reclaimed by automatic retention | n/a (not implemented) | Recorded descriptively as diagnostics (R15) | Tracker risk log; storage spec §5.3 |

## 9. Decisions / Open Questions

Product questions mirror the direction spec (section 14); runtime bounded
implementation decisions mirror the runtime spec (section 9). `TBD` means
undecided; decisions are returned to the hub, never invented here. Product
removals themselves are decided (ADR-0002 LOCK-001/002/003/004/006 plus the
non-preservation clause of LOCK-005 for the existing compaction implementation)
and are not open questions.
Resolved rows (Q3, R1, R2, R5, R6, R8, resolved 2026-08-12; R7 resolved
2026-08-14) record the durable
decision in this tracker and in the owning artifact (inventory section 9 for
Q3; runtime spec section 9 for R1/R2/R5/R6/R7/R8); they are closed and no longer
gate P0. On 2026-08-13 R2 and R6 were revised by a post-P0 user clarification —
file-authoritative hybrid configuration and an atomic legacy-reader cutover
instead of dual-read; the revised texts below are current, the original
2026-08-12 wording is preserved as historical evidence in this section and the
P0 checklist, and P0 stays Complete with its recorded evidence
unchanged. R9 (observation/hydration implementation details) is open as of
2026-08-13 (see row); required by P4.2 only, it is not a P1-P3 blocker and
does not gate P0 (Complete). R10 (canonical schema/field-registry layout and exact persistence
assignment) is open as of 2026-08-13 (see row), bounded within the
now-resolved file/SecretStorage topology; required by P4.1, it does not
gate P0 (Complete), and P4.1 cannot exit until the registry/schema/provenance
contract is evidenced. R11-R14 (Failure/Outcome/Recovery bounds: operation/
outcome identity, record location, and retention; minimum private-runtime
Failure/Outcome schema, normalization boundary, field tiers, runtime redaction,
cancellation provenance, and versioned panel envelope; recovery
accounting/coordination; worker-crash in-flight disposition) are open as of
2026-08-14 (see rows); all required by P4.2, they
do not gate P0 (Complete) or P1. R15-R17 (storage bounds: automatic retention
values; canonical aggregate schema/revision + changefeed disposition + artifact
registry; offline archive/cutover procedure) are open as of 2026-08-14
(see rows; ADR-0005); required by P4.2 (P4.2a storage sub-boundary), they do
not gate P0 (Complete) or P1-P3. Post-reconstruction error maturity (runtime
spec section 7.3) is tracked separately in section 7 and is not a gate.

| # | Question | Decision | Owner | Required by | Status |
|---|---|---|---|---|---|
| 1 | Final meaning of 'topic': derived navigation label, session-metadata facet, or new persisted grouping model? | TBD | Hub | P1 | Open |
| 2 | When does the sidebar deprecation notice ship relative to P1 navigation? | TBD | Hub | P1/P3.1 | Open |
| 3 | What exact counts form the P0 complexity baseline (message types, provider methods, webview entry points)? | Resolved (2026-08-12): 332 distinct webview message `type:` literals — WebviewMessage 189 + ExtensionMessage 143, disjoint sets; 250 generated v2 SDK `KiloClient` public methods, because the extension imports `@kilocode/sdk/v2/client`; 6 HTML/webview esbuild entries, excluding the shiki worker asset. Reproducible commands in the inventory (section 10); current counts in the inventory (sections 4.4/9) and tracker section 8; reuse those commands for all later deltas | Hub (decision); inventory (evidence) | P0 | Resolved |
| 4 | Sidebar removal timing/order within P3.1 and adoption thresholds | Removal decided (LOCK-001); numeric thresholds TBD | Hub | P3.1 | Partial |
| 5 | Which consolidated configuration surface replaces settings/profile/marketplace panels, and how does it present custom provider records? | TBD | Hub | P3/P4.1 | Open |
| R1 | Private transport protocol | Resolved (2026-08-12): JSON-RPC 2.0 over child-process stdio with standard Content-Length framing (`vscode-jsonrpc` precedent). One extension-owned worker child; initialize handshake replaces port detection/health; requests carry commands, notifications carry normalized event envelopes; stderr remains bounded diagnostics; EOF/process exit owns lifecycle. HTTP/SSE/generated SDK remains bridge-only and is deleted. No retained-terminal protocol commitment: terminal/worktree surfaces are not LOCK-008 harness invariants and are handled by their removal/migration scope | Implementation | P4.2 | Resolved |
| R2 | Storage engine for extension-owned state | Resolved (2026-08-12; **revised 2026-08-13**): canonical files/assets own effective config — one global config root and `<workspaceRoot>/.kilo/` (runtime spec section 3.1); VS Code `globalState`/`workspaceState` own only UI-local/derived state (layout/churn, dismissed state, derived selector/read-model indexes); all secrets use `SecretStorage`; runtime-owned session/event/artifact persistence remains runtime-owned; immutable worker snapshots are derived versioned values — not a second persisted store — identified by canonical file content + schema version + opaque secret references, never by UI state. Original 2026-08-12 wording (product/UI config + selector indexes in `globalState`) preserved as historical evidence | Implementation | P4.1 | Resolved (revised 2026-08-13) |
| R3 | Numeric startup SLA | Bounded product decision | Hub | P5 | Open |
| R4 | Adoption thresholds for removal timing | Bounded product decision | Hub | P3 | Open |
| R5 | Exact project harness-assets path | Resolved (2026-08-12): one canonical project boundary = first VS Code workspace root; project-versioned harness assets live only under `<workspaceRoot>/.kilo/`, including `.kilo/kilo.json[c]`, agent/command/rules/skills/workflows/plans/config assets. P4.1 establishes the canonical project files and field registry; the ancestor walk, `.kilocode`/`.opencode`, global project-asset sources, and primary-worktree mirror reads are deleted together at the P4.3 cutover, with per-row removal evidence recorded at P4.4. No multi-source precedence remains; no migration/import tool exists | Implementation | P4.1 | Resolved |
| R6 | Legacy-reader cutover (formerly: dual-read window deadline) | Resolved (2026-08-12; **revised 2026-08-13**): there is no dual-read compatibility window and no import tool. P4.3 is the last legacy-reader phase boundary: the current implementation may use old sources only before the cutover; at the P4.3 boundary all legacy readers are deleted together and cannot influence effective config. The sole user manually reconciles any desired current configuration into canonical files before the cutover. Original 2026-08-12 decision (dual-read opens only during P4.3, shrinks monotonically, no new bridge consumers, fully closed before P4.3 exits / P4.4 begins) preserved as historical evidence | Implementation | P4.3 | Resolved (revised 2026-08-13) |
| R7 | Performance gate thresholds (startup stages, prompt-submit/first-token, stream-render, tool/permission, session-switch, config-update, removal reduction) | Resolved (2026-08-14): gates use no numeric pass/fail thresholds. P1/P2 compare descriptive, affected-path, same-environment measurements against the P0 baseline — record med/p95/sample/provenance and investigate obvious structural anomalies; measurement noise alone does not block and there is no requirement to improve. P3/P4 removal phases prove removed-feature initialization/readers/listeners/resources are absent and record affected startup/session-switch/memory/worker-lifecycle deltas; zero or positive noisy delta is allowed if no removed work remains and no structurally unbounded growth/resource leak appears; only affected measured rows are rerun per phase. Complexity budgets record deltas; zero reduction in a dimension is allowed with a stated phase-boundary reason; permanent-removal completeness remains required. `Same environment/comparable` means same benchmark scripts/scenario, machine/OS class, VS Code profile type, seeded/provider conditions, instrumentation mode, and recorded git SHA/dirty/environment drift; non-comparable runs are recorded but cannot support gate claims. Numeric product SLA is R3, resolved separately at P5. No invented numerics (LOCK-PERF-6) | Hub/Engineering | Resolved (2026-08-14); no threshold-using gate remains | Resolved |
| R8 | Benchmark tooling/harness choice | Resolved (2026-08-12): retain the existing two-harness tooling as the P0 and later comparison harness — Extension Host scenarios 1/2/3/4/5/10 under `packages/kilo-vscode/script/p0-bench/` + runner/merge/safety/provenance tools; backend scenarios 6/7/8/9/11/12/13 under `packages/opencode/test/benchmark/` + runner. Limitations recorded: manual-only, platform/environment/provenance scoped, backend in-process `Server.listen`/`AppLayer` only, n=5 descriptive | Implementation | P0 | Resolved |
| R9 | Observation/hydration implementation details (snapshot/event handshake; revision scope/ordering/idempotency; ephemeral-fact retention) | Open — bounded implementation decision under the normative observation contract (runtime spec section 7.1); the contract fixes the one-owner and lifecycle-convergence constraints, not the wire schema, event sourcing, polling, timer subsystems, or retention. Required by P4.2 only; not a P1-P3 blocker. P1/P2 record current-behavior convergence evidence without deciding future private handshake mechanics | Implementation | P4.2 | Open |
| R10 | Canonical schema/field-registry layout and exact persistence assignment | Open — the normative rules are fixed by the runtime spec: legal source taxonomy (section 3.1), field-registry content (section 3.2), typed composition/materialization/provenance (section 5.1), agent-manifest role (section 5.2), permission composition (section 5.3), and the bidirectional file-editing/WYSIWYG contract (section 5.4). File/asset authority is fixed by R2 (revised 2026-08-13) and R10 is bounded within that topology: exact canonical filenames/layout, registry entry per remaining field class, legal scope/operator per field, and watcher owner/stamping/conflict implementation details (runtime spec section 5.4). It does not reopen file authority, the two-level authored scope set, the SecretStorage exception, or the no-migration decision. P4.1 is not verifiable until the registry covers every configurable field class and the schema/provenance/WYSIWYG contract is evidenced | Implementation | P4.1 | Open |
| R11 | Operation/outcome identity and record location/retention | Open — bounded implementation decision under the normative Failure/Outcome/Recovery target (runtime spec section 7.2) and the observation contract (section 7.1): what an accepted semantic operation's identity is, where the canonical Failure/Outcome records live, and their minimal retention under existing storage — no new store mandate. Generation-path operations only (prompt/generation, provider attempt, tool call, permission/question wait, child/background task); config commit outcomes are owned by runtime spec sections 5/5.4 and are not R11 operations. It does not reopen runtime sole authority for operational facts or the client replay prohibition | Implementation | P4.2 | Open (added 2026-08-14) |
| R12 | Minimum private-runtime Failure/Outcome schema + panel projection/redaction | Open — bounded implementation decision under runtime spec section 7.2: the minimum Failure/Outcome schema, the runtime-owned normalization boundary, minimal field tiers (durable vs diagnostic vs panel-visible), runtime-side redaction before persistence/projection, cancellation provenance (at least user stop/steering/timeout/network disconnect/unknown), and a versioned private panel envelope/projection. No complete taxonomy and no byte/depth sanitizer contract freeze. The private error envelope's version/compatibility is owned by R1/R9/R12 as appropriate | Implementation | P4.2 | Open (added 2026-08-14) |
| R13 | Recovery accounting/coordination and low-level retry visibility | Open — bounded implementation decision under runtime spec section 7.2 — P4.2 is accounting/coordination only: owner/scope, budget consumed/termination, next-at occurrence time, provenance, and visibility of nested low-level attempts within the owning operation. It may reuse current bounded behavior. Retryability algorithms, delay shapes, and future recovery features are post-foundation (runtime spec section 7.3). It does not preserve old retry shapes, delay ladders, the environment retry flag, or the auto-continue implementation | Implementation | P4.2 | Open (added 2026-08-14) |
| R14 | Worker-crash in-flight disposition | Open — bounded implementation decision under runtime spec sections 7.2 and 7.1: how an accepted in-flight operation at a worker crash converges to a recorded disposition with resource cleanup and no silent client replay — without requiring resumability and without a new persistent operation ledger | Implementation | P4.2 | Open (added 2026-08-14) |
| R15 | Automatic retention bounds (byte-budget high/low watermarks, recent-retention floor, family eligibility/ordering, diagnostics) | Open — bounded implementation decision under the invisible automatic retention policy (ADR-0005 I-6; storage spec section 5.3): the exact byte-budget high/low watermarks with hysteresis, the recent-retention floor, root-session-family eligibility and pruning ordering, and diagnostic reporting of aggregate rows/bytes reclaimed and failures. No numeric budget is decided now; no user-visible setting, per-session pin UI, storage dashboard, or manual cleanup surface exists or will be added | Implementation | P4.2 (P4.2a storage sub-boundary). Not a P1-P3 blocker | Open (added 2026-08-14) |
| R16 | Canonical aggregate schema/revision model + bounded outbox/changefeed disposition + artifact ownership/retention registry | Open — bounded implementation decision under the canonical storage target (ADR-0005 I-2/I-3/I-7; storage spec sections 5.1, 5.2, 5.4): the canonical aggregate/read-model schema and the atomic monotonic aggregate/session revision commit model; the bounded outbox/changefeed disposition (retention, truncation eligibility after authoritative hydration state, not authoritative history); and the artifact field/owner/retention registry (analogous to the config field registry, runtime spec section 3.2) registering every session-owned sidecar/artifact. Unregistered session-owned artifacts block the storage phase exit. No exact schema is invented now | Implementation | P4.2 (P4.2a storage sub-boundary). Not a P1-P3 blocker | Open (added 2026-08-14) |
| R17 | Offline archive format/location/integrity + fresh-DB cutover identity + rollback/archive-deletion authority | Open — bounded implementation decision under the offline cutover (ADR-0005 I-8; storage spec section 6): exact archive format and location, checksum/integrity evidence, fresh canonical DB cutover identity, the explicit archive member set (legacy `kilo.db` including `event_sequence`, the three session-owned sidecar dirs, and the disposition of inert `session-export.db`), and the rollback procedure and archive-deletion authority (deletion is separately authorized, never a cutover side effect). R17 distinguishes the pre-P4 operational containment archive from the P4.2 cutover archive, which is the rollback authority. No migration/import, no dual-reader, and no runtime archive reader | Implementation | P4.2 (P4.2a storage sub-boundary). Not a P1-P3 blocker | Open (added 2026-08-14) |

## 10. Risk / Blocker Log

| Date | Phase | Risk / Blocker | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| 2026-08-10 | All | Residual worktree/Diff Viewer and other removed features remain implemented in the current branch | Removal phases must treat them as cleanup scope, never as retained capabilities | Removal inventory (section 7) and P3 gates; truthful current-state claims (LOCK-013) | Manifestor | Monitored |
| 2026-08-10 | P4 | Dual authority could outlive the migration bridge | Old path retained indefinitely; contract drift | Atomic legacy-reader cutover at P4.3 under revised R6; old CLI/server deletion (P4.5) | Manifestor | Monitored |
| 2026-08-10 | P4 | Config authority change could interrupt active generations | Generation snapshot instability | Atomic version creation + snapshot pinning (LOCK-011, runtime spec section 5) | Manifestor | Monitored |
| 2026-08-10 | P5 | Selector availability gated on backend state could regress during migration | Startup degraded until backend ready | Persisted indexes before worker readiness; action-specific gates (LOCK-012) | Manifestor | Monitored |
| 2026-08-10 | All | Performance claims based on estimates (e.g. 20-40%/30-50%) could become acceptance claims | Unmeasured magnitudes; false performance claims | Evidence-only gates (LOCK-PERF-6); hypotheses flagged; P0 descriptive n=5 baselines recorded with evidence links (section 8, six accepted campaigns); no numeric thresholds exist (R7 resolved 2026-08-14, section 9) — descriptive same-environment comparisons only | Manifestor | Resolved (2026-08-12) |
| 2026-08-10 | P3-P5 | Removed features might still initialize at worker startup (residual code) | Startup work does not decline despite removal | Structural absence proof per removal subphase — initialization/readers/listeners/resources absent — plus recorded affected-path deltas; zero or positive noisy delta is allowed if no removed work remains (LOCK-PERF-3, runtime spec section 10) | Manifestor | Monitored |
| 2026-08-10 | P0-P2 | Transport/event overhead misattributed as the dominant latency | Wrong optimization target | LOCK-PERF-7: measure model/network/tool/approval separately from transport/event overhead | Manifestor | Monitored |
| 2026-08-10 | P0 | Unbounded benchmark capture could grow process memory without bound during a long/hung sample run | Harness OOM; invalid benchmark run | Bounded capture implemented: raw output retained only as a `capBytes` byte-capped tail with `MAX_SEGMENTS` object bound (`packages/kilo-vscode/script/p0-bench/parse.ts`); covered by `tests/unit/p0-bench-capture.test.ts`, `p0-bench-parse.test.ts`, `p0-bench-cleanup.test.ts`, `p0-bench-stats.test.ts` | Manifestor | Resolved |
| 2026-08-10 | P0 | Unbounded worker stderr accumulation could grow extension-host memory over the worker lifetime | Extension-host memory growth; lost diagnostics | Bounded diagnostic stderr tail: `MAX_STDERR_TAIL_LINES` (100 lines) and `MAX_STDERR_TAIL_BYTES` (16 KiB) caps with reassembly (`packages/kilo-vscode/src/services/cli-backend/stderr-tail.ts`); covered by `tests/unit/stderr-tail.test.ts` | Manifestor | Resolved |
| 2026-08-10 | P0 | Environmental esbuild-watcher process attribution (a non-owned process observed during harness runs) could be misread as a harness/benchmark defect | Misattributed performance or resource claims | Left unresolved as an attribution question; it is not a benchmark claim and no metric depends on it (LOCK-PERF-6) | Manifestor | Monitored |
| 2026-08-12 | P0 | Merged many-agent-MCP campaign segments ran with different `backendCli` temp paths (`environmentDrift` in `merge-manifest.json`) | Cross-segment timing comparability | Drift recorded and limited to temp paths; all segments share one `cliSnapshotSha256`; values stay descriptive n=5, not SLA (R7 Open) | Manifestor | Monitored |
| 2026-08-12 | P0 | CLI process-tier files changed after the 2026-08-11 backend campaign ran | Backend campaign numbers describe an older CLI process tier if re-used for later-phase comparison | Current-tier rerun completed 2026-08-12 (`specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl`, git 7a768502dd, 42/42 ok, 79 n=5 summaries); the environmental first-attempt partial (`2026-08-12T06-05-12-356Z/backend.jsonl`, no run finish, scenarios 6/7/8 only) is retained as excluded evidence; the 2026-08-11 campaign remains historical tier evidence only (section 8) | Manifestor | Resolved |
| 2026-08-13 | P1-P5 | Presentation state can diverge from runtime operational facts across lifecycle boundaries — extension-owned view boundaries (panel close/reopen, reload, session switch) and runtime boundaries (transport reconnect, worker restart). Current-state motivation: the extension derives and persists per-session status/timing read-model state from `session.status` events (`packages/kilo-vscode/src/agent-manager/session-timing.ts`, `packages/kilo-vscode/src/agent-manager/AgentManagerProvider.ts`), while the runtime owns session status (`packages/opencode/src/session/status.ts`); derived state is not revalidated against the runtime at every boundary | Stale or duplicated presentation state; UI-held facts surviving a lifecycle boundary; orphaned processes/resources; lost updates | Sole runtime authority for operational facts with derived presentation state (runtime spec section 7.1); lifecycle-boundary convergence evidence recorded per phase (direction spec section 11); R9 records the bounded implementation decision (section 9) | Manifestor | Monitored |
| 2026-08-13 | P4 | The config refactor relocates storage but keeps source competition: generic compatibility readers/overlays still contribute to effective config after migration, or dual-read becomes permanent | Effective config keeps merging from competing sources; the removal gates become unverifiable | Closed legal source taxonomy and field registry (runtime spec sections 3.1-3.2); deterministic materialization with typed composition and provenance (runtime spec section 5.1); per-source removal evidence with inactive proof (runtime spec section 8.1; tracker section 7); P4.1/P4.3/P4.4 exit gates (section 5); R10 open and required by P4.1 (section 9) | Manifestor | Monitored |
| 2026-08-13 | P4 | File and UI effective configuration diverge — external edits, stale drafts, invalid external edits, or deletion/unset produce silent overwrites, partial applies, or legacy fallback | Users lose edits; effective config no longer matches the canonical files; WYSIWYG guarantee broken | Bidirectional file-editing contract with watched external edits, content/version-stamp conflict detection, validation-before-write, and visible reconciliation (runtime spec section 5.4); WYSIWYG acceptance gate at P4.1 (runtime spec section 10.9; direction spec section 11); exact presentation under direction spec Q5 | Manifestor | Monitored |
| 2026-08-13 | P0-P4 | The 2026-08-13 post-P0 decision revision (file-authoritative hybrid; atomic cutover instead of dual-read) is misread as retroactively changing P0 evidence or as a new ADR | Historical P0 evidence distorted; decision authority confusion | Revision recorded as a durable clarification/revision dated 2026-08-13: ADR-0003 amended in place (not a new ADR), ADR-0002 unchanged, `p0-current-state-inventory.md` unchanged, P0 stays Complete with original R2/R6 wording preserved as historical evidence (runtime spec section 9; tracker section 9) | Manifestor | Monitored |
| 2026-08-13 | P4 | P4.3 cutover proceeds without a pre-cutover manual reconciliation checklist/evidence for the sole user, or without an explicit mapping of the 15 P0 enumerated sources onto the 13 removal classes / retained legal classes | Desired current configuration lost at the cutover; unclassified baseline sources survive | Pre-cutover reconciliation checklist/evidence recorded for the sole user (manual only; no migration tooling); explicit P0 15-source to 13-removal-class mapping recorded before P4.3 (runtime spec section 8.1; tracker section 7); no-migration decision unchanged | Manifestor | Monitored |
| 2026-08-14 | P1-P5 | Inventory-first analysis paralysis — an exhaustive pre-migration classification of legacy features blocks P1/P2/P4 from starting | Migration stalls before any implementation begins | Principle-first policy (LOCK-014): no exhaustive pre-migration inventory or suspension registry is required; first-touch disposition is decided just in time (ADR-0004) | Manifestor | Monitored |
| 2026-08-14 | P1-P5 | Unrecorded feature loss — a displaced behavior disappears with no evidence trail | Users lose observable behavior with no record of value or disposition | Just-in-time candidate registration (LOCK-015): a registry entry is created when an implemented behavior is actually disabled/removed or intentionally not carried forward (tracker section 7) | Manifestor | Monitored |
| 2026-08-14 | P1-P5 | Reconstruction candidate used as a compatibility entitlement — an entry is treated as a promise to restore or keep a behavior | Scope creep; migration stalls on compatibility detours | Registry is evidence preservation only (LOCK-015): no restore path, parity waiver, phase gate, or implementation backlog derives from an entry (ADR-0004) | Manifestor | Monitored |
| 2026-08-14 | P2-P5 | Candidate loophole weakens final H parity — a tracker or registry entry is used to waive a final H-1..H-13 gate | Final target acceptance weakened | H-1..H-13 are final target/parity gates (LOCK-014): never waived by a tracker or candidate entry; P2 proves in-scope target-surface behavior and P4 proves the H invariants under the private runtime | Manifestor | Monitored |
| 2026-08-14 | P1-P2 | Noisy descriptive measurements stall a phase without a structural finding | Phase blocked on measurement noise | Measurement noise alone does not block; comparisons are descriptive, affected-path, same-environment, and obvious structural anomalies are investigated (R7 resolved 2026-08-14; runtime spec section 10) | Manifestor | Monitored |
| 2026-08-14 | P3-P4 | A zero or positive noisy delta masks incomplete removal | Removed work silently retained | Structural absence of removed-feature initialization/readers/listeners/resources remains the mandatory gate; deltas are recorded evidence, not the exit criterion (R7 resolved 2026-08-14; runtime spec section 10.9-10.10) | Manifestor | Monitored |
| 2026-08-14 | P4 | DB exhaustion before the cutover: live `kilo.db` ~24.56 GB (2.29M events; event payload ~17.96 GB, ~99.2% full message/part update snapshots), growth ~7.5 GB/7 days (derived from the two dated observations) and ~1 MB/min during a separate short active sample, disk ~91-92% | Disk exhaustion; runtime failure before the P4.2 storage cutover | Operational containment (bounded manual operation: full archive + keep last-week-active sessions in the current legacy DB) records its policy and evidence slots without claiming completion (storage spec section 4); the kept last-week set exists only in the legacy store before the cutover and in the offline legacy archive afterward — the P4.2 cutover boots an empty canonical DB with no pre-cutover sessions (storage spec section 6.2); storage is not a P1-P3 code prerequisite; the P4.2a cutover is the target bound (ADR-0005) | Manifestor | Monitored |
| 2026-08-14 | P4 | Operational containment overclaimed as target behavior or as a phase gate | False completion claims; P1-P3 blocked on the wrong thing | Containment is a bounded manual operation, not target behavior and not a phase gate; its evidence slots stay pending until execution evidence exists (LOCK-013; storage spec section 4.3) | Manifestor | Monitored |
| 2026-08-14 | P4 | Storage cutover proceeds with migration/dual-read/archive-reader behavior, or old-history storage compatibility is retained as a target | Compatibility detour contradicts the canonical storage target | Clean cutover enforced (ADR-0005 I-8): no migration/import, no dual-reader, no runtime archive reader; legacy event-log sync/warp surfaces removed at P4.4/P4.5 with no default compatibility entitlement (runtime spec section 8.2; direction spec section 12) | Manifestor | Monitored |

## 11. Change Log

| Date | Change | By |
|---|---|---|
| 2026-08-10 | Initial creation: tracker for ADR-0002 migration; documentation foundation complete; all phases Not started | Manifestor execution of audit-correction task |
| 2026-08-10 | Final product boundaries (LOCK-001..008) and runtime/config decisions (LOCK-009..012, ADR-0003 + runtime spec) recorded; tracker revised: new decision locks, phase set P0-P5 with subphases, new H-1..H-13 parity matrix, removal inventory evidence, runtime metrics, updated decisions/risks; all phases still Not started; no implementation evidence | Manifestor execution of final-boundaries documentation task |
| 2026-08-10 | Performance made first-class: LOCK-PERF-1..7 recorded; performance model, cost attribution, instrumentation plan, benchmark scenarios, and regression gates added to the runtime spec (section 10); performance objective and removed-features-not-startup-dependencies rules added to the direction spec; tracker gained performance metrics (all Not proven), P0 profiling tasks, and P1/P2/P3 performance gates; no measurements exist on the current branch | Manifestor execution of performance-model documentation task |
| 2026-08-10 | Performance-doc audit corrections applied: TUI lazy rendering vs static CLI/TUI module-graph imports distinguished (magnitude unmeasured); AppLayer described as layer definition + lazy runtime handle with graph construction at server listener build, not at first import; benchmark scenarios mapped to explicit tracker metric rows (warm view, no-provider/custom-provider/many-agent-MCP startup, parallel child sessions, hot config update, cold-update no-interruption, burst coalescing); P4.4 exit evidence requires measured net startup-work reduction and absent removed-feature initialization; ambiguous provider citations qualified to `packages/opencode/src/provider/provider.ts`; worker CLI entry/module-graph load added to instrumentation points; all performance values remain Not proven | Manifestor execution of performance-doc audit-correction task |
| 2026-08-10 | P0 activated: static current-state inventory (`specs/vscode-orchestrator/p0-current-state-inventory.md`) checked in with surfaces, message/SSE/SDK protocol counts, removal residue, runtime/config root-cause graph, static redundancy candidates R-1..R-10, H-1..H-13 baseline map, proposed baseline-count definitions (Q3), and dynamic unknowns U-1..U-10; tracker P0 phase set Active with inventory/harness evidence; no removal claimed complete; no performance metric changed from Not proven | Manifestor execution of P0-evidence update task |
| 2026-08-10 | H-1..H-13 baseline fixture added: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` executes H-1, H-2, H-7, H-8, H-9, H-10, H-11, H-12, H-13 against real harness services and records H-3..H-6 as explicit gaps with references; every entry carries `parity: "unproven"`; tracker section 6 statuses updated to baseline-smoke/gap-recorded with parity Not proven; no target-surface criterion claimed passing | Manifestor execution of P0-evidence update task |
| 2026-08-10 | P0 instrumentation added (opt-in `KILO_P0_PERF`): extension host `packages/kilo-vscode/src/perf/perf-instrument.ts`, backend `packages/opencode/src/kilocode/perf/instrument.ts`, webview `packages/kilo-vscode/webview-ui/src/utils/perf.ts`; covered by `packages/opencode/test/kilocode/p0-instrument.test.ts` and `packages/kilo-vscode/tests/unit/p0-perf-instrument.test.ts`; instrumentation points exist but no durable per-stage timings recorded (section 8 remains Not proven) | Manifestor execution of P0-evidence update task |
| 2026-08-10 | Benchmark harnesses added: backend under `packages/opencode/test/benchmark/` (scenarios 6,7,8,9,11,12,13; runner `packages/opencode/script/p0-benchmark.ts` via `bun run bench:p0`) and VS Code Extension Host under `packages/kilo-vscode/script/p0-bench/` (scenarios 1,2,3,4,5,10; `packages/kilo-vscode/script/e2e-p0-bench.ts` + `e2e-p0-bench-launch.mjs` via `bun run test:p0-bench`, runner `packages/kilo-vscode/tests/e2e/p0-bench-runner.ts`); both have passing unit/integration tests; only smoke runs so far — no full repeated baseline, so benchmark-runnable criterion is PARTIAL | Manifestor execution of P0-evidence update task |
| 2026-08-10 | OOM correction: bounded benchmark capture (`capBytes` + `MAX_SEGMENTS` in `packages/kilo-vscode/script/p0-bench/parse.ts`) and bounded worker stderr diagnostic tail (`MAX_STDERR_TAIL_LINES`/`MAX_STDERR_TAIL_BYTES` in `packages/kilo-vscode/src/services/cli-backend/stderr-tail.ts`) added with unit tests; risk rows recorded; environmental non-owned esbuild watcher attribution left unresolved and not a benchmark claim | Manifestor execution of P0-evidence update task |
| 2026-08-12 | P0 objective evidence update: H-3..H-6 fixture gaps closed (fixture now executes all H-1..H-13 as live tests through real production services/run-owned fixtures; no gap records remain; section 6 H-3..H-6 rows moved from gap-recorded to baseline-smoke with parity still Not proven); three formal repeated baseline campaigns recorded under `specs/vscode-orchestrator/evidence/p0-baseline/` (Extension Host cold-start `2026-08-11T11-51-16-883Z`, merged many-agent-MCP `many-agent-mcp-merged-2026-08-12T00-27-49-435Z` with `baselineComplete` + merge manifest + `environmentDrift`, backend `2026-08-11T04-46-19-926Z/backend.jsonl` 42/42 ok, 79 n=5 summaries); section 8 metric rows updated to Measured only where a campaign objectively supports the metric with explicit scope, all values descriptive n=5 p95=max and NOT SLA/threshold (R7 Open); remaining rows stay Not proven; P0 stays Active; no removal claimed complete; risk log entries added for environment drift and post-campaign CLI process-tier changes | Manifestor execution of P0-evidence update task |
| 2026-08-12 | P0 harness-fix and current-tier evidence update: accepted Extension Host warm-view/no-provider/custom-provider campaign (`2026-08-12T05-52-07-672Z/benchmark.jsonl`, git 7a768502dd, gitDirty true, run status ok, 19 samples — warm-view 2 warmup + 5 measured, no-provider 1 + 5, custom-provider 1 + 5 — 27 n=5 summaries) and current-tier backend rerun (`2026-08-12T06-08-27-792Z/backend.jsonl`, git 7a768502dd, gitDirty true, 42/42 ok, 79 n=5 summaries, CLI-side in-process `Server.listen`/`AppLayer`, `serve_cli_entry` not emitted), bringing the accepted campaign set to five (cold-start, many-agent-MCP, historical backend, warm-view/no-provider/custom-provider, current-tier backend); two pre-fix partial artifacts retained but excluded and never cited as baseline (`2026-08-12T04-30-39-069Z/benchmark.jsonl` no finish/no custom-provider, `2026-08-12T06-05-12-356Z/backend.jsonl` no finish/scenarios 6/7/8 only); harness-fix tests added (`test: packages/kilo-vscode/tests/unit/p0-bench-launch-failure.test.ts`, `test: packages/opencode/test/kilocode/p0-bench-seed-config-schema.test.ts`) covering scenario 4 fixture schema correction, shared fixture schema test, early `runTests` failure observation, and bounded blocked-sample fallback (P0 progress evidence, not product parity); section 8 warm-view row measured, no-provider row split into fresh no-seed vs seeded-empty persisted conditions, custom-provider row measured, and backend scenario 6/8/9/11/12/13 rows updated to current-tier values with the 2026-08-11 campaign retained as historical tier evidence; risk row for post-2026-08-11 CLI process-tier drift resolved; all values descriptive n=5 p95=max and NOT SLA/threshold (R7 Open); P0 stays Active; no removal claimed complete | Manifestor execution of P0-evidence update task |
| 2026-08-12 | P0 baseline issue requirement removed: P0 closure no longer references or requires a planned baseline GitHub issue; closure uses tracker-local objective test/doc evidence and recorded decisions. Tracker schema (generic `issue: -` / PR/test/doc evidence fields), metrics, campaigns, locks, statuses, and other decisions unchanged. | Manifestor execution of baseline-issue-removal task |
| 2026-08-12 | P0 session-switch evidence update: accepted the sixth formal repeated baseline campaign — Extension Host session switch (`2026-08-12T07-21-22-201Z/benchmark.jsonl`, git 7a768502dd, gitDirty true, run status ok; one lifecycle, 5 seeded deterministic sessions, real Playwright tab-strip clicks, settled when the active tab id and header title match; 1 warmup + 5 measured, all ok, one n=5 summary); section 8 Session switch row changed from Not proven to Measured (`switchSettleMs` med 195 / p95=max 282 ms, min 115, max 282, mean 201.6; descriptive n=5 only, not SLA/threshold, no P1 navigation parity claim, R7 Open); benchmark-scenarios exit checklist marked MET — full repeated baselines now recorded for all 13 defined scenarios (runtime spec 10.9); session-switch removed from the unmeasured P0 rows and next actions; P0 stays Active; no removal claimed complete | Manifestor execution of P0-evidence update task |
| 2026-08-12 | P0 decisions finalized and P0 marked Complete: Q3 and R1/R2/R5/R6/R8 resolved and recorded (tracker section 9; inventory section 9 for Q3; runtime spec section 9 for R1/R2/R5/R6/R8) under the locked decision text; R7 stays Open with required-by clarified to "before the first P3/P4/P5 performance gate that uses thresholds (and the P1/P2 no-regression gate if applicable), not the P0 baseline recording"; five `Not proven` metric rows re-scoped to later-phase gates (persisted-selector paint → P5; attribution + per-event transport/webview flush → P2; removed-feature init count + startup-work net reduction → P3/P4.4) and removed from P0 blockers/next actions; P0 exit checklist marked MET for baseline counts, Q3, bounded decisions, instrumentation/baselines, and benchmark reproducibility; P0 status set Complete (2026-08-12) with the recorded objective evidence; P1 left Not started explicitly; risk row for "no performance measurements exist" resolved; no GitHub issue, no target-surface parity, no SLA, no removal completion claimed; canonical architecture docs unchanged (LOCK-013); no commit or push | Manifestor execution of P0 decision-finalization task |
| 2026-08-13 | Documentation reinforcement: lifecycle-boundary observation generalized into architecture obligations — runtime sole authority for operational facts, presentation derivation, view/session lifecycle isolation, hydration/reconnect convergence, and lifecycle-boundary acceptance evidence. Direction spec: terminology rows (section 4), H-11 (section 6), ownership (section 7), bounded architecture (section 8), acceptance gates (section 11), risks (section 13). Runtime spec: scope cross-reference (section 1), observation/hydration contract (section 7.1), constraints pointer (section 7), R9 added open (section 9). Tracker: Session Bootstrap section, lifecycle-boundary evidence checkboxes in P1/P2/P4, H-11 criterion synced with the direction spec, R9 row, risk and change-log entries. No ADR, inventory, canonical-doc, code, or evidence-file changes; P0 stays Complete; all resolved decision texts unchanged; no commit or push | Manifestor execution of documentation-reinforcement task |
| 2026-08-13 | Audit corrections accepted: lifecycle-boundary phase mapping aligned — P1 records only the extension-owned view boundaries (panel close/reopen, reload, session switch) on the migration bridge; P2 records all five boundaries (view boundaries plus transport reconnect and worker restart) on harness-parity flows over the current bridge; P4 records all five against the private-worker observation surface. R9 required by P4.2 only (tracker and runtime spec section 9); P1/P2 test current behavior without deciding future private handshake mechanics. Tracker exit checkboxes link to spec sections instead of restating runtime spec 7.1 outcome language; tracker section 6 H-11 note and risk row distinguish view boundaries from runtime boundaries; risk-row provenance replaced with repository evidence (`packages/kilo-vscode/src/agent-manager/session-timing.ts`, `packages/kilo-vscode/src/agent-manager/AgentManagerProvider.ts`, `packages/opencode/src/session/status.ts`); direction spec section 13 risk-table rows corrected to two columns; direction spec section 11 gate and H-11 invariant distinguish boundary classes. P0 stays Complete; all resolved decision texts unchanged; no commit or push | Manifestor execution of audit-correction task |
| 2026-08-13 | Config-refactor contract strengthened: bounded target configuration model defined in the runtime spec — legal source taxonomy and field registry (sections 3.1-3.2), config authority and deterministic materialization with typed composition, provenance, and env/CLI disposition (section 5.1), typed agent manifests (section 5.2), restrictive permission composition (section 5.3), and effective-config source removal inventory (section 8.1); evidence-vs-target rows added (section 2.6); R10 added open, required by P4.1 (runtime spec and tracker section 9); P4 exit checklist gained field-registry/schema/provenance, dual-read cutoff, and per-source inactive-evidence gates; effective-config source removal evidence table added (tracker section 7) with a counting obligation in section 8 (9 source classes; P4.4 exits with zero rows active); risk and change-log entries added. Direction spec: H-1/H-6 updated to typed agent manifests and restrictive policy composition, preserving capabilities. No ADR, inventory, canonical-doc, code, or evidence-file changes; P0 stays Complete; all resolved decision texts unchanged; no commit or push | Manifestor execution of config-refactor documentation task |
| 2026-08-13 | File-authoritative hybrid decision revision: durable user decision — all user-authored effective configuration is file-authoritative and WYSIWYG through the UI under exactly two canonical authored scopes (one global config root; `<workspaceRoot>/.kilo/`); no migration/import tool and no dual-read compatibility window (atomic legacy-reader cutover at P4.3; sole user manually reconciles desired configuration before cutover). ADR-0003 amended in place (Decision, LOCK-010/I-2, alternatives, consequences, follow-up; revision dated 2026-08-13; not a new ADR); ADR-0002 unchanged. Runtime spec: ownership domains and legal source taxonomy rewritten (sections 3-3.2), snapshot identity includes canonical file content + schema version + opaque secret references (section 5.1), agent markdown retained as a typed canonical project/global asset (section 5.2), permission contract expanded — child inheritance, question-flow vs `question`-tool distinction, per-session approval records, no-rule=ask, toggle semantics, generated availability defaults (section 5.3) — new bidirectional file-editing/WYSIWYG contract (section 5.4), migration strategy revised to legacy-reader cutover with no dual-read/import (section 7), removal disposition changed to delete with no target reader for 13 source classes including legacy global config filenames/readers and legacy migration readers (section 8.1), R2/R6 revised with original wording preserved as historical evidence and R10 bounded within the resolved topology (section 9), WYSIWYG and permission-evaluator gates added (section 10.9), agent/permission code evidence added (section 2.2). Direction spec: LOCK-010, terminology, surfaces, H-1/H-6 target-contract split (P2 proves current capability; §5.2/§5.3/§5.4 contracts gate at P4), ownership, bounded architecture, gates, compatibility, risks, Q5 (WYSIWYG presentation open; semantics decided). Tracker: Session Bootstrap, phase overview, P0 checklist revision note, P4 scope/exit checklist (cutover, WYSIWYG, permission-evaluator), H-1/H-6 synced, section 7 removal table now 13 rows with delete disposition, section 8 source-count wording fixed, R2/R6/R10 rows, risks and this change-log entry. `p0-current-state-inventory.md` unchanged; P0 stays Complete; canonical architecture docs unchanged (LOCK-013); no commit or push | Manifestor execution of file-authoritative hybrid revision task |
| 2026-08-13 | Final audit corrections accepted: internal lettered orchestration labels removed from all artifacts and replaced with direct product-language statements or durable IDs (LOCK-010, LOCK-011, R2/R6); runtime spec section 8.1 and tracker section 7 effective-config removal tables completed to 13 source classes with `Evidence phase` columns — adding global project-asset sources and primary-worktree mirror reads — plus the P0 15-source to 13-removal-class mapping obligation and pre-cutover manual reconciliation evidence; phase semantics clarified everywhere — P4.3 performs the atomic legacy-reader cutover/deletion, P4.4 records and verifies per-row inactive/removal evidence and narrows the public transport, P4.5 deletes old CLI/server/product/public interfaces (ADR-0003 consequence corrected; obsolete deadline phrasing removed); runtime spec section 3 table header renamed to `Canonical scopes and legal inputs`. ADR-0002, inventory, and code untouched; P0 stays Complete; no commit or push | Manifestor execution of final-audit-correction task |
| 2026-08-14 | Architecture-first direct reconstruction + bounded Failure/Outcome/Recovery: ADR-0004 created (principle-first policy, two closed sets, no default compatibility entitlement, just-in-time disposition, LOCK-014/015, error-branch input-evidence-only); direction spec corrected to final-gate language for H-1..H-13 and scoped compatibility policy (LOCK-014); runtime spec gained error/retry/recovery ownership evidence (2.7) and the bounded Failure/Outcome/Recovery target (7.2) with R11-R14 open and required by P4.2 (section 9); tracker gained just-in-time maintenance rules, Reconstruction candidate status, reconstruction candidate registry (initially empty) + observed-candidates note (auto-continue, timer display), P2/P4/P5 phase and gate corrections per LOCK-014/015, risk and change-log entries, and the ADR-0004 link. P0 stays Complete; P1-P5 Not started; ADR-0002/0003 and the P0 inventory unchanged; no commit or push | Manifestor execution of direct-reconstruction documentation task |
| 2026-08-14 | Audit corrections accepted: discard always records a drop reconstruction-candidate entry — ADR-0004 Decision/I-3, the LOCK-014 rows (direction spec and tracker), direction spec section 12, and the tracker maintenance rules now state that every intentional non-carry-forward, including a clearly-obsolete discard immediately assigned `drop`, records an entry preserving user value/provenance/decision evidence. Permanent-removal set stated precisely, replacing the coarse removal-range citation — ADR-0002 LOCK-001/002/003/004/006 plus the non-preservation clause of LOCK-005 for the existing compaction implementation, with LOCK-005's minimal internal overflow safeguard explicitly retained in the final-required set through H-13 (ADR-0004 Context/I-2, the LOCK-014 rows, the tracker maintenance rules, the direction spec section 9 removal-inventory caption, and the tracker section 9 note). ADR-0002/0003 decisions unchanged; P0 stays Complete; no commit or push | Manifestor execution of accepted audit-correction task |
| 2026-08-14 | Error architecture scope split + performance guardrail decision: error foundation is independently valuable, not merely retry support, and is split between the P4.2 private-runtime foundation (runtime spec section 7.2: runtime-owned normalization boundary, minimal Failure/Outcome schema without taxonomy freeze, operation identity/outcome facts for generation-path operations, minimal durable/diagnostic/panel-visible field tiers, runtime-side redaction before persistence/projection, structured redacted panel projection, cancellation provenance, schema/envelope ownership, semantic recovery authority, worker-crash in-flight disposition) and separately planned post-reconstruction error maturity (runtime spec section 7.3; tracker section 7 backlog — taxonomy refinement, diagnostic retention/sanitizer hardening, logs/telemetry keep-lists, rich error actions/notification routing, domain-specific integrations), which is not a reconstruction candidate and not a P4/P5 blocker. R11-R14 refined: R11 record location/retention under existing storage (no new store), R12 schema + normalization boundary + field tiers + redaction + cancellation provenance + versioned envelope (no taxonomy or byte/depth sanitizer contract freeze), R13 accounting/coordination only (may reuse current bounded behavior; retryability algorithms/delay shapes are post-foundation), R14 crash disposition without resumability or a new op ledger. R7 resolved 2026-08-14: no numeric pass/fail performance thresholds — P1/P2 descriptive same-environment affected-path comparisons (no requirement to improve; noise alone does not block); P3/P4 structural absence proof plus recorded deltas (zero/positive noisy delta allowed if no removed work remains); only affected rows rerun per phase; complexity budgets record deltas; numeric SLA stays R3 at P5. All mirrored gates updated (direction spec §8/§9/§11/§13, runtime spec §9/§10.1/§10.7/§10.9-10.11, tracker P1/P2/P3/P4 checklists, metrics statuses, risks). ADR-0004 updated (error foundation/maturity split, refined I-9/I-10, new I-12). P0 stays Complete; ADR-0002/0003, inventory, and canonical docs unchanged; no commit or push | Manifestor execution of error-scope-and-performance-guardrail documentation task |
| 2026-08-14 | Bounded private-runtime storage foundation integrated: ADR-0005 created (canonical aggregate storage, invisible automatic byte-budget retention, artifact field/owner/retention registry, offline archive cutover; LOCK-016/017) and ADR-0001 marked Superseded (metadata/supersession links only; historical decision body preserved). ADR-0004 updated (direct reconstruction includes the clean P4.2 storage cutover with no compatibility entitlement). Storage spec rewritten as the implementation source of truth for the new target (current state with the 2026-08-14 read-only aggregate measurement ~24.56 GB DB / ~17.96 GB event payload / ~99.2% full update snapshots / disk ~91-92% / growth derived from the two dated observations ≈ 7.5 GB per 7 days, with ~1 MB/min labeled as a separate short active sample, no content read; operational containment as a pending bounded manual operation, not a phase gate; target model; cutover; storage work units S0..S5 under P4.2a; gates/tests; terminology). Runtime spec updated (storage foundation in scope, ownership row, R9 changefeed and R11 storage interaction, P4.2a-before-P4.2b ordering and P4.2 gates, R15-R17 open required by P4.2 and not P1-P3 blockers, maintenance performance guardrails, legacy storage reader/writer removal section 8.2). Direction spec updated (H-10/H-11/H-12, bounded-architecture storage bullet, terminology note, final-H-parity-only compatibility, ADR-0005 links). Tracker updated (bootstrap links, P4 overview/checklist with P4.2a/b, R15-R17 rows, storage metrics table, legacy storage reader/writer removal evidence, DB-exhaustion/containment/cutover risk rows, links, change log). P0 stays Complete; P1-P5 Not started; ADR-0002/0003, inventory, evidence, and canonical docs unchanged; no commit or push | Manifestor execution of storage-architecture-integration documentation task |
| 2026-08-14 | Storage-document audit corrections accepted: fresh canonical DB semantics made explicit and unambiguous — the P4.2 cutover boots an empty canonical DB with no pre-cutover sessions; the operational-containment last-week set remains only in the offline legacy archive and is not migrated/read by the new runtime; "retained sessions" / lossless-continuation wording in ADR-0005 and the storage spec scoped to canonical-era runtime-retained sessions (ADR-0005 I-8/I-9/I-10; storage spec sections 1.3, 4.1, 4.3, 5.1, 6.2). Revert snapshots reconciled as project-scoped/shared: not deleted as part of one session family; artifact registry assigns ownership/GC (project-level reachability/refcount) separately, no silent orphaning (ADR-0005 I-6; storage spec sections 3.3, 5.3, 5.4). H-10 target wording corrected to sessions + registered artifacts persist/resume with the bounded changefeed non-authoritative and not H-10 history (direction spec section 6; tracker section 6). S4/P4.2 ordering corrected: S4 verifies storage-side bounded changefeed ordering/truncation/idempotency; wire-level R9 convergence is the P4.2b gate (storage spec sections 7, 8.2). R9 blocker wording aligned to "Required by P4.2 only; not a P1-P3 blocker" (runtime spec and tracker section 9). Growth provenance corrected: both dated observations preserved, derived interval/rate method stated (~7.5 GB/7 days from 16.9 GB on 2026-08-07 to 24.56 GB on 2026-08-14), ~1 MB/min labeled as a separate short active sample, and the experimental-flags probe recorded as current-state probe evidence with date/method, not a repo-cited proof (ADR-0005; storage spec sections 2.2, 4.1; tracker sections 8, 10). Cutover archive set made explicit and R17 distinguishes the operational containment archive from the P4.2 cutover archive/rollback authority, including `event_sequence`, session-owned sidecars, and inert `session-export.db` disposition (storage spec sections 3.3, 6.1, 6.4; runtime spec and tracker section 9 R17). No stale durable question references remain in the doc set. P0 stays Complete; all resolved decision texts unchanged; no commit or push | Manifestor execution of storage-document audit-correction task |

## 12. Links

- ADR-0001: [`../adr/0001-lossless-session-storage-rewriting.md`](../adr/0001-lossless-session-storage-rewriting.md) (Superseded by ADR-0005; historical decision body preserved)
- ADR-0002: [`../adr/0002-focus-vscode-on-agent-orchestration.md`](../adr/0002-focus-vscode-on-agent-orchestration.md)
- ADR-0003: [`../adr/0003-replace-cli-configuration-with-private-gui-runtime.md`](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md)
- ADR-0004: [`../adr/0004-architecture-first-direct-reconstruction.md`](../adr/0004-architecture-first-direct-reconstruction.md)
- ADR-0005: [`../adr/0005-bounded-private-runtime-storage.md`](../adr/0005-bounded-private-runtime-storage.md)
- Storage spec: [`../storage/session-storage-rewriting.md`](../storage/session-storage-rewriting.md)
- Direction spec: [`agent-orchestration-direction.md`](agent-orchestration-direction.md)
- Runtime/config spec: [`runtime-and-configuration-direction.md`](runtime-and-configuration-direction.md)
- P0 current-state inventory: [`p0-current-state-inventory.md`](p0-current-state-inventory.md)
- P0 baseline evidence: [`evidence/p0-baseline/`](evidence/p0-baseline/) (accepted: cold-start `2026-08-11T11-51-16-883Z/benchmark.jsonl`, many-agent-MCP merged `many-agent-mcp-merged-2026-08-12T00-27-49-435Z/benchmark.jsonl` + `merge-manifest.json`, historical backend `2026-08-11T04-46-19-926Z/backend.jsonl`, Extension Host warm-view/no-provider/custom-provider `2026-08-12T05-52-07-672Z/benchmark.jsonl`, current-tier backend `2026-08-12T06-08-27-792Z/backend.jsonl`, Extension Host session-switch `2026-08-12T07-21-22-201Z/benchmark.jsonl`; excluded partials, retained but never cited as baseline: `2026-08-12T04-30-39-069Z/benchmark.jsonl`, `2026-08-12T06-05-12-356Z/backend.jsonl`)
- Canonical architecture docs: unchanged (LOCK-013), `packages/kilo-docs/pages/contributing/architecture/`
