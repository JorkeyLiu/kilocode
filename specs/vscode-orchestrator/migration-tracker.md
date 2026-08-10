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
| P0 | Baseline inventory | Not started | - | Documentation foundation (ADR-0002, ADR-0003, direction spec, runtime spec, tracker) complete; no runnable fixture, inventories, counts, or performance baseline exist yet |
| P1 | Orchestration-first navigation | Not started | - | Gated on P0 |
| P2 | Harness surface parity | Not started | - | Gated on P1; requires H-1..H-13 criteria and named evidence |
| P3 | Product removal | Not started | - | Subphases P3.1-P3.4 (sidebar, worktree/diff, cloud/JetBrains/Console/KiloClaw, indexing/memory/context-management/autocomplete) |
| P4 | Private runtime and configuration | Not started | - | Subphases P4.1-P4.5 (GUI read model, private runtime entrypoint, dual-read, source removal, old CLI/server deletion); owned by runtime spec section 7 |
| P5 | Startup and selector readiness | Not started | - | Startup acceptance per runtime spec section 6 |

Initial status rationale: the ADRs, both direction specs, and this tracker are
complete documentation foundation (2026-08-10). All product, runtime/config, and
performance decisions are recorded (LOCK-001..013, LOCK-PERF-1..7); no
implementation has started. P0 discovery/baseline has not started: no runnable
fixture for the named H-1..H-13 flows, no surface/protocol/removal/root-cause
inventories, and no baseline counts exist, and no issues/PRs/tests are linked
here. No performance measurements exist on the current branch: all performance
evidence is Not proven (LOCK-PERF-6). Nothing below claims implementation
progress.

## 5. Phase Details And Exit Checklists

Exit criteria below are taken from the direction spec (section 10) and the runtime
spec (sections 5-7). Each checkbox is complete only when objective evidence
(issue/PR/test/doc) is recorded alongside it.

### P0 - Baseline inventory

- Status: Not started
- Scope: Freeze the surface inventory (direction spec 1.3), message protocol
  inventory, removal inventory (direction spec section 9, tracker section 7), and
  runtime/config root-cause inventory (runtime spec section 2: config sources,
  provider sources/loaders, readiness chain stages, convergence machinery); build
  a runnable baseline fixture/inventory for the named H-1..H-13 flows; resolve the
  bounded implementation decisions required by P0/P1 (runtime spec section 9).
- Exit checklist:
  - [ ] Runnable baseline fixture/inventory covering the named H-1..H-13 harness flows
  - [ ] Reproducible surface inventory (direction spec 1.3)
  - [ ] Message protocol inventory (used/unused per the P0 protocol inventory)
  - [ ] Removal inventory for all LOCK-002/003/004/006 removals with source paths (section 7)
  - [ ] Runtime/config root-cause inventory: enumerated config sources, provider sources/loaders, readiness chain stages, convergence machinery paths (runtime spec section 2)
  - [ ] Baseline counts recorded in section 8
  - [ ] Open question 3 resolved (exact baseline metric definitions)
  - [ ] Bounded implementation decisions required by P0/P1 recorded (runtime spec section 9)
  - [ ] Performance instrumentation executed at the runtime spec (section 10.8) instrumentation points; per-stage cold/warm timings recorded in section 8
  - [ ] P0 performance baseline metrics recorded in section 8 with evidence links (all performance evidence Not proven until recorded; LOCK-PERF-6)
  - [ ] Benchmark scenarios (runtime spec section 10.9) runnable and reproducible
  - [ ] Static redundancy candidate inventory recorded (module-scope AppRuntime handle + AppLayer graph construction at listener build, per-instance bootstrap, feature-layer startup, removed-feature startup contributions; runtime spec section 10.4)
  - Evidence: issue: - | PR: - | test: - | doc: -
- Next actions: produce the runnable fixture; enumerate protocol routes and removal
  surfaces; enumerate config/provider/readiness root causes; establish baseline
  counts; instrument startup/request/config stages and record the P0 performance
  baseline (runtime spec section 10); record bounded decisions; open the baseline
  issue.

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
recorded here; no parity suite exists today and no criterion is claimed as
passing.

| # | Capability | Target-surface acceptance criterion | Status | Issue/PR | Test/Doc |
|---|---|---|---|---|---|
| H-1 | Custom agents | From an orchestration panel, a user can spawn a session selecting a user-defined custom agent by name, and the session runs under that agent's config | Not proven | - | - |
| H-2 | Sub-task delegation | From an orchestration panel, a session can delegate a defined sub-task to a child session and the result flows back to the parent, visible in navigation | Not proven | - | - |
| H-3 | Extensible tools | A session spawned from a panel exposes the full tool registry, and a user-defined tool is invocable in that session | Not proven | - | - |
| H-4 | Skills | A skill is loadable and runnable from a panel-hosted session, with selection remaining harness-owned | Not proven | - | - |
| H-5 | MCP | A session spawned from a panel with MCP configured has its MCP tools available and usable | Not proven | - | - |
| H-6 | Permission/question flows | A tool permission or question raised by a panel-hosted session resolves inline through the permission flow, and the outcome is applied to that session | Not proven | - | - |
| H-7 | Parent-child sessions | Topic/session navigation shows parent/child session hierarchy, and relations persist across panel restarts | Not proven | - | - |
| H-8 | Background/parallel execution | Two or more panel-hosted sessions run concurrently in the background, and each remains controllable, without worktree isolation | Not proven | - | - |
| H-9 | User-selected custom-provider models | Each panel-hosted session selects its own model and reasoning variant from a user-defined provider independently, and the selection applies | Not proven | - | - |
| H-10 | Persistence | A panel-hosted session's transcript, events, and artifacts persist across an extension restart and resume in place | Not proven | - | - |
| H-11 | Lifecycle correctness | Panel-driven create/pause/resume/close drives the harness lifecycle API and releases processes/resources correctly, with no bypass | Not proven | - | - |
| H-12 | Checkpoint rollback | From a panel-hosted session, withdrawing/reverting a message restores the affected code state, the revert can be un-reverted or cleaned up, and lifecycle stays correct; distinct from ADR-0001 | Not proven | - | - |
| H-13 | Internal context-overflow safeguard | A long-running panel-hosted session remains functional at context overflow with no user-facing context-management UI, and the safeguard never surfaces as a context-management product | Not proven | - | - |

## 7. Removal Inventory Evidence

Each removal row records evidence per category that exists for the item: `source`,
`tests`, `docs`, `generated SDK`, `config`, `i18n`, `build/package`. A `-` in a
category means no evidence exists; a removal is complete only when every existing
category has recorded evidence. No removal is reclassified as deferred.

| Removal (LOCK) | Phase | Source | Tests | Docs | Generated SDK | Config | i18n | Build/package |
|---|---|---|---|---|---|---|---|---|
| Ordinary single-chat sidebar (LOCK-001) | P3.1 | - | - | - | - | - | - | - |
| Worktree infrastructure (LOCK-002) | P3.2 | - | - | - | - | - | - | - |
| Custom Diff Viewer surfaces (LOCK-002) | P3.2 | - | - | - | - | - | - | - |
| Cloud sessions (LOCK-003) | P3.3 | - | - | - | - | - | - | - |
| JetBrains (LOCK-003) | P3.3 | - | - | - | - | - | - | - |
| Console (LOCK-003) | P3.3 | - | - | - | - | - | - | - |
| KiloClaw (LOCK-003) | P3.3 | - | - | - | - | - | - | - |
| Indexing (LOCK-004) | P3.4 | - | - | - | - | - | - | - |
| Project memory (LOCK-004) | P3.4 | - | - | - | - | - | - | - |
| User-visible context management/compaction (LOCK-004) | P3.4 | - | - | - | - | - | - | - |
| Autocomplete (LOCK-004) | P3.4 | - | - | - | - | - | - | - |
| Preset providers/catalog/onboarding/org sources (LOCK-006) | P4.4 | - | - | - | - | - | - | - |

## 8. Baseline / Complexity / Runtime Metrics

P0 establishes the baselines; later phases record measured deltas. Counts are
counts, not aspirations (direction spec section 11). `TBD` values are not
evidence.

| Metric | P0 baseline | Delta at P3 | Delta at P4 | Delta at P5 | Measurement source |
|---|---|---|---|---|---|
| Webview message types | TBD (open question 3) | TBD | TBD | TBD | P0 protocol inventory |
| Provider methods | TBD (open question 3) | TBD | TBD | TBD | P0 protocol inventory |
| Webview entry points | TBD (open question 3) | TBD | TBD | TBD | P0 surface inventory |
| Config sources merged | TBD (12+ today, runtime spec 2.2) | TBD | TBD | 1 | P0 config root-cause inventory |
| Provider source kinds (catalog/config/auth/org) | TBD (runtime spec 2.3) | TBD | TBD | 1 (custom records) | P0 provider root-cause inventory |
| Convergence/cold-rebuild passes | TBD (runtime spec 2.4) | TBD | TBD | 0 | P0 runtime root-cause inventory |
| Startup readiness stages before UI enable | TBD (runtime spec 2.5) | TBD | TBD | TBD | P0 readiness chain inventory |
| Removal items with full evidence | TBD | TBD | TBD | TBD | Section 7 |

Performance metrics (LOCK-PERF). P0 records the baseline with evidence links; no
performance metric is proven until then (LOCK-PERF-6). All values are
`Not proven`/TBD today; no measurements exist on the current branch.

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

## 11. Change Log

| Date | Change | By |
|---|---|---|
| 2026-08-10 | Initial creation: tracker for ADR-0002 migration; documentation foundation complete; all phases Not started | Manifestor execution of audit-correction task |
| 2026-08-10 | Final product boundaries (LOCK-001..008) and runtime/config decisions (LOCK-009..012, ADR-0003 + runtime spec) recorded; tracker revised: new decision locks, phase set P0-P5 with subphases, new H-1..H-13 parity matrix, removal inventory evidence, runtime metrics, updated decisions/risks; all phases still Not started; no implementation evidence | Manifestor execution of final-boundaries documentation task |
| 2026-08-10 | Performance made first-class: LOCK-PERF-1..7 recorded; performance model, cost attribution, instrumentation plan, benchmark scenarios, and regression gates added to the runtime spec (section 10); performance objective and removed-features-not-startup-dependencies rules added to the direction spec; tracker gained performance metrics (all Not proven), P0 profiling tasks, and P1/P2/P3 performance gates; no measurements exist on the current branch | Manifestor execution of performance-model documentation task |
| 2026-08-10 | Performance-doc audit corrections applied: TUI lazy rendering vs static CLI/TUI module-graph imports distinguished (magnitude unmeasured); AppLayer described as layer definition + lazy runtime handle with graph construction at server listener build, not at first import; benchmark scenarios mapped to explicit tracker metric rows (warm view, no-provider/custom-provider/many-agent-MCP startup, parallel child sessions, hot config update, cold-update no-interruption, burst coalescing); P4.4 exit evidence requires measured net startup-work reduction and absent removed-feature initialization; ambiguous provider citations qualified to `packages/opencode/src/provider/provider.ts`; worker CLI entry/module-graph load added to instrumentation points; all performance values remain Not proven | Manifestor execution of performance-doc audit-correction task |

## 12. Links

- ADR-0002: [`../adr/0002-focus-vscode-on-agent-orchestration.md`](../adr/0002-focus-vscode-on-agent-orchestration.md)
- ADR-0003: [`../adr/0003-replace-cli-configuration-with-private-gui-runtime.md`](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md)
- Direction spec: [`agent-orchestration-direction.md`](agent-orchestration-direction.md)
- Runtime/config spec: [`runtime-and-configuration-direction.md`](runtime-and-configuration-direction.md)
- Canonical architecture docs: unchanged (LOCK-013), `packages/kilo-docs/pages/contributing/architecture/`
