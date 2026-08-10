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

## 2. Status Vocabulary

| Status | Meaning |
|---|---|
| Not started | No work and no evidence recorded for this phase |
| Active | Work is in progress; evidence accrues here as it lands |
| Blocked | Work is stalled on a decision, dependency, or issue recorded in section 10 |
| Complete | All exit criteria met and objective exit evidence recorded in this tracker |
| Deferred | Scope moved out of the current migration per a recorded decision |

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
| LOCK-007 | Retain checkpoint behavior defined as SessionRevert + Snapshot semantics: withdrawing/reverting a message restores affected code, with unrevert/cleanup and lifecycle correctness. Do not conflate this with ADR-0001 storage checkpoint/resync. |
| LOCK-008 | Preserve core harness capabilities: custom agents, sub-task delegation, extensible tools, skills, MCP, permissions/questions, parent-child sessions, background/parallel execution, user-selected custom-provider models, persistence, lifecycle correctness, checkpoint rollback, and internal context-overflow reliability. Worktrees are not a harness invariant. |
| LOCK-009 | Eliminate CLI/TUI/Console as products and public interfaces. Keep the agent runtime out of the VS Code Extension Host as an extension-owned private headless worker process for crash/resource/lifecycle isolation. The existing `kilo serve` HTTP/SSE/generated-SDK path may be a migration bridge, but it is not a target compatibility contract. The private transport remains an internal implementation choice. |
| LOCK-010 | GUI-owned configuration is authoritative. Product/UI configuration and persisted selector indexes are extension-owned; secrets use VS Code SecretStorage; project-versioned harness assets use one canonical explicit project boundary and no multi-source precedence merge; the runtime consumes immutable versioned snapshots. |
| LOCK-011 | A generation keeps the exact config/runtime snapshot it starts with. A configuration update atomically creates a new version for later generations and must not interrupt active generations. Resource replacement (provider/MCP/tool resources) is version-scoped/lazy and old resources are disposed only after owners release them; avoid process-global rebuild/convergence as the target model. |
| LOCK-012 | Model and agent selectors render from extension-owned persisted indexes before the private worker is ready. Runtime connection/validation is separate readiness and must not globally disable selection. Startup gates are action-specific, not one global `extensionDataReady` barrier. |
| LOCK-013 | Canonical architecture docs continue to describe implemented reality and are updated only as implementation lands. The mutable tracker records current migration evidence truthfully. |
| LOCK-PERF-1 | Performance simplification is a primary objective alongside product coherence. Remove redundant architecture from the hot path. |
| LOCK-PERF-2 | CLI/TUI/Console are not products. A private headless worker may remain for isolation; its startup and runtime costs must be measured. |
| LOCK-PERF-3 | Removed features must not contribute to startup/readiness: worktree/Diff Viewer, cloud sessions, JetBrains, Console, KiloClaw, indexing, memory, user-visible context management, autocomplete, preset provider catalog/onboarding. |
| LOCK-PERF-4 | Persisted custom-provider/model/agent choices must be renderable before worker readiness; action-specific readiness replaces global `extensionDataReady` gating. |
| LOCK-PERF-5 | Preserve harness semantics and performance correctness: custom agents, delegation, tools, skills, MCP, permissions/questions, parent-child/background/parallel sessions, persistence, SessionRevert+Snapshot rollback, invisible internal context-overflow safeguard. |
| LOCK-PERF-6 | No performance claim is accepted without runtime evidence. Static reachability identifies candidates; benchmarks/profiles establish magnitude. |
| LOCK-PERF-7 | Prompt submission/streaming transport on localhost is not presumed to be the dominant generation latency. Model/network/tool/user approval costs must be measured separately from transport/event overhead. |

## 4. Phase Overview

Current phase: **P0** (Baseline inventory).

| Phase | Title | Status | Exit evidence recorded | Notes |
|---|---|---|---|---|
| P0 | Baseline inventory | Active (2026-08-10) | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md`; test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts`, `packages/opencode/test/kilocode/p0-instrument.test.ts`, `packages/opencode/test/benchmark/`, `packages/kilo-vscode/script/p0-bench/` | Static inventory, H-1..H-13 baseline fixture, opt-in `KILO_P0_PERF` instrumentation, and backend/extension benchmark harnesses exist in the working tree; H-3..H-6 remain explicit fixture gaps, target-surface parity unproven, no performance metric recorded |
| P1 | Orchestration-first navigation | Not started | - | Gated on P0 |
| P2 | Harness surface parity | Not started | - | Gated on P1; requires H-1..H-13 criteria and named evidence |
| P3 | Product removal | Not started | - | Subphases P3.1-P3.4 (sidebar, worktree/diff, cloud/JetBrains/Console/KiloClaw, indexing/memory/context-management/autocomplete) |
| P4 | Private runtime and configuration | Not started | - | Subphases P4.1-P4.5 (GUI read model, private runtime entrypoint, dual-read, source removal, old CLI/server deletion); owned by runtime spec section 7 |
| P5 | Startup and selector readiness | Not started | - | Startup acceptance per runtime spec section 6 |

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

## 5. Phase Details And Exit Checklists

Exit criteria below are taken from the direction spec (section 10) and the runtime
spec (sections 5-7). Each checkbox is complete only when objective evidence
(issue/PR/test/doc) is recorded alongside it.

### P0 - Baseline inventory

- Status: Active (2026-08-10)
- Scope: Freeze the surface inventory (direction spec 1.3), message protocol
  inventory, removal inventory (direction spec section 9, tracker section 7), and
  runtime/config root-cause inventory (runtime spec section 2: config sources,
  provider sources/loaders, readiness chain stages, convergence machinery); build
  a runnable baseline fixture/inventory for the named H-1..H-13 flows; resolve the
  bounded implementation decisions required by P0/P1 (runtime spec section 9).
- Exit checklist (2026-08-10 state):
  - [ ] Runnable baseline fixture/inventory covering the named H-1..H-13 harness flows — PARTIAL: fixture executes H-1, H-2, H-7, H-8, H-9, H-10, H-11, H-12, H-13 as live tests and records H-3..H-6 as explicit gaps with references (`test: packages/opencode/test/kilocode/p0-harness-baseline.test.ts`); no target-surface fixture covers all 13 and parity remains unproven
  - [x] Reproducible surface inventory (direction spec 1.3) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 3)
  - [x] Message protocol inventory (used/unused per the P0 protocol inventory) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 4; static classification only, runtime dispatch still Unknown, U-1)
  - [x] Removal inventory for all LOCK-002/003/004/006 removals with source paths (section 7) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 5; residual current-state evidence; no removal claimed complete)
  - [x] Runtime/config root-cause inventory: enumerated config sources, provider sources/loaders, readiness chain stages, convergence machinery paths (runtime spec section 2) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 6; 15 merge sources enumerated, readiness chain stages 1-10, convergence machinery file set)
  - [ ] Baseline counts recorded in section 8 — PARTIAL: reproducible counts recorded in the inventory (section 4.4/9) and reflected in tracker section 8, but Q3 metric definitions remain unapproved (proposal only)
  - [ ] Open question 3 resolved (exact baseline metric definitions) — still Open (Q3); inventory section 9 records the proposed definitions pending hub approval
  - [ ] Bounded implementation decisions required by P0/P1 recorded (runtime spec section 9) — still Open (R1, R2, R5, R6, R8)
  - [ ] Performance instrumentation executed at the runtime spec (section 10.8) instrumentation points; per-stage cold/warm timings recorded in section 8 — PARTIAL: opt-in `KILO_P0_PERF` instrumentation exists for backend/extension/webview (`test: packages/opencode/test/kilocode/p0-instrument.test.ts`, `test: packages/kilo-vscode/tests/unit/p0-perf-instrument.test.ts`); no per-stage timings recorded as durable baseline (section 8 all `Not proven`)
  - [ ] P0 performance baseline metrics recorded in section 8 with evidence links (all performance evidence Not proven until recorded; LOCK-PERF-6) — not met: all performance metrics remain `Not proven`; smoke runs are evidence only, not baseline
  - [ ] Benchmark scenarios (runtime spec section 10.9) runnable and reproducible — PARTIAL: backend harness (scenarios 6,7,8,9,11,12,13) under `packages/opencode/test/benchmark/` with runner `packages/opencode/script/p0-benchmark.ts`; Extension Host harness (scenarios 1,2,3,4,5,10) under `packages/kilo-vscode/script/p0-bench/`; both have passing unit/integration tests, but only single smoke runs (and one 5-sample scenario-12 backend run) exist — no full repeated baseline
  - [x] Static redundancy candidate inventory recorded (module-scope AppRuntime handle + AppLayer graph construction at listener build, per-instance bootstrap, feature-layer startup, removed-feature startup contributions; runtime spec section 10.4) — `doc: specs/vscode-orchestrator/p0-current-state-inventory.md` (section 7, R-1..R-10)
  - Evidence: issue: - | PR: - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts`, `packages/opencode/test/kilocode/p0-instrument.test.ts`, `packages/opencode/test/benchmark/`, `packages/kilo-vscode/tests/unit/connection-service-model-first.test.ts`, `packages/kilo-vscode/tests/unit/p0-perf-instrument.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-capture.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-parse.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-stats.test.ts`, `packages/kilo-vscode/tests/unit/p0-bench-cleanup.test.ts`, `packages/kilo-vscode/tests/unit/stderr-tail.test.ts` | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md`
- Next actions: close fixture gaps H-3..H-6 with runnable entries or record blockers; establish a repeated baseline from both benchmark harnesses (backend `bun run bench:p0`, extension `bun run test:p0-bench`) with durable recorded samples; record per-stage cold/warm timings at the instrumentation points; resolve Q3 and R1/R2/R5/R6/R8; open the baseline issue.

### P1 - Orchestration-first navigation

- Status: Not started
- Scope: Topic/session navigation as the main view over the migration bridge
  backend; session picker; ordinary single-chat sidebar keeps working unchanged.
- Exit checklist:
  - [ ] Topic/session navigation works across sessions without worktree dependency (LOCK-002)
  - [ ] No ordinary single-chat sidebar capability change
  - [ ] Open question 1 (topic meaning) decided
  - [ ] No performance regression on the navigation/session-switch path against the P0 baseline (measured; runtime spec section 10.9)
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
  - [ ] No performance regression on harness-parity flows (prompt submit, streaming, tool/permission) against the P0 baseline (measured; runtime spec section 10.9)
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
  - [ ] Each removal subphase records measured net startup-work reduction and confirms the removed feature no longer initializes at worker startup (LOCK-PERF-3; runtime spec section 10.9-10.10)
  - [ ] Harness semantics unregressed on every removal (LOCK-PERF-5)
  - Evidence: issue: - | PR: - | test: - | doc: -
- Next actions: none until P2 exits.

### P4 - Private runtime and configuration

- Status: Not started
- Scope (owned by runtime spec sections 3-7):
  - P4.1: local GUI read model and config authority (extension-owned persisted
    config + selector indexes; SecretStorage for secrets; one canonical project
    harness-assets boundary; no multi-source precedence merge)
  - P4.2: private runtime entrypoint and snapshot API (extension-owned headless
    worker; immutable versioned snapshots; generation pinning)
  - P4.3: dual-read window over the existing HTTP/SSE/SDK bridge with an explicit
    deadline; no permanent dual authority
  - P4.4: source removal (12-source merge, preset provider loaders/catalog,
    convergence machinery, backend-gated fetch chain) and transport narrowing
    (private transport; SDK/public server surface ceases to be public); removal
    exits only on a measured net startup-work reduction against the P0 baseline
    and confirmation that removed-feature initialization is absent (LOCK-PERF-3,
    runtime spec section 10.9-10.10)
  - P4.5: old CLI/server product deletion (CLI/TUI/Console products and public
    interfaces)
- Exit checklist:
  - [ ] Every datum has one owner and one persistence path (runtime spec section 3 table)
  - [ ] Custom-provider-only boundary enforced (runtime spec section 4)
  - [ ] Config update semantics verified: atomic version creation, generation snapshot pinning, no active-generation interruption, resource version ownership/disposal, validation before commit, rollback/error behavior (runtime spec section 5)
  - [ ] P4.4 source removal records a measured net startup-work reduction against the P0 baseline and confirms removed-feature initialization is absent from worker startup (LOCK-PERF-1, LOCK-PERF-3; runtime spec section 10.9-10.10)
  - [ ] Dual-read window closed by the recorded deadline; old path deleted (runtime spec section 7)
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
  - Evidence: issue: - | PR: - | test: - | doc: -
- Next actions: none until P4 exits.

## 6. Capability Parity Evidence (H-1..H-13)

Criterion text is the falsifiable target-surface acceptance criterion from the
direction spec (section 6). Status is `Not proven` until objective evidence is
recorded here. The P0 baseline fixture
(`packages/opencode/test/kilocode/p0-harness-baseline.test.ts`) executes
H-1, H-2, H-7, H-8, H-9, H-10, H-11, H-12, H-13 against the real harness
services (CLI-side) and records H-3..H-6 as explicit gaps with references to
existing coverage; every entry carries `parity: "unproven"`. The fixture is
baseline evidence, not a target-surface parity suite: no orchestration-panel
acceptance criterion is claimed as passing. Baseline smoke only; H parity
remains Not proven for all 13.

| # | Capability | Target-surface acceptance criterion | Status | Issue/PR | Test/Doc |
|---|---|---|---|---|---|
| H-1 | Custom agents | From an orchestration panel, a user can spawn a session selecting a user-defined custom agent by name, and the session runs under that agent's config | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-2 | Sub-task delegation | From an orchestration panel, a session can delegate a defined sub-task to a child session and the result flows back to the parent, visible in navigation | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-3 | Extensible tools | A session spawned from a panel exposes the full tool registry, and a user-defined tool is invocable in that session | Gap recorded; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (gap entry; refs to existing `test/tool/` coverage) |
| H-4 | Skills | A skill is loadable and runnable from a panel-hosted session, with selection remaining harness-owned | Gap recorded; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (gap entry; refs to existing `test/skill/` coverage) |
| H-5 | MCP | A session spawned from a panel with MCP configured has its MCP tools available and usable | Gap recorded; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (gap entry; refs to existing `test/kilocode/mcp-*.test.ts` coverage) |
| H-6 | Permission/question flows | A tool permission or question raised by a panel-hosted session resolves inline through the permission flow, and the outcome is applied to that session | Gap recorded; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` (gap entry; refs to existing `test/permission/`, `test/question/` coverage) |
| H-7 | Parent-child sessions | Topic/session navigation shows parent/child session hierarchy, and relations persist across panel restarts | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-8 | Background/parallel execution | Two or more panel-hosted sessions run concurrently in the background, and each remains controllable, without worktree isolation | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-9 | User-selected custom-provider models | Each panel-hosted session selects its own model and reasoning variant from a user-defined provider independently, and the selection applies | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-10 | Persistence | A panel-hosted session's transcript, events, and artifacts persist across an extension restart and resume in place | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-11 | Lifecycle correctness | Panel-driven create/pause/resume/close drives the harness lifecycle API and releases processes/resources correctly, with no bypass | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
| H-12 | Checkpoint rollback | From a panel-hosted session, withdrawing/reverting a message restores the affected code state, the revert can be un-reverted or cleaned up, and lifecycle stays correct; distinct from ADR-0001 | Baseline smoke only; parity Not proven | - | test: `packages/opencode/test/kilocode/p0-harness-baseline.test.ts` |
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

## 8. Baseline / Complexity / Runtime Metrics

P0 establishes the baselines; later phases record measured deltas. Counts are
counts, not aspirations (direction spec section 11). `TBD` values are not
evidence.

| Metric | P0 baseline | Delta at P3 | Delta at P4 | Delta at P5 | Measurement source |
|---|---|---|---|---|---|
| Webview message types | 332 distinct `type` literals (Q3 proposal, unapproved; inventory §4.1/§9) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§4.4 reproducible count) |
| Provider methods | 250 v2 SDK public methods (Q3 proposal, unapproved; inventory §4.3/§9) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§4.4 reproducible count) |
| Webview entry points | 6 esbuild webview entry points (Q3 proposal, unapproved; inventory §4.4/§9) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§4.4 reproducible count) |
| Config sources merged | 15 enumerated sources (12+ floor; runtime-active count still Unknown, inventory §6.1, U-2) | TBD | TBD | 1 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§6.1) |
| Provider source kinds (catalog/config/auth/org) | Enumerated in inventory §6.2 (runtime-active count Unknown, U-2) | TBD | TBD | 1 (custom records) | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§6.2) |
| Convergence/cold-rebuild passes | TBD (machinery enumerated in inventory §6.3; pass count unmeasured, U-5) | TBD | TBD | 0 | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§6.3) |
| Startup readiness stages before UI enable | 10 enumerated stages (inventory §6.4; per-stage durations unmeasured) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§6.4) |
| Removal items with full evidence | 0 (no removal complete; residue only, inventory §5) | TBD | TBD | TBD | doc: `specs/vscode-orchestrator/p0-current-state-inventory.md` (§5); tracker §7 |

Counts above that derive from the inventory are reproducible (inventory
section 10 commands); they are proposed P0 baseline definitions pending Q3
approval and are labeled as such. The exact-count question 3 remains open
(section 9); the proposal lives in the inventory (section 9).

Smoke artifacts: backend and Extension Host benchmark harnesses have produced
single-run smoke records (backend: all seven scenarios once plus five measured
scenario-12 samples; extension: cold-start/warm-view/session-switch smoke), and
historical `/tmp` JSONL runs contain stale pre-fix artifacts. None of these are
durable baseline evidence (LOCK-PERF-6): they are not repeated, not versioned,
and some are pre-fix. All are excluded from the metrics below, which remain
`Not proven` until a repeated baseline with recorded evidence links exists.

Performance metrics (LOCK-PERF). P0 records the baseline with evidence links; no
performance metric is proven until then (LOCK-PERF-6). All values are
`Not proven`/TBD today; no durable baseline measurement is recorded on the
current branch (smoke runs are excluded, see note above).

| Metric | P0 baseline | Delta at P3 | Delta at P4 | Delta at P5 | Measurement source |
|---|---|---|---|---|---|
| Worker cold start (extension spawn -> port detected) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (server-manager spawn/port timestamps) |
| Worker module graph + AppLayer graph construction | Not proven | TBD | TBD | TBD | P0 performance instrumentation (runtime spec 10.2-10.3) |
| Server listening -> SSE connected | Not proven | TBD | TBD | TBD | P0 performance instrumentation |
| UI fetch chain -> `extensionDataReady` (current global gate) | Not proven | TBD | TBD | Removed (action-specific gates) | P0 performance instrumentation (KiloProvider fetch chain; LOCK-PERF-4) |
| Persisted-selector paint -> worker ready | Not proven | TBD | TBD | TBD | P0 performance instrumentation (LOCK-PERF-4) |
| Warm view (extension reopen with live worker; webview restore path) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (warm-view scenario, runtime spec 10.9) |
| No-provider persisted state (startup without provider/auth records) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (runtime spec 10.9) |
| Custom-provider startup (one or more user-defined provider records; provider state build) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (runtime spec 10.9) |
| Many-agent/MCP startup (large agent set and several MCP servers; bootstrap and tool resolution) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (runtime spec 10.9) |
| Prompt submit -> first model event/token | Not proven | TBD | TBD | TBD | P0 performance instrumentation (LOCK-PERF-7) |
| Model/network/tool/user-approval vs transport/event overhead | Not proven | TBD | TBD | TBD | P0 performance instrumentation (LOCK-PERF-7 attribution) |
| Per-event transport handling + webview render flush | Not proven | TBD | TBD | TBD | P0 performance instrumentation |
| Tool/permission round-trip | Not proven | TBD | TBD | TBD | P0 performance instrumentation |
| Session switch | Not proven | TBD | TBD | TBD | P0 performance instrumentation |
| Parallel child sessions (concurrent generation with parent-child delegation) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (runtime spec 10.9) |
| Cold config commit -> convergence complete | Not proven | TBD | TBD | 0 passes | P0 performance instrumentation (config-convergence) |
| Hot config update (persist + cache invalidation + `config-updated` without rebuild) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (runtime spec 10.6, 10.9) |
| Cold config update during active generation (no interruption) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (fence/drain/reboot while a generation streams; LOCK-011) |
| Burst config updates (coalescing of overlapping cold saves) | Not proven | TBD | TBD | TBD | P0 performance instrumentation (runtime spec 10.6, 10.9) |
| Startup-loaded services / removed-feature initialization count | Not proven | TBD | TBD | TBD | P0 static inventory + runtime measurement (LOCK-PERF-3) |
| Startup-work net reduction vs baseline | Not proven | TBD | TBD | TBD | P0 baseline comparison; thresholds TBD product/engineering decision (section 9) |

Estimates such as 20-40% or 30-50% startup reduction are hypotheses only and must
not be used as acceptance claims (LOCK-PERF-6). Numeric thresholds are recorded
product/engineering decisions (section 9), never invented here.

## 9. Decisions / Open Questions

Product questions mirror the direction spec (section 14); runtime bounded
implementation decisions mirror the runtime spec (section 9). `TBD` means
undecided; decisions are returned to the hub, never invented here. Product
removals themselves are decided (LOCK-001..006) and are not open questions.

| # | Question | Decision | Owner | Required by | Status |
|---|---|---|---|---|---|
| 1 | Final meaning of 'topic': derived navigation label, session-metadata facet, or new persisted grouping model? | TBD | Hub | P1 | Open |
| 2 | When does the sidebar deprecation notice ship relative to P1 navigation? | TBD | Hub | P1/P3.1 | Open |
| 3 | What exact counts form the P0 complexity baseline (message types, provider methods, webview entry points)? | TBD | Hub | P0 | Open |
| 4 | Sidebar removal timing/order within P3.1 and adoption thresholds | Removal decided (LOCK-001); numeric thresholds TBD | Hub | P3.1 | Partial |
| 5 | Which consolidated configuration surface replaces settings/profile/marketplace panels, and how does it present custom provider records? | TBD | Hub | P3/P4.1 | Open |
| R1 | Private transport protocol | Bounded implementation decision | Implementation (P0/P1) | P4.2 | Open |
| R2 | Storage engine for extension-owned state | Bounded implementation decision | Implementation (P0/P1) | P4.1 | Open |
| R3 | Numeric startup SLA | Bounded product decision | Hub | P5 | Open |
| R4 | Adoption thresholds for removal timing | Bounded product decision | Hub | P3 | Open |
| R5 | Exact project harness-assets path | Bounded implementation decision | Implementation (P0/P1) | P4.1 | Open |
| R6 | Dual-read window deadline date | Bounded implementation decision | Implementation (P0/P1) | P4.3 | Open |
| R7 | Performance gate thresholds (startup stages, prompt-submit/first-token, stream-render, tool/permission, session-switch, config-update, removal reduction) | Recorded product/engineering decision; no invented numerics (LOCK-PERF-6) | Hub/Engineering | P0 baseline; P3/P4/P5 performance gates | Open |
| R8 | Benchmark tooling/harness choice | Internal implementation choice; not prescribed by the runtime spec | Implementation (P0/P1) | P0 | Open |

## 10. Risk / Blocker Log

| Date | Phase | Risk / Blocker | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| 2026-08-10 | All | Residual worktree/Diff Viewer and other removed features remain implemented in the current branch | Removal phases must treat them as cleanup scope, never as retained capabilities | Removal inventory (section 7) and P3 gates; truthful current-state claims (LOCK-013) | Manifestor | Monitored |
| 2026-08-10 | P4 | Dual authority could outlive the migration bridge | Old path retained indefinitely; contract drift | Explicit dual-read deadline (R6); old CLI/server deletion (P4.5) | Manifestor | Monitored |
| 2026-08-10 | P4 | Config authority change could interrupt active generations | Generation snapshot instability | Atomic version creation + snapshot pinning (LOCK-011, runtime spec section 5) | Manifestor | Monitored |
| 2026-08-10 | P5 | Selector availability gated on backend state could regress during migration | Startup degraded until backend ready | Persisted indexes before worker readiness; action-specific gates (LOCK-012) | Manifestor | Monitored |
| 2026-08-10 | All | No performance measurements exist; estimates (e.g. 20-40%/30-50%) could become acceptance claims | Unmeasured magnitudes; false performance claims | Evidence-only gates (LOCK-PERF-6); hypotheses flagged; P0 baseline required (section 8) | Manifestor | Monitored |
| 2026-08-10 | P3-P5 | Removed features might still initialize at worker startup (residual code) | Startup work does not decline despite removal | Measured net startup-work reduction per removal subphase (LOCK-PERF-3, runtime spec section 10) | Manifestor | Monitored |
| 2026-08-10 | P0-P2 | Transport/event overhead misattributed as the dominant latency | Wrong optimization target | LOCK-PERF-7: measure model/network/tool/approval separately from transport/event overhead | Manifestor | Monitored |
| 2026-08-10 | P0 | Unbounded benchmark capture could grow process memory without bound during a long/hung sample run | Harness OOM; invalid benchmark run | Bounded capture implemented: raw output retained only as a `capBytes` byte-capped tail with `MAX_SEGMENTS` object bound (`packages/kilo-vscode/script/p0-bench/parse.ts`); covered by `tests/unit/p0-bench-capture.test.ts`, `p0-bench-parse.test.ts`, `p0-bench-cleanup.test.ts`, `p0-bench-stats.test.ts` | Manifestor | Resolved |
| 2026-08-10 | P0 | Unbounded worker stderr accumulation could grow extension-host memory over the worker lifetime | Extension-host memory growth; lost diagnostics | Bounded diagnostic stderr tail: `MAX_STDERR_TAIL_LINES` (100 lines) and `MAX_STDERR_TAIL_BYTES` (16 KiB) caps with reassembly (`packages/kilo-vscode/src/services/cli-backend/stderr-tail.ts`); covered by `tests/unit/stderr-tail.test.ts` | Manifestor | Resolved |
| 2026-08-10 | P0 | Environmental esbuild-watcher process attribution (a non-owned process observed during harness runs) could be misread as a harness/benchmark defect | Misattributed performance or resource claims | Left unresolved as an attribution question; it is not a benchmark claim and no metric depends on it (LOCK-PERF-6) | Manifestor | Monitored |

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

## 12. Links

- ADR-0002: [`../adr/0002-focus-vscode-on-agent-orchestration.md`](../adr/0002-focus-vscode-on-agent-orchestration.md)
- ADR-0003: [`../adr/0003-replace-cli-configuration-with-private-gui-runtime.md`](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md)
- Direction spec: [`agent-orchestration-direction.md`](agent-orchestration-direction.md)
- Runtime/config spec: [`runtime-and-configuration-direction.md`](runtime-and-configuration-direction.md)
- P0 current-state inventory: [`p0-current-state-inventory.md`](p0-current-state-inventory.md)
- Canonical architecture docs: unchanged (LOCK-013), `packages/kilo-docs/pages/contributing/architecture/`
