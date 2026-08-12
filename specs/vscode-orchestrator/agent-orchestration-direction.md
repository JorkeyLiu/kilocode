# VS Code Agent Orchestrator - Technical Direction

## Goal

Internal technical specification for the VS Code Agent Orchestrator: the only
product is the extension as an orchestrator of concurrent agent sessions, with
topic/session navigation as the main view and the full harness capability boundary
explicitly preserved. This document is the durable cross-session context: a fresh
session must be able to read this file and continue the work without rediscovering
the locked decisions, the target surfaces, the harness invariants, or the
migration phases.

The durable architecture decisions are recorded separately in
[ADR-0002: Focus VS Code on Agent Orchestration](../adr/0002-focus-vscode-on-agent-orchestration.md)
(Status: Active) and
[ADR-0003: Replace CLI Configuration with Private GUI Runtime](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md)
(Status: Active). This document is the implementation source of truth for product
direction, target surfaces, capability matrix, bounded target architecture,
product migration phases, acceptance gates, compatibility policy, risks, and open
questions. Runtime/config migration (private worker, GUI-owned configuration,
immutable snapshots, startup readiness) is owned by
[`runtime-and-configuration-direction.md`](runtime-and-configuration-direction.md)
under ADR-0003.

This is an internal specification under the existing `specs/` convention (same as
`specs/storage/` and `specs/v2/`). It is not itself an ADR and is not a public
feature proposal. It does not change any source code, canonical architecture docs,
docs/nav, or generated artifacts, and it creates no changeset.

## 1. Status And Decisions

### 1.1 Locked decisions

These decisions are already made and are non-negotiable for every phase of this
project.

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

The performance locks LOCK-PERF-1..7 are the performance decision family; their
full model, cost attribution, instrumentation plan, benchmark scenarios, and
regression gates live in the runtime spec (section 10).

### 1.2 Implementation status (current)

| Area | Status |
|---|---|
| Shared `kilo serve` backend via `KiloConnectionService` + `ServerManager` | Current behavior; migration bridge only, not a target contract (LOCK-009) |
| Ordinary single-chat sidebar | Current behavior; on the deprecation/removal path (LOCK-001) |
| Agent Manager editor tab (parallel sessions, terminals, setup scripts) | Current behavior; orchestration surface; worktree capabilities are cleanup scope, not retained (LOCK-002) |
| Worktree infrastructure and custom Diff Viewer surfaces | Residual implementation present; removal decided (LOCK-002), not a retained capability |
| Cloud sessions, JetBrains, Console, KiloClaw | Residual implementation present; removal decided (LOCK-003) |
| Indexing, project memory, user-visible context management/compaction, autocomplete | Residual implementation present; removal decided (LOCK-004); only a minimal internal context-overflow safeguard is retained (LOCK-005) |
| Preset provider identities/catalogs, models.dev dependency, onboarding/organization sources | Residual implementation present; removal decided (LOCK-006) |
| Backend-gated selector readiness (`extensionDataReady`) | Current behavior; target is action-specific readiness (LOCK-012), owned by the runtime spec |
| Performance instrumentation / baseline | P0 baseline recorded (2026-08-12): descriptive n=5 sample statistics with exact evidence paths in the tracker (section 8) from six accepted campaigns; target-surface parity and all numeric thresholds remain Not proven (LOCK-PERF-6); R7 stays Open and is not a P0 blocker (required-by = before the first threshold-using performance gate; runtime spec section 9); existing partial instrumentation (`kilo startup`, provider `log.time`, Effect spans, ACP profiling) is not sufficient for extension acceptance (runtime spec section 10.11) |
| Topic/session navigation | Not implemented; provisional navigation language |
| Canonical architecture docs rewrite | Not done; locked out (LOCK-013) |

This table is a point-in-time snapshot; mutable phase status, exit evidence,
blockers, and next actions are tracked in
[`migration-tracker.md`](migration-tracker.md), which is the source of truth for
progress (ADR-0002 invariant I-10).

### 1.3 Current product surface inventory

Grounded in the canonical architecture docs (`vscode-extension.md`) and
`packages/kilo-vscode/AGENTS.md`.

| Surface | Location | Role today | Target classification |
|---|---|---|---|
| Ordinary single-chat sidebar | Activity bar (`kilo-code.SidebarProvider`) | Single-session chat | Deprecate, then remove (LOCK-001) |
| Editor chat tab | Open in Tab | Single-session chat in an editor panel | Migrate into orchestration panels |
| Agent Manager | Editor tab | Parallel sessions, terminals, setup scripts | Core orchestration surface; worktree capabilities removed (LOCK-002) |
| Diff viewer / diff virtual | Webviews | Diff rendering | Removed (LOCK-002); native VS Code diff APIs may serve checkpoint review |
| KiloClaw | Webview | Additional assistant surface | Removed (LOCK-003) |
| Cloud session surfaces | Panels/routes | Cloud sessions | Removed (LOCK-003) |
| JetBrains / Console | Separate products | Editor product, browser console | Removed (LOCK-003) |
| Settings / profile / marketplace | Panels | Configuration and accounts | Consolidate into GUI-owned configuration (ADR-0003) |
| Autocomplete | Editor assistance | Inline completions + commit messages | Removed (LOCK-004) |
| Indexing / memory / context management | Backend + UI | Semantic search, memory, compaction | Removed (LOCK-004); internal overflow safeguard retained (LOCK-005) |

Shared facts that the direction builds on: one extension host, one shared
`KiloConnectionService`, one `kilo serve` child process today; SSE events filtered
per webview via `trackedSessionIds`; webview state carried over `postMessage`.
Worktrees under `.kilo/worktrees/` are removal scope (LOCK-002).

## 2. Product Thesis

The extension is the user's orchestrator for many concurrent Coding Agents. One
extension window is a control room: open sessions in editor panels, navigate them
by topic, run them in parallel, delegate sub-tasks to specialized agents, watch
background progress, and inspect work product - while every session remains a
first-class Coding Agent with the full harness (custom agents, tools, skills, MCP,
permissions, user-selected custom-provider models, persistence, lifecycle,
checkpoint rollback, internal context-overflow reliability).

The orchestrator UI is a product surface; the harness is the kernel. The two are
separable by ownership (section 7 and the runtime spec) but never by capability: a
smaller product must not produce a weaker agent runtime (LOCK-008).

Performance objective: performance simplification is a primary objective alongside
product coherence (LOCK-PERF-1). CLI/TUI/Console are not products (LOCK-009), so
deleting them is a product decision; runtime slimming is a separate, measured
engineering program. Removed features never contribute to worker startup/readiness
(LOCK-PERF-3), persisted selectors render before worker readiness (LOCK-PERF-4),
harness semantics and performance correctness are preserved (LOCK-PERF-5), and no
performance claim is accepted without runtime evidence (LOCK-PERF-6). The full
performance model - cost attribution, instrumentation plan, benchmark scenarios,
and regression gates - is owned by the runtime spec
([`runtime-and-configuration-direction.md`](runtime-and-configuration-direction.md),
section 10).

## 3. User Journey

1. Open the workspace; the orchestration view shows active sessions grouped by
   topic.
2. Pick a topic or open a new session in an editor panel; choose an agent and a
   model from a user-defined provider for that session.
3. Spawn several concurrent sessions, each running in the background in parallel.
4. Delegate a sub-task: a session forks a child session with a specialized agent
   and a defined task; results flow back to the parent.
5. Monitor progress across panels; resolve permission/question flows inline.
6. Review a checkpoint: withdrawing or reverting a message restores affected code
   through SessionRevert + Snapshot semantics (LOCK-007), reviewed with native VS
   Code diff APIs (LOCK-002).
7. Return later: sessions, events, and artifacts persist (ADR-0001) and resume in
   place.

The ordinary single-chat sidebar habit is replaced by this loop through migration
affordances, not by a forced break (section 10).

## 4. Terminology Boundaries

| Term | Definition | Boundary |
|---|---|---|
| Agent | A session's runtime persona configured by agent files (harness concept) | Harness kernel; the UI selects it, never redefines it |
| Session | One agent run instance with a transcript; may have parent/child relations | Harness kernel; the UI navigates and controls it |
| Topic | Provisional navigation label for grouping sessions | NOT a persisted domain model until specified (open question 1) |
| Orchestrator UI | The product surface: panels, navigation, controls, panel lifecycle | Extension product ownership (section 7) |
| Harness kernel | Runtime: agents, tools, permissions, session model, storage, lifecycle, execution, checkpoint rollback, context-overflow safeguard | Private runtime ownership (ADR-0003, runtime spec) |
| Private runtime | Extension-owned headless worker process, outside the Extension Host | Runtime ownership (ADR-0003) |
| Ordinary single-chat sidebar | The deprecated chat surface, distinct from topic/session navigation | On the deprecation/removal path (LOCK-001) |
| Custom provider | A user-defined provider record: endpoint, protocol, model definitions, or supported discovery | Only provider kind retained (LOCK-006) |
| Checkpoint rollback | SessionRevert + Snapshot semantics for withdrawing/reverting messages | Harness capability, distinct from ADR-0001 storage rewriting (LOCK-007) |

## 5. Target Product Surfaces

| Surface | Role | Notes |
|---|---|---|
| Orchestration panel (editor tab) | Primary surface: session grid/list grouped by topic, spawn/stop/pause, agent + model selection, delegation | Reuses the Agent Manager pattern; worktree controls removed (LOCK-002) |
| Session editor panels | Open sessions in editor tabs for focused single-session work | Replaces the ordinary single-chat sidebar habit via migration affordances |
| Topic/session navigation | Main navigation: switch between topics and sessions | Provisional language; derived from session metadata until specified |
| Checkpoint review | Native VS Code diff APIs for reviewing a revert/withdraw | Not a custom Diff Viewer surface (LOCK-002) |
| Configuration surface | GUI-owned product/UI configuration and custom provider records | Extension application state + SecretStorage (ADR-0003, LOCK-010) |

Not target surfaces: worktrees, custom Diff Viewer webviews, cloud sessions,
JetBrains, Console, KiloClaw, indexing, project memory, user-visible context
management, autocomplete, preset provider identities (LOCK-001..006).

## 6. Harness Capability Matrix

Every LOCK-008 capability is an architectural invariant. The invariant column
states what must always hold; the target-surface acceptance criterion is the
falsifiable evidence a phase must record in the migration tracker before claiming
the capability from the target surface; the current-status column is implemented
reality today in the CLI harness and is not a claim that any target-surface
criterion already passes.

| # | Capability | Invariant | Target-surface acceptance criterion | Current status | Orchestrator relation |
|---|---|---|---|---|---|
| H-1 | Custom agents | Users can define and select custom agents per session; agent config is honored by the harness | From an orchestration panel, a user can spawn a session selecting a user-defined custom agent by name, and the session runs under that agent's config | Implemented in CLI harness (agent config, per-session selector); target-surface parity unproven | Per-session agent selector in orchestration panel |
| H-2 | Sub-task delegation | Sessions can delegate to child agents/sessions with defined tasks and result flow-back | From an orchestration panel, a session can delegate a defined sub-task to a child session and the result flows back to the parent, visible in navigation | Implemented in CLI harness (child sessions, delegated subagent) | Primary orchestration gesture; must be surfaced in panels |
| H-3 | Extensible tools | Tool registry is extensible (builtin + plugin + user tools) and per-session | A session spawned from a panel exposes the full tool registry, and a user-defined tool is invocable in that session | Implemented in CLI harness | Exposed per session; UI never hard-codes a fixed tool set |
| H-4 | Skills | Skills load and run per session | A skill is loadable and runnable from a panel-hosted session, with selection remaining harness-owned | Implemented in CLI harness | Invocable from panels; selection stays harness-owned |
| H-5 | MCP | MCP servers are configured and used per session | A session spawned from a panel with MCP configured has its MCP tools available and usable | Implemented in CLI harness | Per-session tool source; configuration GUI-owned (LOCK-010) |
| H-6 | Permission/question flows | Every tool permission and question resolves through the permission flow | A tool permission or question raised by a panel-hosted session resolves inline through the permission flow, and the outcome is applied to that session | Implemented in CLI harness | Rendered inline in panels |
| H-7 | Parent-child sessions | Parent/child session relations are first-class and preserved | Topic/session navigation shows parent/child session hierarchy, and relations persist across panel restarts | Implemented in CLI harness | Navigation must show hierarchy |
| H-8 | Background/parallel execution | Sessions run in background and in parallel, without worktree isolation as a requirement | Two or more panel-hosted sessions run concurrently in the background, and each remains controllable | Implemented in CLI harness (Agent Manager) | Core orchestration behavior; worktrees are not a harness invariant (LOCK-008) |
| H-9 | User-selected custom-provider models | Per-session model and reasoning-variant selection, restricted to models offered by user-defined/custom providers | Each panel-hosted session selects its own model and reasoning variant from a user-defined provider independently, and the selection applies | Implemented in CLI harness (agent/model selectors); preset-provider removal not done (LOCK-006) | Per-session selector in panels |
| H-10 | Persistence | Sessions, events, and artifacts persist and resume across extension restarts | A panel-hosted session's transcript, events, and artifacts persist across an extension restart and resume in place | Implemented (existing storage behavior); ADR-0001 checkpoint/resync rewriting is a separate, unimplemented direction and is not evidence of current behavior | Unchanged by this direction; UI does not own state |
| H-11 | Lifecycle correctness | Session create/pause/resume/close/cleanup, process ownership, and resource release are correct | Panel-driven create/pause/resume/close drives the harness lifecycle API and releases processes/resources correctly, with no bypass | Implemented in CLI harness | UI must drive lifecycle through harness APIs, never bypass them |
| H-12 | Checkpoint rollback | SessionRevert + Snapshot semantics: withdrawing/reverting a message restores affected code, with unrevert/cleanup and lifecycle correctness; distinct from ADR-0001 storage checkpoint/resync | From a panel-hosted session, withdrawing/reverting a message restores the affected code state, the revert can be un-reverted or cleaned up, and lifecycle stays correct | Implemented (SessionRevert + Snapshot in CLI harness); not conflated with ADR-0001 | Review via native VS Code diff APIs (LOCK-002) |
| H-13 | Internal context-overflow safeguard | Long-running agents keep functioning past context limits through a minimal internal safeguard; it is an invisible harness reliability mechanism, not a user-facing context-management product | A long-running panel-hosted session remains functional at context overflow with no user-facing context-management UI, and the safeguard never surfaces as a context-management product | Existing compaction machinery present; no requirement to preserve it (LOCK-005) | Invisible; no UI surface |

No parity suite exists today: the target-surface acceptance criteria above are
unproven until each phase records objective evidence (issue/PR/test/doc links) in
the migration tracker's capability evidence table. The "current status" column
describes the CLI harness today, not target-surface parity.

## 7. Ownership Principles

- Orchestrator UI/product owns: panels, navigation, topic labels, panel
  lifecycle, message routing within the extension, and GUI-owned configuration and
  persisted selector indexes (ADR-0003, LOCK-010).
- Harness kernel (private runtime) owns: agents, tools, permissions, session
  model, storage, lifecycle, execution, checkpoint rollback, and the internal
  context-overflow safeguard. The runtime is an extension-owned private headless
  worker outside the Extension Host (LOCK-009).
- The existing `kilo serve` HTTP/SSE/generated-SDK path is a migration bridge, not
  a target compatibility contract (LOCK-009); the private transport is an internal
  implementation choice.
- No rewrite: migration proceeds by consolidation and removal phases, not by
  rebuilding the extension or the backend.
- Only user-defined/custom providers are retained (LOCK-006); preset provider
  identities/catalogs are removed.
- Canonical architecture docs are updated only when implementation changes reality
  (LOCK-013).
- 'topic' is provisional navigation language; deciding its persisted meaning is a
  product decision returned to the hub, not made here.

## 8. Bounded Target Architecture

The target shape, bounded to avoid scope creep:

- One extension host and one extension-owned private headless worker (LOCK-009).
  All sessions, panels, and orchestration views ride it; no second runtime.
- Orchestration panel as the primary surface with topic/session navigation as the
  main view; session editor panels for focused work.
- A reduced webview set: orchestration panel + session panels + configuration
  surface. Removed surfaces (sidebar at P3.1, diff viewer/diff virtual at P3.2,
  KiloClaw at P3.3, autocomplete at P3.4) retire their message types and entry
  points.
- GUI-owned configuration and persisted selector indexes (LOCK-010); custom
  provider records only (LOCK-006); immutable versioned runtime snapshots
  (LOCK-011). Detailed ownership, provider, config, and startup semantics are
  owned by `runtime-and-configuration-direction.md`.
- No new persisted domain model for 'topic' in this direction; navigation derives
  grouping from existing session metadata until open question 1 is decided.
- No worktree execution, no custom diff surfaces, no cloud/Console/JetBrains
  surfaces (LOCK-002, LOCK-003).
- Removed features never contribute to startup/readiness (LOCK-PERF-3): a removal
  phase is not complete while the removed feature still initializes during worker
  startup. Measured startup-work reduction is recorded per the runtime spec
  performance gates (section 10).

Anything that names new message types, new webview entry points, or new state
files is a proposal owned by the phase that introduces it, not committed here.

## 9. Removal Inventory

All rows are decided removals (LOCK-001..006); none are deferred. Evidence
categories for each removal (source/tests/docs/generated SDK/config/i18n/build/
package) are tracked in `migration-tracker.md` section 7. Removals are also
performance gates: a removed feature must not contribute to worker
startup/readiness (LOCK-PERF-3), and each removal subphase records a measured net
startup-work reduction against the P0 performance baseline (runtime spec section
10.9-10.10).

| Removal (LOCK) | What is removed | Residual today | Gate |
|---|---|---|---|
| Ordinary single-chat sidebar (LOCK-001) | The sidebar surface and its dependent code | Present; on deprecation/removal path | P3.1 |
| Worktree infrastructure (LOCK-002) | Worktree session isolation, `.kilo/worktrees/`, setup scripts, worktree diff/review | Residual implementation in Agent Manager; cleanup scope | P3.2 |
| Custom Diff Viewer surfaces (LOCK-002) | Diff Viewer and Diff Virtual webviews | Residual webviews present | P3.2 |
| Cloud sessions (LOCK-003) | Cloud session panels and routes | Present | P3.3 |
| JetBrains (LOCK-003) | `packages/kilo-jetbrains/` product | Present | P3.3 |
| Console (LOCK-003) | `packages/kilo-console/` and CLI console surface | Present | P3.3 |
| KiloClaw (LOCK-003) | KiloClaw webview and bootstrap | Present | P3.3 |
| Indexing (LOCK-004) | `packages/kilo-indexing/`, semantic search tool, indexing status | Present | P3.4 |
| Project memory (LOCK-004) | Memory tools, memory fetch, system-prompt injection | Present | P3.4 |
| User-visible context management/compaction (LOCK-004) | Compaction settings and context-management UI | Present; internal overflow safeguard retained separately (LOCK-005) | P3.4 |
| Autocomplete (LOCK-004) | Inline completions and commit-message generation | Present | P3.4 |
| Preset providers/catalog/onboarding/org sources (LOCK-006) | Preset provider identities, models.dev catalog, bundled gateway onboarding/auth, organization/cloud provider sources | Present | P4.4 |

## 10. Migration Phases

Dependencies run top to bottom. Each phase ships its exit criteria before the next
starts. Phases are directional and gated; nothing here claims implemented removal.
Phase status and exit evidence are recorded in the migration tracker, which is the
source of truth for progress. Product phases P0-P3 are defined below; runtime and
startup phases P4 (private runtime and configuration) and P5 (startup and selector
readiness) are owned by `runtime-and-configuration-direction.md` and tracked here
in full detail. Every consolidation or removal phase ships only with a documented,
concrete rollback/revert path (section 11); this does not mandate a new
feature-flag subsystem.

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 Baseline inventory | Freeze the surface inventory (1.3), message protocol inventory, removal inventory (section 9), and runtime/config root-cause inventory (runtime spec 2); build a runnable baseline fixture/inventory for the named H-1..H-13 flows; execute the performance instrumentation plan and baseline (runtime spec section 10); resolve bounded decisions required by P0/P1 (runtime spec 9) | Runnable baseline fixture/inventory covering the named H-1..H-13 harness flows; reproducible surface/protocol/removal/root-cause inventories; baseline counts recorded in the tracker metrics; P0 performance baseline recorded in the tracker metrics (runtime spec section 10); bounded decisions recorded |
| P1 Orchestration-first navigation | Topic/session navigation as the main view over the migration bridge backend; session picker; ordinary single-chat sidebar keeps working unchanged | Navigation works across sessions; no sidebar capability change; no worktree dependency (LOCK-002) |
| P2 Harness surface parity | Every H-1..H-13 capability reachable from orchestration panels (agent/model selectors, delegation, tools/skills/MCP, permission rendering, checkpoint review) | Every H-1..H-13 target-surface acceptance criterion (section 6) passes from the target surface, with each criterion's named evidence (issue/PR/test/doc links) recorded in the tracker capability table |
| P3 Product removal | Remove the decided surfaces: P3.1 sidebar deprecation then removal (LOCK-001); P3.2 worktree infrastructure + custom Diff Viewer surfaces (LOCK-002); P3.3 cloud/JetBrains/Console/KiloClaw (LOCK-003); P3.4 indexing/memory/context-management/autocomplete (LOCK-004) | Each removal's evidence recorded in the tracker removal inventory (source/tests/docs/generated SDK/config/i18n/build/package); H-1..H-13 parity intact (P2 evidence); documented rollback/revert path shipped with the phase; no removed feature reclassified as deferred |

## 11. Acceptance Gates And Complexity Budgets

- Capability parity gate: before any surface is removed, every H-1..H-13
  target-surface acceptance criterion (section 6) has recorded, falsifiable
  evidence from the target surface (P2 exit criterion), captured in the tracker's
  capability evidence table with issue/PR/test/doc links.
- No capability regression: harness invariants (H-1..H-13) hold across every
  phase; regression tests cover agent/delegation/tool/skill/MCP/permission/
  checkpoint/overflow flows, not only rendering.
- Removal completeness gate: each removal (section 9) has evidence per category
  that exists for it in the tracker removal inventory; nothing is removed
  silently, and nothing removed is reclassified as deferred.
- Complexity budget: each consolidation phase nets a measurable reduction in
  webview message types, provider methods, and webview entry points against the P0
  baseline, with before/after counts recorded in the tracker metrics. Budgets are
  counts, not aspirations; a phase that nets no reduction has not met its exit
  criteria.
- Rollback/revert gate: before a consolidation or removal phase ships, it
  documents and ships a concrete rollback/revert path (e.g., revert commit,
  surface re-enablement, message-type restoration). This does not mandate a new
  feature-flag subsystem.
- Runtime/config gates: snapshot pinning per generation, no active-generation
  interruption, atomic version creation, action-specific readiness, and the
  dual-read deadline (runtime spec sections 5-7) gate P4; startup acceptance
  criteria (runtime spec section 6) gate P5.
- Performance gate: no performance claim without runtime evidence (LOCK-PERF-6);
  every phase compares against the P0 performance baseline recorded in the
  tracker; removals yield a measurable net startup-work reduction and no
  harness-semantics regression (LOCK-PERF-3, LOCK-PERF-5). Numeric thresholds are
  recorded product/engineering decisions, never invented here; estimates such as
  20-40% or 30-50% are hypotheses only and are not acceptance claims. Model and
  gate details live in the runtime spec (section 10).
- Compatibility gate: released-client behavior and stored state stay compatible
  (section 12).
- Architecture gate: canonical docs are touched only when implementation lands
  (LOCK-013); decision/spec artifacts do not count as implementation.

## 12. Compatibility Policy

- The extension is a client of the harness kernel; the private runtime relation is
  owned by ADR-0003 and the runtime spec. The existing `kilo serve` SDK surface is
  a migration bridge with an explicit dual-read deadline, never a permanent target
  contract (LOCK-009).
- One runtime model (extension host + one private worker) is the target;
  consolidation never spawns per-panel runtimes.
- User state stays with its current owners during migration; the target ownership
  domains (runtime spec section 3) assign one owner and one persistence path per
  datum. No state migration is proposed by this document beyond the runtime spec's
  phased read model.
- No changes to public product docs or canonical architecture docs until
  implementation lands (LOCK-013).
- Any removal keeps the harness reachable; removing a capability without a
  replacement surface is a capability cut and is prohibited (LOCK-008).
- Message types are removed only when their surface is removed (section 9 removal inventory, P3 phases);
  undecided surfaces' message types stay until disposition.
- Sidebar removal is a decided direction (LOCK-001) executed at P3.1 with a
  deprecation step; each consolidation/removal phase ships with a documented
  rollback/revert path (section 11).

## 13. Risks

| Risk | Mitigation |
|---|---|
| Sidebar migration churn for existing users | Directional deprecation, migration affordances, gated removal (P3.1) |
| 'topic' semantics undefined | Provisional language only; no persisted model; decided via open question 1 |
| Removal drops a needed harness capability | Capability parity gate (H-1..H-13) before any surface removal |
| Worktree removal breaks parallel-work expectations | Parallel execution is preserved without worktree isolation (H-8); worktrees are not a harness invariant (LOCK-008) |
| Context overflow without user-facing management regresses long agents | Internal safeguard retained (H-13, LOCK-005) |
| Runtime/config migration stalls or dual authority persists | Bounded dual-read with explicit deadline; P4/P5 gates owned by the runtime spec |
| Preset provider removal fragments model availability | Custom-provider-only boundary with generic protocol adapters (LOCK-006) |
| Canonical docs drift from implemented reality | LOCK-013: docs updated only when implementation lands |
| Budgets treated as goals instead of gates | Complexity budget enforced as counts in each consolidation phase (section 11) |
| Performance claims based on estimates (e.g. 20-40%/30-50%) become acceptance claims | Evidence-only gates (LOCK-PERF-6); hypotheses explicitly flagged; thresholds recorded by product/engineering decision (runtime spec section 10) |
| Removed features still initialize during worker startup | Startup work does not decline despite removal | Measured net startup-work reduction per removal subphase (LOCK-PERF-3, runtime spec section 10) |

## 14. Open Questions

These must be answered before the affected phase; product decisions are returned
to the hub rather than decided here. Runtime/config bounded implementation
decisions are listed in `runtime-and-configuration-direction.md` section 9.

1. Final meaning of 'topic': derived navigation label, session-metadata facet, or
   a new persisted grouping model? (Affects P1 navigation and section 8.)
2. When does the sidebar deprecation notice ship relative to P1 navigation?
   (P1/P3.1.)
3. What exact counts form the P0 complexity baseline (message types, provider
   methods, webview entry points)? RESOLVED (2026-08-12): 332 distinct webview
   message `type:` literals (WebviewMessage 189 + ExtensionMessage 143, disjoint
   sets); 250 generated v2 SDK `KiloClient` public methods (the extension
   imports `@kilocode/sdk/v2/client`); 6 HTML/webview esbuild entries,
   excluding the shiki worker asset. Reproducible commands and current counts:
   `p0-current-state-inventory.md` (sections 4.4/9/10); decision recorded in
   the migration tracker (section 9).
4. Sidebar removal timing/order within P3.1 and any adoption thresholds: LOCK-001
   decides removal; numeric thresholds remain a recorded product decision
   (bounded, runtime spec section 9).
5. Which consolidated configuration surface replaces settings/profile/marketplace
   panels, and how does it present custom provider records? (P3/P4.1.)

## 15. Current Status Summary

- Current (implemented): shared backend; ordinary single-chat sidebar + Agent
  Manager + open-in-tab panels; residual worktree and Diff Viewer infrastructure;
  cloud/JetBrains/Console/KiloClaw surfaces; indexing/memory/context-management/
  autocomplete; preset provider catalogs. These are residual implementation, not
  retained capabilities where removal is decided (LOCK-002/003/004/006).
- Not implemented: topic/session navigation, orchestration-first main view,
  product removals, private runtime, GUI-owned configuration, action-specific
  readiness. This direction is the design target, not shipped behavior.
- ADR-0002 records the durable product decision; ADR-0003 records the durable
  runtime/config decision; this document owns the product migration design; the
  runtime spec owns the runtime/config migration design.
- Phase status, exit evidence, and next actions are tracked in the migration
  tracker (`migration-tracker.md`), the source of truth for progress.

## Verification Commands

Markdown/table check for the five spec files (must pass without modifying
anything):

- `bun run script/check-md-table-padding.ts specs/adr/0002-focus-vscode-on-agent-orchestration.md specs/adr/0003-replace-cli-configuration-with-private-gui-runtime.md specs/vscode-orchestrator/agent-orchestration-direction.md specs/vscode-orchestrator/runtime-and-configuration-direction.md specs/vscode-orchestrator/migration-tracker.md`

Architecture impact check (run from repo root; report the outcome):

- `bun run script/check-architecture-impact.ts --worktree`

No source-code, test, or typecheck commands apply: this work creates decision/spec
artifacts only (LOCK-013).
