# 0002: Focus VS Code on Agent Orchestration

- Status: Active
- Date: 2026-08-10
- Owner: Kilo maintainers

## Context

The only shipping product is the VS Code Agent Orchestrator. The extension is
structurally a client of a general CLI today: it spawns `kilo serve`, consumes SSE,
fetches provider/agent/config state over HTTP, and gates UI enablement on
`extensionDataReady` (`packages/kilo-vscode/src/KiloProvider.ts`), while the CLI
carries the full harness (custom agents, sub-task delegation, extensible tools,
skills, MCP, permissions, model selection). The product identity is split between
"a chat panel" and "an orchestrator".

The user confirmed the final product boundaries: the only product is the VS Code
Agent Orchestrator; the ordinary single-chat sidebar is not co-equal and remains on
the deprecation/removal path; all worktree infrastructure, custom Diff Viewer
surfaces, cloud sessions, JetBrains, Console, KiloClaw, indexing, project memory,
user-visible context management, autocomplete, and preset provider identities are
removed, not deferred. The current branch still contains residual worktree/Diff
Viewer implementation and all other removed features; this ADR records the decided
direction only and claims nothing about implementation state. The canonical
architecture docs (`packages/kilo-docs/pages/contributing/architecture/`) still
describe the implemented system and are updated only as implementation lands
(LOCK-013).

Runtime and configuration ownership (private headless worker, GUI-owned
configuration, immutable generation snapshots, immediate selector state) is a
separate durable decision recorded in ADR-0003; this ADR stays focused on product
direction. ADR-0001 (session storage checkpoint/resync) is an unrelated storage
decision and is untouched here.

## Decision

The only product is the VS Code Agent Orchestrator: concurrent agent sessions in
editor tabs/panels with topic/session navigation as the main view. The ordinary
single-chat sidebar is not a co-equal product surface and is on the
deprecation/removal path. All worktree infrastructure and custom Diff Viewer
surfaces, cloud sessions, JetBrains, Console, KiloClaw, indexing/semantic
search/project memory/user-visible context management/compaction, autocomplete,
and preset provider identities/catalogs are removed; they are not deferred. Core
harness capabilities (custom agents, sub-task delegation, extensible tools, skills,
MCP, permissions/questions, parent-child sessions, background/parallel execution,
user-selected custom-provider models, persistence, lifecycle correctness,
checkpoint rollback, internal context-overflow reliability) are preserved as
architectural invariants.

Status Active means this is the current chosen direction: not completed
implementation and not formal external approval.

## Invariants / constraints

- I-1 (LOCK-001): the only product is the VS Code Agent Orchestrator; the ordinary
  single-chat sidebar is not co-equal and remains on the deprecation/removal path.
- I-2 (LOCK-002): all worktree infrastructure and all custom Diff Viewer surfaces
  are removed. Native VS Code diff APIs may still be used for checkpoint review
  where needed.
- I-3 (LOCK-003): cloud sessions, JetBrains, Console, and KiloClaw are removed
  completely; they are not deferred.
- I-4 (LOCK-004): indexing, semantic indexing/search integration, project memory,
  memory tools/system-prompt injection, user-visible context
  management/compaction settings, and autocomplete are removed completely.
- I-5 (LOCK-005): a minimal internal context-overflow safeguard for long-running
  agents is retained as an invisible harness reliability mechanism, not a
  user-facing context-management product. The existing compaction implementation
  does not need to be preserved.
- I-6 (LOCK-006): only user-defined/custom providers are retained. Preset provider
  identities/catalogs, bundled gateway/provider onboarding/auth flows, the
  models.dev catalog dependency, and organization/cloud provider sources are
  removed. Generic protocol adapters required to connect a user-defined provider
  may remain.
- I-7 (LOCK-007): checkpoint behavior is retained as SessionRevert + Snapshot
  semantics: withdrawing/reverting a message restores affected code, with
  unrevert/cleanup and lifecycle correctness. This is distinct from ADR-0001
  storage checkpoint/resync.
- I-8 (LOCK-008): core harness capabilities are preserved: custom agents, sub-task
  delegation, extensible tools, skills, MCP, permissions/questions, parent-child
  sessions, background/parallel execution, user-selected custom-provider models,
  persistence, lifecycle correctness, checkpoint rollback, and internal
  context-overflow reliability. Worktrees are not a harness invariant.
- I-9 (LOCK-013): canonical architecture docs describe implemented reality and are
  updated only as implementation lands; this work creates decision/spec artifacts
  only, and the present capability and gap are recorded truthfully in
  `../vscode-orchestrator/current-state.md`.
- I-10: progress tracking is separate from this ADR; `../vscode-orchestrator/current-state.md`
  records only the present capability, gap, unknown, and open decision that
  changes the next judgment, and running code and observed behavior outrank
  status prose.

Target semantics live in `../vscode-orchestrator/direction.md`.
Runtime/config ownership decisions live in ADR-0003. Implemented reality lives
in the canonical architecture docs; the present capability and gap live in
`../vscode-orchestrator/current-state.md`, not in this ADR.

## Alternatives considered

| Alternative | Why rejected or deferred |
|---|---|
| Keep the sidebar as a co-equal chat surface | Rejected: splits product identity; I-1 makes the orchestrator the only product. Directional deprecation/migration is the chosen path. |
| Retain worktrees as a harness invariant | Rejected: worktrees are not a harness invariant (LOCK-008); all worktree infrastructure is removed (LOCK-002). |
| Keep custom Diff Viewer surfaces | Rejected: native VS Code diff APIs suffice for checkpoint review (LOCK-002). |
| Defer cloud/JetBrains/Console/KiloClaw to a later phase | Rejected: they are removed completely, not deferred (LOCK-003). |
| Keep user-visible context management/compaction | Rejected: removed (LOCK-004); only a minimal internal context-overflow safeguard remains (LOCK-005). |
| Keep preset provider identities/catalogs | Rejected: only user-defined/custom providers are retained (LOCK-006); runtime detail is owned by ADR-0003. |
| Rewrite the extension or replace the shared backend now | Rejected for now: runtime/config migration is owned by ADR-0003 and its technical spec; no premature rewrite is mandated. |
| Define 'topic' as a new persisted domain model | Rejected: 'topic' is deterministic derived navigation defined in `../vscode-orchestrator/direction.md` — root session ID identity, root title label, parentID membership, max member updatedAt with ID tie-break ordering, orphan/missing-parent/cycle degradation to independent Topics — with no independent persistence, API, config, schema, or operational fact. |

## Consequences

Positive:

- Single, defensible product identity: the only product is the orchestrator.
- All product removals are decided and on record (worktrees, Diff Viewer, cloud,
  JetBrains, Console, KiloClaw, indexing, memory, context management,
  autocomplete, preset providers); they will not be re-proposed as deferred work.
- Harness capability stays intact (LOCK-008): a smaller product does not mean a
  weaker agent runtime.
- Rejected alternatives are on record so they will not be re-litigated from
  scratch.

Negative:

- Removed surfaces leave the tree where implementation lands; remaining work
  proceeds directly against the target, not through a separate removal gate.
- Migration cost is real: navigation, session picker, and multi-panel UX must
  replace sidebar habits.
- 'topic' target semantics are fixed as deterministic derived navigation in `../vscode-orchestrator/direction.md`; remaining product and UX presentation decisions may still churn.

## Follow-up artifacts

- ADR-0003: `../adr/0003-replace-cli-configuration-with-private-gui-runtime.md` -
  records the durable runtime/config ownership decision (private headless worker,
  GUI-owned configuration, immutable generation snapshots, immediate selector
  state) and complements this ADR.
- Target semantics: `../vscode-orchestrator/direction.md` - owns the approved
  product target; the canonical architecture docs own implemented reality and
  `../vscode-orchestrator/current-state.md` owns the present capability and gap.
- Canonical architecture docs: updated separately when implementation changes
  reality.

## Supersession

- Supersedes: none.
- Superseded by: none.
