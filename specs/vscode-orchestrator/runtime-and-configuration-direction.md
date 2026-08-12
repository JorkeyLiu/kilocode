# Private GUI Runtime and Configuration - Technical Direction

## Goal

Internal technical specification for replacing the CLI-owned configuration and
runtime authority with an extension-owned private runtime and GUI-owned
configuration for the VS Code Agent Orchestrator. It explains why the current
architecture produces the observed startup and config problems, defines the target
ownership domains so every datum has one owner and one persistence path, defines
the custom-provider-only boundary, the config update semantics, the startup
acceptance criteria, and a no-big-bang migration strategy with an explicit
deadline. A fresh session must be able to read this file and continue the work
without rediscovering the decisions, root causes, ownership domains, or phases.

The durable decisions are recorded in
[ADR-0003: Replace CLI Configuration with Private GUI Runtime](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md)
(Status: Active) and
[ADR-0002: Focus VS Code on Agent Orchestration](../adr/0002-focus-vscode-on-agent-orchestration.md)
(Status: Active). This document is the implementation source of truth for the
runtime/config migration; the product direction spec
[`agent-orchestration-direction.md`](agent-orchestration-direction.md) owns the
product surface and harness matrix. Mutable phase status and exit evidence are
tracked in [`migration-tracker.md`](migration-tracker.md).

This is an internal specification under the existing `specs/` convention. It is
not itself an ADR and is not a public feature proposal. It does not change any
source code, canonical architecture docs, docs/nav, or generated artifacts, and it
creates no changeset.

## 1. Scope

This spec owns:

- Current root causes with repository evidence (section 2). Evidence describes the
  implemented system today; target decisions describe where the system is headed.
  They are distinct and neither side claims the other.
- Target ownership domains: every datum has one owner and one persistence path
  (section 3).
- The provider target: custom provider records only (section 4).
- Configuration update semantics and lifecycle: atomic version creation,
  generation snapshot pinning, action-specific readiness, resource version
  ownership/disposal, rollback/error behavior, validation before commit, and no
  active-generation interruption (section 5).
- Startup acceptance: persisted selectors before worker readiness, no global
  disable, visible reconciliation, cold/warm instrumentation, no autocomplete
  prewarm dependency (section 6).
- Migration strategy from the current HTTP/SSE/config system without a big-bang
  rewrite (section 7).
- The removal checklist for all LOCK-002/003/004/006 removals with evidence
  categories (section 8).
- Bounded implementation decisions that P0/P1 must resolve (section 9).
- The performance model: cost attribution, redundancy candidates, latency
  attribution, instrumentation plan, benchmark scenarios, regression gates, and
  runtime-slimming acceptance criteria (section 10).

Not in scope: product surfaces, the harness capability matrix, and product
removal phases (owned by `agent-orchestration-direction.md`); session storage
rewriting (ADR-0001); code changes of any kind.

## 2. Current State And Root Causes

All statements in this section describe the implemented system today, grounded in
repository evidence. None of them claim the target architecture exists.

### 2.1 The CLI backend is the configuration authority

The extension is a client of a general CLI. `KiloConnectionService` owns one
`ServerManager` (child process), one generated SDK client, and one SSE adapter
(`packages/kilo-vscode/src/services/cli-backend/connection-service.ts`,
`server-manager.ts`); the extension host drives the server through generated SDK
HTTP calls plus global SSE (`packages/kilo-docs/pages/contributing/architecture/vscode-extension.md`,
"Shared server ownership"). Product/UI configuration is split: VS Code settings
hold `kilo-code.new.*` extension options while CLI config (global and project
`kilo.json[c]`, OpenCode-compatible files, provider auth, tools, permissions,
modes) holds runtime behavior (`vscode-extension.md`, "Config split"). The
extension cannot render model/agent selection without asking the backend.

Evidence:

- `packages/kilo-vscode/src/KiloProvider.ts` - `initializeConnection` awaits
  `fetchAndSendProviders`, `fetchAndSendAgents`, `fetchAndSendSkills`,
  `fetchAndSendCommands`, `fetchAndSendConfig`, `fetchAndSendIndexingStatus`, the
  memory fetch, and session-status seeding, then posts `extensionDataReady`.
- `packages/kilo-vscode/src/extension.ts` - activation registers providers and
  starts connection flows against the backend.
- `packages/kilo-docs/pages/contributing/architecture/vscode-extension.md` -
  shared server ownership and config split.

### 2.2 Twelve-plus-source configuration merge

Effective config is a merge of 12+ sources with later-source precedence and no
single authority: legacy migrations, organization modes, auth-record remote
config, global config files, explicit `KILO_CONFIG` file, project config files
plus discovered config directories, `KILO_CONFIG_DIR`, `KILO_CONFIG_CONTENT`,
active cloud organization config, managed config directory, macOS managed
preferences, and runtime flag-derived permission/tool/compaction/plugin behavior
(`packages/kilo-docs/pages/contributing/architecture/cli-runtime.md`, "Config
precedence"). The loader in `packages/opencode/src/config/config.ts` performs the
merge with `mergeDeep` and concatenating array merge, and every cold save has
hot/cold classification semantics.

Evidence:

- `packages/opencode/src/config/config.ts` - `mergeConfig`, `mergeConfigConcatArrays`,
  `loadFile`, per-source merge steps.
- `packages/kilo-docs/pages/contributing/architecture/cli-runtime.md` - "Config
  precedence" table (12 rows) and "Config update lifecycle".

### 2.3 Provider catalogs and preset loaders

Provider state combines preset catalog data, config, auth records, and
organization sources with many preset loaders. Bundled provider identities carry
metadata and option patches; models.dev catalog data is loaded with a fallback to
an empty catalog when unavailable; a large checked-in catalog file exists; auth
records use `api`/`oauth`/`wellknown` variants plus a separate v2 multi-account
store; organization IDs participate in model fetch; a five-minute model cache and
custom-endpoint overrides exist (cli-runtime.md, "Outbound provider
authentication" and "Provider routing").

Evidence:

- `packages/opencode/src/kilocode/provider/provider.ts` - bundled providers,
  `patchModelsDevModel`, provider option patches.
- `packages/opencode/src/kilocode/provider/metadata.ts` - preset provider
  metadata keys.
- `packages/opencode/src/kilocode/provider/models-api.json` - checked-in provider
  catalog.
- `packages/opencode/src/provider/models.ts` - "models.dev catalog unavailable,
  using empty catalog" fallback.
- `packages/opencode/src/provider/provider.ts` - models.dev data handling.
- `packages/kilo-docs/pages/contributing/architecture/cli-runtime.md` - provider
  auth and routing sections.

### 2.4 Cold runtime identity rebuild and convergence

Cold config saves trigger a background convergence pass that drains readers and
write/control leases, disposes the exact pre-fence directory-keyed runtime
identities, boots the latest disk state, and releases the admission fence after
the latest committed version converges (`packages/opencode/src/kilocode/server/config-convergence.ts`,
`generation-gate.ts`, `control-lease.ts`, `config-rebuild.ts`; cli-runtime.md,
"Config update lifecycle"). This machinery exists to reconcile multi-source
authority and directory-keyed runtime identity; it is expensive and is the target
model for config application today.

Evidence:

- `packages/opencode/src/kilocode/server/config-convergence.ts`,
  `generation-gate.ts`, `control-lease.ts`, `config-rebuild.ts`.
- `packages/kilo-docs/pages/contributing/architecture/cli-runtime.md` - "Config
  update lifecycle" flow, fencing, coalescing, reload/failure behavior.

### 2.5 Selector readiness chain

UI enablement chains on eventual backend state: backend spawn -> SSE connected ->
parallel provider/agent/skills/config/commands/status HTTP fetches -> UI enable
(`KiloProvider.initializeConnection`). Selectors are disabled until this barrier
resolves, so cold provider state and backend connection failures gate the whole
surface, and autocomplete prewarm can start the server during activation
(vscode-extension.md, "Shared server ownership").

Evidence:

- `packages/kilo-vscode/src/KiloProvider.ts` - `initializeConnection` fetch chain
  and `extensionDataReady` post.
- `packages/kilo-vscode/src/services/cli-backend/sdk-sse-adapter.ts` - SSE
  reconnect and readiness.
- `packages/kilo-docs/pages/contributing/architecture/vscode-extension.md` -
  startup and shared-server behavior.

### 2.6 Evidence vs target decisions

| Topic | Current (evidence, section 2) | Target (decision, ADR-0003 + this spec) |
|---|---|---|
| Config authority | CLI backend merges 12+ sources (2.2) | GUI-owned configuration, one canonical project boundary (section 3) |
| Config application | Cold saves rebuild directory-keyed identities through convergence (2.4) | Immutable versioned snapshots; atomic version creation; no active-generation interruption (section 5) |
| Providers | Preset catalogs + config + auth + organization sources (2.3) | User-defined/custom provider records only (section 4) |
| Selector readiness | Backend spawn -> SSE -> HTTP fetch -> UI enable (2.5) | Persisted indexes before worker readiness; action-specific gates (section 6) |
| Runtime process | General `kilo serve` child with public HTTP/SSE/SDK surface (2.1) | Extension-owned private headless worker; private transport (section 7) |

## 3. Target State Ownership Domains

Every datum has exactly one owner and one persistence path. No datum is owned by
two stores, and no store is authoritative for two owners' data.

| Domain | Owner | Persistence path | Examples |
|---|---|---|---|
| Extension application state | Extension host | VS Code storage APIs (workspace/global state) | Product/UI configuration, persisted selector indexes (models, agents), panel layout, UI options |
| Secrets | Extension host | VS Code SecretStorage | Provider API keys, auth tokens, credentials |
| Project-versioned harness assets | Extension host (canonical boundary) | One canonical explicit project asset path — resolved (2026-08-12, R5): first VS Code workspace root, assets only under `<workspaceRoot>/.kilo/` (section 9) | Project agent definitions, project-level harness configuration; no multi-source precedence merge |
| Session and storage state | Runtime (harness kernel) | Runtime-owned persistence (existing session/storage semantics, ADR-0001 for storage rewriting) | Sessions, events, artifacts, transcript data |
| Immutable runtime snapshot | Runtime (harness kernel) | Versioned snapshots created atomically on config commit | Effective config + runtime identity consumed by generations |
| Private worker resources | Private worker (per version, lazy) | Version-scoped resource ownership | Provider/MCP/tool resources; disposed only after owners release them |

Rules:

- GUI-owned means extension application state with appropriate VS Code storage
  APIs, not necessarily VS Code settings.json; complex records and secrets never
  live in settings.json (ADR-0003, LOCK-010).
- The runtime never merges project assets with other sources; it consumes the
  immutable snapshot built from the canonical boundary.
- Resource lifecycle follows version ownership: replacement is version-scoped and
  lazy, and old resources are disposed only after their owners release them
  (LOCK-011).

## 4. Provider Target

- Only user-defined/custom provider records exist in the product. A record is a
  user-supplied endpoint, protocol, and model definition, or a supported
  discovery path over user-accessible endpoints.
- Removed: preset provider identities, preset provider catalogs, bundled
  gateway/provider onboarding and auth flows, the models.dev catalog dependency,
  and organization/cloud provider sources (LOCK-006).
- Generic protocol adapters (for example OpenAI-compatible or Anthropic-compatible
  request shaping) are implementation choices required to connect a user-defined
  provider; they are not preset providers and carry no bundled identity, catalog,
  onboarding, or organization data.
- Persisted selector indexes (models and agents, LOCK-012) are derived from
  user-defined provider records and agent definitions owned by the extension
  (section 3), so selection does not depend on the worker being ready.
- Runtime connection and validation of a user-defined provider is a separate,
  action-specific readiness concern (section 5 and 6); it never globally disables
  selection.

## 5. Configuration Update Semantics And Lifecycle

- Validation before commit: an update is validated against the schema and, where
  meaningful, against the resources it targets before a new version is committed.
  A failed validation aborts the update; the prior version stays authoritative.
- Atomic version creation: every committed update creates a new immutable version
  with a monotonic sequence. Versions are never mutated in place.
- Generation snapshot pinning: a generation keeps the exact version it started
  with for its whole lifetime; all reads inside the generation return the pinned
  snapshot (LOCK-011).
- No active-generation interruption: an update acknowledges immediately after
  commit and never cancels, drains, or rebuilds active generations (LOCK-011).
- Resource version ownership/disposal: provider/MCP/tool resources are created per
  version lazily; a resource version is replaced only when a later generation
  needs it, and old-version resources are disposed only after all owners have
  released them (LOCK-011). Process-global rebuild/convergence is not the target
  model.
- Rollback/error behavior: an aborted update leaves the prior version
  authoritative; reverting a committed version means committing a new version (or
  a revert operation), never mutating the old one. Error paths are visible in
  instrumentation (section 6) without erasing user choice.
- Action-specific readiness: a feature gates on the specific version and resources
  it needs, not on a global readiness event (LOCK-012).

## 6. Startup Acceptance

Accepted behavior once the runtime/config migration lands (P5 gates):

- Persisted custom providers, models, and agents render in their selectors before
  the private worker is ready, from extension-owned persisted indexes (LOCK-012).
- No selector is globally disabled by backend connection state; runtime
  connection/validation is separate readiness.
- Invalid or stale entries reconcile visibly (for example a stale model marked and
  refreshed when its provider validates) without erasing the user's choice.
- Startup stages are instrumented (cold and warm), so per-stage timing and failure
  are observable; no numeric SLA is mandated here (bounded decision, section 9).
- No autocomplete prewarm dependency: autocomplete is removed (LOCK-004) and the
  worker never starts merely to prewarm completions.
- No single `extensionDataReady` barrier remains as a gate for the whole UI; gates
  are action-specific (LOCK-012).

## 7. Migration Strategy

The migration replaces the current HTTP/SSE/config system without a big-bang
rewrite. Each step is a phase with objective gates (tracked in
`migration-tracker.md`; runtime phases P4.x, startup phase P5).

1. Inventory: enumerate config sources (section 2.2), provider sources and loaders
   (2.3), readiness chain stages (2.5), and the removal surface list (section 8).
   Baseline counts are recorded in the tracker.
2. Local GUI read model: the extension owns persisted config and selector indexes
   (section 3). The extension becomes the read-model authority for UI state.
3. Dual-read with an explicit deadline: during the migration bridge the private
   runtime consumes GUI-committed snapshots while the existing `kilo serve`
   HTTP/SSE/SDK path still serves the bridge (LOCK-009 allows this as a migration
   bridge, not a target contract). The window is time-boxed by an explicit
   deadline — resolved (2026-08-12, R6): the deadline is the P4.3 phase boundary
   itself (opens only during P4.3, shrinks monotonically, no new bridge
   consumers, fully closed before P4.3 exits / P4.4 begins; section 9). No
   permanent dual authority.
4. Private runtime entrypoint: an extension-owned private headless worker process
   outside the Extension Host (LOCK-009) with a snapshot API.
5. Snapshot API: versioned immutable config/runtime snapshots (section 5) that
   generations consume; generated-SDK/public HTTP calls cease to be the
   consumption path.
6. Source removal: remove the 12-source merge, preset provider loaders and
   catalog, and the convergence/rebuild machinery (sections 2.2-2.4); remove the
   extension's wait-on-backend fetch chain (2.5).
7. Transport narrowing: replace the HTTP/SSE/SDK surface with the private
   transport; the generated SDK and public server surface stop being public
   interfaces. The private transport protocol is an internal implementation choice
   (bounded decision, section 9), not a compatibility contract.
8. Old CLI/server deletion: delete the CLI/TUI/Console product surfaces and public
   interfaces (LOCK-009) after the bridge deadline closes.

Constraints: no permanent dual authority; the old path is deleted, not retained;
every step has objective exit evidence in the tracker; canonical architecture docs
change only when implementation lands (LOCK-013).

## 8. Removal Checklist

Evidence fields per category are recorded in the tracker (section 7 of the
tracker): `source`, `tests`, `docs`, `generated SDK`, `config`, `i18n`,
`build/package`. A removal is not complete until every category that exists for
the item has recorded evidence; nothing removed is reclassified as deferred.

| Removal (LOCK) | What is removed | Residual today | Phase |
|---|---|---|---|
| Worktree infrastructure (LOCK-002) | Worktree session isolation, `.kilo/worktrees/`, worktree setup scripts, worktree diff/review surfaces | Residual implementation in Agent Manager; cleanup scope, not retained capability | P3.2 |
| Custom Diff Viewer surfaces (LOCK-002) | Diff Viewer and Diff Virtual webviews | Residual webviews present | P3.2 |
| Cloud sessions (LOCK-003) | Cloud session panels and routes | Present in repo | P3.3 |
| JetBrains (LOCK-003) | `packages/kilo-jetbrains/` product | Present in repo | P3.3 |
| Console (LOCK-003) | `packages/kilo-console/` and CLI console surface | Present in repo | P3.3 |
| KiloClaw (LOCK-003) | KiloClaw webview and bootstrap | Present in repo | P3.3 |
| Indexing (LOCK-004) | `packages/kilo-indexing/`, semantic search tool, indexing status surface | Present in repo | P3.4 |
| Project memory (LOCK-004) | Memory tools, memory fetch, system-prompt injection | Present in repo | P3.4 |
| User-visible context management/compaction (LOCK-004) | Compaction settings and context-management UI | Present in repo; minimal internal overflow safeguard retained separately (LOCK-005) | P3.4 |
| Autocomplete (LOCK-004) | Inline completions and commit-message generation | Present in repo | P3.4 |
| Preset providers/catalog/onboarding/org sources (LOCK-006) | Preset provider identities, models.dev catalog, bundled gateway onboarding/auth, organization/cloud provider sources | Present in repo | P4.4 |

## 9. Bounded Implementation Decisions

These were intentionally not chosen at spec-writing time. They are recorded as
implementation decisions that P0/P1 must resolve, with objective evidence,
before the affected phase can exit. As of 2026-08-12, R1/R2/R5/R6/R8 are
resolved with the decisions below (also recorded in the tracker, section 9);
R3 (numeric startup SLA) and R4 (adoption thresholds) remain open; R7 remains
open with required-by clarified (see row). The tracker (section 9) is the
mutable status source; this table is the durable decision record.

| Decision | Bounded by | Required by | Resolved (2026-08-12) |
|---|---|---|---|
| R1 Private transport protocol | Internal implementation choice; not a compatibility contract (LOCK-009) | P4.2 (snapshot API + transport) | Resolved: JSON-RPC 2.0 over child-process stdio with standard Content-Length framing (`vscode-jsonrpc` precedent). One extension-owned worker child; initialize handshake replaces port detection/health; requests carry commands, notifications carry normalized event envelopes; stderr remains bounded diagnostics; EOF/process exit owns lifecycle. HTTP/SSE/generated SDK remains bridge-only and is deleted. No retained-terminal protocol commitment: terminal/worktree surfaces are not LOCK-008 harness invariants and are handled by their removal/migration scope |
| R2 Storage engine for extension-owned state | Extension application state with VS Code storage APIs; complex records never in settings.json (LOCK-010) | P4.1 (GUI read model) | Resolved: extension-owned product/UI config + persisted selector indexes use VS Code `globalState`; per-workspace runtime-tracking state uses `workspaceState`; all secrets use `SecretStorage`; runtime-owned session/event/artifact persistence remains runtime-owned; immutable worker snapshots are derived versioned values, not a second persisted store |
| R3 Numeric startup SLA | Thresholds are a recorded product decision | P5 (startup acceptance) | Open |
| R4 Adoption thresholds for removal timing | Evidence-driven product decision | P3 (product removal gates) | Open |
| R5 Exact project harness-assets path | One canonical explicit project boundary (LOCK-010) | P4.1 | Resolved: one canonical project boundary = first VS Code workspace root; project-versioned harness assets live only under `<workspaceRoot>/.kilo/`, including `.kilo/kilo.json[c]`, agent/command/rules/skills/workflows/plans/config assets. P4.1 migrates root/legacy sources; P4.4 deletes ancestor walk, `.kilocode`/`.opencode`, global project-asset sources, and primary-worktree mirror reads. No multi-source precedence remains |
| R6 Dual-read window deadline | Explicit deadline; no permanent dual authority (LOCK-009, section 7) | P4.3 | Resolved: no unsupported calendar date. The explicit deadline is the P4.3 phase boundary: dual-read opens only during P4.3, must shrink monotonically, gains no new bridge consumers, and must be fully closed before P4.3 exits / P4.4 begins. P4.4/P4.5 then delete source/transport/product code; no fallback read survives into P4.4 |
| R7 Performance gate thresholds (startup stages, prompt-submit/first-token, stream-render, tool/permission, session-switch, config-update) | Recorded product/engineering decision; no invented numerics (LOCK-PERF-6) | Required by = before the first P3/P4/P5 performance gate that uses thresholds (and the P1/P2 no-regression gate if applicable), not the P0 baseline recording; threshold policy must be recorded before each affected phase starts/claims its gate, using comparable same-environment control evidence | Open — not a P0 blocker; P0 satisfies its component by recording descriptive runtime baselines (tracker section 8) |
| R8 Benchmark tooling/harness choice | Internal implementation choice; not prescribed by this spec | P0 profiling tasks | Resolved: retain the existing two-harness tooling as the P0 and later comparison harness — Extension Host scenarios 1/2/3/4/5/10 under `packages/kilo-vscode/script/p0-bench/` (runner/merge/safety/provenance tools); backend scenarios 6/7/8/9/11/12/13 under `packages/opencode/test/benchmark/` (runner). Limitations recorded: manual-only, platform/environment/provenance scoped, backend in-process `Server.listen`/`AppLayer` only, n=5 descriptive |

## 10. Performance Model And Regression Gates

Performance is a first-class architectural objective alongside product coherence
(LOCK-PERF-1). This section records the evidence-based cost attribution for the
current runtime, the known redundancy candidates, the instrumentation plan, the
benchmark scenarios, the regression gates, and the runtime-slimming acceptance
criteria. P0 recorded descriptive baseline magnitudes in the tracker (section 8)
from the six accepted campaigns; nothing here claims an implemented improvement
(LOCK-PERF-6).

### 10.1 Performance decision locks (LOCK-PERF-1..7)

| ID | Decision |
|---|---|
| LOCK-PERF-1 | Performance simplification is a primary objective alongside product coherence. Remove redundant architecture from the hot path. |
| LOCK-PERF-2 | CLI/TUI/Console are not products. A private headless worker may remain for isolation; its startup and runtime costs must be measured. |
| LOCK-PERF-3 | Removed features must not contribute to startup/readiness: worktree/Diff Viewer, cloud sessions, JetBrains, Console, KiloClaw, indexing, memory, user-visible context management, autocomplete, preset provider catalog/onboarding. |
| LOCK-PERF-4 | Persisted custom-provider/model/agent choices must be renderable before worker readiness; action-specific readiness replaces global `extensionDataReady` gating. |
| LOCK-PERF-5 | Preserve harness semantics and performance correctness: custom agents, delegation, tools, skills, MCP, permissions/questions, parent-child/background/parallel sessions, persistence, SessionRevert+Snapshot rollback, invisible internal context-overflow safeguard. |
| LOCK-PERF-6 | No performance claim is accepted without runtime evidence. Static reachability identifies candidates; benchmarks/profiles establish magnitude. |
| LOCK-PERF-7 | Prompt submission/streaming transport on localhost is not presumed to be the dominant generation latency. Model/network/tool/user approval costs must be measured separately from transport/event overhead. |

### 10.2 Cost attribution: CLI presentation vs general runtime

Evidence-based conclusion:

- CLI presentation/TUI rendering contributes approximately no VS Code
  generation hot-path cost: `kilo serve` never instantiates or renders the TUI.
  TUI rendering is lazy. The serve command (`packages/opencode/src/cli/cmd/serve.ts`)
  is headless (`instance: false`), imports the server dynamically, and never
  invokes the TUI renderer; the renderer
  (`packages/opencode/src/cli/cmd/tui/app.tsx`, SolidJS + OpenTUI) is loaded
  only by the interactive attach command via dynamic import
  (`packages/opencode/src/cli/cmd/tui/attach.ts`). Command parsing is a one-shot
  yargs pass at process start.
- Static CLI entry imports are a separate, distinct cost: the worker process
  starts through the CLI entry (`packages/opencode/src/index.ts`), which
  statically imports the run/attach/thread command modules (`cli/cmd/run`,
  `cli/cmd/tui/attach`, `cli/cmd/tui/thread`) and the UI logo module
  (`cli/ui.ts`). The serve-path TUI config/keymap module graph is reached
  through the static thread chain `cli/cmd/tui/thread.ts` ->
  `KiloTuiThreadDaemon` (`packages/opencode/src/kilocode/cli/cmd/tui/thread.ts`)
  -> `TuiConfig`/`TuiKeybind` (`packages/opencode/src/cli/cmd/tui/config/tui.ts`)
  -> `@opentui/keymap/extras`, so part of the CLI/TUI command/config/keymap
  module graph is present in the worker process even though rendering is never
  instantiated. `cli/cmd/run/runtime.boot.ts` is interactive-only: it is
  reached only through the dynamic `run/runtime` import in the interactive run
  path (`cli/cmd/run.ts`), not as a serve-path static import. Deleting TUI/CLI
  commands and pruning those imports may therefore reduce worker
  module-graph/startup cost, but the magnitude is unmeasured (section 10.11)
  and must be confirmed by the P0 instrumentation; without pruned import paths
  it only shrinks the shipped surface.
- The general CLI runtime does contribute material potential cost:
  - The AppLayer graph is broad (Core, Session, and Feature layers: Database,
    Auth, Account, Config, Git, Ripgrep, Storage, Snapshot, Plugin,
    provider/model-cache, ProviderAuth, Agent, Skill, Discovery, GenerationGate,
    ControlLease, ConfigConvergence, AgentManager, KiloViewers, Notebook,
    Question, Permission, Session*, BackgroundJob, EventV2Bridge, LSP, MCP,
    McpAuth, Command, Truncate, ToolRegistry, Format, Project, ProjectV2,
    ProjectCopy, MoveSession, PtyTicket, Vcs, Reference, Workspace, Worktree,
    Installation, MemoryService, ShareNext, SessionShare). The module-scope
    `export const AppLayer = makeAppLayer()` and
    `ManagedRuntime.make(AppLayer, { memoMap })` at
    `packages/opencode/src/effect/app-runtime.ts:207-210` build the layer
    definition and a lazy runtime handle (Effect builds the layer via
    `Layer.buildWithMemoMap` only on first use), not the service instances; the
    graph is constructed when the server listener builds it - for the serve path
    at `Server.listen` -> `KiloListener.build` with `opts.appLayer`
    (`packages/opencode/src/server/server.ts:88-116,144`;
    `packages/opencode/src/kilocode/server/listener.ts`,
    `Layer.buildWithMemoMap`). So the construction cost is paid at worker/server
    listener build, not at first import.
  - Per-instance bootstrap: `packages/opencode/src/project/bootstrap.ts`
    (`InstanceBootstrap`) loads config, initializes plugins and the Kilo
    bootstrap, then concurrently initializes reference/lsp/format/vcs/snapshot/
    project services per directory on first access.
  - Config/provider initialization: the 12+ source merge (section 2.2), preset
    provider loaders and the 3.0 MB checked-in models-dev catalog
    (`packages/opencode/src/kilocode/provider/models-api.json`, section 2.3), and
    the convergence/rebuild machinery (section 2.4).
  - Feature layers include removed-feature services (Worktree, MemoryService,
    Notebook, AgentManager, KiloViewers, ShareNext) that under LOCK-PERF-3 must
    not contribute to startup once removed.
- Magnitudes for the measured stages are recorded descriptively in the tracker
  (section 8) from the accepted P0 campaigns. This paragraph is the
  evidence-based hypothesis the P0 baseline confirmed or refuted; the recorded
  values are descriptive n=5 sample statistics, not measured improvements.

### 10.3 Current startup timeline (evidence)

The timeline below is the implemented system today; per-stage durations for the
measured stages are recorded in the tracker (section 8) from the accepted P0
campaigns (descriptive n=5 statistics with evidence links, LOCK-PERF-6); stages
without an accepted campaign or an existing extension-owned index are later-phase
gates (P2/P3/P4.4/P5), not measured here.

| Stage | Location | Today |
|---|---|---|
| Extension activate | `packages/kilo-vscode/src/extension.ts` | Registers sidebar, Agent Manager, KiloClaw, Diff Viewer, settings, marketplace, autocomplete, attention, telemetry; starts connection flows. No timing. |
| Connection start | `KiloProvider.initializeConnection` (`packages/kilo-vscode/src/KiloProvider.ts:1506`) | `connectionService.connect(workspaceDir)`. |
| Worker spawn | `ServerManager` (`packages/kilo-vscode/src/services/cli-backend/server-manager.ts:88,113`) | Spawns `bin/kilo serve --port 0`; console log only. |
| Port detected | stdout `parseServerPort` (`server-manager.ts:166`, `server-utils.ts`) | "kilo server listening on http://...:PORT"; console log only. |
| Worker module graph + AppLayer graph construction | `effect/app-runtime.ts:207-210` (layer definition + lazy runtime handle); server listener build (`server.ts` `Server.listen` -> `KiloListener.build`) | Layer definition at module scope; graph construction at listener build; no timing. |
| Server listening | `server.ts:88-116` -> `KiloListener.build` | Prints the port line the extension parses. |
| SSE connected | `sdk-sse-adapter.ts`; `KiloProvider.onStateChange` (`KiloProvider.ts:1589`) | Console log only. |
| Instance bootstrap (first directory request) | `project/bootstrap.ts` `InstanceBootstrap` | Effect span exists; per-directory on first access. |
| UI fetch chain | `KiloProvider.doInitializeConnection` (`KiloProvider.ts:1679-1689`) | Parallel providers/agents/skills/commands/config/indexing/memory/session-status fetches. |
| Global readiness barrier | `KiloProvider.ts:1694` `postMessage({ type: "extensionDataReady" })` | Current global gate; target is action-specific readiness (LOCK-PERF-4, section 6). |

### 10.4 Known redundancy candidates

Static reachability identifies these candidates (LOCK-PERF-6); magnitudes require
measurement. None is claimed as removable or removed here.

- Module-scope AppRuntime: `ManagedRuntime.make(AppLayer, { memoMap })`
  (`effect/app-runtime.ts:210`) builds the runtime handle at module scope, but
  the AppLayer service graph is constructed lazily when the layer is first built
  - the server listener build for the serve path
  (`server.ts` `Server.listen` -> `KiloListener.build`, `listener.ts`
  `Layer.buildWithMemoMap`).
- Preset provider surface: 3.0 MB models-dev catalog
  (`kilocode/provider/models-api.json`), preset provider identities, metadata
  keys, and loaders (section 2.3; LOCK-006 removal).
- Config machinery: 12+ source merge and cold convergence/rebuild passes
  (sections 2.2, 2.4; LOCK-011 target removes process-global rebuild).
- Per-instance bootstrap work, including removed-feature initialization (memory,
  indexing via `KilocodeBootstrap`, and the Feature/Session layer services named
  in 10.2).
- Extension readiness chain: the wait-on-backend fetch chain gating the whole UI
  (section 2.5) is a startup/readiness cost, distinct from generation cost.
- Removed-feature startup contributions (LOCK-PERF-3): worktree/Diff Viewer,
  cloud sessions, JetBrains, Console, KiloClaw, indexing, memory, user-visible
  context management, autocomplete, preset provider catalog/onboarding.

### 10.5 Request/streaming latency attribution

LOCK-PERF-7: localhost transport is not presumed to be the dominant generation
latency. The metric classes are: startup, readiness, prompt-submit/first-token,
stream-render, tool/permission, session-switch, and config-update. The cost
classes below must be measured separately, never summed into one number.

| Cost class | What it covers | Existing instrumentation |
|---|---|---|
| Prompt transport | Prompt submit HTTP/SDK call, handler routing, session prompt build | None on the extension path |
| Model/network | Provider connect, request shaping, time to first token from the model endpoint | Partial: provider `log.time("state")`, `log.time("getSDK")` (`packages/opencode/src/provider/provider.ts:1388,1746`) |
| Transport/event | SSE per-event encode/decode, event dispatch, `postMessage` to webview | None on the extension path |
| Webview render flush | DOM/markdown render per token batch | None |
| Tool execution | Tool start/end, output handling | `Tool.execute` spans (`tool/registry.ts:224`, `tool/tool.ts:145`, `session/tools.ts:170`) |
| Permission/questions | Ask/reply round trips through the permission flow | None |
| Session-switch | Load/restore of the switched session | None |

### 10.6 Config-update performance costs

- Hot vs cold classification (cli-runtime "Config update lifecycle", section 2.2).
  Hot saves persist, invalidate caches, and emit `config-updated` without a
  runtime rebuild; cold saves run the convergence pass (section 2.4).
- Cold save cost components to measure: admission-fence duration, drain of
  readers/write/control leases, disposal of pre-fence identities, boot of the
  latest disk state, and post-release convergence (`config-convergence.ts`,
  `generation-gate.ts`, `control-lease.ts`, `config-rebuild.ts`; observability
  exists via `trackRebuildStarted`/`trackRebuildCompleted`/`awaitRebuilds`).
- Burst config updates must be measured for coalescing behavior.
- Target: atomic version creation with no process-global rebuild (section 5,
  LOCK-011); cold convergence passes go to 0.

### 10.7 Target performance principles

- Performance simplification is a primary objective alongside product coherence
  (LOCK-PERF-1). The hot path is extension -> private worker -> harness
  generation path; redundant architecture on that path is removal scope.
- CLI/TUI/Console are not products (LOCK-009). A private headless worker may
  remain for isolation, but its startup and runtime costs are measured
  (LOCK-PERF-2).
- Removed features never contribute to startup/readiness (LOCK-PERF-3).
- Persisted selector indexes render before worker readiness; gates are
  action-specific, not the global `extensionDataReady` barrier (LOCK-PERF-4,
  section 6).
- Harness semantics and performance correctness are preserved (LOCK-PERF-5): no
  regression in transport/event handling, generation pinning, rollback, or the
  overflow safeguard.
- No performance claim without runtime evidence (LOCK-PERF-6). Thresholds are
  recorded product/engineering decisions (section 9), never invented here.
- Localhost transport is not presumed dominant (LOCK-PERF-7); attribution is
  measured per cost class (10.5).

### 10.8 Instrumentation plan

Instrument the named points below (cold and warm), non-invasively, in P0. The
tracker records the executed points and per-stage timings (tracker section 8).
The Today column shows existing partial instrumentation; "-" means none.

| Point | Where | Today |
|---|---|---|
| Extension activate | `extension.ts` activation | - |
| Worker CLI entry / module-graph load | `packages/opencode/src/index.ts` static imports (run/attach/thread commands, `cli/ui.ts` logo, TUI config/keymap via `cli/cmd/tui/thread.ts` -> `KiloTuiThreadDaemon` (`kilocode/cli/cmd/tui/thread.ts`) -> `TuiConfig`/`TuiKeybind` (`cli/cmd/tui/config/tui.ts`) -> `@opentui/keymap/extras`) | - |
| Worker spawn | `server-manager.ts` spawn | Console log |
| Port detected | `server-manager.ts` stdout parse | Console log |
| AppLayer graph construction | `effect/app-runtime.ts:207-210` (layer definition + lazy runtime handle); `server.ts` `Server.listen` -> `KiloListener.build` (`listener.ts` `Layer.buildWithMemoMap`) | P0 spans `app_layer_define` / `app_runtime_make` (module-load) |
| Server listening | `server.ts` `Server.listen` | Console line |
| SSE connected | `sdk-sse-adapter.ts` / `KiloProvider.onStateChange` | Console log |
| Instance bootstrap | `project/bootstrap.ts` `InstanceBootstrap` | Effect span |
| Config load | `config.ts` | Partial spans (`Config.loadActiveOrgConfig`) |
| Provider state | `packages/opencode/src/provider/provider.ts` | `log.time("state")`, `log.time("getSDK")` |
| First data fetch | `KiloProvider` fetch chain (`KiloProvider.ts:1679-1689`) | Console log |
| Global readiness barrier | `KiloProvider.ts:1694` `extensionDataReady` | Console log; replaced by action-specific gates (LOCK-PERF-4) |
| Persisted-selector paint | Target webview render of persisted indexes | - |
| Prompt sent | Extension prompt submit path | - |
| First model event (first assistant-message update, never "first token" — LOCK-PERF-7) | SSE event handling | `model.firstEvent` |
| Per-event transport handling | `connection-service.ts` `handleSseEvent` (the SSE adapter's `onEvent` dispatch; not `sdk-sse-adapter.ts` and not the per-provider `KiloProvider.handleEvent`) | Extension `sse.event` span (bounded eventType/dir/transaction metadata; `dir` is the per-event instance-directory envelope on the shared connection — it varies per event across sidebar/tabs/Agent Manager worktrees and is never the panel's workspace root) |
| Webview render flush | Webview render path | Generic `webview.load`/`render`/`mount`/`paint` records — NOT persisted-selector paint (no extension-owned persisted indexes exist) |
| Tool start/end | `Tool.execute` | Effect span + P0 `tool_execute` span (session-id correlated, bounded tool/call/message metadata, one pair per session call) + distinct inner `tool_execute_plugin` stage for plugin/custom tool bodies |
| Permission asked/replied | Permission/question flow | Extension `permission.asked`/`replied`, `question.asked`/`replied`/`rejected` marks + backend `permission_wait` / `question_wait` spans (request-id correlated; rejection = unmatched start). Asked/replied marks are keyed by permission/question id and carry NO directory — the shared connection's directory context only routes the reply back to its panel |
| Config commit | `config-convergence.ts` commit | Rebuild tracking |
| Convergence complete | `config-convergence.ts` release | `trackRebuildCompleted` |
| Run-owned process-tree memory guard (P0 safety infrastructure, not a latency point) | `script/p0-bench/memory-guard.ts` + `script/p0-bench/sample.ts` lifecycle | Per-lifecycle bounded `memoryGuard` result on every sample: configured engineering safety rails (RSS/VSZ/aggregate, default any-owned-RSS ≥ 4 GiB, aggregate-RSS ≥ 6 GiB, VSZ ≥ 64 GiB; env-tunable via `KILO_P0_MEMORY_GUARD_*`), poll count/overhead, max aggregate RSS, max owned count, max process RSS/VSZ identity, breach or null, capped time series. A guard breach aborts the lifecycle with `ok:false`, `blocked.reason="memory-guard-abort"` and exact-owned cleanup still runs. Rails are engineering safety limits, never performance thresholds (LOCK-PERF-7) — see 10.9 | - |
| Immutable per-campaign CLI snapshot (P0 provenance safety, not a latency point) | `script/p0-bench/snapshot.ts` + `server-manager.ts` `resolveCliPath` (`KILO_P0_BACKEND_CLI`) | Run-owned temp copy of `bin/kilo` pinned through a benchmark-only override so the non-owned dev CLI watcher cannot change the measured binary mid-campaign; original + snapshot SHA/path recorded on run/sample records; snapshot deleted after the campaign; production fallback unchanged | - |

### 10.9 Benchmark scenarios and regression gates

Benchmark scenarios (each maps to rows in the tracker metrics table, tracker
section 8):

| Scenario | Measures |
|---|---|
| Cold start | Worker spawn -> port detected -> SSE connected -> persisted-selector paint -> fetch chain done; AppLayer graph construction |
| Warm view | Extension reopen with live worker; webview restore path |
| No-provider persisted state | Startup without provider/auth records |
| Custom-provider startup | One or more user-defined provider records; provider state build |
| Many-agent/MCP startup | Large agent set and several MCP servers; bootstrap and tool resolution |
| First prompt | Prompt submit -> first model event/token (LOCK-PERF-7 attribution) |
| Streaming large output | Per-event transport handling + webview render flush over a long stream |
| Parallel child sessions | Concurrent generation with parent-child delegation |
| Permission-heavy task | Tool/permission ask/reply round trips |
| Session switch | Load/restore of the switched session |
| Hot config update | Persist + cache invalidation + `config-updated` without rebuild |
| Cold provider config update during active generation | Fence/drain/reboot while a generation streams; no interruption |
| Burst config updates | Coalescing of overlapping cold saves |

Gate rules:

- Gates are comparisons against the P0 baseline recorded in the tracker
  (section 8); numeric thresholds are recorded product/engineering decisions
  (section 9), never invented here.
- No regression in harness semantics or performance correctness (LOCK-PERF-5):
  the H-1..H-13 flows, generation pinning, rollback, and the overflow safeguard
  stay intact on every measured path.
- Measurable net reduction in startup work, loaded services, and removed-feature
  initialization (LOCK-PERF-1, LOCK-PERF-3) before a removal phase exits.
- Estimates such as 20-40% or 30-50% startup reduction are hypotheses only and
  must not be used as acceptance claims (LOCK-PERF-6).

Safety infrastructure (not gates, not thresholds, not claims):

- P0 runs carry a run-owned process-tree memory guard (10.8). Ownership is
  seeded only from processes whose args contain the exact unique lifecycle
  userData path, then expanded recursively to descendants by PPID; ancestors
  and name-matched unrelated processes (e.g. the user's production VS Code) are
  never monitored or touched. On a safety-rail breach the lifecycle/sample
  becomes `ok:false`, `blocked.reason="memory-guard-abort"`, the done marker is
  written, only exact owned userData PIDs are terminated via the existing
  cleanup helpers, and teardown still verifies port/scratch cleanup.
  Guard-aborted samples are failures, never baselines. Rails are engineering
  safety limits — not performance thresholds and not an SLA (LOCK-PERF-7 stays
  Open); no performance result derives from them.
- The measured CLI binary is immutable per campaign: `bin/kilo` is snapshotted
  to a run-owned temp path before samples and pinned through the
  benchmark-only `KILO_P0_BACKEND_CLI` override, so the non-owned dev watcher
  cannot change binary provenance mid-campaign. Production fallback is
  unchanged when the override is absent.
- Platform note: macOS `ps` reports a fixed ~400 GB address-space baseline for
  every process, so the VSZ rail is inert-by-construction there (RSS rails are
  the effective abort gates; VSZ is still recorded for RSS-vs-VSZ
  distinction); on Linux all three rails are active. Unsupported platforms fail
  the benchmark safely before launch rather than running unguarded.
- The prior interrupted campaign's evidence is ineligible: no live RSS/VSZ time
  series existed, so root cause of the observed system freeze is UNKNOWN. This
  section documents the guard only; it claims no root cause and no performance
  result.

### 10.10 Runtime slimming acceptance criteria

A phase claims runtime slimming only with all of:

- Startup: the worker reaches readiness without initializing removed features
  (LOCK-PERF-3); persisted selectors render before worker readiness (LOCK-PERF-4,
  section 6); no global `extensionDataReady` barrier; AppLayer/process-graph
  construction cost is measurably reduced against the P0 baseline.
- Config: cold saves commit without process-global rebuild/convergence (target 0
  passes) and never interrupt active generations (section 5, LOCK-011).
- Harness: H-1..H-13 invariants and performance correctness preserved
  (LOCK-PERF-5) - delegation, tools, skills, MCP, permissions,
  parent-child/background/parallel sessions, persistence, SessionRevert+Snapshot,
  overflow safeguard - with no regression in transport/event handling or prompt
  latency attribution.
- Evidence: before/after metrics recorded in the tracker (section 8) against the
  recorded thresholds (section 9); issue/PR/test/doc evidence per phase; nothing
  claimed without measurement (LOCK-PERF-6).

### 10.11 Evidence status

- P0 baseline recorded (2026-08-12): six accepted repeated campaigns under
  `specs/vscode-orchestrator/evidence/p0-baseline/` (Extension Host cold-start,
  many-agent-MCP, historical and current-tier backend in-process
  `Server.listen`/`AppLayer`, warm-view/no-provider/custom-provider,
  session-switch) with measured values recorded in the tracker (section 8) as
  descriptive n=5 sample statistics with evidence links. The backend campaigns
  are CLI-side in-process harness evidence only — neither target-surface nor
  private-worker evidence.
- Target-only metrics without a P0 measurement are later-phase gates, not P0
  blockers: persisted-selector paint gates at P5 (no extension-owned persisted
  indexes exist before P4.1); cost attribution (LOCK-PERF-7) and per-event
  transport/webview render flush gate at P2 (harness-parity/streaming);
  removed-feature initialization count and startup-work net reduction gate at
  P3/P4.4 (removal). No performance threshold is claimed (R7 remains Open;
  required-by clarified in section 9).
- Existing partial instrumentation - `kilo startup`
  (`packages/opencode/src/cli/cmd/debug/startup.ts`, prints process-start
  `performance.now()`), provider `log.time`, Effect spans, and ACP profiling
  (`packages/opencode/src/acp/profile.ts`) - is not sufficient for extension
  performance acceptance.
- Every value in the tracker performance metrics table stays `Not proven`/TBD
  until a measurement with an evidence link is recorded there (LOCK-PERF-6);
  the tracker (section 8) is the mutable source of truth for metric values.

## 11. Verification Commands

Markdown/table check for the spec files (must pass without modifying anything):

- `bun run script/check-md-table-padding.ts specs/adr/0002-focus-vscode-on-agent-orchestration.md specs/adr/0003-replace-cli-configuration-with-private-gui-runtime.md specs/vscode-orchestrator/agent-orchestration-direction.md specs/vscode-orchestrator/runtime-and-configuration-direction.md specs/vscode-orchestrator/migration-tracker.md`

Architecture impact check (run from repo root; report the outcome):

- `bun run script/check-architecture-impact.ts --worktree`

No source-code, test, or typecheck commands apply: this work creates decision/spec
artifacts only (LOCK-013).
