# Private GUI Runtime and Configuration - Technical Direction

## Goal

Internal technical specification for replacing the CLI-owned configuration and
runtime authority with an extension-owned private runtime and file-authoritative
GUI-managed configuration for the VS Code Agent Orchestrator. It explains why
the current architecture produces the observed startup and config problems,
defines the target ownership domains so every datum has one owner and one
persistence path, defines the custom-provider-only boundary, the config update
semantics, the startup acceptance criteria, and a no-big-bang migration strategy
with an atomic legacy-reader cutover at P4.3 (no dual-read window, no import). A
fresh session must be able to read this file and continue the work without
rediscovering the decisions, root causes, ownership domains, or phases.

The durable decisions are recorded in
[ADR-0003: Replace CLI Configuration with Private GUI Runtime](../adr/0003-replace-cli-configuration-with-private-gui-runtime.md)
(Status: Active) and
[ADR-0002: Focus VS Code on Agent Orchestration](../adr/0002-focus-vscode-on-agent-orchestration.md)
(Status: Active). The just-in-time direct-reconstruction policy is recorded in
[ADR-0004: Architecture-First Direct Reconstruction](../adr/0004-architecture-first-direct-reconstruction.md)
(Status: Active); this document owns its bounded Failure/Outcome/Recovery target
(section 7.2) and the R11-R14 bounded implementation decisions (section 9).
The durable storage decision is recorded in
[ADR-0005: Bounded Private-Runtime Storage](../adr/0005-bounded-private-runtime-storage.md)
(Status: Active), which supersedes ADR-0001's checkpoint + resync / multi-client
transport target; this document owns the P4.2 storage integration (ordering,
gates, R9/R11 interaction, R15-R17) and its implementation source of truth is
the [storage spec](../storage/session-storage-rewriting.md).
This document is the implementation source of truth for the
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
- The legal source taxonomy and field registry: the closed set of authored
  inputs that may contribute to effective config — the file-authoritative hybrid
  with exactly two canonical authored scopes (one global config root and
  `<workspaceRoot>/.kilo/`) — and the registry that assigns every configurable
  field class one owner, one persistence path, one composition operator, and one
  removal disposition (sections 3.1, 3.2).
- The provider target: custom provider records only (section 4).
- Configuration update semantics and lifecycle: atomic version creation,
  generation snapshot pinning, action-specific readiness, resource version
  ownership/disposal, rollback/error behavior, validation before commit, and no
  active-generation interruption (section 5).
- The config authority and materialization contract: canonical file/asset
  authority (file-authoritative hybrid), typed composition, deterministic
  materialization, provenance, agent-manifest role, restrictive permission
  composition, the bidirectional file-editing/WYSIWYG contract, and
  effective-config source removal disposition (sections 5.1-5.4, 8.1).
- Startup acceptance: persisted selectors before worker readiness, no global
  disable, visible reconciliation, cold/warm instrumentation, no autocomplete
  prewarm dependency (section 6).
- Migration strategy from the current HTTP/SSE/config system without a big-bang
  rewrite (section 7).
- The removal checklist for all LOCK-002/003/004/006 removals with evidence
  categories (section 8).
- Bounded implementation decisions, resolved with objective evidence before the
  affected phase can exit (section 9).
- The observation/hydration contract: runtime sole authority for operational
  facts; extension/webview state is derived presentation/read-model state;
  snapshot/revision/event convergence across transport reconnect and worker
  restart (section 7.1).
- The bounded Failure/Outcome/Recovery target: an independently valuable
  runtime-owned foundation — one normalization boundary, minimal Failure/Outcome
  schema without taxonomy freeze, operation identity/outcome facts, minimal field
  tiers, runtime-side redaction, structured redacted panel projection,
  cancellation provenance, schema ownership, and the private runtime as sole
  semantic recovery authority — with post-reconstruction maturity separately
  scoped and the four bounded implementation decisions R11-R14 required by P4.2
  (sections 7.2, 7.3, 9).
- The storage foundation landing inside P4.2: canonical aggregate storage with
  invisible automatic byte-budget retention, the artifact field/owner/retention
  registry, and the offline archive cutover (ADR-0005; storage spec sections
  5-8). P4.2a (storage) is the first sub-boundary and lands before the P4.2b
  private-wire/schema freeze for R9 and R11-R14 (sections 7, 9); R15-R17 are
  bounded here (section 9).
- The performance model: cost attribution, redundancy candidates, latency
  attribution, instrumentation plan, benchmark scenarios, regression gates, and
  runtime-slimming acceptance criteria (section 10).

Not in scope: product surfaces, the harness capability matrix, and product
removal phases (owned by `agent-orchestration-direction.md`); standalone
storage work outside the P4.2 storage foundation (owned by the storage spec
under ADR-0005 — ADR-0001's checkpoint/resync direction is superseded and is
not target behavior); code changes of any kind.

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
- `packages/opencode/src/config/agent.ts` - agent markdown is scanned from
  `{agent,agents}/**/*.md` (`Glob.scan`, line 30), parsed through the shared
  config-object schema (`ConfigMarkdown.parse`), and merged per-field with
  config-defined agents; per-agent permissions are merged onto defaults via
  `Permission.merge` (`packages/opencode/src/agent/agent.ts:330,351`).
- `packages/opencode/src/permission/index.ts` - `evaluate` picks the last
  matching rule with `findLast` (lines 107-113): last-match-wins within the
  flattened rulesets; `resolve` layers base/session/saved overrides.
- `packages/opencode/src/agent/subagent-permissions.ts` - a subagent's session
  inherits the parent agent's `deny` edit rules and default-denies
  `task`/`todowrite` when absent (lines 23-33), while session restrictions are
  session-scoped.
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
| Config authority | CLI backend merges 12+ sources (2.2) | File-authoritative hybrid: canonical config files/assets under one global config root and `<workspaceRoot>/.kilo/`; the GUI is a bidirectional editor/read model over them (sections 3-3.2, 5.1, 5.4) |
| Config application | Cold saves rebuild directory-keyed identities through convergence (2.4) | Deterministic materialization to immutable versioned snapshots; typed composition; no active-generation interruption (sections 5, 5.1) |
| Effective-config input | Right-biased deep merge; global/project file load order conflicts with the write-target preference; root-file and config-dir loaders disagree; overlay provenance collapses many sources to `system` (2.2) | Closed legal source taxonomy; schema-declared composition operators replace generic merge/last-writer-wins (sections 3.1, 5.1) |
| Providers | Preset catalogs + config + auth + organization sources (2.3) | User-defined/custom provider records only (section 4) |
| Selector readiness | Backend spawn -> SSE -> HTTP fetch -> UI enable (2.5) | Persisted indexes render and remain interactive independent of worker lifecycle; action-specific gates (section 6) |
| Runtime process | General `kilo serve` child with public HTTP/SSE/SDK surface (2.1) | Extension-owned private headless worker; private transport (section 7) |
| Agent definitions | Agent markdown shares the config-object schema and merges per-field with config-defined agents; per-agent permission currently overrides global user policy (2.2) | Typed canonical agent manifests: agent markdown retained as a canonical project/global asset, one manifest per ID; duplicate/conflict fails validation, never widens enclosing policy (section 5.2) |
| Permission evaluation | Last-match-wins within flattened layers; session tool toggles can weaken non-mode agent denies; `question` and legacy `mcp` rules have enforcement ambiguity (2.2) | Restrictive policy stack with monotonic deny/ask/allow composition; provenance identifies contributing policies and the decisive rule (section 5.3) |

### 2.7 Error, retry, and recovery ownership (evidence)

Failure/outcome/recovery handling today is spread across multiple owners with no
single authority over what an operation's outcome is, who may retry it, and when
recovery is complete:

- The session prompt loop owns retry scheduling and classification:
  `SessionRetry.policy` / `SessionRetry.retryable`
  (`packages/opencode/src/session/retry.ts`) classify errors and schedule
  exponential backoff (2000 ms initial delay, 30000 ms local cap) or a
  server-provided `Retry-After`/`retry-after-ms` value capped only by the 32-bit
  `setTimeout` maximum, publishing `retry` status events
  (`packages/opencode/src/session/processor.ts`,
  `KiloSessionProcessor.retryOpts`).
- The LLM executor owns a separate retry input: `maxRetries: input.retries ?? 0`
  at the AI-SDK call layer (`packages/opencode/src/session/llm.ts`).
- Child/incomplete-session loops own their own bounded same-session retries:
  transient provider failures on child task sessions
  (`packages/opencode/src/tool/task.ts`,
  `packages/opencode/src/kilocode/tool/task-retry.ts`) and retry of terminally
  incomplete attempts before settlement (`packages/opencode/src/session/processor.ts`).
- The extension owns retry on its side too: an exponential-backoff ladder
  (5s/10s/30s/60s/300s) with `Retry-After`/`Retry-After-MS` extraction and
  per-session abort controllers (`packages/kilo-vscode/src/util/retry.ts`,
  `packages/kilo-vscode/src/KiloProvider.ts` `withRetry`), a generic 3-attempt
  `retry()` (`packages/kilo-vscode/src/services/cli-backend/retry.ts`), and SSE
  reconnect retry (`packages/kilo-vscode/src/services/cli-backend/sdk-sse-adapter.ts`).
- The retry limit is an environment flag (`Flag.KILO_SESSION_RETRY_LIMIT`,
  `packages/opencode/src/kilocode/session/processor.ts`), not a runtime policy.
- There is no unified operation/outcome identity: no runtime-owned record says
  whether a submitted prompt, a tool call, or a child task reached a terminal or
  intermediate outcome, who owns its retry budget and provenance, or how a
  worker crash disposes an in-flight operation.
- The paused `jorkey/feature/error-system` branch is design/input evidence only
  (ADR-0004): it intentionally did not change retry policy, and its
  compatibility/versioning/client scope is discarded under the current product
  removals.

None of this binds the target: the Failure/Outcome/Recovery target (section
7.2) does not preserve these implementation shapes, the current error
taxonomy, delay ladders, the environment retry flag, or the auto-continue
implementation (ADR-0004). The target is not merely retry support: one
runtime-owned normalization boundary, minimal schema without taxonomy freeze,
field tiers, redaction, persistence/projection, cancellation provenance, and
schema ownership each earn independent rationale across provider/session/tool/
permission/worker/UI errors, with recovery as one consumer of those facts
(section 7.2).

## 3. Target State Ownership Domains

Every datum has exactly one owner and one persistence path. No datum is owned by
two stores, and no store is authoritative for two owners' data. The model is a
file-authoritative hybrid (LOCK-010): all user-authored effective configuration is
file-authoritative and WYSIWYG through the UI, under exactly two canonical
authored scopes.

Canonical scopes and legal inputs (effective-config inputs):

| Domain | Owner | Persistence path | Legal contents |
|---|---|---|---|
| Canonical global config files/assets | User authoring; extension host (GUI) reads/writes on the user's behalf | One canonical global config root (file system) | Global-effective config fields and global typed assets (for example global agent markdown, commands, rules, skills) per the field registry |
| Canonical project config files/assets | User authoring; extension host (canonical boundary) | First VS Code workspace root, assets only under `<workspaceRoot>/.kilo/` (R5) | Project-effective config fields and project typed assets (for example agent markdown, commands, skills, project MCP/tool declarations) per the field registry |
| Secrets | Extension host | VS Code SecretStorage | Credentials only, referenced by opaque IDs |
| Runtime defaults and safety invariants | Versioned runtime schema | Schema (versioned) | Defaults and safety invariants, never user-authored overlays |

Documented separately — not effective-config inputs:

| Domain | Owner | Persistence path | Legal contents |
|---|---|---|---|
| VS Code application state | Extension host | VS Code `globalState` / `workspaceState` | UI-only layout/churn, dismissed state, derived selector/read-model indexes; never effective-config authority |
| Session and storage state | Runtime (harness kernel) | Runtime-owned persistence: canonical aggregate storage + registered artifacts after the P4.2 cutover (ADR-0005; storage spec); the legacy store serves P1-P3 until the cutover | Sessions, events, artifacts, transcript data, operational facts; automatic retention is invisible runtime maintenance, not a user surface. The P4.2 cutover boots an empty canonical DB with no pre-cutover sessions; the operational-containment last-week set remains only in the offline legacy archive (ADR-0005 I-8/I-10; storage spec section 6.2) |
| Permission approval records | Runtime (per-session) | Runtime-owned per-session records | Explicit operation approvals with bounded scope/lifetime (section 5.3); never authored config |
| Immutable runtime snapshot | Runtime (harness kernel) | Derived versioned value, created atomically on config commit | Effective config + runtime identity consumed by generations; derived, not a second persisted store (R2) |
| Private worker resources | Private worker (per version, lazy) | Version-scoped resource ownership | Provider/MCP/tool resources; disposed only after owners release them |

Rules:

- File-authoritative hybrid: every effective setting has canonical file/asset
  provenance; the UI is a bidirectional editor/read model over canonical
  files/assets, not a separate config store (section 5.4). Complex records and
  secrets never live in VS Code settings.json; `globalState`/`workspaceState`
  are UI-local/derived only and are never effective-config authority (ADR-0003,
  LOCK-010).
- The runtime never merges canonical files with other sources; it consumes the
  immutable snapshot built from the canonical inputs of the two authored scopes
  plus schema defaults and opaque secret references.
- Resource lifecycle follows version ownership: replacement is version-scoped and
  lazy, and old resources are disposed only after their owners release them
  (LOCK-011).
- Derived snapshots are versioned values, not a second persisted store; their
  identity includes canonical file content, the schema version, and opaque
  secret references — never UI state (sections 5.1, 9 R2).

### 3.1 Legal source taxonomy

The set of authored inputs that may contribute to effective config is closed and
typed. Every datum belongs to exactly one category below; a datum that is not
assigned to one of them is invalid until its ownership is decided.

| # | Source class | Owner | Persistence | Legal contents |
|---|---|---|---|---|
| 1 | Canonical global config files/assets | User authoring; extension host (GUI) reads/writes on the user's behalf | One canonical global config root | Global-effective config fields and global typed assets (for example global agent markdown, commands, rules, skills) per the field registry (section 3.2) |
| 2 | Canonical project config files/assets | User authoring; extension host (canonical boundary) | `<workspaceRoot>/.kilo/` (R5) | Project-effective config fields and project typed assets (for example agent markdown, commands, skills, project MCP/tool declarations) per the field registry (section 3.2) |
| 3 | SecretStorage credentials | Extension host | VS Code SecretStorage | Credentials only, referenced by opaque IDs |
| 4 | Runtime defaults and safety invariants | Versioned runtime schema | Schema (versioned) | Defaults and safety invariants, never user-authored overlays |

The two authored scopes (rows 1-2) are the only canonical authored scopes:
global-only, project-only, or both-with-typed-composition per field is decided by
the field registry (section 3.2); agent markdown is retained as a typed
canonical project/global asset with one manifest per ID (section 5.2).

Not effective-config inputs (documented separately in section 3): VS
Code `globalState`/`workspaceState` (UI-only layout/churn, dismissed state,
derived selector/read-model indexes), runtime/session storage (operational facts
and session state), and bounded permission approval records (explicit operation
records). There is no arbitrary external path or ancestor source: generic
compatibility readers/overlays, `KILO_CONFIG*`/`KILO_PERMISSION` overrides,
`.opencode`/`.kilocode` locations, ancestor directory walks, cloud/org/managed
config, legacy global config filenames/readers, top-level `mode`/`tools`
conversions, and arbitrary CLI/env override layers are removed as sources
(sections 5.1, 8.1). Explicit session/request intent is an operation against a
materialized snapshot, not another config source (section 5.1).

### 3.2 Field registry

Every configurable field class has a registry entry before P4.1 exits (R10,
section 9): canonical schema path, owner/storage, legal scope (global-only,
project-only, or both-with-typed-composition), composition operator, validation,
secret handling, generation-snapshot inclusion, provenance, and removal
disposition (deletion at the P4.3 cutover with no target reader — there is no
migration/import disposition). The registry is the enforcement surface for one
datum/one owner/one persistence path and for file/asset provenance: no
unregistered or deprecated key is silently accepted, no field class reads from
more than one legal source class (section 3.1), and every effective setting
resolves to canonical file/asset provenance (section 5.1).

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
  user-defined provider records and agent manifests in the canonical files/assets
  (section 3.1), so selection does not depend on the worker being ready; the
  indexes are UI-local/derived state, never effective-config authority (section
  3, R2).
- Runtime connection and validation of a user-defined provider is a separate,
  action-specific readiness concern (section 5 and 6); it never globally disables
  selection.

## 5. Configuration Update Semantics And Lifecycle

- Validation before commit: an update is validated against the versioned runtime
  schema (section 5.1) and, where meaningful, against the resources it targets
  before a new version is committed. A failed validation aborts the update; the
  prior version stays authoritative.
- Typed composition: field values compose only through the schema-declared
  operator for that field (section 5.1); generic deep merge and last-writer-wins
  are not the target model.
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

### 5.1 Config authority and deterministic materialization

- Canonical schema authority: one versioned runtime schema is the single
  authority for field identity, validation, defaults, safety invariants, and
  per-field composition operators. The schema version participates in every
  materialization: the same canonical inputs at the same schema version produce
  the same snapshot identity/hash. Snapshot identity comprises canonical file
  content, the schema version, and opaque secret identity/references as
  appropriate — never UI state (LOCK-010). Every effective setting has canonical
  file/asset provenance.
- Deterministic materialization, not a runtime merge: all canonical records and
  assets (section 3.1) are validated together and one immutable, versioned
  generation snapshot is emitted, or the update is rejected. The snapshot
  includes the resolved agent manifest/prompt, effective permission policy,
  tool/skill/MCP availability and declarations, custom-provider/model references,
  and the runtime options a generation needs. Secrets remain opaque references
  resolved through SecretStorage ownership as appropriate. After a failure there
  is no partial fallback to stale or legacy values.
- Typed composition: composition never uses generic deep merge or last-writer-wins
  (LOCK-011 target model). Each field composes only through its schema-declared
  operator, which is one of: single value (duplicate/conflict is a validation
  error), keyed collection by stable ID (duplicate-ID conflict is an error unless
  the schema explicitly defines replacement), ordered list (ordering defined by
  the schema), or restrictive policy composition (section 5.3). There is no
  generic fallback precedence.
- Provenance and explainability: effective-config and permission decisions are
  explainable. Machine-inspectable provenance identifies the schema version, the
  canonical owner/input (file/asset), explicit vs default status, the composition
  operator, and the decisive conflict or policy rule. Validation/conflict and
  diagnostic surfaces are acceptance requirements, not later UI options.
- Env/CLI disposition: no generic compatibility reader or overlay is an
  effective-config source: `KILO_CONFIG`, `KILO_CONFIG_DIR`,
  `KILO_CONFIG_CONTENT`, `KILO_PERMISSION`, legacy `opencode.*` keys,
  `.kilocode`/`.opencode` locations, ancestor directory walks, cloud/org/managed
  config sources, legacy global config filenames/readers, top-level `mode`/`tools`
  conversions, and arbitrary CLI/env override layers are removed as sources
  (section 8.1). There is no migration/import tool and no dual-read compatibility
  window: before the P4.3 cutover the current implementation may still read
  legacy sources; at the cutover all legacy readers are deleted together and
  cannot affect effective config (sections 7, 8.1; R6 revised 2026-08-13). The
  sole user manually recreates any desired current configuration in the
  canonical files before the cutover. Private-worker bootstrap/diagnostic
  process parameters are not configuration sources.

### 5.2 Agent manifests

- Agent markdown is retained as a typed canonical project/global asset (section
  3.1), not a second general config source: a schema-defined manifest with one
  manifest per agent ID; duplicate IDs or conflicting definitions fail
  validation. GUI-authored agents write these canonical manifests, so GUI edits
  never bypass file provenance (section 5.4).
- A manifest may define the agent prompt and schema-approved agent
  specialization/defaults (for example model or tool defaults). It cannot own
  provider credentials, product/global selector state, or weaken the enclosing
  permission/safety policy (section 5.3).
- Legacy mode/agent config keys and alternate agent directories have no target
  reader: they are deleted at the P4.3 cutover, and any desired agents are
  recreated manually as canonical manifests (no import; section 8.1). The exact
  canonical asset path and schema for each agent field class are assigned in the
  field registry (section 3.2, R10).

### 5.3 Permission composition

- Permission targets compose as a restrictive policy stack: runtime hard safety
  ceilings, enclosing global/workspace policy, the selected agent manifest's
  policy, and session restrictions compose monotonically. Deny at any applicable
  enclosing layer wins; otherwise ask wins over allow when any applicable layer
  requires confirmation; allow requires every applicable layer to permit the
  action.
- Agent manifests and session tool toggles may narrow permissions but never widen
  enclosing restrictions. An explicit user approval may resolve an ask for its
  bounded scope/lifetime but never overrides a deny or a hard safety ceiling.
- Wildcard/rule ordering may exist within one owned policy document where the
  schema defines it; later sources never override other policy layers.
- MCP/skill/tool enablement is availability/capability discovery, not permission
  authorization. Provenance for a permission decision identifies every
  contributing policy and the decisive rule (section 5.1).

Child sessions and inheritance:

- Parent denies and session restrictions are enclosing for child sessions; a
  parent's allow is not inherited by children. A child evaluates against the
  enclosing global/project policy, its selected agent manifest, and its own
  session restrictions (current baseline behavior already defaults a subagent to
  denied `task`/`todowrite` and inherits the parent agent's `deny` edit rules —
  `packages/opencode/src/agent/subagent-permissions.ts`).

Question flow and tool distinction:

- The free-form question flow (a runtime ask rendered to the user) and the
  `question` tool (a harness tool a session invokes) are distinct targets:
  permission evaluation treats them as separate permission strings with their own
  registry entries (section 3.2), removing the current enforcement ambiguity
  between `question` and legacy `mcp` rules.

Approval records:

- Explicit approvals are runtime-owned per-session operation records with bounded
  scope/lifetime, by default not persisted beyond the session. A durable policy
  change is authored config and is written to canonical files only through a
  separate UI/file edit (section 5.4) — never as a side effect of answering an
  ask. "Allow everything" is a per-session approval that resolves asks only; it
  never overrides a deny or a hard safety ceiling.
- No-rule default is ask. A session tool toggle-on changes availability only (it
  creates no permission grant); toggle-off adds a session restriction.
- Generated availability defaults (tool/skill/MCP availability inferred for the
  selected agent) live at the selected-agent layer, below the enclosing
  global/project policies.

### 5.4 Bidirectional file editing and WYSIWYG acceptance

The UI is a bidirectional editor/read model over canonical files/assets, not a
separate config store (LOCK-010). There is exactly one effective-config
representation: the canonical files/assets of section 3.1 plus schema defaults
and opaque secret references. The UI never holds a second authoritative copy.

- UI commits: a UI edit validates against the schema (section 5.1) and atomically
  writes the canonical file(s); the deterministic materializer emits a new
  version (section 5.1). A failed validation aborts the write and reports
  file/field provenance; the prior valid snapshot stays authoritative.
- External edits: canonical files are watched. An external file change is
  validated, materialized into a new version, and reconciled visibly into the UI
  without a manual reload. Active generations remain pinned to the snapshot they
  started with; new readers/generations use the new valid snapshot (LOCK-011).
- Draft conflicts: stale drafts are detected with content/version stamps. A stale
  draft plus an external edit surfaces a visible conflict and never silently
  overwrites the file.
- Invalid external edits: an invalid external edit does not partially apply and
  does not fall back to legacy values; it reports file/field provenance and
  preserves the prior valid snapshot until corrected.
- File deletion/unset: deletion of a canonical file or field maps to the
  schema-defined unset/default handling (section 5.1), predictably and visibly.

WYSIWYG acceptance semantics (gated at P4.1). These behavioral semantics
are decided here; the exact UI presentation (dialogs, diff surfaces, notification
wording, where each is shown) is a product decision under direction spec open
question 5:

- File-to-UI: external edits to canonical files are observed without manual
  reload and rendered in the UI.
- UI-to-file: UI writes preserve JSONC/markdown formatting where possible and are
  atomic and validated.
- Conflict: a stale draft plus an external edit gives a visible conflict, never a
  silent overwrite.
- Invalid external edits: never partially apply and never fall back to legacy
  values; the prior valid snapshot is preserved.
- Deletion/unset: file deletion and field unset map predictably to
  schema-defined defaults.
- Generation pinning: active generations retain the old snapshot; new
  readers/generations use the new valid snapshot.

## 6. Startup Acceptance

Accepted behavior once the runtime/config migration lands (P5 gates). The
target is streamlined, unified, and efficient: selector and navigation UI do
not wait on the private worker or on runtime/provider catalog readiness, and
the target removes redundant connection stages — it does not merely shorten a
spinner. Worker startup may still take time; a waiting or disabled selector
surface during that time is not acceptable target behavior.

Normative acceptance criteria (each is a P5 exit gate and is falsifiable by
the named evidence; R3/R7, section 9, bound only the numeric parts):

1. Selector availability is independent of worker lifecycle (LOCK-012). Custom
   provider, model, and agent selectors render and remain interactive from
   extension-owned persisted indexes while the private worker is not started,
   is deliberately unavailable (withheld, killed, or failed to spawn), is
   starting, is reconnecting, or is in a failed state. No worker lifecycle
   state may disable a selector, replace a selector with a waiting state, or
   blank the selector surface.
2. Selection is never disabled by readiness. Selecting a provider, model, or
   agent is not disabled solely because runtime or provider validation
   readiness has not been reached. Runtime-required actions (for example
   prompt submission, provider validation, live provider testing) are gated
   individually with an explicit state and reason surfaced to the user;
   selection itself is not a runtime-required action.
3. Reconciliation preserves selector availability. External canonical-file and
   persisted-index reconciliation (section 5.4) preserves selector
   availability: during and after reconciliation, selectors keep rendering and
   accepting input from the last-known valid derived index, or present the
   invalid/stale state explicitly (marked stale/invalid with the reason),
   without erasing the user's choice; reconciliation never reintroduces a
   worker-readiness dependency into the selector path and never blanks or
   disables selectors as a side effect.
4. Structural absence of the old readiness chain is proven (P4.4/P4.5).
   Objective structural evidence proves the absence of the single global
   `extensionDataReady` barrier, the port-detection/health/SSE/generated-SDK
   selector fetch chain (section 2.5), and the removed startup contributors
   (LOCK-PERF-3, section 10.4) from the worker startup path. The selector data
   path is the extension-owned persisted index, not a backend fetch.
5. P5 evidence includes a real worker-unavailable scenario. P5 exit evidence
   includes an Extension Host scenario in which the worker is withheld, killed,
   or failed while selectors still render and remain interactive, plus
   descriptive paint-before-ready timing and provenance per R7 (section 9):
   persisted-selector paint occurs before worker readiness, with cold and warm
   per-stage timing recorded descriptively (section 10.8); no numeric SLA is
   mandated here (R3, section 9).
6. Cold and warm activation distinguish UI selector readiness from runtime
   action readiness. Cold and warm instrumentation records separately when the
   selector/navigation UI is interactive (persisted indexes) and when
   runtime-required actions become available (worker ready). These are two
   distinct facts; acceptance evidence never collapses them into one
   readiness point.

Also accepted, unchanged:

- Invalid or stale entries reconcile visibly without erasing the user's choice
  (criterion 3).
- Startup stages are instrumented (cold and warm), so per-stage timing and
  failure are observable; no numeric SLA is mandated here (R3, criteria 5-6).
- No autocomplete prewarm dependency: autocomplete is removed (LOCK-004) and
  the worker never starts merely to prewarm completions.
- No single `extensionDataReady` barrier remains as a gate for the whole UI;
  gates are action-specific (LOCK-012, criterion 4).

Clarifications that bound the criteria:

- Worker startup may still take time; the target removes the coupling that
  makes selector/navigation UI wait on it. Redundant connection stages (port
  detection, health checks, SSE connect, generated-SDK fetches on the selector
  path) are removed, not merely shortened.
- Direction spec open question 5 decides how the configuration surface is
  presented; it cannot gate selector availability (criteria 1-2).
- Numeric SLA policy (R3, section 9) remains open; criteria 1-4 and 6 are
  behavioral/structural gates that apply regardless of any numeric decision.

## 7. Migration Strategy

The migration replaces the current HTTP/SSE/config system without a big-bang
rewrite. Each step is a phase with objective gates (tracked in
`migration-tracker.md`; runtime phases P4.x, startup phase P5).

1. Inventory: enumerate config sources (section 2.2), provider sources and loaders
   (2.3), readiness chain stages (2.5), and the removal surface list (section 8).
   Baseline counts are recorded in the tracker. Enumerated sources are classified
    against the legal source taxonomy (section 3.1) as legal or removed; there is
    no migration-input class, and classification drives the removal
    inventory (section 8.1).
2. File-authoritative GUI read/write model: the extension owns the bidirectional
   editor over canonical config files/assets (section 5.4) and the persisted
   selector indexes derived from them (section 3). The extension becomes the
   read-model authority for UI state, guided by the field registry (section 3.2)
   so every field class has one owner and one persistence path before P4.1 exits.
3. Legacy-reader cutover (no dual-read): there is no dual-read compatibility
   window and no import tool. Until the P4.3 cutover the current implementation
   may use the legacy sources it reads today; at the P4.3 phase boundary all
   legacy readers are deleted together and can no longer influence effective
   config (R6, revised 2026-08-13; sections 8.1, 9). The sole user manually
   reconciles any desired current configuration into the canonical files before
   the cutover; the extension provides no automatic migration.
4. Private runtime entrypoint: an extension-owned private headless worker process
   outside the Extension Host (LOCK-009) with a snapshot API.
5. Snapshot API: versioned immutable config/runtime snapshots (section 5) that
   generations consume; generated-SDK/public HTTP calls cease to be the
   consumption path. Snapshots are produced by the deterministic materializer
   (section 5.1) from the canonical records/assets of section 3.1; snapshot
   identity includes canonical file content, the schema version, and opaque
   secret references — never UI state.
6. Source removal (P4.4): remove the 12-source merge, preset provider loaders
   and catalog, and the convergence/rebuild machinery (sections 2.2-2.4); remove
   the extension's wait-on-backend fetch chain (2.5). The legacy readers
   themselves were deleted together at the P4.3 cutover (step 3); P4.4 records
   and verifies per-row inactive/removal evidence for every legacy
   effective-config source class (section 8.1) — including legacy global config
   filenames/readers and legacy migration readers — with disposition deletion
   and no target reader; no generic compatibility reader survives.
7. Transport narrowing (P4.4): replace the HTTP/SSE/SDK surface with the private
   transport; the generated SDK and public server surface stop being public
   interfaces. The private transport protocol is an internal implementation choice
   (bounded decision, section 9), not a compatibility contract.
8. Old CLI/server deletion (P4.5): delete the CLI/TUI/Console product surfaces and
   public interfaces (LOCK-009) after the P4.3 cutover and the P4.4 transport
   narrowing.

Constraints: no dual-read window and no import; the old path is deleted, not
retained; every step has objective exit evidence in the tracker; canonical
architecture docs change only when implementation lands (LOCK-013). After the
P4.3 cutover no generic compatibility reader or overlay is an effective-config
source (sections 5.1, 8.1) — all legacy readers are deleted together — and P4.4
records per-source removal evidence in the tracker. Operational facts about
sessions/worker state are observed through the runtime observation and hydration
contract (section 7.1) — distinct from the immutable config snapshot consumption
path (step 5) — and the observation surface rides the private transport (R1)
after the P4.4 transport narrowing. Failure/outcome/recovery behavior follows
the section 7.2 target on the private runtime; the current retry/error stack
(section 2.7) is implementation history, not a target contract (ADR-0004).
Storage: within P4.2, the storage foundation and cutover (P4.2a; storage spec
work units S0..S5) is the first sub-boundary and precedes the P4.2b private-wire/
schema freeze for R9 and R11-R14; P4.2 cannot exit until the canonical
schema/revision model, automatic retention, artifact registry, R15-R17,
clean-DB cutover, and H-10/H-11 persistence/lifecycle evidence all pass
(ADR-0005 I-11; storage spec section 8). P4.2a's storage cutover (offline
archive, fresh canonical DB) mirrors this step 3 cutover discipline: no
migration/import, no dual-reader, and no runtime archive reader. Legacy
storage writers/readers and the old sync/warp surfaces are removed at
P4.4/P4.5 (section 8.2).

### 7.1 Runtime observation and hydration contract

The runtime is the sole authority for operational facts about sessions and the
worker: session existence and lifecycle state, message presence and ordering,
state-transition timing, and resource ownership. Extension and webview state is
derived presentation/read-model state: the UI renders and routes runtime
operational facts and never invents, revises, or independently persists them.
This is a one-owner constraint on the same basis as the section 3 ownership
domains; it does not create a new persisted store.

- Observation shape: operational facts are exposed to the extension/webview as
  observational snapshots plus revisions/events. "Snapshot" here is an
  observation of runtime state, distinct from the immutable config-generation
  snapshots of section 5. Revisions/events are deltas over the same facts.
- Occurrence vs receipt time: when semantics depend on it, a fact's occurrence
  time is runtime-owned and distinguished from receipt/transport time; the
  presentation side never reports transport time as the fact's own time.
- Convergence: on transport reconnect and worker restart (and on panel
  close/reopen, reload, and session switch, which are extension-owned view
  lifecycle), the extension/webview read model converges to the runtime's current
  operational facts via snapshot/revision/event resynchronization — no stale,
  duplicated, or lost presentation state, and no UI-held fact surviving a view
  lifecycle boundary.
- Bounded, not prescriptive: this contract does not mandate event sourcing,
  durable retention of every ephemeral fact, polling, a timer subsystem, or a
  specific wire schema. The snapshot/event handshake, revision
  scope/ordering/idempotency, and retention policy sufficient to meet
  convergence are bounded implementation decisions (R9, section 9). R9 may use a
  bounded derived changefeed/outbox for reconnect deltas; such a feed is not
  authoritative history, is not required for reconstruction, and is eligible
  for automatic truncation once the extension/webview holds an authoritative
  hydration state (ADR-0005; storage spec sections 5.2, 9). The private
  transport (R1) is the carrier after the P4.4 transport narrowing, but its wire
  shape for observation is part of R9, not fixed here.

### 7.2 Failure/Outcome/Recovery

A bounded target foundation for failure, outcome, and recovery, owned here
(ADR-0004). It addresses the root causes of section 2.7 without preserving the
current retry/error implementation shapes, the existing error taxonomy, delay
ladders, the environment retry flag, the auto-continue implementation, or any
SDK/cloud/JetBrains/TUI projection of errors.

The foundation is independently valuable, not merely retry support: one
runtime-owned normalization boundary, a minimal Failure/Outcome schema without
taxonomy freeze, operation identity/outcome facts, minimal field tiers,
runtime-side redaction, structured redacted panel projection, cancellation
provenance, and schema ownership each earn their place across provider/session/
tool/permission/worker/UI errors; recovery is one consumer of these facts, not
the only purpose.

Normative target (P4.2 foundation):

- Runtime-owned normalization boundary: exactly one place converts
  provider/session/tool/permission/worker/transport errors into a runtime
  Failure record. Classification labels a failed operation and is separate from
  recovery: classifying an error never by itself schedules a retry.
- Minimal private-runtime Failure/Outcome schema without taxonomy freeze: the
  minimum fields needed to record an operation's outcome and its failure facts;
  no complete taxonomy is decided now.
- Operation identity and outcome are runtime-owned operational facts under the
  observation contract of section 7.1. Every accepted semantic operation on the
  generation path — prompt/generation, provider attempt, tool call,
  permission/question wait, child/background task — has a runtime-owned
  identity; its terminal or intermediate outcome (succeeded, failed, ambiguous,
  in-flight, superseded, abandoned) is a runtime fact, never invented or revised
  by the extension or webview. Config commit outcomes are owned by section 5 and
  section 5.4 and are not operations of this model.
- Minimal field tiers: each Failure/Outcome field is classified as durable,
  diagnostic, or panel-visible, so persistence, diagnostics, and projection each
  keep only what they need.
- Runtime-side redaction before persistence/projection: secrets and bounded
  detail are removed by the runtime before anything is persisted or projected.
- Structured redacted panel projection: the panel renders the runtime's
  outcome/recovery facts through a versioned private envelope, never a
  client-side re-derivation of failure.
- Cancellation provenance: a cancelled operation records why it was cancelled,
  distinguishing at least user stop, steering, timeout, network disconnect, and
  unknown.
- The private runtime is the sole semantic recovery authority. A client
  (extension/webview) may reconnect transport and re-observe state, but it may
  never replay or re-dispatch an accepted semantic operation; replay of an
  accepted operation is a runtime decision.
- Recovery policy has explicit owner/scope, budget consumed and termination,
  next-at occurrence time (when the next attempt may occur versus when the
  failure occurred), provenance (who requested it), and side-effect/replay-safety
  inputs (why it is safe: no committed side effect replayed, no ambiguous history
  re-driven).
- Nested low-level retries are not invisible to the owning operation's
  accounting: a low-level retry inside a provider/SDK/transport layer is visible
  to and consumes the owning operation's budget and provenance; it never loops
  outside the operation's accounting.
- A worker crash yields an explicit in-flight disposition: every accepted
  operation in flight at the crash converges to a recorded terminal/intermediate
  disposition under section 7.1 resynchronization, with no orphaned resource
  ownership and no silent replay.
- Schema/envelope ownership: the private error envelope's version/compatibility
  is owned by R1/R9/R12 as appropriate, never by a client projection.
- No requirement to preserve old retry/error behavior: section 2.7's multiple
  retry owners, Retry-After-driven first waits, and projection-specific error
  shapes are implementation history, not target contracts.

Not required by the P4.2 foundation (deferred to post-reconstruction maturity,
section 7.3): a complete taxonomy; a complete byte/depth sanitizer contract; rich
causal-chain diagnostics; telemetry/logging redesign; a user-facing action
catalog or notification UX; config-validation error unification;
SDK/cloud/JetBrains/TUI/public transport compatibility; the current delay
ladders and environment retry flag; auto-continue preservation.

The minimum private-runtime Failure/Outcome schema, normalization boundary,
field tiers, runtime redaction, cancellation provenance, versioned panel
envelope, recovery accounting/coordination, and worker-crash in-flight
disposition are bounded implementation decisions R11-R14 (section 9), required
by P4.2; a 14-variant taxonomy or a frozen algorithm set is not decided now
(ADR-0004). R11's durable Failure/Outcome fields persist in the canonical
aggregate storage / registered artifact model (ADR-0005; storage spec sections
5.1, 5.4); diagnostic and panel projections are derived and never create
competing stores.

### 7.3 Post-reconstruction error maturity

Separately planned work after core reconstruction (2026-08-14 decision). These
items are NOT reconstruction candidates: they are not displaced legacy
behaviors, they never create just-in-time registry entries, and they do not
block P4/P5 unless separately promoted:

- Taxonomy refinement — a complete error taxonomy; no freeze at P4.2.
- Diagnostic retention/sanitizer hardening — e.g. the paused error-system
  branch's byte/depth sanitizer contract is not a P4.2 requirement.
- Logs/telemetry keep-lists — which fields diagnostics/logs/telemetry retain.
- Rich error actions/notification routing — a user-facing action catalog and
  notification UX are not P4.2 requirements.
- Domain-specific error integrations — per provider/session/tool/permission/
  worker/UI domain, reusing the foundation's normalization boundary and schema.

Each item is promoted to scoped work by a recorded decision after core
reconstruction; promotion does not reopen the P4.2 foundation scope. The
tracker holds the named backlog/decision note (tracker section 7), deliberately
outside the just-in-time reconstruction candidate registry.

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

### 8.1 Effective-config source removal

Each row is a legacy effective-config source class (section 5.1) whose target
disposition is deletion at the P4.3 cutover with no target reader: no import
tool, no compatibility reader, and no dual-read window exists or will be created.
Legacy readers are deleted together at the P4.3 cutover (section 7); the P4.4
evidence phase records and verifies per-row inactive/removal evidence for all 13
classes below. Any desired current values are manually recreated in the canonical
files/assets of section 3.1 before the cutover (R6, revised 2026-08-13; section
9). A row is complete only when every existing evidence category for the item
records evidence (tracker section 7 rules) and the source is proven inactive — no
read of that source affects effective config after the cutover, because its
reader is deleted. The P0 baseline enumerates 15 current merge sources
(inventory §6.1); each maps onto a retained legal source class (section 3.1) or
exactly one of the 13 removal classes below, so no baseline source remains
unclassified after P4.4. The tracker records per-row evidence and the P4.4
counting method.

| Source class | Disposition | Evidence phase |
|---|---|---|
| `KILO_CONFIG` env override | Delete; no target reader; desired values recreated in canonical files | P4.4 |
| `KILO_CONFIG_DIR` env override | Delete; no target reader | P4.4 |
| `KILO_CONFIG_CONTENT` env override | Delete; no target reader | P4.4 |
| `KILO_PERMISSION` env override | Delete; no target reader; desired policy written to canonical policy files | P4.4 |
| Legacy `opencode.*` keys, `.opencode` / `.kilocode` locations | Delete; no target reader | P4.4 |
| Global project-asset sources | Delete; no target reader; project-versioned harness assets live only under `<workspaceRoot>/.kilo/` (R5) | P4.4 |
| Ancestor directory walks | Delete; no target reader; the canonical project boundary is `<workspaceRoot>/.kilo/` (R5) | P4.4 |
| Primary-worktree mirror reads | Delete; no target reader; effective config reads the first VS Code workspace root, never a primary-worktree mirror (R5) | P4.4 |
| Cloud/org/managed config sources | Delete; no target reader | P4.4 |
| Top-level `mode`/`tools` conversions | Delete; no target reader; desired agents/tools recreated as canonical typed assets | P4.4 |
| Arbitrary CLI/env override layers | Delete; no target reader; private-worker bootstrap/diagnostic process parameters are not configuration sources | P4.4 |
| Legacy global config filenames/readers | Delete; no target reader; the only global authored scope is the canonical global config root (section 3.1) | P4.4 |
| Legacy migration readers/import tooling | Delete; no target reader; no migration tool exists or will be created | P4.4 |

### 8.2 Legacy storage reader/writer removal

Old event-log and sync surfaces are removed with the old runtime surfaces
(ADR-0005 I-4/I-11; storage spec sections 3.4, 5.5). They have no default
compatibility entitlement (ADR-0004) and are removed at P4.4/P4.5 with the same
per-category evidence rules as section 8; none is reclassified as deferred.

| Removal | What is removed | Residual today | Phase |
|---|---|---|---|
| Multi-client sync/warp replay protocol | `/sync/history`, `/sync/replay`, `/sync/steal`, workspace sync live SSE replay, session warp over the event log | Present in repo (current sync/warp implementation on the event log) | P4.4/P4.5 |
| Old-peer capability negotiation / released-client storage compatibility | Capability negotiation for pre-compaction peers, mixed-version DB sharing boundary, removed-client compatibility for the event log; `/sync/checkpoint` was never built and is rejected | Present in repo (capability-boundary design only, never implemented) | P4.4/P4.5 |
| Unbounded full-payload event log as authoritative history | Append-only `event` table as authoritative durable history and sync transport; permanent duplicate full-payload snapshots; generic full-object update history | Present in repo (current behavior) | P4.4/P4.5 (canonical model replaces writes at P4.2a) |
| Legacy storage writers/readers | Event-log writers (`updateMessage`/`updatePart` full-snapshot publishes), event-log read paths, legacy file-backed storage prefixes (`session/`, `message/`, `part/`) | Present in repo | P4.4/P4.5 |

## 9. Bounded Implementation Decisions

These were intentionally not chosen at spec-writing time. They are recorded as
implementation decisions with objective evidence, before the affected phase can
exit. As of 2026-08-12, R1/R2/R5/R6/R8 are resolved with the decisions below
(also recorded in the tracker, section 9); R3 (numeric startup SLA) remains
open and R4 (adoption thresholds) is resolved 2026-08-15 — no numeric adoption
threshold applies to removal timing (see row); R7 (performance gate thresholds)
is resolved 2026-08-14 — performance gates use no numeric pass/fail thresholds
(see row).
R9 (observation/hydration implementation details) is added open on
2026-08-13, required by P4.2 (see row). R10 (canonical schema/field-registry
layout and exact persistence assignment) is added open on 2026-08-13, required
by P4.1 (see row). R11-R14 (Failure/Outcome/Recovery bounds: operation/outcome
identity, record location, and retention; minimum private-runtime
Failure/Outcome schema, normalization boundary, field tiers, runtime redaction,
cancellation provenance, and versioned panel envelope; recovery
accounting/coordination; worker-crash in-flight disposition) are added open on
2026-08-14, all required by P4.2 (see
rows; ADR-0004). R15-R17 (storage bounds: automatic retention values, canonical
aggregate schema/revision + changefeed disposition + artifact registry, and the
offline archive/cutover procedure) are resolved 2026-08-20 under ADR-0005,
all required by P4.2 (P4.2a storage sub-boundary) and not P1-P3 blockers (see
rows). The tracker (section 9) is the mutable
status source; this table is the durable decision record.

On 2026-08-13 R2 and R6 were revised by a post-P0 user clarification
(file-authoritative hybrid configuration; atomic cutover instead of dual-read).
The revised texts below are current; the original 2026-08-12 wording is
preserved as historical evidence in the tracker (section 9) and in the P0
checklist. P0 remains Complete; its recorded evidence is unchanged.

| Decision | Bounded by | Required by | Resolved (2026-08-12) |
|---|---|---|---|
| R1 Private transport protocol | Internal implementation choice; not a compatibility contract (LOCK-009) | P4.2 (snapshot API + transport) | Resolved: JSON-RPC 2.0 over child-process stdio with standard Content-Length framing (`vscode-jsonrpc` precedent). One extension-owned worker child; initialize handshake replaces port detection/health; requests carry commands, notifications carry normalized event envelopes; stderr remains bounded diagnostics; EOF/process exit owns lifecycle. HTTP/SSE/generated SDK remains bridge-only and is deleted. No retained-terminal protocol commitment: terminal/worktree surfaces are not LOCK-008 harness invariants and are handled by their removal/migration scope |
| R2 Storage engine for extension-owned state | Extension application state with VS Code storage APIs; complex records never in settings.json (LOCK-010) | P4.1 (file-authoritative read/write model) | Resolved (2026-08-12; **revised 2026-08-13**): canonical files/assets own effective config (one global config root and `<workspaceRoot>/.kilo/`, section 3.1); VS Code `globalState`/`workspaceState` own only UI-local/derived state (layout/churn, dismissed state, derived selector/read-model indexes); all secrets use `SecretStorage`; runtime-owned session/event/artifact persistence remains runtime-owned; immutable worker snapshots are derived versioned values — not a second persisted store — identified by canonical file content + schema version + opaque secret references, never by UI state. The original 2026-08-12 wording (product/UI config in `globalState`) is preserved as historical evidence in the tracker |
| R3 Numeric startup SLA | Thresholds are a recorded product decision; the behavioral and structural P5 gates (section 6 criteria 1-4, 6) are mandatory regardless — this row decides only whether numeric thresholds are added on top | P5 (startup acceptance) | Open |
| R4 Adoption thresholds for removal timing | Evidence-driven product decision | P3 (product removal gates) | Resolved (2026-08-15): no numeric adoption threshold applies to removal timing; removal proceeds per the decided phase order (P3.1..P3.4), each subphase preceded by the migration affordances already supplied (P1/P2) and recording its own exit evidence (tracker section 9) |
| R5 Exact project harness-assets path | One canonical explicit project boundary (LOCK-010) | P4.1 | Resolved (2026-08-12): one canonical project boundary = first VS Code workspace root; project-versioned harness assets live only under `<workspaceRoot>/.kilo/`, including `.kilo/kilo.json[c]`, agent/command/rules/skills/workflows/plans/config assets. P4.1 establishes the canonical project files and field registry; the ancestor walk, `.kilocode`/`.opencode`, global project-asset sources, and primary-worktree mirror reads are deleted together at the P4.3 cutover, with per-row removal evidence recorded at P4.4. No multi-source precedence remains; no migration/import tool exists |
| R6 Legacy-reader cutover (formerly: dual-read window deadline) | No dual authority and no compatibility window (LOCK-009; section 7) | P4.3 | Resolved (2026-08-12; **revised 2026-08-13**): there is no dual-read compatibility window and no import tool. P4.3 is the last legacy-reader phase boundary: the current implementation may use old sources only before the cutover; at the P4.3 boundary all legacy readers are deleted together and cannot influence effective config. The sole user manually reconciles any desired current configuration into canonical files before the cutover. The original 2026-08-12 decision (dual-read opens only during P4.3, shrinks monotonically, no new bridge consumers) is preserved as historical evidence in the tracker |
| R7 Performance gate thresholds (startup stages, prompt-submit/first-token, stream-render, tool/permission, session-switch, config-update, removal reduction) | Resolved (2026-08-14): gates use no numeric pass/fail thresholds. P1/P2 compare descriptive, affected-path, same-environment measurements against the P0 baseline — record med/p95/sample/provenance and investigate obvious structural anomalies; measurement noise alone does not block and there is no requirement to improve. P3/P4 removal phases prove removed-feature initialization/readers/listeners/resources are absent and record affected startup/session-switch/memory/worker-lifecycle deltas; zero or positive noisy delta is allowed if no removed work remains and no structurally unbounded growth/resource leak appears; only affected measured rows are rerun per phase. Complexity budgets record deltas; zero reduction in a dimension is allowed with a stated phase-boundary reason; permanent-removal completeness remains required. `Same environment/comparable` means same benchmark scripts/scenario, machine/OS class, VS Code profile type, seeded/provider conditions, instrumentation mode, and recorded git SHA/dirty/environment drift; non-comparable runs are recorded but cannot support gate claims. Numeric product SLA is R3, resolved separately at P5 | Resolved (2026-08-14) | Resolved — no threshold-using gate remains; P1 can start without an undefined threshold gate (LOCK-PERF-6) |
| R8 Benchmark tooling/harness choice | Internal implementation choice; not prescribed by this spec | P0 profiling tasks | Resolved: retain the existing two-harness tooling as the P0 and later comparison harness — Extension Host scenarios 1/2/3/4/5/10 under `packages/kilo-vscode/script/p0-bench/` (runner/merge/safety/provenance tools); backend scenarios 6/7/8/9/11/12/13 under `packages/opencode/test/benchmark/` (runner). Limitations recorded: manual-only, platform/environment/provenance scoped, backend in-process `Server.listen`/`AppLayer` only, n=5 descriptive |
| R9 Observation/hydration implementation details (snapshot/event handshake; revision scope/ordering/idempotency; ephemeral-fact retention) | Bounded implementation decision; the normative contract (section 7.1) fixes the one-owner and lifecycle-convergence constraints but not the wire schema, event sourcing, polling, timer subsystems, or retention. R9 may use a bounded derived changefeed/outbox for reconnect deltas; it is not authoritative history, is not required for reconstruction, and is eligible for automatic truncation after authoritative hydration state exists (ADR-0005; storage spec section 5.2) | P4.2 (P4.2a storage sub-boundary first, then the P4.2b wire/schema freeze; the private-worker observation surface must not ship without it). Required by P4.2 only; not a P1-P3 blocker | Open — added 2026-08-13 |
| R10 Canonical schema/field-registry layout and exact persistence assignment | The normative rules are fixed by this spec — legal source taxonomy (section 3.1), field-registry content (section 3.2), typed composition/materialization/provenance (section 5.1), agent-manifest role (section 5.2), permission composition (section 5.3), and the bidirectional file-editing/WYSIWYG contract (section 5.4). File/asset authority is fixed by R2 (revised 2026-08-13), and R10 is bounded within that topology: exact canonical filenames/layout, the registry entry per remaining field class, legal scope/operator per field, and watcher owner/stamping/conflict implementation details (section 5.4). It does not reopen file authority, the two-level authored scope set, the SecretStorage exception, or the no-migration decision. The persisted-index layout and reconciliation behavior are additionally bounded by section 6 criterion 3: reconciliation must preserve the last-known valid derived index or an explicit invalid/stale presentation and never reintroduce a worker-readiness dependency | P4.1 (P4.1 is not verifiable until the registry covers every configurable field class and the schema/provenance/WYSIWYG contract is evidenced). Not a P0 blocker | Open — added 2026-08-13 |
| R11 Operation/outcome identity and record location/retention | Bounded implementation decision under the normative Failure/Outcome/Recovery target (section 7.2) and the observation contract (section 7.1): what an accepted semantic operation's identity is, where the canonical Failure/Outcome records live, and their minimal retention under existing storage — no new store mandate. Generation-path operations only (prompt/generation, provider attempt, tool call, permission/question wait, child/background task); config commit outcomes are owned by sections 5/5.4 and are not R11 operations. Durable Failure/Outcome fields persist in the canonical aggregate storage / registered artifact model; diagnostic and panel projections are derived and never create competing stores (ADR-0005; storage spec sections 5.1, 5.4). It does not reopen runtime sole authority for operational facts or the client replay prohibition | P4.2 (P4.2a storage sub-boundary first). Not a P0-P1 blocker | Open — added 2026-08-14 |
| R12 Minimum private-runtime Failure/Outcome schema + panel projection/redaction | Bounded implementation decision under section 7.2: the minimum Failure/Outcome schema, the runtime-owned normalization boundary, minimal field tiers (durable vs diagnostic vs panel-visible), runtime-side redaction before persistence/projection, cancellation provenance (at least user stop/steering/timeout/network disconnect/unknown), and a versioned private panel envelope/projection. No complete taxonomy and no byte/depth sanitizer contract freeze. The private error envelope's version/compatibility is owned by R1/R9/R12 as appropriate | P4.2. Not a P0-P1 blocker | Open — added 2026-08-14 |
| R13 Recovery accounting/coordination and low-level retry visibility | Bounded implementation decision under section 7.2 — P4.2 is accounting/coordination only: owner/scope, budget consumed/termination, next-at occurrence time, provenance, and visibility of nested low-level attempts within the owning operation. It may reuse current bounded behavior. Retryability algorithms, delay shapes, and future recovery features are post-foundation (section 7.3). It does not preserve old retry shapes, delay ladders, the environment retry flag, or the auto-continue implementation | P4.2. Not a P0-P1 blocker | Open — added 2026-08-14 |
| R14 Worker-crash in-flight disposition | Bounded implementation decision under sections 7.2 and 7.1: how an accepted in-flight operation at a worker crash converges to a recorded disposition with resource cleanup and no silent client replay — without requiring resumability and without a new persistent operation ledger | P4.2. Not a P0-P1 blocker | Open — added 2026-08-14 |
| R15 Automatic retention bounds (byte-budget high/low watermarks, recent-retention floor, family eligibility/ordering, diagnostics) | Invisible automatic retention (ADR-0005 I-6; storage spec 5.3) | P4.2 (P4.2a storage sub-boundary). Not a P1-P3 blocker | Resolved (2026-08-20): Budget scope is physical bytes of active canonical DB main file + WAL and registered session-family artifacts; excludes offline archives, logs/cache, and project-owned snapshot storage. High watermark 8 GiB, low watermark 6 GiB — a resource bound, not a performance SLA, with 25% hysteresis; values change only via later recorded architecture decision, never user config. Protect every root family whose max runtime-owned activity across root+descendants is within 7 days; additionally requires all members terminal/idle and no active/in-flight operation or maintenance/read lease; protections revalidated in deletion transaction. Order eligible roots by activity ascending then root ID. Maintenance is coalesced after boot and canonical commits, runs only off generation hot path when idle and high exceeded, deletes complete families until at/below low or no eligible family remains. Canonical DB deletion is one immediate transaction; filesystem artifact cleanup uses durable idempotent cleanup obligation so crash recovery cannot expose partially retained canonical family; never partial transcript truncation. Fresh canonical DB uses incremental auto-vacuum; after pruning checkpoint/reclaim incrementally off hot path; physical accounting includes WAL; if floor/protections prevent low, stop safely and emit pressure diagnostics. Per-run diagnostics: trigger, before/after physical bytes, selected/deleted/skipped counts with reasons, canonical rows and artifact bytes reclaimed, checkpoint/vacuum result, failures; no setting/pin/dashboard/manual cleanup/UI. Rationale: 8/6 separates normal operation from measured ~24.56 GiB legacy emergency; 7 days preserves recent continuity while bounding growth |
| R16 Canonical aggregate schema/revision model + bounded outbox/changefeed disposition + artifact ownership/retention registry | Canonical storage target (ADR-0005 I-2/I-3/I-7; storage spec 5.1, 5.2, 5.4) | P4.2 (P4.2a storage sub-boundary). Not a P1-P3 blocker | Resolved (2026-08-20): Canonical durable truth is normalized session/message/part/todo/share and registered operation/outcome/failure aggregates as R11 fields land, plus registered artifacts. `SessionTable.revision` is per-session monotonic revision; each semantic mutation and its revision commit in one immediate transaction. Legacy `event`/`event_sequence` not required for reconstruction, remains removal scope. Deletion obtains final revision=current+1 and atomically writes payload-free delete tombstone to changefeed before hard-deleting aggregate in same transaction; feed rows have no FK cascade to session. Bounded payload-free changefeed with global monotonic sequence, session ID, session revision, kind, runtime-owned occurrence time; uniqueness/idempotency is `(session_id, revision, kind)`; derived, never reconstruction authority; snapshot hydration establishes sequence cursor; acknowledged rows truncatable; hard cap both 50,000 rows and 64 MiB — exceeding either may evict oldest rows even if unacknowledged; any cursor gap forces full rehydration; exact wire handshake remains R9/P4.2b. Closed registry: canonical DB aggregate rows (including SessionShare/todo/message/part/context and future outcome/failure rows) are schema-owned and cascade/transaction governed, not file artifacts; `session_diff`, `session_diff_base`, `session_share` are session-family-owned file artifacts retained/deleted with family; `snapshot` is project-owned and collected only by project reachability/refcount, never family pruning; `session-export.db` is legacy cutover material under R17, not canonical artifact. New runtime artifact writes require registry entry before landing. Sequencing: R16 registry definition available to S2; S2 materializes/consumes registry for deletion; S3 is closure/audit verifying every writer/class registered, project snapshot ownership correct, zero unregistered artifacts remain; thus S2→S3 preserved. Rationale: payload-free bounded deltas avoid recreating full-object event growth while allowing reconnect efficiency; hard-cap gaps safe because canonical snapshot hydration is authoritative |
| R17 Offline archive format/location/integrity + fresh-DB cutover identity + rollback/archive-deletion authority | Offline cutover (ADR-0005 I-8; storage spec 6) | P4.2 (P4.2a storage sub-boundary). Not a P1-P3 blocker | Resolved (2026-08-20): Cutover archive is offline versioned directory under same-filesystem sibling derived from `Global.Path.data`: `<data-basename>-archive/p4.2/<UTC>-<uuid>/`; temp archive under same `p4.2` parent; EXDEV/cross-device fallback forbidden/fails closed; manifest schema v1 and preserved POSIX relative paths; no runtime archive reader. Stop sole runtime and close handles; run `wal_checkpoint(TRUNCATE)`, `integrity_check`, `foreign_key_check`. Fixed members are `kilo.db` plus `kilo.db-wal`/`kilo.db-shm` if present after checkpoint, `storage/session_diff`, `storage/session_diff_base`, `storage/session_share`; explicitly include `session-export.db` and its WAL/SHM when present, otherwise record absence; explicitly exclude project-owned `snapshot` (not rollback material); nothing else archived. Manifest v1 records archive ID, UTC creation, source data root, each sorted file path with bytes and SHA-256, present/absent fixed members, deterministic aggregate SHA-256 over sorted path/bytes/hash records; preserve empty fixed directories; fsync files/directories, reverify, atomically rename temp to final, fsync parent; any failure leaves legacy active and aborts cutover. Fresh DB has singleton storage identity: UUID, schema version, creation time, cutover archive ID; boot gate verifies identity and zero sessions/registered family artifacts before activation. Rollback is offline only: stop/close, verify archive, separately archive current canonical store under distinct rollback ID, atomically restore legacy members, rerun integrity checks, then boot legacy path; never dual-read. Cutover archive deletion requires separate explicit maintainer authorization after cutover, never a cutover side effect; no runtime/UI/API automatic deletion path. Rationale: directory+manifest permits transparent offline integrity/restore without runtime compatibility reader; same-parent atomic rename and explicit optional members fail closed |

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
| LOCK-PERF-1 | Performance simplification is a primary objective alongside product coherence. Remove redundant architecture from the hot path as a structural objective — eliminating redundant architecture, not per-phase optimization or a numeric improvement demand. |
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
  generation path; redundant architecture on that path is removal scope. This is
  a structural objective — removing redundant architecture — not per-phase
  optimization.
- CLI/TUI/Console are not products (LOCK-009). A private headless worker may
  remain for isolation, but its startup and runtime costs are measured
  (LOCK-PERF-2).
- Removed features never contribute to startup/readiness (LOCK-PERF-3).
- Persisted selector indexes render and remain interactive independent of worker
  readiness and lifecycle; gates are action-specific, not the global
  `extensionDataReady` barrier (LOCK-PERF-4, section 6 criteria 1-6).
- Harness semantics and performance correctness are preserved (LOCK-PERF-5): no
  regression in transport/event handling, generation pinning, rollback, or the
  overflow safeguard.
- No performance claim without runtime evidence (LOCK-PERF-6). There are no
  numeric pass/fail performance thresholds (R7 resolved 2026-08-14, section 9):
  P1/P2 compare descriptively on affected paths in a same environment; P3/P4
  prove structural absence of removed work and record affected-path deltas.
- Localhost transport is not presumed dominant (LOCK-PERF-7); attribution is
  measured per cost class (10.5).
- Storage maintenance is invisible private-runtime work, never a user-visible
  surface (ADR-0005 I-6): automatic retention runs when the runtime is idle and
  never on the generation hot path; active/in-flight and maintenance-leased/
  read families are never pruned. Rows/bytes reclaimed and retention failures
  are recorded descriptively as diagnostics; reclaimed-byte figures are
  descriptive maintenance evidence, not a numeric performance gate and not a
  storage-product metric (R7 resolved 2026-08-14; R15, section 9).

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
| Run-owned process-tree memory guard (P0 safety infrastructure, not a latency point) | `script/p0-bench/memory-guard.ts` + `script/p0-bench/sample.ts` lifecycle | Per-lifecycle bounded `memoryGuard` result on every sample: configured engineering safety rails (RSS/VSZ/aggregate, default any-owned-RSS ≥ 4 GiB, aggregate-RSS ≥ 6 GiB, VSZ ≥ 64 GiB; env-tunable via `KILO_P0_MEMORY_GUARD_*`), poll count/overhead, max aggregate RSS, max owned count, max process RSS/VSZ identity, breach or null, capped time series. A guard breach aborts the lifecycle with `ok:false`, `blocked.reason="memory-guard-abort"` and exact-owned cleanup still runs. Rails are engineering safety limits, never performance thresholds (R7 resolved 2026-08-14: no numeric thresholds) — see 10.9 | - |
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

- Gates are descriptive comparisons against the P0 baseline recorded in the
  tracker (section 8): same-environment, affected-path runs record
  med/p95/sample/provenance. There are no numeric pass/fail thresholds (R7
  resolved 2026-08-14, section 9).
- `Same environment/comparable` means the same benchmark scripts/scenario,
  machine/OS class, VS Code profile type, seeded/provider conditions,
  instrumentation mode, and recorded git SHA/dirty/environment drift.
  Non-comparable runs are recorded but cannot support gate claims.
- No regression in harness semantics or performance correctness (LOCK-PERF-5):
  the H-1..H-13 flows, generation pinning, rollback, and the overflow safeguard
  stay intact on every measured path.
- Removal phases prove removed-feature initialization/readers/listeners/
  resources are absent and record affected startup/session-switch/memory/worker
  lifecycle deltas; zero or positive noisy delta is allowed if no removed work
  remains and no structurally unbounded growth/resource leak appears
  (LOCK-PERF-1, LOCK-PERF-3). Only the affected measured rows are rerun per
  phase — not the entire P0 campaign.
- Complexity budgets record deltas; zero reduction in a dimension is allowed
  with a stated phase-boundary reason; permanent-removal completeness remains
  required (direction spec section 11).
- Config-source removal evidence gate: P4.1 does not exit until the field
  registry covers every configurable field class (section 3.2) and the
  schema/provenance contract is evidenced (R10); P4.4 does not exit until each
  legacy effective-config source (section 8.1, including legacy global config
  filenames/readers and legacy migration readers) records per-row removal
  evidence and is proven inactive, leaving the closed legal source taxonomy
  (section 3.1) as the only input set.
- WYSIWYG acceptance gate: P4.1 does not exit until the section 5.4 behavioral
  semantics are evidenced — file-to-UI observation without manual reload; atomic,
  validated UI-to-file writes preserving JSONC/markdown formatting where
  possible; visible stale-draft conflicts (never silent overwrite); no partial
  apply or legacy fallback on invalid external edits; predictable
  deletion/unset; and generation pinning with new readers using the new valid
  snapshot (LOCK-011).
- P5 selector-readiness gate: P5 does not exit until the section 6 criteria are
  evidenced — selector availability across worker lifecycle states (criterion 1),
  no readiness-based selection disable (criterion 2), reconciliation preservation
  (criterion 3), structural absence of the old chain (criterion 4), the Extension
  Host worker-unavailable scenario plus descriptive paint-before-ready timing
  (criterion 5, R7), and the cold/warm UI-vs-runtime readiness distinction
  (criterion 6).
- Permission-evaluator gate: P4 does not exit until the permission evaluator
  implements the section 5.3 restrictive policy stack — monotonic deny/ask/allow
  composition, no widening, enclosing parent denies/session restrictions for
  children with no parent-allow inheritance, runtime-owned per-session approval
  records, and the question-flow vs `question`-tool distinction — and target
  semantics are evidenced by a permission-evaluator test surface. P2's H-6
  criterion proves current behavior/capability only (direction spec section 6)
  and does not gate on section 5.3 semantics.
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
  safety limits — not performance thresholds and not an SLA; no performance
  result derives from them (R7 resolved 2026-08-14, section 9).
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
  (LOCK-PERF-3); persisted selectors render and remain interactive independent
  of worker readiness and lifecycle, with structural absence of the old
  readiness chain and the worker-unavailable scenario evidence (LOCK-PERF-4,
  section 6 criteria 1-6); no global `extensionDataReady` barrier; the
  AppLayer/process-graph
  is structurally absent of removed features, with affected startup deltas
  recorded against the P0 baseline (zero or positive noisy delta is allowed if
  no removed work remains and no structurally unbounded growth/resource leak
  appears).
- Config: cold saves commit without process-global rebuild/convergence (target 0
  passes) and never interrupt active generations (section 5, LOCK-011); effective
  config composes only from the closed legal source taxonomy (sections 3.1, 5.1),
  every legacy effective-config source (section 8.1) is proven inactive, and the
  section 5.4 WYSIWYG behavioral semantics are evidenced.
- Harness: H-1..H-13 invariants and performance correctness preserved
  (LOCK-PERF-5) - delegation, tools, skills, MCP, permissions,
  parent-child/background/parallel sessions, persistence, SessionRevert+Snapshot,
  overflow safeguard - with no regression in transport/event handling or prompt
  latency attribution.
- Evidence: only the affected measured rows are rerun per phase and recorded in
  the tracker (section 8) with med/p95/sample/provenance (descriptive,
  same-environment); issue/PR/test/doc evidence per phase; nothing claimed
  without measurement (LOCK-PERF-6). No numeric pass/fail threshold applies
  (R7 resolved 2026-08-14, section 9).

### 10.11 Evidence status

- P0 baseline recorded (2026-08-12): six accepted repeated campaigns under
  `specs/vscode-orchestrator/evidence/p0-baseline/` (Extension Host cold-start,
  many-agent-MCP, historical and current-tier backend in-process
  `Server.listen`/`AppLayer`, warm-view/no-provider/custom-provider,
  session-switch) with measured values recorded in the tracker (section 8) as
  descriptive n=5 sample statistics with evidence links. The backend campaigns
  are CLI-side in-process harness evidence only — neither target-surface nor
  private-worker evidence.
- Target-only metrics without a P0 measurement are later-phase evidence, not P0
  blockers: persisted-selector paint gates at P5 (no extension-owned persisted
  indexes exist before P4.1; P5 evidence per section 6 criteria 1/5/6 —
  descriptive paint-before-ready timing plus a worker-unavailable Extension
  Host scenario); cost attribution (LOCK-PERF-7) and per-event
  transport/webview render flush are descriptive evidence at P2
  (harness-parity/streaming) — recorded with med/p95/sample/provenance, not an
  independent P2 exit blocker; removed-feature initialization absence and
  affected-path deltas gate at P3/P4.4 (removal). No numeric performance
  threshold exists (R7 resolved 2026-08-14, section 9).
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

- `bun run script/check-md-table-padding.ts specs/adr/0001-lossless-session-storage-rewriting.md specs/adr/0002-focus-vscode-on-agent-orchestration.md specs/adr/0003-replace-cli-configuration-with-private-gui-runtime.md specs/adr/0004-architecture-first-direct-reconstruction.md specs/adr/0005-bounded-private-runtime-storage.md specs/storage/session-storage-rewriting.md specs/vscode-orchestrator/agent-orchestration-direction.md specs/vscode-orchestrator/runtime-and-configuration-direction.md specs/vscode-orchestrator/migration-tracker.md`

Architecture impact check (run from repo root; report the outcome):

- `bun run script/check-architecture-impact.ts --worktree`

No source-code, test, or typecheck commands apply: this work creates decision/spec
artifacts only (LOCK-013).
