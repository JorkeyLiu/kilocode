# 0003: Replace CLI Configuration with Private GUI Runtime

- Status: Active
- Date: 2026-08-10
- Owner: Kilo maintainers

## Context

The VS Code extension is structurally a client of a general CLI. Activation waits
on backend spawn, SSE connection, and parallel provider/agent/config/status HTTP
fetches before posting `extensionDataReady`, and selectors are enabled only after
that barrier resolves (`packages/kilo-vscode/src/KiloProvider.ts`). Configuration
merges 12+ sources with later-source precedence and no single authority
(`packages/kilo-docs/pages/contributing/architecture/cli-runtime.md`, "Config
precedence"; `packages/opencode/src/config/config.ts`), and cold saves rebuild
directory-keyed runtime identities through a fence/gate/convergence machine
(`packages/opencode/src/kilocode/server/config-convergence.ts`) that exists
because config authority is spread across sources. Provider state combines preset
catalog data, config, auth records, and organization sources with many preset
loaders (`packages/opencode/src/kilocode/provider/provider.ts`,
`packages/opencode/src/kilocode/provider/models-api.json`, models.dev fallback in
`packages/opencode/src/provider/models.ts`), fragmenting provider capability and
gating model selection on eventual backend state. The harness kernel itself is
service-based and does not depend on CLI presentation.

ADR-0002 records the product direction: the only product is the VS Code Agent
Orchestrator, and CLI/TUI/Console are no longer products. This ADR records the
runtime and configuration ownership that makes the product structurally correct: a
private headless runtime with extension-owned configuration authority. Detailed
root-cause analysis with repository evidence, the target ownership domains, the
provider boundary, config update semantics, startup acceptance, and the migration
strategy live in the technical spec
(`../vscode-orchestrator/runtime-and-configuration-direction.md`).

## Decision

The CLI/TUI/Console are eliminated as products and public interfaces. The agent
runtime runs in an extension-owned private headless worker process, outside the VS
Code Extension Host, for crash/resource/lifecycle isolation. Product/UI
configuration and persisted selector indexes are extension-owned; the runtime
consumes immutable versioned snapshots; a generation keeps the exact snapshot it
starts with, and configuration updates create new versions atomically without
interrupting active generations. Model and agent selectors render from
extension-owned persisted indexes before the worker is ready, with action-specific
startup gates instead of one global `extensionDataReady` barrier. The private
transport is an internal implementation choice, not a compatibility contract.

Status Active means this is the current chosen direction: not completed
implementation and not formal external approval.

## Invariants / constraints

- I-1 (LOCK-009): CLI/TUI/Console are eliminated as products and public
  interfaces. The agent runtime stays out of the VS Code Extension Host as an
  extension-owned private headless worker process for crash/resource/lifecycle
  isolation. The existing `kilo serve` HTTP/SSE/generated-SDK path may serve as a
  migration bridge, but it is not a target compatibility contract; the private
  transport remains an internal implementation choice.
- I-2 (LOCK-010): GUI-owned configuration is authoritative. Product/UI
  configuration and persisted selector indexes are extension-owned; secrets use
  VS Code SecretStorage; project-versioned harness assets use one canonical
  explicit project boundary with no multi-source precedence merge; the runtime
  consumes immutable versioned snapshots.
- I-3 (LOCK-011): a generation keeps the exact config/runtime snapshot it starts
  with. A configuration update atomically creates a new version for later
  generations and must not interrupt active generations. Resource replacement
  (provider/MCP/tool resources) is version-scoped and lazy, and old resources are
  disposed only after their owners release them; process-global
  rebuild/convergence is not the target model.
- I-4 (LOCK-012): model and agent selectors render from extension-owned persisted
  indexes before the private worker is ready. Runtime connection/validation is
  separate readiness and must not globally disable selection. Startup gates are
  action-specific, not one global `extensionDataReady` barrier.
- I-5 (LOCK-013): canonical architecture docs describe implemented reality and
  are updated only as implementation lands; the migration tracker records current
  migration evidence truthfully.

Detailed acceptance criteria, current root causes with repository evidence, target
ownership domains, provider boundary, config update semantics, startup
acceptance, and the migration strategy live in the technical spec
(`../vscode-orchestrator/runtime-and-configuration-direction.md`), which is the
implementation source of truth. Mutable phase status and exit evidence are
tracked in the migration tracker (`../vscode-orchestrator/migration-tracker.md`).

## Alternatives considered

| Alternative | Why rejected or deferred |
|---|---|
| Keep the CLI as the configuration and runtime authority | Rejected: LOCK-009 eliminates CLI/TUI/Console as products; startup and config semantics would keep depending on external server state (root causes in the technical spec, section 2). |
| Use VS Code settings.json as the configuration authority | Rejected: complex records and secrets do not belong in settings.json; GUI-owned configuration means extension application state with appropriate VS Code storage APIs plus SecretStorage for secrets (LOCK-010). |
| Keep the 12-source precedence merge with process-global cold rebuild/convergence | Rejected: the convergence machine exists to reconcile multi-source authority; one canonical project boundary and immutable snapshots make it unnecessary (LOCK-010, LOCK-011). |
| Run the runtime inside the VS Code Extension Host | Rejected: crash/resource/lifecycle isolation requires a separate private headless worker process (LOCK-009). |
| Keep the public HTTP/SSE/SDK surface as a target compatibility contract | Rejected for now: the existing `kilo serve` path may be a migration bridge only; the private transport is an internal implementation choice (LOCK-009). |
| Preset provider catalog/onboarding/organization sources | Rejected: only user-defined/custom providers are retained (LOCK-006, ADR-0002); generic protocol adapters are implementation, not preset providers. |
| Big-bang rewrite of the runtime and transport | Rejected: migration proceeds by inventory, local GUI read model, bounded dual-read with an explicit deadline, then source removal (technical spec, section 7). |

## Consequences

Positive:

- Startup no longer depends on eventual backend state: selectors render from
  persisted indexes and gates are action-specific (LOCK-012).
- Configuration has one owner and one persistence path per datum, eliminating the
  12-source merge and its convergence machinery (LOCK-010, LOCK-011).
- A generation is stable: config updates never interrupt active generations, and
  resources are disposed only after owners release them (LOCK-011).
- The harness kernel stays intact while the CLI product surface disappears
  (LOCK-009, LOCK-008).

Negative:

- The private worker, snapshot API, and extension-owned configuration stores are
  real new components; the migration is phased, not a rewrite (technical spec,
  section 7).
- The existing `kilo serve` path must be removed as a public interface after the
  migration bridge closes, with an explicit deadline; no permanent dual authority
  (technical spec, section 7).
- Transport protocol, storage engine, numeric startup SLA, adoption thresholds,
  and the exact project asset path remain bounded implementation decisions
  (technical spec, section 9), not chosen here.

## Follow-up artifacts

- Technical spec: `../vscode-orchestrator/runtime-and-configuration-direction.md` -
  owns current root causes with evidence, target ownership domains, provider
  target, config update semantics and lifecycle, startup acceptance, migration
  strategy, removal checklist, and bounded implementation decisions. It remains
  the implementation source of truth; this ADR records the durable decision only.
- Related decision: `../adr/0002-focus-vscode-on-agent-orchestration.md` - product
  direction (only product, removals, harness invariants); this ADR complements it
  by deciding runtime/config ownership.
- Migration tracker: `../vscode-orchestrator/migration-tracker.md` - owns mutable
  phase status and exit evidence for the runtime/config migration.
- Canonical architecture docs: none yet. The implemented system is unchanged until
  implementation lands; when implementation changes reality, the architecture
  pages are updated separately (LOCK-013).

## Supersession

- Supersedes: none.
- Superseded by: none.
