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
(Status: Active),
[ADR-0003: Replace CLI Configuration with Private GUI Runtime](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md)
(Status: Active),
[ADR-0004: Architecture-First Direct Reconstruction](../adr/0004-architecture-first-direct-reconstruction.md)
(Status: Active), and
[ADR-0005: Bounded Private-Runtime Storage](../adr/0005-bounded-private-runtime-storage.md)
(Status: Active; canonical storage foundation, superseding ADR-0001's
checkpoint + resync / multi-client transport target). This document is the implementation source of truth for product
direction, target surfaces, capability matrix, bounded target architecture,
product migration phases, acceptance gates, compatibility policy, risks, and open
questions. Runtime/config migration (private worker, file-authoritative
GUI-managed configuration, immutable snapshots, startup readiness) is owned by
[`runtime-and-configuration-direction.md`](runtime-and-configuration-direction.md)
under ADR-0003. The just-in-time direct-reconstruction policy (ADR-0004)
governs how every phase treats legacy features and behaviors outside the two
closed sets; its implementation detail lives in the migration tracker
(reconstruction candidate registry, section 7) and the runtime spec
(Failure/Outcome/Recovery target, section 7.2).

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
| LOCK-001 | Agent Manager is the only chat UI (hosting in Primary/Secondary Sidebar or editor group does not change judgment); `kilo-code.SidebarProvider` deleted at P3.1 and `kilo-code.new.TabPanel`/`kilo-code.new.openInTab` deleted in current working tree — P3.5 Complete (2026-09-01, validated `b2dc5002…` + `cd26b5f0…` `kilo-gc-lifecycle-proof/2`). |
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

The performance locks LOCK-PERF-1..7 are the performance decision family; their
full model, cost attribution, instrumentation plan, benchmark scenarios, and
regression gates live in the runtime spec (section 10). LOCK-PERF-1 is a
structural objective — removing redundant architecture — not a per-phase
optimization demand; there are no numeric pass/fail performance thresholds
(R7 resolved 2026-08-14, runtime spec sections 9-10).

### 1.2 Implementation status (current)

| Area | Status |
|---|---|
| Shared `kilo serve` backend via `KiloConnectionService` + `ServerManager` | Current behavior; migration bridge only, not a target contract (LOCK-009) |
| Ordinary single-chat sidebar (`kilo-code.SidebarProvider`) | Removed at P3.1 — no `viewsContainers`/`views` contribution, no `registerWebviewViewProvider` (LOCK-001) |
| TabPanel / Open in Tab (`kilo-code.new.TabPanel`/`kilo-code.new.openInTab`) | Removed in current working tree — manifest/serializer/commands/local tabs deleted; product is Agent Manager-only (P3.5 Complete 2026-09-01, `b2dc5002…` + `cd26b5f0…` `kilo-gc-proof/2`) (LOCK-001) |
| Agent Manager — only chat UI (any host: Primary/Secondary Sidebar or editor group) | Current behavior; sole chat surface; internal session sidebar/tabs/terminals/navigation/persistence/hydration retained; worktree capabilities are cleanup scope, not retained (LOCK-001/LOCK-002) |
| Worktree infrastructure and custom Diff Viewer surfaces | Residual implementation present; removal decided (LOCK-002), not a retained capability |
| Cloud sessions, JetBrains, Console, KiloClaw | Residual implementation present; removal decided (LOCK-003) |
| Indexing, project memory, user-visible context management/compaction, autocomplete | Residual implementation present; removal decided (LOCK-004); only a minimal internal context-overflow safeguard is retained (LOCK-005) |
| Preset provider identities/catalogs, models.dev dependency, onboarding/organization sources | Residual implementation present; removal decided (LOCK-006) |
| Backend-gated selector readiness (`extensionDataReady`) | Current behavior; target is action-specific readiness (LOCK-012), owned by the runtime spec |
| Performance instrumentation / baseline | P0 baseline recorded (2026-08-12): descriptive n=5 sample statistics with exact evidence paths in the tracker (section 8) from six accepted campaigns; target-surface parity remains Not proven; R7 resolved 2026-08-14 — no numeric pass/fail performance thresholds, P1/P2 compare descriptively on affected paths in a same environment, P3/P4 prove structural absence of removed work and record deltas (runtime spec sections 9-10); existing partial instrumentation (`kilo startup`, provider `log.time`, Effect spans, ACP profiling) is not sufficient for extension acceptance (runtime spec section 10.11) |
| Topic/session navigation | Not implemented; Topic decided as a derived navigation concept (Q1 resolved 2026-08-14, section 14) |
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
| Ordinary single-chat sidebar | `kilo-code.SidebarProvider` (Activity Bar) | — | Removed at P3.1 — deleted, must not be restored (LOCK-001) |
| Editor chat tab (`kilo-code.new.TabPanel`/`kilo-code.new.openInTab`) | — | — | Removed in current working tree (P3.5 Complete 2026-09-01) — no manifest/serializer/commands/local tabs (LOCK-001) |
| Agent Manager | Editor tab or Primary/Secondary Sidebar (host does not change judgment) | Only chat UI; parallel sessions, terminals, internal session sidebar/tabs/navigation/persistence/hydration | Core orchestration surface; sole chat UI (LOCK-001/LOCK-002) |
| Diff viewer / diff virtual | Webviews | Diff rendering | Removed (LOCK-002); native VS Code diff APIs may serve checkpoint review |
| KiloClaw | Webview | Additional assistant surface | Removed (LOCK-003) |
| Cloud session surfaces | Panels/routes | Cloud sessions | Removed (LOCK-003) |
| JetBrains / Console | Separate products | Editor product, browser console | Removed (LOCK-003) |
| Settings / profile / marketplace | Panels | Configuration and accounts | Consolidate into the file-authoritative configuration surface — a bidirectional editor/read model over canonical config files/assets (ADR-0003, runtime spec section 5.4) |
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
7. Return later: sessions and registered artifacts persist (ADR-0005) and
   resume in place.

The ordinary single-chat sidebar habit was replaced by this loop through migration affordances at P3.1 (now removed); TabPanel/Open in Tab habit is replaced by Agent Manager-only at P3.5 (Complete 2026-09-01, `b2dc5002…` + `cd26b5f0…`), not by a forced break (section 10).

## 4. Terminology Boundaries

| Term | Definition | Boundary |
|---|---|---|
| Agent | A session's runtime persona configured by agent files (harness concept) | Harness kernel; the UI selects it, never redefines it |
| Session | One agent run instance with a transcript; may have parent/child relations | Harness kernel; the UI navigates and controls it |
| Topic | Derived navigation concept: each root session defines one Topic; root session ID is stable Topic identity; root title is the label; descendants belong through parentID; activity is max member updatedAt; order descending with deterministic ID tie-break; orphan/missing-parent/cycle components degrade to independent Topics | NOT a persisted domain model — no independent Topic persistence/API/config/schema/metadata; selection/expansion is presentation state only (Q1 resolved 2026-08-14) |
| Orchestrator UI | The product surface: panels, navigation, controls, panel lifecycle | Extension product ownership (section 7) |
| Harness kernel | Runtime: agents, tools, permissions, session model, storage, lifecycle, execution, checkpoint rollback, context-overflow safeguard | Private runtime ownership (ADR-0003, runtime spec) |
| Private runtime | Extension-owned headless worker process, outside the Extension Host | Runtime ownership (ADR-0003) |
| Ordinary single-chat sidebar | Historical deprecated chat surface (`kilo-code.SidebarProvider`), distinct from topic/session navigation | Removed at P3.1 — deleted, must not be restored (LOCK-001) |
| TabPanel / Open in Tab | Historical editor-tab chat (`kilo-code.new.TabPanel`/`kilo-code.new.openInTab`), distinct from Agent Manager | Removed in current working tree — deleted (P3.5 Complete 2026-09-01) (LOCK-001) |
| Custom provider | A user-defined provider record: endpoint, protocol, model definitions, or supported discovery | Only provider kind retained (LOCK-006) |
| Checkpoint rollback | SessionRevert + Snapshot semantics for withdrawing/reverting messages | Harness capability, distinct from the ADR-0005 storage foundation and ADR-0001's historical checkpoint/resync (LOCK-007) |
| Operational fact | A runtime-owned fact about runtime/session state: session existence, lifecycle state, message presence/ordering, state-transition timing | Sole runtime authority; the UI renders it, never invents or revises it (runtime spec section 7.1) |
| Presentation state | Extension/webview state derived from runtime operational facts (read-model state) | Derived only; never authoritative for operational facts (runtime spec section 7.1) |
| Agent manifest | The typed, schema-validated canonical asset defining an agent's prompt and schema-approved specialization/defaults | Canonical typed asset (project or global); one manifest per agent ID; never widens enclosing policy (runtime spec section 5.2) |
| Permission policy stack | The restrictive composition of runtime hard safety ceilings, global/workspace policy, agent manifest policy, and session restrictions | Monotonic deny/ask/allow composition; provenance per decision (runtime spec section 5.3) |
| Effective configuration | Every user-authored datum that can affect a materialized generation snapshot | File-authoritative with canonical file/asset provenance; the UI and files are WYSIWYG (runtime spec sections 3.1, 5.1, 5.4) |
| Canonical config files/assets | The only two authored scopes: one global config root and `<workspaceRoot>/.kilo/` | The only effective-config inputs; no other authored scope, external path, or ancestor source (runtime spec section 3.1) |

Storage terminology — canonical aggregate, bounded changefeed, offline archive,
revert snapshot, config generation snapshot, and observation snapshot — is
defined in the storage spec (section 9) under ADR-0005. The last three keep
their boundaries here and in the runtime spec: revert snapshot is
SessionRevert + Snapshot storage (LOCK-007), config generation snapshot is the
immutable versioned config snapshot (runtime spec section 5), and observation
snapshot is an observation of runtime operational facts (runtime spec section
7.1); none is a competing durable store for session history.

## 5. Target Product Surfaces

| Surface | Role | Notes |
|---|---|---|
| Orchestration panel (Agent Manager — only chat UI) | Primary and sole chat surface: session grid/list grouped by topic, spawn/stop/pause, agent + model selection, delegation; may be hosted in Primary/Secondary Sidebar or editor group without changing judgment; internal session sidebar/tabs/terminals/navigation/persistence retained | Agent Manager only; TabPanel/Open in Tab deleted (LOCK-001/P3.5 Complete 2026-09-01); worktree controls removed (LOCK-002) |
| Topic/session navigation | Main navigation: switch between topics and sessions | Derived from root sessions (Q1 resolved 2026-08-14): identity = root session ID, label = root title, membership = parentID, activity = max member updatedAt, descending order with deterministic ID tie-break; selection/expansion is presentation state only |
| Checkpoint review | Native VS Code diff APIs for reviewing a revert/withdraw | Not a custom Diff Viewer surface (LOCK-002) |
| Configuration surface | File-authoritative configuration: a bidirectional editor/read model over canonical config files and typed assets | Canonical files under one global config root and `<workspaceRoot>/.kilo/`; secrets via SecretStorage; VS Code state is UI-local/derived only (ADR-0003, runtime spec section 5.4) |

Not target surfaces: `kilo-code.SidebarProvider` sidebar (removed P3.1), `kilo-code.new.TabPanel`/`kilo-code.new.openInTab` (removed P3.5 Complete 2026-09-01), worktrees, custom Diff Viewer webviews, cloud sessions, JetBrains, Console, KiloClaw, indexing, project memory, user-visible context management, autocomplete, preset provider identities (LOCK-001..006).

## 6. Harness Capability Matrix

Every LOCK-008 capability is an architectural invariant. The invariant column
states what must always hold; the target-surface acceptance criterion is the
falsifiable evidence a phase must record in the migration tracker before claiming
the capability from the target surface; the current-status column is implemented
reality today in the CLI harness and is not a claim that any target-surface
criterion already passes.

| # | Capability | Invariant | Target-surface acceptance criterion | Current status | Orchestrator relation |
|---|---|---|---|---|---|
| H-1 | Custom agents | Users can define and select custom agents per session; the session runs under the selected agent's typed manifest (one manifest per agent ID; duplicate/conflicting definitions fail validation; manifests never widen the enclosing permission/safety policy) | From an orchestration panel, a user can spawn a session selecting a user-defined custom agent by name, and the session runs under that agent's manifest (P2 proves this current capability). The typed-manifest contract — one canonical manifest per ID, duplicate/conflict validation, canonical file/asset provenance — is proven at P4 via the field-registry/schema gate (runtime spec sections 3.2, 5.2), not at P2 | Implemented in CLI harness (agent config, per-session selector); target-surface parity unproven | Per-session agent selector in orchestration panel |
| H-2 | Sub-task delegation | Sessions can delegate to child agents/sessions with defined tasks and result flow-back | From an orchestration panel, a session can delegate a defined sub-task to a child session and the result flows back to the parent, visible in navigation | Implemented in CLI harness (child sessions, delegated subagent) | Primary orchestration gesture; must be surfaced in panels |
| H-3 | Extensible tools | Tool registry is extensible (builtin + plugin + user tools) and per-session | A session spawned from a panel exposes the full tool registry, and a user-defined tool is invocable in that session | Implemented in CLI harness | Exposed per session; UI never hard-codes a fixed tool set |
| H-4 | Skills | Skills load and run per session | A skill is loadable and runnable from a panel-hosted session, with selection remaining harness-owned | Implemented in CLI harness | Invocable from panels; selection stays harness-owned |
| H-5 | MCP | MCP servers are configured and used per session | A session spawned from a panel with MCP configured has its MCP tools available and usable | Implemented in CLI harness | Per-session tool source; configuration file-authoritative (LOCK-010, runtime spec section 5.4) |
| H-6 | Permission/question flows | Every tool permission and question resolves through the permission flow under the restrictive policy stack: deny at any applicable layer wins, ask wins over allow when any layer requires confirmation, allow requires all applicable layers to permit; agent/session restrictions narrow but never widen enclosing policy; an explicit approval never overrides a deny | A tool permission or question raised by a panel-hosted session resolves inline through the permission flow, and the outcome is applied to that session (P2 proves this current behavior/capability). The restrictive-policy-stack semantics — monotonic deny/ask/allow composition, no widening, enclosing parent denies/session restrictions for children, bounded per-session approval records (runtime spec section 5.3) — are proven at P4 via the permission-evaluator gate, not at P2 | Implemented in CLI harness | Rendered inline in panels |
| H-7 | Parent-child sessions | Parent/child session relations are first-class and preserved | Topic/session navigation shows parent/child session hierarchy, and relations persist across panel restarts | Implemented in CLI harness | Navigation must show hierarchy |
| H-8 | Background/parallel execution | Sessions run in background and in parallel, without worktree isolation as a requirement | Two or more panel-hosted sessions run concurrently in the background, and each remains controllable | Implemented in CLI harness (Agent Manager) | Core orchestration behavior; worktrees are not a harness invariant (LOCK-008) |
| H-9 | User-selected custom-provider models | Per-session model and reasoning-variant selection, restricted to models offered by user-defined/custom providers | Each panel-hosted session selects its own model and reasoning variant from a user-defined provider independently, and the selection applies | Implemented in CLI harness (agent/model selectors); preset-provider removal not done (LOCK-006) | Per-session selector in panels |
| H-10 | Persistence | Sessions and registered artifacts persist and resume across extension restarts; the bounded changefeed is non-authoritative derived state, not H-10 history | A panel-hosted session's transcript and registered artifacts persist across an extension restart and resume in place; the bounded changefeed is non-authoritative and is not H-10 history | Implemented (existing storage behavior on the legacy store through P1-P3); the ADR-0005 canonical storage foundation is a separate, unimplemented direction landing at P4.2 (P4.2a) and is not evidence of current behavior. Final H-10 parity is proven at P4 against the canonical storage foundation after the P4.2 cutover; no old-history storage compatibility is required | Unchanged by this direction; UI does not own state |
| H-11 | Lifecycle correctness | Session create/pause/resume/close/cleanup, process ownership, and resource release are correct; the extension-owned view lifecycle boundaries (panel close/reopen, reload, session switch) and the runtime boundaries (transport reconnect, worker restart) never corrupt runtime operational facts or leave orphaned processes/resources | Panel-driven create/pause/resume/close drives the harness lifecycle API and releases processes/resources correctly, with no bypass, and presentation state converges to runtime operational facts across panel close/reopen, reload, session switch, transport reconnect, and worker restart (runtime spec section 7.1) | Implemented in CLI harness; P4.2 storage cutover evidence includes H-10/H-11 persistence/lifecycle against the canonical storage foundation (ADR-0005; storage spec section 8) | UI must drive lifecycle through harness APIs, never bypass them; presentation state derives from runtime facts (runtime spec section 7.1) |
| H-12 | Checkpoint rollback | SessionRevert + Snapshot semantics: withdrawing/reverting a message restores affected code, with unrevert/cleanup and lifecycle correctness; distinct from the ADR-0005 canonical storage foundation and ADR-0001's historical checkpoint/resync | From a panel-hosted session, withdrawing/reverting a message restores the affected code state, the revert can be un-reverted or cleaned up, and lifecycle stays correct | Implemented (SessionRevert + Snapshot in CLI harness); not conflated with ADR-0005 canonical storage or ADR-0001's historical checkpoint/resync | Review via native VS Code diff APIs (LOCK-002) |
| H-13 | Internal context-overflow safeguard | Long-running agents keep functioning past context limits through a minimal internal safeguard; it is an invisible harness reliability mechanism, not a user-facing context-management product | A long-running panel-hosted session remains functional at context overflow with no user-facing context-management UI, and the safeguard never surfaces as a context-management product | Existing compaction machinery present; no requirement to preserve it (LOCK-005) | Invisible; no UI surface |

No parity suite exists today: the target-surface acceptance criteria above are
unproven until each phase records objective evidence (issue/PR/test/doc links) in
the migration tracker's capability evidence table. The "current status" column
describes the CLI harness today, not target-surface parity.

H-1..H-13 are final target/parity gates (LOCK-014): each criterion must hold at
final target acceptance from the target surface, and P4's final runtime gates
prove the H invariants under the private runtime. They do not require every
intermediate commit or phase to preserve the old implementation. Intermediate
phases keep the workspace testable, keep migration evidence truthful, and avoid
corrupting persisted state; a phase may explicitly record temporary capability
absence (for example in the tracker) while a capability is being rebuilt. No
tracker or reconstruction-candidate entry ever waives a final H parity gate.

Target-contract split (avoids P2 deadlock): P2 proves the current
behavior/capability behind each criterion (a session runs under the selected
agent; a permission/question resolves inline and the outcome applies). The
target contracts that the harness does not implement today — the typed-manifest
validation and canonical provenance of runtime spec section 5.2, the restrictive
policy-stack semantics of section 5.3, and the file-authoritative WYSIWYG
editing of section 5.4 — are proven at P4 through the field-registry/schema gate,
the permission-evaluator gate, and the WYSIWYG acceptance gate (section 11),
never at P2.

## 7. Ownership Principles

- Orchestrator UI/product owns: panels, navigation, topic labels, panel
  lifecycle, message routing within the extension, and file-authoritative
  configuration — canonical config files/assets with the UI as a bidirectional
  editor/read model — plus persisted selector indexes derived from them
  (ADR-0003, LOCK-010; runtime spec sections 3, 5.4).
- Harness kernel (private runtime) owns: agents, tools, permissions, session
  model, storage, lifecycle, execution, checkpoint rollback, and the internal
  context-overflow safeguard. The runtime is an extension-owned private headless
  worker outside the Extension Host (LOCK-009). Storage ownership follows
  ADR-0005: the private runtime is the sole owner of session/event/artifact
  persistence and maintenance, with invisible automatic retention and the
  offline archive cutover at P4.2a.
- The existing `kilo serve` HTTP/SSE/generated-SDK path is a migration bridge, not
  a target compatibility contract (LOCK-009); the private transport is an internal
  implementation choice.
- Operational facts are runtime-owned: the runtime is the sole authority for
  session/worker state (existence, lifecycle state, message presence/ordering,
  timing); extension/webview state is derived presentation/read-model state and
  is never an independent authority (runtime spec section 7.1).
- View/session lifecycle isolation: the extension owns panel/editor lifecycle
  (open, close/reopen, reload, session switch); view lifecycle never mutates
  runtime operational facts, and transport reconnect and worker restart converge
  presentation state to runtime truth (runtime spec section 7.1).
- No rewrite: migration proceeds by consolidation and removal phases, not by
  rebuilding the extension or the backend.
- Only user-defined/custom providers are retained (LOCK-006); preset provider
  identities/catalogs are removed.
- Canonical architecture docs are updated only when implementation changes reality
  (LOCK-013).
- 'topic' is a derived navigation concept (Q1 resolved 2026-08-14): the UI derives
  Topic grouping from root sessions and their parentID membership; no independent
  Topic persistence, API, config, schema, or metadata exists, and selection/
  expansion is presentation state only.

## 8. Bounded Target Architecture

The target shape, bounded to avoid scope creep:

- One extension host and one extension-owned private headless worker (LOCK-009).
  All sessions, panels, and orchestration views ride it; no second runtime.
- One authoritative runtime fact owner: the runtime is the sole authority for
  operational facts; extension/webview state is derived presentation/read-model
  state (runtime spec section 7.1).
- View/session lifecycle isolation: panel close/reopen, targeted reload, and session
  switch never mutate runtime facts; transport reconnect and worker restart
  converge presentation state through the runtime observation/hydration contract
  (runtime spec section 7.1).
- Agent Manager as the primary and sole chat surface with topic/session navigation as the
  main view; no TabPanel/Open in Tab session editor panels — P3.5 Complete 2026-09-01; host in Primary/Secondary Sidebar or editor group does not change judgment; internal session sidebar/tabs/terminals/navigation/persistence retained (LOCK-002).
- A reduced webview set: Agent Manager panel + configuration surface. Removed surfaces (sidebar at P3.1, TabPanel/Open in Tab at P3.5 Complete 2026-09-01, diff viewer/diff virtual at P3.2,
  KiloClaw at P3.3, autocomplete at P3.4) retire their message types and entry
  points.
- File-authoritative configuration and persisted selector indexes (LOCK-010;
  canonical config files/assets under one global config root and
  `<workspaceRoot>/.kilo/` with the UI as a bidirectional editor/read model —
  runtime spec sections 3, 5.4); custom provider records only (LOCK-006);
  immutable versioned runtime snapshots (LOCK-011). Detailed ownership,
  provider, config, and startup semantics are owned by
  `runtime-and-configuration-direction.md`.
- No new persisted domain model for 'topic': Q1 resolved 2026-08-14 — Topic is a
  derived navigation concept (root-session identity, root-title label, parentID
  membership, max-member-updatedAt activity, descending order with deterministic
  ID tie-break; orphan/missing-parent/cycle components degrade to independent
  Topics); no independent Topic persistence/API/config/schema/metadata.
- One private runtime owns all session/event/artifact persistence and
  maintenance: canonical aggregate storage with transactionally maintained
  normalized aggregates/read models plus explicitly registered artifacts,
  invisible automatic byte-budget retention, and an offline archive cutover at
  P4.2 (ADR-0005; storage spec). No multi-client sync/warp, no old-peer
  capability negotiation, and no old-history storage compatibility.
- No worktree execution, no custom diff surfaces, no cloud/Console/JetBrains
  surfaces (LOCK-002, LOCK-003).
- Removed features never contribute to startup/readiness (LOCK-PERF-3): a removal
  phase is not complete while the removed feature still initializes during worker
  startup. Structural absence is proven per phase, and affected-path deltas are
  recorded per the runtime spec performance gates (section 10); no numeric
  improvement is required (R7 resolved 2026-08-14).

Anything that names new message types, new webview entry points, or new state
files is a proposal owned by the phase that introduces it, not committed here.

## 9. Removal Inventory

All rows are decided removals (ADR-0002 LOCK-001/002/003/004/006 plus the
non-preservation clause of LOCK-005 for the existing compaction implementation;
LOCK-005's minimal internal overflow safeguard remains in the final-required set
through H-13); none are deferred. Evidence
categories for each removal (source/tests/docs/generated SDK/config/i18n/build/
package) are tracked in `migration-tracker.md` §6 Removal And Reconstruction Index. Removals are also
structural performance gates: a removed feature must not contribute to worker
startup/readiness (LOCK-PERF-3), and each removal subphase proves
removed-feature initialization/readers/listeners/resources are absent and
records affected startup/session-switch/memory/worker-lifecycle deltas against
the P0 performance baseline (runtime spec section
10.9-10.10); zero or positive noisy delta is allowed if no removed work remains
and no structurally unbounded growth/resource leak appears (R7 resolved
2026-08-14).

| Removal (LOCK) | What is removed | Residual today | Gate |
|---|---|---|---|
| Ordinary single-chat sidebar (LOCK-001) | The sidebar surface and its dependent code (`kilo-code.SidebarProvider`) | Removed at P3.1 — deleted, must not be restored | P3.1 |
| TabPanel / Open in Tab (`kilo-code.new.TabPanel`/`kilo-code.new.openInTab`) (LOCK-001) | TabPanel webview, `kilo-code.new.openInTab` command, serializer, local tabs/SessionTabStrip | Deleted in working tree (manifest/serializer/commands/local-tabs) — P3.5 Complete 2026-09-01 (`b2dc5002…` + `cd26b5f0…` `kilo-gc-proof/2`) | P3.5 |
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
| P2 Harness surface parity | Every H-1..H-13 capability reachable from orchestration panels (agent/model selectors, delegation, tools/skills/MCP, permission rendering, checkpoint review) | Every H-1..H-13 target-surface acceptance criterion (section 6) passes from the target surface, with each criterion's named evidence (issue/PR/test/doc links) recorded in the tracker capability table. P2 establishes target-surface product/harness behavior for what is in scope (LOCK-014): temporary capability absence may be recorded explicitly but must be resolved before P2 exits, and final H parity under the private runtime is proven at P4 — never waived by a tracker or reconstruction-candidate entry |
| P3 Product removal | Remove the decided surfaces: P3.1 sidebar deprecation then removal (LOCK-001); P3.2 worktree infrastructure + custom Diff Viewer surfaces (LOCK-002); P3.3 cloud/JetBrains/Console/KiloClaw (LOCK-003); P3.4 indexing/memory/context-management/autocomplete (LOCK-004) | Each removal's evidence recorded in the tracker removal inventory (source/tests/docs/generated SDK/config/i18n/build/package); H-1..H-13 parity intact (P2 evidence); documented rollback/revert path shipped with the phase; no removed feature reclassified as deferred |
| P3.5 Agent Manager-only consolidation (LOCK-001) | Delete TabPanel/Open in Tab: manifest `kilo-code.new.TabPanel`/`kilo-code.new.openInTab`, serializer, commands, local tabs (`SessionTabStrip`/`local-tabs.tsx`), chat-target dual-surface branching; Agent Manager is sole chat UI (host in Primary/Secondary Sidebar or editor group does not change judgment; internal session sidebar/tabs/terminals/navigation/persistence retained) | Complete 2026-09-01 — deletions landed; Gate C /2 validated (`/tmp/kilo-lc-20260901-181400-0d78f02e` `b2dc5002…` + `/tmp/kilo-rr-20260901-181450-8a3f7c9e` `cd26b5f0…` both `validated:true` `kilo-gc-proof/2`); Gates C/D/P4.4/G3 remain Active per LOCK-004 |

## 11. Acceptance Gates And Complexity Budgets

- Capability parity gate: before any surface is removed, every H-1..H-13
  target-surface acceptance criterion (section 6) has recorded, falsifiable
  evidence from the target surface (P2 exit criterion), captured in the tracker's
  capability evidence table with issue/PR/test/doc links.
- No capability regression: H-1..H-13 are final target/parity gates (LOCK-014);
  they are proven from the target surface at P2 (in-scope behavior) and under the
  private runtime at P4, and they are never waived by a tracker or
  reconstruction-candidate entry. Intermediate phases keep the workspace
  testable, keep migration evidence truthful, and avoid corrupting persisted
  state; regression tests cover the named
  agent/delegation/tool/skill/MCP/permission/checkpoint/overflow flows for
  whatever is in scope in each phase, not only rendering.
- Removal completeness gate: each removal (section 9) has evidence per category
  that exists for it in the tracker removal inventory; nothing is removed
  silently, and nothing removed is reclassified as deferred.
- Complexity budget: each consolidation phase records before/after deltas for
  webview message types, provider methods, and webview entry points against the
  P0 baseline in the tracker metrics. Budgets record deltas, not per-phase
  optimization demands: zero reduction in a dimension is allowed with a stated
  phase-boundary reason, while permanent-removal completeness (section 9)
  remains required.
- Rollback/revert gate: before a consolidation or removal phase ships, it
  documents and ships a concrete rollback/revert path (e.g., revert commit,
  surface re-enablement, message-type restoration). This does not mandate a new
  feature-flag subsystem.
- Runtime/config gates: snapshot pinning per generation, no active-generation
  interruption, atomic version creation, action-specific readiness, and the
  P4.3 legacy-reader cutover — no dual-read window and no import tool (runtime
  spec sections 5, 7, 9 R6) — gate P4; the field-registry/schema/provenance
  contract (runtime spec sections 3.2, 5.1) and the WYSIWYG acceptance semantics
  (runtime spec section 5.4) gate P4.1; the cutover itself gates P4.3;
  per-source effective-config removal evidence (runtime spec section 8.1) gates
  P4.4; the permission evaluator implements the section 5.3 restrictive policy
  stack before P4 exits (permission-evaluator gate); startup acceptance criteria
  (runtime spec section 6) gate P5.
- Observation/hydration convergence gate: per phase, lifecycle-boundary
  convergence evidence is recorded in the tracker against the runtime
  observation and hydration contract (runtime spec section 7.1). P1 records the
  extension-owned view boundaries only (panel close/reopen, reload, session
  switch) on the migration bridge; P2 records the complete five-boundary
  behavior (the three view boundaries plus transport reconnect and worker
  restart) on harness-parity flows over the current bridge; P4 records all five
  again against the private-worker observation surface, showing presentation
  state converges to runtime operational facts with no loss, duplication, or
  stale authority.
- Performance gate: no performance claim without runtime evidence (LOCK-PERF-6).
  P1/P2 compare descriptive, affected-path, same-environment measurements
  against the P0 baseline recorded in the tracker and investigate obvious
  structural anomalies; there is no numeric pass/fail threshold and no
  requirement to improve (R7 resolved 2026-08-14). Removals prove structural
  absence — removed-feature initialization/readers/listeners/resources are
  absent — and record affected startup/session-switch/memory/worker-lifecycle
  deltas; zero or positive noisy delta is allowed if no removed work remains and
  no structurally unbounded growth/resource leak appears (LOCK-PERF-3,
  LOCK-PERF-5). Complexity budgets record deltas; zero reduction in a dimension
  is allowed with a stated phase-boundary reason; permanent-removal completeness
  remains required. Only affected measured rows are rerun per phase. Estimates
  such as 20-40% or 30-50% are hypotheses only and are not acceptance claims.
  Model and gate details live in the runtime spec (section 10).
- Compatibility gate: stored state is never corrupted by an intermediate phase
  (LOCK-014); released-client behavior compatibility obligations are limited to
  the two closed sets (final H-1..H-13 capabilities and the permanent removals)
  and any phase-explicit requirement — outside them there is no default
  compatibility entitlement (LOCK-014, section 12).
- Architecture gate: canonical docs are touched only when implementation lands
  (LOCK-013); decision/spec artifacts do not count as implementation.

## 12. Compatibility Policy

- The extension is a client of the harness kernel; the private runtime relation is
  owned by ADR-0003 and the runtime spec. The existing `kilo serve` SDK surface is
  a migration bridge with an atomic cutover at P4.3 — no dual-read compatibility
  window and no import tool — never a permanent target contract (LOCK-009).
- One runtime model (extension host + one private worker) is the target;
  consolidation never spawns per-panel runtimes.
- User state stays with its current owners during the migration; the target
  ownership domains (runtime spec section 3) assign one owner and one persistence
  path per datum. No state migration or import is proposed: the sole user
  manually reconciles any desired current configuration into the canonical files
  before the P4.3 cutover (runtime spec section 7).
- No changes to public product docs or canonical architecture docs until
  implementation lands (LOCK-013).
- Any removal keeps the harness reachable; removing a capability without a
  replacement surface is a capability cut and is prohibited (LOCK-008).
- Message types are removed only when their surface is removed (section 9 removal inventory, P3 phases);
  undecided surfaces' message types stay until disposition.
- Sidebar removal is a decided direction (LOCK-001) executed at P3.1 with a
  deprecation step; each consolidation/removal phase ships with a documented
  rollback/revert path (section 11).
- No default compatibility entitlement outside the two closed sets (LOCK-014):
  when implementation first touches a legacy feature/behavior not named by the
  final H-1..H-13 capabilities or the permanent removals, the responsible phase
  directly migrates it, removes/disables the old implementation and records it as
  a reconstruction candidate in the tracker, or discards it if clearly obsolete —
  every intentional non-carry-forward, including a clearly-obsolete discard
  immediately assigned `drop`, records a reconstruction-candidate entry; decided
  just in time, never through advance enumeration (ADR-0004).
- No compatibility shim, adapter, dual implementation, or old state owner is
  added solely to preserve a reconstruction candidate (LOCK-014); existing
  compatibility code may be deleted when it obstructs the target.
- Reconstruction-candidate entries are evidence preservation (LOCK-015): they
  never create a compatibility promise, implementation backlog, or phase gate,
  and they never block P1-P4 exits. Final H parity and the permanent removals
  are not weakened by an entry or an observed-candidate note.
- Final H parity is the only persistence parity: no old-history storage
  compatibility is required (ADR-0005). The legacy event-log sync/warp surfaces
  and legacy storage writers/readers are removed at P4.4/P4.5 with no default
  compatibility entitlement (ADR-0004; runtime spec section 8.2); the clean
  P4.2 storage cutover carries no migration/import, no dual-reader, and no
  archive reader, and direct reconstruction applies to storage exactly as it
  applies to configuration.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Sidebar migration churn for existing users | Directional deprecation, migration affordances, gated removal (P3.1) |
| Topic scope creep toward a persisted grouping model | Q1 resolved 2026-08-14: Topic is a derived navigation concept only — no independent Topic persistence/API/config/schema/metadata (section 14) |
| Removal drops a needed harness capability | Capability parity gate (H-1..H-13) before any surface removal |
| Worktree removal breaks parallel-work expectations | Parallel execution is preserved without worktree isolation (H-8); worktrees are not a harness invariant (LOCK-008) |
| Context overflow without user-facing management regresses long agents | Internal safeguard retained (H-13, LOCK-005) |
| Runtime/config migration stalls or dual authority persists | Atomic legacy-reader cutover at P4.3 — no dual-read window, no import; all legacy readers deleted together and cannot influence effective config; P4/P5 gates owned by the runtime spec |
| Config files and the UI diverge (external edits, stale drafts, invalid external edits, deletion/unset) | Bidirectional file-editing contract with watched external edits, visible conflict detection, validation-before-write, and reconciliation (runtime spec section 5.4); WYSIWYG acceptance gate at P4.1 (section 11) |
| Preset provider removal fragments model availability | Custom-provider-only boundary with generic protocol adapters (LOCK-006) |
| Canonical docs drift from implemented reality | LOCK-013: docs updated only when implementation lands |
| Budgets treated as goals instead of gates | Complexity budgets record deltas with a stated phase-boundary reason; permanent-removal completeness stays mandatory (section 11) |
| Performance claims based on estimates (e.g. 20-40%/30-50%) become acceptance claims | Evidence-only gates (LOCK-PERF-6); hypotheses explicitly flagged; no numeric pass/fail thresholds exist (R7 resolved 2026-08-14) — comparisons are descriptive and same-environment (runtime spec section 10) |
| Removed features still initialize during worker startup, so startup work does not decline despite removal | Structural absence proof per removal subphase — initialization/readers/listeners/resources absent — plus recorded affected-path deltas; zero or positive noisy delta is allowed if no removed work remains (LOCK-PERF-3, runtime spec section 10) |
| Noisy descriptive measurements block a phase without a structural finding | Measurement noise alone does not block; comparisons are descriptive, affected-path, same-environment, and obvious structural anomalies are investigated (R7 resolved 2026-08-14, runtime spec section 10) |
| The lifecycle boundaries — extension-owned view boundaries (panel close/reopen, reload, session switch) and runtime boundaries (transport reconnect, worker restart) — diverge from runtime operational truth, leaving stale or duplicated presentation state, UI-held facts surviving a boundary, or orphaned processes/resources | Sole runtime authority for operational facts with derived presentation state (runtime spec section 7.1); lifecycle-boundary convergence evidence per phase (section 11); R9 bounds the implementation decision (runtime spec section 9) |
| Inventory-first analysis paralysis: exhaustive pre-classification of legacy features blocks P1/P2/P4 from starting | Principle-first policy (LOCK-014): no exhaustive pre-migration inventory or suspension registry is required; first-touch disposition is decided just in time (ADR-0004) |
| Unrecorded feature loss: a displaced behavior disappears with no evidence trail | Just-in-time candidate registration (LOCK-015): a registry entry is created when an implemented behavior is actually disabled/removed or intentionally not carried forward (tracker section 7) |
| Reconstruction candidate used as a compatibility entitlement: an entry is treated as a promise to restore or keep a behavior | Registry is evidence preservation only (LOCK-015): no restore path, parity waiver, phase gate, or implementation backlog derives from an entry (ADR-0004) |
| Candidate loophole weakens final H parity: a tracker or registry entry waives a final H-1..H-13 gate | H-1..H-13 are final target/parity gates (LOCK-014): never waived by a tracker or candidate entry; P2 proves in-scope target-surface behavior, P4 proves the H invariants under the private runtime |

## 14. Open Questions

These must be answered before the affected phase; product decisions are returned
to the hub rather than decided here. Runtime/config bounded implementation
decisions are listed in `runtime-and-configuration-direction.md` section 9.

1. Final meaning of 'topic': derived navigation label, session-metadata facet, or
   a new persisted grouping model? RESOLVED (2026-08-14): a derived navigation
   concept — in P1, each root session defines one Topic; root session ID is stable
   Topic identity; root title is the label; descendants belong through parentID;
   activity is the max member updatedAt; order is descending with a deterministic
   ID tie-break; orphan/missing-parent/cycle components degrade to independent
   Topics; Topic selection/expansion is presentation state only; no
   independent Topic persistence/API/config/schema/metadata. (Affects P1
   navigation and section 8; recorded in the migration tracker section 9.)
2. When does the sidebar deprecation notice ship relative to P1 navigation?
   RESOLVED (2026-08-15): P1/P2 supplied the migration affordances and P3.1
   removes the sidebar now; the deprecation step shipped as the P1/P2 migration
   surface plus the release note (minor `remove-sidebar-chat.md` changeset), so
   no separate deprecation notice remains. (Recorded in the migration tracker
   section 9.)
3. What exact counts form the P0 complexity baseline (message types, provider
   methods, webview entry points)? RESOLVED (2026-08-12): 332 distinct webview
   message `type:` literals (WebviewMessage 189 + ExtensionMessage 143, disjoint
   sets); 250 generated v2 SDK `KiloClient` public methods (the extension
   imports `@kilocode/sdk/v2/client`); 6 HTML/webview esbuild entries,
   excluding the shiki worker asset. Reproducible commands and current counts:
   `p0-current-state-inventory.md` (sections 4.4/9/10); decision recorded in
   the migration tracker (section 9).
4. Sidebar removal timing/order within P3.1 and any adoption thresholds:
   RESOLVED (2026-08-15): LOCK-001 decides removal; P1/P2 supplied the migration
   affordances and P3.1 removes the sidebar now; no numeric adoption threshold
   applies. (Recorded in the migration tracker section 9 and the runtime spec
   section 9, R4.)
5. Which consolidated configuration surface replaces settings/profile/marketplace
   panels, how does it present custom provider records, and what is the exact
   WYSIWYG presentation of draft conflicts, invalid-edit reporting, and
   file/UI reconciliation? (P3/P4.1. The behavioral WYSIWYG semantics are
   decided in runtime spec section 5.4; only the presentation is open here.)

## 15. Current Status Summary

- Current (implemented, validated 2026-09-01): shared backend; Agent Manager is the only chat UI (host in Primary/Secondary Sidebar or editor group does not change judgment; internal session sidebar/tabs/terminals/navigation/persistence/hydration retained); `kilo-code.SidebarProvider` deleted at P3.1 and `kilo-code.new.TabPanel`/`kilo-code.new.openInTab` deleted in current working tree (manifest/serializer/commands/local tabs deleted); P3.5 Complete 2026-09-01 — lifecycle `/tmp/kilo-lc-20260901-181400-0d78f02e` `b2dc5002…` + restart `/tmp/kilo-rr-20260901-181450-8a3f7c9e` `cd26b5f0…` both `validated:true` `kilo-gc-proof/2`; historical /1 remains valid; Gates C/D/P4.4/G3 remain Active per LOCK-004 (no cutover/cross-dir/crash/retention/epoch-drift/Linux/Windows closure); residual worktree and Diff Viewer infrastructure; cloud/JetBrains/Console/KiloClaw surfaces; indexing/memory/context-management/autocomplete; preset provider catalogs. These are residual implementation, not retained capabilities where removal is decided (LOCK-002/003/004/006) except TabPanel/sidebar which are already deleted.
- Historical /1 preparation evidence (pre-2026-09-01) proved EventV2/title/persistence/hydration/reload with dual-surface TabPanel scope — remains valid for EventV2/title/persistence/hydration/reload; TabPanel part no longer acceptance. New /2 is Agent Manager-only and Complete (validated).
- Not implemented (remaining): private runtime, file-authoritative configuration (canonical config files/assets with bidirectional UI editor), action-specific readiness, broader Gates C/D/P4.4/G3 (transport cutover/cross-dir/crash/retention/epoch-drift/Linux/Windows). P3.5 bounded product phase is Complete; broader gates remain Active per LOCK-004.
- ADR-0002 records the durable product decision; ADR-0003 records the durable
  runtime/config decision; ADR-0004 records the durable just-in-time direct-
  reconstruction policy; ADR-0005 records the durable bounded private-runtime
  storage decision (superseding ADR-0001's checkpoint/resync transport target);
  this document owns the product migration design; the
  runtime spec owns the runtime/config migration design and the bounded
  Failure/Outcome/Recovery target (section 7.2).
- Phase status, exit evidence, and next actions are tracked in the migration
  tracker (`migration-tracker.md`), the source of truth for progress. P3.5 is Complete (2026-09-01) via `/2` evidence (`b2dc5002…` + `cd26b5f0…`); Gates C/D/P4.4/G3 remain Active per LOCK-004.

## Verification Commands

Markdown/table check for the spec files (must pass without modifying
anything):

- `bun run script/check-md-table-padding.ts specs/adr/0001-lossless-session-storage-rewriting.md specs/adr/0002-focus-vscode-on-agent-orchestration.md specs/adr/0003-replace-cli-configuration-with-private-gui-runtime.md specs/adr/0004-architecture-first-direct-reconstruction.md specs/adr/0005-bounded-private-runtime-storage.md specs/storage/session-storage-rewriting.md specs/vscode-orchestrator/agent-orchestration-direction.md specs/vscode-orchestrator/runtime-and-configuration-direction.md specs/vscode-orchestrator/migration-tracker.md`

Architecture impact check (run from repo root; report the outcome):

- `bun run script/check-architecture-impact.ts --worktree`

No source-code, test, or typecheck commands apply: this work creates decision/spec
artifacts only (LOCK-013).
