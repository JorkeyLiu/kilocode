# P0 Current-State Inventory — VS Code Agent Orchestrator Migration

Migration evidence artifact for the VS Code Agent Orchestrator migration. This
file turns the completed static investigation into a checked-in, reproducible
inventory of the implemented current state. It is **migration evidence, not
canonical architecture documentation** (LOCK-013: canonical docs describe
implemented reality; this artifact records the current-state facts the removal
and runtime phases will act on).

Audience: the hub, P3 removal subphases, P4 runtime/config subphases, P5 startup
phases, and any future session that needs the current-state baseline without
re-searching the repository.

> **Amendment (2026-08-25).** The original inventory was collected against the
> working tree at commit `6ecc440507` on 2026-08-10 (see section 1 and section 11)
> and recorded the extension legacy-migration/importer and Roo-import surfaces
> as present. On 2026-08-25 those extension surfaces were removed in a separate
> bounded P4.4 implementation unit; the current-state is updated at the
> "Legacy migration / Roo import" surface row and the section 3 note: the
> extension legacy-migration and Roo-import trees are gone, with removal
> assertions in `packages/kilo-vscode/tests/unit/p3-4-removal.test.ts:420-444`.
> The CLI/TUI migration helper
> (`packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts:33-80,148-166`)
> was retained at that point (historical — not part of the removed extension
> importer). **Update (2026-08-27, P4.4 residual package — documentation-only per
> LOCK-002):** that dead helper is now physically deleted (zero active callers
> since T27; `Flag.KILO_TUI_CONFIG` getter also deleted; canonical TUI loader
> `resolveWorktree`/`canonicalRoot` + `ConfigPaths.fileInDirectory(root, "tui")`
> + `path.join(root, ".kilo")` only preserved). No other inventory
> row was reclassified by these amendments; disposition and residual scope for all
> other surfaces (including the preset-provider/catalog LOCK-006 row) are
> unchanged. This is migration evidence only — it does not edit canonical
> architecture docs (LOCK-013). P4.4 remains Active/residual (LOCK-001).

> **Amendment (2026-08-27, P4.4 Open Config legacy diagnostic cleanup).** The VS Code Open Config diagnostic inventory (`packages/kilo-vscode/src/kilo-provider/config-file.ts` → `open-config.ts` → `KiloProvider` → `Settings.tsx`) is now limited to canonical authorities: resolved global `kilo.jsonc` (`KILO_CONFIG_DIR` controls resolved `Global.Path.config` root) and `<workspaceRoot>/.kilo/kilo.jsonc`. Legacy source taxonomy (`sourceXdg`/`home*`/`env*`/`project*`, `KILO_CONFIG`/`KILO_CONFIG_CONTENT`/`.kilocode`/`.opencode`/`project-root`/non-`kilo.jsonc` alternatives, `legacy`/`virtual`/`statusLoadedLegacy` badges) removed from `config-file.ts`, `open-config.ts` `Labels`/status, `webview-messages.ts` `OpenConfigFileRequest.labels`, `Settings.tsx`, and all 20 webview i18n dictionaries (replaced with `settings.config.source.global`/`local`). Canonical creation/opening, localization, `KILO_DISABLE_PROJECT_CONFIG` semantics, and `KILO_CONFIG_DIR`→`Global.Path.config` compatibility + sandbox deny remain. Evidence: `tests/unit/open-config.test.ts` and `tests/unit/p4-4-open-config-legacy-absence.test.ts`. P4.4 remains Active/residual; no canonical loader/server/SDK change.

> **Amendment (2026-08-27, P4.4 ModelCache residual removal — ModelCache service boundary deleted, LOCK-MODELCACHE-001).** `packages/opencode/src/provider/model-cache.ts` is physically deleted (boundary deleted, not replaced). `packages/opencode/src/effect/app-runtime.ts` no longer exposes a ModelCache injection seam (`ModelCache`/`ModelCacheLayer` absent), `packages/opencode/src/server/routes/instance/httpapi/server.ts` `AppOptions` no longer exposes it, and callers `packages/opencode/src/kilocode/server/provider-auth-lifecycle.ts`, `packages/opencode/src/kilocode/server/custom-provider-save.ts`, `packages/opencode/src/kilocode/server/custom-provider-delete.ts`, `packages/opencode/src/kilocode/anaconda-desktop/service.ts` no longer reference `ModelCache`. Generic catalog `packages/opencode/src/kilocode/provider/models-api.json` (3.0 MB), `packages/core/src/models-dev.ts` (disk cache, fallback fetch, 60-minute refresh, explicit `kilo models --refresh`), `packages/opencode/src/provider/provider.ts` `BUNDLED_PROVIDERS`, and `KILO_MODEL_SCHEMA_EXTENSIONS`/`patchModelsDevModel` remain per LOCK-006; HTTP/SSE/generated-SDK transport unchanged per LOCK-009. Evidence: `packages/opencode/test/kilocode/p4-4-model-cache-removal.test.ts` (file absent, no production `ModelCache` reference, seams removed, catalog preserved). P4.4 remains Active/residual; no row/phase closure claimed. Prior T7 (2026-08-26) description of `provider/model-cache.ts` as invalidation-only `clear` is historical and superseded by this deletion.

## 1. Status And Classification Rules

- Status of every claim: `Evidence` (verified file:line reference),
  `Unknown` (not resolvable by static analysis), or `Not proven`
  (performance magnitude — LOCK-PERF-6).
- No performance claim is made anywhere in this file. All magnitudes are
  `Not proven` here; measured values are recorded in the tracker (tracker
  section 8) with evidence links, not in this artifact.
- No P0 phase is claimed complete. This artifact is an input to P0 exit, not
  evidence of P0 exit.
- Counts are reproducible via the commands in section 11. A count that is not
  reproducible is labeled `Unknown`, never estimated.
- Working-tree note: the inventory below was collected against commit
  `6ecc440507` on branch `jorkey/integration` **including uncommitted
  working-tree changes** that add opt-in P0 instrumentation
  (`packages/kilo-vscode/src/perf/`, `packages/opencode/src/kilocode/perf/`,
  call sites across 17 files) and an H-1..H-13 baseline fixture
  (`packages/opencode/test/kilocode/p0-harness-baseline.test.ts`). Those
  uncommitted files are current-state facts and are cited as such. If they are
  reverted or changed, the line references below may drift.
- The working tree changed during collection: the `p0Perf` webview message
  type (webview→extension) appeared in `webview-messages.ts` mid-collection
  (concurrent uncommitted P0 instrumentation work), and the H-1..H-13 baseline
  fixture gained lines while this artifact was being written (1191 → 1193
  lines between collection and final verification). All counts below were
  re-verified against the final state of the working tree (2026-08-10 14:07)
  and are the post-`p0Perf` numbers. Fixture line citations were re-verified
  at 14:07 and again in this work unit against the fixture's current stable
  state (1253 lines; `SessionRevert.defaultLayer` wiring at `:263` landed in
  this work unit, section 8).

## 2. Purpose And Method

### 2.1 Purpose

- Freeze the surface inventory (direction spec section 1.3), the message
  protocol inventory, the removal inventory (direction spec section 9 /
  tracker section 7), and the runtime/config root-cause inventory (runtime
  spec section 2) with concrete file:line references.
- Map every H-1..H-13 flow to an existing executable harness entry or an
  explicit gap (tracker P0 exit checklist row 1).
- Record the static redundancy candidates (runtime spec section 10.4) and the
  dynamic evidence unknowns so no later phase can claim a removal or a
  performance improvement without measured evidence (LOCK-PERF-6).

### 2.2 Method

- Static source search across `packages/kilo-vscode`, `packages/opencode`,
  `packages/sdk/js`, `packages/kilo-i18n`, `packages/kilo-docs`, and the
  removal-target packages, using `rg`/`grep` and manual reads.
- Message-protocol classification method: for each distinct `type:` literal in
  the `WebviewMessage` and `ExtensionMessage` unions, search the whole
  extension package (`src/` + `webview-ui/`, excluding the type-definition
  directory) for any reference. A type referenced only inside
  `webview-ui/src/types/messages/` is classified `Unused (static)`. All other
  types are `Used`. Because dispatch can be dynamic (string-built types,
  generic handlers, remote-controlled flows), `Used`/`Unused (static)` are
  static classifications; final truth needs the runtime probe in section 9.
- Counts: reproducible commands are listed beside every count (section 11).
- Evidence date: 2026-08-10.

## 3. Surface Inventory

Expansion of direction spec section 1.3 with verified current implementation
locations. "Target classification" is copied from the direction spec. Rows
explicitly updated with post-implementation evidence record removal; other
rows remain current-state or target evidence only.

| Surface | Current implementation (evidence) | Role today | Target classification |
|---|---|---|---|
| Ordinary single-chat sidebar | `packages/kilo-vscode/src/KiloProvider.ts:281` (`viewType = "kilo-code.SidebarProvider"`); `packages/kilo-vscode/src/extension.ts:206-212` (`registerWebviewViewProvider`); focus commands `extension.ts:455,465,480`; shared webview build `webview-ui/src/index.tsx` | Single-session chat | Deprecate, then remove (LOCK-001) |
| Editor chat tab ("Open in Tab") | `extension.ts:290-314` (`kilo-code.new.TabPanel` serializer); uses the sidebar webview build and a dedicated `KiloProvider` instance per tab | Single-session chat in an editor panel | Migrate into orchestration panels |
| Agent Manager (editor tab) | `extension.ts:225-230` (`AgentManagerProvider`), `extension.ts:262-278` (panel serializer); extension code `src/agent-manager/` (34 files incl. `AgentManagerProvider.ts`, `vscode-host.ts`, `GitOps.ts`, `GitStatsPoller.ts`, `terminal-manager.ts`, `run/`); webview `webview-ui/agent-manager/` | Parallel sessions, terminals, setup scripts | Core orchestration surface; worktree capabilities removed (LOCK-002) |
| Diff Viewer webview | `extension.ts:316-324`; `src/diff/DiffViewerProvider.ts:24` (`viewType = "kilo-code.new.DiffViewerPanel"`), `:102`; webview `webview-ui/diff-viewer/` | Diff rendering | Removed (LOCK-002) |
| Diff Virtual webview | `extension.ts:326-330`; `src/DiffVirtualProvider.ts:46` (`kilo-code.new.DiffVirtualPanel`); webview `webview-ui/diff-virtual/`; open path `src/kilo-provider/editor-actions.ts:106-107` (`openDiffVirtual`) | Lightweight single-file diff for permission approval | Removed (LOCK-002) |
| KiloClaw | `extension.ts:221-223` (provider), `extension.ts:280-288` (panel serializer); `src/kiloclaw/KiloClawProvider.ts:59` (`kilo-code.new.KiloClawPanel`); webview `webview-ui/kiloclaw/`; backend `packages/opencode/src/kilocode/claw/` | Additional assistant surface | Removed (LOCK-003) |
| Cloud session surfaces | `KiloProvider.ts:876-877` (`openCloudSession`), `KiloProvider.ts:1330-1339` (`requestCloudSessions`, `requestCloudSessionData`); handler `src/kilo-provider/handlers/cloud-session.ts`; webview `webview-ui/src/App.tsx:145-147`, `webview-ui/src/context/session.tsx:1201-1210`; backend `packages/opencode/src/kilocode/cloud-session.ts` | Cloud session panels/routes | Removed (LOCK-003) |
| JetBrains | `packages/kilo-jetbrains/` (whole package; 518 MB incl. build artifacts) | Editor product | Removed (LOCK-003) |
| Console | `packages/kilo-console/` (whole package; 16 MB); CLI-side `packages/opencode/src/kilocode/console/`; `packages/opencode/src/cli/cmd/account.ts:6` (commented-out `kilo console` command) | Browser console / CLI console surface | Removed (LOCK-003) |
| Settings / profile panels | `extension.ts:333-334` (`SettingsEditorProvider`), `extension.ts:346-349` (serializers for `kilo-code.new.settingsPanel`, `kilo-code.new.profilePanel`); `src/SettingsEditorProvider.ts:47` | Configuration and accounts | Consolidate into GUI-owned configuration (ADR-0003) |
| Marketplace panel | `extension.ts:335-343` (`MarketplacePanelProvider`, `MarketplaceNotifier`); `src/MarketplacePanelProvider.ts:31` (`kilo-code.new.marketplacePanel`); webview `webview-ui/marketplace/` | Catalog/install surface | Consolidate/remove with preset provider boundary (LOCK-006) |
| Autocomplete | `extension.ts:257` (`ensureBackendForAutocomplete`), `extension.ts:570` (`registerAutocompleteProvider`); `src/services/autocomplete/` (16+ files incl. `classic-auto-complete/`, `ensure-backend.ts`); `package.json` commands `kilo-code.new.autocomplete.*` (`package.json:198-213,717-739`) and settings (`package.json:859-877`) | Inline completions + commit messages | Removed (LOCK-004) |
| Commit-message generation | `src/services/commit-message/index.ts` | Commit message generation | Removed with autocomplete (LOCK-004) |
| Indexing | `KiloProvider.ts:1227-1236` (request handlers), `KiloProvider.ts:2569-2607` (`fetchAndSendIndexingStatus`); `src/kilo-provider/indexing-settings.ts`; webview `webview-ui/src/components/settings/IndexingTab.tsx`; server env `src/services/cli-backend/server-manager.ts:26-29` (`KILO_DISABLE_CODEBASE_INDEXING`) | Semantic indexing status/UI | Removed (LOCK-004) |
| Project memory | `KiloProvider.ts:363,1687,2494,4396-4407`; `src/kilo-provider/memory.ts`; webview memory context + `webview-ui/src/components/settings/ContextTab.tsx`; packages `packages/kilo-memory/`, `packages/opencode/src/kilocode/memory/` | Memory tools, memory fetch, system-prompt injection | Removed (LOCK-004) |
| User-visible context management/compaction | `webview-ui/src/components/settings/ContextTab.tsx:21,132-172` (compaction `threshold_percent`, `auto`, `prune` settings); `CompactRequest` message `webview-ui/src/types/messages/webview-messages.ts:189-190`; `packages/opencode/src/session/compaction.ts`; `SessionCompaction.defaultLayer` in `packages/opencode/src/effect/app-runtime.ts:147` | Compaction settings and context-management UI | Removed (LOCK-004); internal overflow safeguard retained (LOCK-005) |
| Preset provider catalog/onboarding | `packages/opencode/src/kilocode/provider/provider.ts` (deleted P4.4-T6 — `KILO_BUNDLED_PROVIDERS` ` "@kilocode/kilo-gateway": async () => createKilo` and `createKilo`/`BundledSDK` removed; `KILO_MODEL_SCHEMA_EXTENSIONS`/`patchModelsDevModel`/`kiloCustomLoaders` retained); `packages/opencode/src/kilocode/provider/models-api.json` (3.0 MB checked-in catalog retained per LOCK-006/009); `packages/opencode/src/kilocode/provider/metadata.ts` (deleted P4.4-T5 — preset `providerMetadata` `noteKey`/`icon`/`priority` helper removed; `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts` `metadata: providerMetadata(item.id)` enrichment removed, optional `Provider.Info` `metadata` field and `Provider` OpenAPI/SDK `metadata` remain optional/contract-compatible per LOCK-009); `packages/opencode/src/provider/provider.ts:178` (`BUNDLED_PROVIDERS` generic SDK loaders retained; `...KILO_BUNDLED_PROVIDERS` spread deleted P4.4-T6); `packages/opencode/src/provider/provider.ts:1383-1392` (models.dev service); `packages/opencode/src/provider/models.ts` (P4.4-T7 — `kilo`/`apertis` injection and `ModelCache`/`KILO_OPENROUTER_BASE` removed; static `Core` overlay only); `packages/opencode/src/provider/model-cache.ts` (deleted 2026-08-27 P4.4 residual package — file physically deleted, no ModelCache service remains; P4.4-T7 invalidation-only `clear` is historical and superseded) | Preset provider identities/catalogs, models.dev dependency (partial removal: preset display metadata enrichment removed P4.4-T5; preset `@kilocode/kilo-gateway` bundled loader removed P4.4-T6; kilo/apertis dynamic fetch/cache removed P4.4-T7 — `provider/model-cache.ts` `kilo`/`apertis` network deleted, `provider/models.ts` static overlay only, handler `ModelCache` removed; committed `models-api.json` 3.0 MB build-time snapshot, generic `Core.ModelsDev` runtime (`packages/core/src/models-dev.ts` with disk cache, fallback fetch, 60-minute background refresh, explicit `kilo models --refresh`; `bun run refresh:models` only refreshes checked-in snapshot), generic adapters, `KILO_MODEL_SCHEMA_EXTENSIONS`/`patchModelsDevModel`, custom-provider paths, HTTP/SSE bridge, and optional `metadata` schema remain open per LOCK-006/009 — `ModelCache` service deleted 2026-08-27 (no `clear` remains) and only `kilo`/`apertis` dynamic fetching was removed) | Removed (LOCK-006) — preset display metadata enrichment removed (P4.4-T5); preset `@kilocode/kilo-gateway` bundled loader removed (P4.4-T6); kilo/apertis dynamic fetch/cache removed (P4.4-T7) — `provider/model-cache.ts` kilo/apertis network deleted, `provider/models.ts` kilo/apertis injection removed, handler `ModelCache` removed; catalog (`models-api.json` 3.0 MB)/`packages/core/src/models-dev.ts` static catalog/generic adapters/bridge remain open residue |
| Notebook | `extension.ts:137` (`createNotebookBridge`); `src/services/notebook/`; `Notebook.defaultLayer` in `app-runtime.ts:136` | Notebook integration | Not in the direction's removal rows; residual harness integration (removal row: not listed in tracker section 7 — see section 4 note) |
| Browser automation | `src/services/browser-automation/` (MCP registration) | Browser automation MCP | Residual integration; disposition not in tracker removal rows |
| Legacy migration / Roo import | Extension legacy-migration and Roo-import trees are removed; removal assertions are in `packages/kilo-vscode/tests/unit/p3-4-removal.test.ts:420-444`. The CLI/TUI migration helper `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts` historically at `33-80,148-166` is now physically deleted in the P4.4 residual package (2026-08-27, zero active callers since T27; `Flag.KILO_TUI_CONFIG` also deleted; canonical loader `resolveWorktree`/`canonicalRoot` + `ConfigPaths.fileInDirectory(root, "tui")` + `path.join(root, ".kilo")` only preserved) — broader P4.5-adjacent residues remain (`theme.tsx:564` `[".kilocode", ".kilo"]` retained as broader residue; `ConfigPaths.files` retained per LOCK-003 with no active TUI call while `ConfigPaths.fileInDirectory` is the active canonical TUI loader at `tui.ts:235,241,250`). | Extension importer/Roo wiring removed; dead CLI/TUI helper file deleted (physically absent) — row remains residual/open for broader migration/import residues per LOCK-001 | Residual: helper file deleted (no active `migrateTuiConfig`/`Flag.KILO_TUI_CONFIG` reader); extension removal evidenced; broader TUI/theme residues remain open |
| Speech-to-text | `src/speech-to-text/`; messages `speechToTextStart/Stop/Cancel/Prewarm` | Dictation | Residual; not in tracker removal rows |
| Image generation/preview | `src/image-generation/`, `src/image-preview.ts` | Image features | Residual; not in tracker removal rows |

Note on rows not in the tracker removal table (Notebook, browser automation,
speech-to-text, image generation): the tracker section 7 rows cover only the
LOCK-002/003/004/006 removals. These additional surfaces are recorded here so
the surface inventory is complete; their disposition is `Unknown` (not decided
by any lock) and is returned to the hub. Legacy migration/Roo import is no
longer an extension surface: its extension implementation is removed; the
CLI/TUI migration helper `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts`
was historically retained open work at 2026-08-25 (not to be confused with the
deleted extension importer) and is now physically deleted in the P4.4 residual
package (2026-08-27, file absent, `Flag.KILO_TUI_CONFIG` also deleted, canonical
loader `resolveWorktree`/`canonicalRoot` + `ConfigPaths.fileInDirectory(root,
"tui")` + `path.join(root, ".kilo")` only preserved) — row remains
residual/open for broader P4.5-adjacent TUI/theme residues (`theme.tsx:564`
`[".kilocode", ".kilo"]` retained as broader residue; `ConfigPaths.files`
retained per LOCK-003 with no active TUI call while `ConfigPaths.fileInDirectory` is the active canonical TUI loader at `tui.ts:235,241,250`) per LOCK-001.

Shared current-state facts (from the direction spec and verified): one
`KiloConnectionService` (`src/services/cli-backend/connection-service.ts:32-38`)
owns one `ServerManager` child process (`server-manager.ts:35-268`), one v2 SDK
client (`connection-service.ts:3`, `createKiloClient` from
`@kilocode/sdk/v2/client`), and one SSE adapter (`sdk-sse-adapter.ts`). SSE
events are filtered per webview via `trackedSessionIds` (`KiloProvider.ts:1575`)
and delivered over `postMessage`. Worktrees under `.kilo/worktrees/` are removal
scope (LOCK-002; documented at
`packages/kilo-docs/pages/contributing/architecture/vscode-extension.md:100`).

## 4. Message / Protocol Inventory

### 4.1 Webview postMessage protocol (extension ↔ webview)

Source of truth: `packages/kilo-vscode/webview-ui/src/types/messages/`
(`webview-messages.ts`, `extension-messages.ts`, plus parts/agents/config/
permissions/profile/providers/questions/sessions/
agent-manager/connection).

| Protocol | Direction | Union members | Distinct `type` literals | Evidence |
|---|---|---|---|---|
| `WebviewMessage` | webview → extension | 141 | 139 | `webview-ui/src/types/messages/webview-messages.ts:963-1104` |
| `ExtensionMessage` | extension → webview | 132 | 120 | `webview-ui/src/types/messages/extension-messages.ts:992-1124` |

The top-level union member sets remain disjoint. At counting-command level the
two files now share one `type:` literal — `retryProviderCleanup` (a
`WebviewMessage` union discriminator at `webview-messages.ts:804` and a nested
retry payload shape inside `extension-messages.ts:900,906`) — so combined
distinct webview message types are **258** (139 + 120 − 1 shared; reproducible
count, section 11). Historical baseline (2026-08-10 collection):
**332** (189 + 143) with 0 shared type strings (section 13).

Static classification (method in section 2.2):

| Class | Webview → extension | Extension → webview | Notes |
|---|---|---|---|
| Used (referenced in extension `src/` or webview code) | 136 of 139 | 119 of 120 | Includes `case "X"`, `=== "X"`, and webview-side `post`/dispatch references |
| Unused (static) — referenced only inside the type-definition directory | 3 | 1 | `agentManager.setDefaultBaseBranch`, `filterMarketplaceItems`, `selectSource` (webview→ext) and `agentManager.multiVersionProgress` (ext→webview) |
| Unknown (needs runtime probe) | all `Used`/`Unused (static)` labels | same | Dynamic dispatch, string-built types, and remote-controlled flows are not provable statically |

The 3 statically-unused webview→extension types:
`agentManager.setDefaultBaseBranch`, `filterMarketplaceItems`, `selectSource`.

The 1 statically-unused extension→webview type:
`agentManager.multiVersionProgress`.

All 4 statically-unused types belong to removal-target or retired surfaces:
worktree base-branch and multi-version agent-manager
(`agentManager.setDefaultBaseBranch`, `agentManager.multiVersionProgress`),
marketplace (`filterMarketplaceItems`), and legacy source selection
(`selectSource`). Static deadness is consistent with the removals that landed
since the 2026-08-10 collection (LOCK-002, LOCK-006, direction spec 1.2), but
is **not** proof of absence of runtime dispatch — see section 10 (U-1).

### 4.2 SSE event protocol (server → extension)

| Protocol | Members | Evidence |
|---|---|---|
| `GlobalEvent` payload union (server SSE → extension) | 149 | `packages/sdk/js/src/v2/gen/types.gen.ts:1009-1158` (union of `Event*` / `SyncEvent*`) |

Removal-surface SSE events present: `EventMemoryStatus/Updated/Error`,
`EventIndexingStatus/Warning`, `EventWorktreeReady/Failed`,
`EventKilocodeAgentManager*`, `EventKilocodeNotebookRequested/Cancelled`,
`EventBackgroundProcess*`, `EventKiloSessionsRemoteStatusChanged`,
`EventSessionNextCompaction*`. The extension filters global events explicitly
at `KiloProvider.ts:1547-1549` (memory, remote-status) and `:1563,1572-1573`.

### 4.3 HTTP/SDK protocol (extension → server)

The extension drives the server through the generated v2 SDK
(`connection-service.ts:3` imports `createKiloClient` from
`@kilocode/sdk/v2/client`).

| Metric | Count | Evidence |
|---|---|---|
| v2 SDK public methods (routes) | 250 | `packages/sdk/js/src/v2/gen/sdk.gen.ts` (250 `url:` entries) |
| v2 SDK resource classes | 86 | `packages/sdk/js/src/v2/gen/sdk.gen.ts` (`export class` lines) |

Removal-target SDK groups (method counts per class):

| Group | Methods | Representative routes |
|---|---|---|
| Worktree | 7 | worktree create/remove/reset |
| Memory | 10 | `/memory/status`, `/memory/show`, `/memory/enable`, `/memory/disable`, `/memory/configure` (`sdk.gen.ts:8940-9064`) |
| Indexing | 3 | `/indexing/status`, `/indexing/warnings`, `/indexing/models` (`sdk.gen.ts:6563-6623`) |
| Kilo | 7 | `/kilo/profile`, `/kilo/auth-status`, `/kilo/modes`, `/kilo/fim`, `/kilo/edit`, `/kilo/notifications`, `/kilo/cloud-sessions` |
| Console | 3 | console routes |
| Claw | 2 | KiloClaw chat routes |
| Notebook | 3 | notebook routes |
| AgentManager | 3 | agent-manager routes |
| BackgroundProcess | 6 | background job routes |
| Organization | 1 | organization route |
| Oauth | 2 | OAuth authorize/callback |
| Diff | 1 | diff route |

The extension's own HTTP surface is exercised through the parallel fetch chain
(`KiloProvider.ts:1680-1689`): providers, agents, skills, commands, config,
indexing status, memory fetch, session-status seed — plus
`client.kilo.profile()` (`KiloProvider.ts:1598`) and `client.kilo.cloudSessions()`
(`kilo-provider/handlers/cloud-session.ts:44`).

### 4.4 Protocol count summary (Q3 raw material)

| Count | Value | Reproducible |
|---|---|---|
| Webview message types (distinct `type` literals, both directions) | 258 | Yes (section 11) |
| WebviewMessage union members | 141 | Yes |
| ExtensionMessage union members | 132 | Yes |
| v2 SDK provider methods | 250 | Yes |
| Webview entry points (esbuild) | 6 (+1 shiki worker asset) | Yes |
| SSE `GlobalEvent` union members | 149 | Yes |

The exact baseline-metric definitions are approved (tracker open question 3
resolved 2026-08-12); section 9 records the approved definitions with the
reproducible counting commands, and the current counts are reflected in the
tracker (section 8).

## 5. Removal Inventory

Matches tracker section 7 rows one-for-one. Evidence categories: `source`,
`tests`, `docs`, `generated SDK`, `config`, `i18n`, `build/package`. `-`
means no evidence found; `Unknown` means the category may exist but was not
verifiable by the static search used here. Nothing here claims a removal has
been executed — this is the residual evidence for the P3/P4.4 removal phases.

| Removal (LOCK) | Phase | Source | Tests | Docs | Generated SDK | Config | i18n | Build/package |
|---|---|---|---|---|---|---|---|---|
| Ordinary single-chat sidebar (LOCK-001) | P3.1 | `KiloProvider.ts:281`, `extension.ts:206-212,455,465,480` | `tests/unit/sidebar-search.test.ts`, `tests/unit/sidebar-tab-dnd.test.ts`, `tests/unit/kilo-provider-load-messages.test.ts` | `packages/kilo-docs/pages/contributing/architecture/vscode-extension.md` (sidebar/panels table `:57`) | - (no SDK surface) | `kilo-code.new.*` VS Code settings (`package.json` contribution) | `webview-ui/src/i18n/` (20 locale files) | `esbuild.js:232` (`dist/webview.js`), `package.json` view container |
| Worktree infrastructure (LOCK-002) | P3.2 | `src/agent-manager/` (10+ files: `GitOps.ts`, `git-import.ts`, `git-transfer.ts`, `terminal-manager.ts`, `GitStatsPoller.ts`, `vscode-host.ts:41-102`, `AgentManagerProvider.ts:740` `getWorktreeDirectories`); `packages/opencode/src/worktree/index.ts`; `app-runtime.ts:171` (`Worktree.appLayer`); `opencode/src/kilocode/primary-worktree.ts`, `worktree-family.ts`, `worktree-cleanup.ts`, `review/worktree-diff.ts` | `tests/unit/agent-manager-phase3a/b/c.test.ts`, `tests/unit/agent-manager-close-session.test.ts` | `vscode-extension.md:84-120` (worktree behavior, `.kilo/worktrees/`) | v2 SDK `Worktree` group (7 methods) | `.kilo/worktrees/`, `.kilo/agent-manager.json` (documented `vscode-extension.md:100`) | `webview-ui/agent-manager/i18n/` | `esbuild.js:209-211` (`dist/agent-manager.js`) |
| Custom Diff Viewer surfaces (LOCK-002) | P3.2 | `src/diff/DiffViewerProvider.ts:24,102`; `src/DiffVirtualProvider.ts:46`; `src/kilo-provider/editor-actions.ts:106-107`; `src/kilo-provider/diff-*` files | `tests/unit/diff-*.test.ts` (diff-source-catalog, diff-session-source, diff-turn-source, diff-hash, diff-image, diff-preview-request, diff-viewer-css-arch) | `vscode-extension.md:58,172` (Diff Viewer/Diff Virtual webviews) | v2 SDK `Diff` group (1 method) | - | `webview-ui/src/i18n/` (diff strings) | `esbuild.js:221-224` (`dist/diff-viewer.js`, `dist/diff-virtual.js`) |
| Cloud sessions (LOCK-003) | P3.3 | `KiloProvider.ts:876-877,1330-1339`; `src/kilo-provider/handlers/cloud-session.ts`; `opencode/src/kilocode/cloud-session.ts`; `webview-ui/src/App.tsx:145-147`, `webview-ui/src/context/session.tsx:1201-1210` | `tests/unit/cloud-session-handler.test.ts` | `packages/kilo-docs/pages/contributing/architecture/cloud-platform.md`, `cloud-security.md` | v2 SDK `Kilo.cloudSessions` (`/kilo/cloud-sessions`) | - | `webview-ui/src/i18n/` (cloud strings) | - |
| JetBrains (LOCK-003) | P3.3 | `packages/kilo-jetbrains/` (whole package) | `packages/kilo-jetbrains/` Gradle test tasks (`./gradlew test`) | `packages/kilo-docs/pages/contributing/architecture/jetbrains-plugin.md` | - | - | JetBrains i18n in-package | `turbo.json:47-54` (`@kilocode/kilo-jetbrains#build/typecheck/test:ci`); workflows `.github/workflows/publish-jetbrains.yml`, `test-jetbrains.yml`, `codeql-kotlin.yml` |
| Console (LOCK-003) | P3.3 | `packages/kilo-console/` (whole package); `opencode/src/kilocode/console/`; `cli/cmd/account.ts:6` | Unknown (package has `src/client.test.ts`) | Unknown | v2 SDK `Console` group (3 methods) | - | `packages/kilo-console/src/i18n` (in-package) | `packages/kilo-console/vite.config.ts` (standalone web app) |
| KiloClaw (LOCK-003) | P3.3 | `src/kiloclaw/KiloClawProvider.ts:59`; `extension.ts:221-223,280-288`; `opencode/src/kilocode/claw/`; `webview-ui/kiloclaw/` | Unknown (no dedicated kiloclaw unit test found in `tests/unit/`) | `vscode-extension.md:60,171` (KiloClaw bootstrap, webview) | v2 SDK `Claw` group (2 methods) | - | `webview-ui/src/i18n/` (KiloClaw strings) | `esbuild.js:216` (`dist/kiloclaw.js`); `package.json:105,145` (KiloClaw commands/menus) |
| Indexing (LOCK-004) | P3.4 | `KiloProvider.ts:1227-1236,2569-2607`; `src/kilo-provider/indexing-settings.ts`; `webview-ui/src/components/settings/IndexingTab.tsx`; `server-manager.ts:26-29`; `packages/kilo-indexing/` | `tests/unit/indexing-settings-message.test.ts`, `indexing-tab-state.test.ts`, `indexing-utils.test.ts`, `kilo-provider-indexing-refresh.test.ts` | `vscode-extension.md:150` (`KILO_DISABLE_CODEBASE_INDEXING`) | v2 SDK `Indexing` group (3 methods) | `kilo-code.new.indexing` settings (`src/kilo-provider/indexing-settings.ts:6`) | `webview-ui/src/i18n/` (indexing strings) | `packages/kilo-indexing/package.json` |
| Project memory (LOCK-004) | P3.4 | `KiloProvider.ts:363,1687,2494,4396-4407`; `src/kilo-provider/memory.ts`; `webview-ui/src/components/settings/ContextTab.tsx`; `packages/kilo-memory/`; `opencode/src/kilocode/memory/` (`turn.ts`, `ports.ts`, `events.ts`, `marker.ts`, `runtime.ts`); `app-runtime.ts:173` (`MemoryService.layer`) | `tests/unit/kilo-provider-memory-events.test.ts`, `agent-manager-memory-commands.test.ts` | `vscode-extension.md` (memory references) | v2 SDK `Memory` group (10 methods) | memory enable/disable state (VS Code state + config) | `webview-ui/src/i18n/` (memory strings) | `packages/kilo-memory/package.json` |
| User-visible context management/compaction (LOCK-004) | P3.4 | `ContextTab.tsx:21,132-172`; `webview-ui/src/types/messages/webview-messages.ts:189-190` (`CompactRequest`); `opencode/src/session/compaction.ts`; `app-runtime.ts:147` (`SessionCompaction.defaultLayer`); retained safeguard `opencode/src/kilocode/session/overflow.ts` + `session/overflow.ts` (LOCK-005) | `packages/opencode/test/` compaction suites (existing) | `cli-runtime.md` (config update lifecycle; compaction behavior) | SSE `EventSessionNextCompaction*` events | `config.compaction.*` (`ContextTab.tsx:21`) | `webview-ui/src/i18n/` (settings.context.* strings) | - |
| Autocomplete (LOCK-004) | P3.4 | `extension.ts:257,570`; `src/services/autocomplete/` (incl. `classic-auto-complete/`, `ensure-backend.ts:8` prewarm); `src/services/commit-message/` | `tests/unit/autocomplete-*.test.ts` (abort-scope, error-backoff, inline-utils, migrate-default, settings-message); `src/services/autocomplete/__tests__/` | `vscode-extension.md:42,137` (autocomplete prewarm, settings) | v2 SDK `Kilo.fim`, `Kilo.edit` (`/kilo/fim`, `/kilo/edit`) | `kilo-code.new.autocomplete.*` (`package.json:859-877`) | `src/services/i18n/`, `webview-ui/src/i18n/` (autocomplete strings) | `package.json:198-213,717-739` (autocomplete commands/keybindings) |
| Preset providers/catalog/onboarding/org sources (LOCK-006) | P4.4 | `opencode/src/kilocode/provider/provider.ts` (deleted P4.4-T6 — `KILO_BUNDLED_PROVIDERS` `"@kilocode/kilo-gateway": async () => createKilo` deleted; `createKilo`/`BundledSDK` removed; `KILO_MODEL_SCHEMA_EXTENSIONS`/`patchModelsDevModel`/`kiloCustomLoaders` retained); `kilocode/provider/models-api.json` (3.0 MB checked-in catalog retained per LOCK-006/009); `kilocode/provider/metadata.ts` (deleted P4.4-T5 — preset `providerMetadata` `noteKey`/`icon`/`priority` helper deleted; optional `Provider.Info` `metadata` field remains optional/contract-compatible per LOCK-009); `provider/provider.ts:178` (`BUNDLED_PROVIDERS` generic SDK loaders retained; `...KILO_BUNDLED_PROVIDERS` spread deleted P4.4-T6); `provider/provider.ts:1383-1392` (models.dev service retained); `provider/models.ts` (P4.4-T7 — `kilo`/`apertis` injection and `ModelCache` removed; static `Core` overlay only); `provider/model-cache.ts` (deleted 2026-08-27 P4.4 residual package — file physically deleted, no ModelCache service remains; P4.4-T7 invalidation-only `clear` is historical and superseded); `kilocode/server/provider-auth-lifecycle.ts`, `kilocode/server/custom-provider-save.ts`, `kilocode/server/custom-provider-delete.ts`, `kilocode/anaconda-desktop/service.ts` (no `ModelCache` reference — deleted with file; AppRuntime/Server seams removed) | `packages/opencode/test/` provider suites (existing); `p4-4-provider-metadata-removal.test.ts` (P4.4-T5); `p4-4-bundled-provider-loader-removal.test.ts` (P4.4-T6); `p4-4-model-cache-removal.test.ts` (deleted 2026-08-27 P4.4 residual package — file absent, no production `ModelCache`/`model-cache` reference, seams removed, catalog preserved; P4.4-T7 kilo/apertis network-absence is historical and superseded) | `packages/kilo-docs/pages/contributing/architecture/cli-runtime.md` ("Outbound provider authentication", "Provider routing") | v2 SDK `Provider` (2), `Oauth` (2), `Auth` (5), `Organization` (1), `Kilo.profile`/`Kilo.auth-status` | Auth records (`api`/`oauth`/`wellknown`), org modes (`config.ts:512`), well-known remote config (`config.ts:586-639`), org IDs in model fetch | - | - |

All 12 tracker removal rows have source evidence; 11 have generated-SDK
evidence (sidebar has none by nature — it is extension-side only). The
`Unknown` cells (Console docs/tests, KiloClaw tests) are explicitly unresolved
and listed in section 9.

## 6. Runtime / Config / Provider / Readiness Root-Cause Graph

Covers runtime spec section 2 (2.1-2.5) with verified locations.

### 6.1 Config authority and 12+-source merge (spec 2.1, 2.2)

- Authority today is the CLI backend. The extension is a client:
  `connection-service.ts:32-38` (one `ServerManager`, one SDK client, one SSE
  adapter); documented in `vscode-extension.md` ("Shared server ownership",
  "Config split").
- Merge implementation: `packages/opencode/src/config/config.ts:63` (`mergeConfig`),
  `:67` (`mergeConfigConcatArrays`), `:373` (`loadFile`).
- Enumerated merge sources (each with evidence line):
  1. Global `config.json` — `config.ts:404`
  2. Global `kilo.json` — `config.ts:406`
  3. Global `kilo.jsonc` — `config.ts:407`
  4. Global `opencode.json` — `config.ts:409`
  5. Global `opencode.jsonc` — `config.ts:410`
  6. Legacy global `config` (TOML) one-shot migration — `config.ts:412-426`
  7. Legacy project config migration (`loadLegacyConfigs`) — `config.ts:495-501`
  8. Organization modes (`loadOrganizationModes`) — `config.ts:512-516`
  9. Auth-record well-known remote config (`.well-known/opencode`) — `config.ts:586-639`
  10. Explicit `KILO_CONFIG` file — `config.ts:655-670`
  11. Project config files + discovered config directories — `config.ts:680`
  12. `KILO_CONFIG_DIR` — `config.ts:707-732`
  13. `KILO_CONFIG_CONTENT` env — `config.ts:794-808`
  14. Managed config directory / macOS managed preferences — `config.ts` (managed-dir paths; documented in `cli-runtime.md` "Config precedence")
  15. Runtime flag-derived permission/tool/compaction/plugin behavior — flags/env in `config.ts` merge chain
- Count of distinct merge sources in the loader: **15 enumerated here** (the
  direction spec's "12+" is a floor; the exact active-per-workspace count is a
  runtime unknown, section 9).

### 6.2 Provider sources and loaders (spec 2.3)

| Source | Evidence |
|---|---|
| Preset provider identities (bundled loaders) | `kilocode/provider/provider.ts` (deleted P4.4-T6 — `KILO_BUNDLED_PROVIDERS` ` "@kilocode/kilo-gateway": async () => createKilo` deleted; `BUNDLED_PROVIDERS` spread deleted from `provider/provider.ts:205`; generic SDK loaders retained) |
| Checked-in catalog (models-dev snapshot) | `kilocode/provider/models-api.json` (3.0 MB) |
| Preset metadata keys | `kilocode/provider/metadata.ts` (deleted P4.4-T5 — preset `providerMetadata` helper removed; optional `Provider.Info` `metadata` field remains optional per LOCK-009; bundled loader deleted P4.4-T6 — `models-api.json`/`models.dev`/generic adapters remain per LOCK-006/009; `ModelCache` deleted 2026-08-27) |
| Models.dev runtime fetch + empty-catalog fallback | `provider/provider.ts:1383-1392`; `provider/models.ts:47-51` ("models.dev catalog unavailable, using empty catalog") |
| Auth records (`api`/`oauth`/`wellknown`) + v2 multi-account store | `provider/auth.ts`; `kilocode/server/provider-auth-lifecycle.ts` |
| Organization sources (org IDs in model fetch) | `config.ts:512-516` (org modes); org-participating model fetch paths in `provider/` |
| Model cache (5-minute TTL) | `provider/model-cache.ts` deleted 2026-08-27 P4.4 residual package — file physically deleted, no ModelCache service remains (historical T7 `Duration.minutes(5)` is superseded) |
| Custom-endpoint overrides | `kilocode/custom-provider.ts`, `custom-provider-save.ts`, `custom-provider-delete.ts` |

### 6.3 Convergence / cold-rebuild machinery (spec 2.4)

All in `packages/opencode/src/kilocode/server/`:

| File | Role |
|---|---|
| `config-convergence.ts` | Cold-save convergence coordinator (commit `:273`, release `:556`) |
| `generation-gate.ts` | Writer admission fence |
| `control-lease.ts` | Control lifetime leases |
| `config-rebuild.ts` | Identity rebuild |
| `config-transaction.ts`, `config-ticket.ts`, `config-write-intent.ts`, `drain-control.ts`, `config-failure.ts`, `config-rollback.ts` | Transaction/ticket/write-intent/drain/rollback support |

Canonical description: `packages/kilo-docs/pages/contributing/architecture/cli-runtime.md` ("Config update lifecycle").

### 6.4 Selector readiness chain (spec 2.5)

1. Extension activation — `extension.ts:130-131` (`activate.start`), registers sidebar/Agent Manager/KiloClaw/Diff/settings/marketplace/autocomplete/attention/telemetry (`extension.ts:202-344,570`); autocomplete may prewarm the backend (`extension.ts:257` → `services/autocomplete/ensure-backend.ts:8-21`).
2. Connection start — `KiloProvider.initializeConnection` (`KiloProvider.ts:1506`) → `doInitializeConnection` (`:1516`) → `connectionService.connect` (`:1537`; `connection-service.ts:136-150`).
3. Worker spawn — `ServerManager.getServer` (`server-manager.ts:47`) → `startServer` (`:70`) → `spawn(cliPath, ["serve", "--port", "0"])` (`:113`).
4. Port detected — stdout `parseServerPort` (`server-manager.ts:166`).
5. Server listening — `packages/opencode/src/server/server.ts:99` (`listenEffect`), `:144` (`KiloListener.build`).
6. AppLayer graph construction — `packages/opencode/src/effect/app-runtime.ts:207-210` (`AppLayer = makeAppLayer()` + `ManagedRuntime.make`), built at listener build via `packages/opencode/src/kilocode/server/listener.ts:11` (`Layer.buildWithMemoMap`).
7. SSE connected — `sdk-sse-adapter.ts:82,206`; `KiloProvider.onStateChange` (`KiloProvider.ts:1589`).
8. Instance bootstrap (first directory request) — `packages/opencode/src/project/bootstrap.ts:21,56,58` (`InstanceBootstrap`).
9. UI fetch chain (parallel) — `KiloProvider.ts:1680-1689` (providers/agents/skills/commands/config/indexing/memory/session-status).
10. Global readiness barrier — `KiloProvider.ts:1694` `postMessage({ type: "extensionDataReady" })` (current global gate; target is action-specific readiness, LOCK-PERF-4 / runtime spec section 6).

### 6.5 Process / runtime graph (runtime spec 10.2-10.3)

- Extension host → one child `kilo serve` process (migration bridge, LOCK-009).
- Worker CLI entry statically imports CLI command modules: `packages/opencode/src/index.ts:3` (`RunCommand`), `:12` (`UI`), `:17` (`ServeCommand`); TUI config/keymap graph reached through `cli/cmd/tui/thread.ts:50` (`KiloTuiThreadDaemon`) → `cli/cmd/tui/config/tui.ts` (`TuiConfig`/`TuiKeybind`).
- Serve path is headless: `cli/cmd/serve.ts:14` (`instance: false`); TUI renderer loaded only by interactive attach via dynamic import (`cli/cmd/tui/attach.ts`).
- AppLayer service graph: Core layer `app-runtime.ts:81-113`, Session layer `:132-158` (incl. removed-feature services `AgentManager` `:133`, `KiloViewers` `:134`, `Notebook` `:136`), Feature layer `:160-177` (incl. `Worktree.appLayer` `:171`, `MemoryService.layer` `:173`, `ShareNext` `:174`).

## 7. Static Redundancy Candidates (runtime spec 10.4)

Candidates identified by static reachability. **No magnitude is claimed**;
benchmarks/profiles establish magnitude (LOCK-PERF-6). Each candidate is
classified by cost class (module graph / listener build / per-instance
bootstrap / readiness chain / removed-feature startup).

| # | Candidate | Evidence | Cost class | Disposition |
|---|---|---|---|---|
| R-1 | Module-scope `AppLayer` + `ManagedRuntime.make(AppLayer, { memoMap })` | `effect/app-runtime.ts:207-210` | Listener build (graph constructed at `KiloListener.build`, `listener.ts:11`) | Keep (lazy by design); measure construction at listener build |
| R-2 | Broad AppLayer graph (~77 services across Core/Session/Feature layers) | `effect/app-runtime.ts:81-177` | Listener build | Candidate for pruning removed-feature services (LOCK-PERF-3) |
| R-3 | Removed-feature services in the layer graph | `Worktree.appLayer` `:171`, `MemoryService.layer` `:173`, `Notebook` `:136`, `AgentManager` `:133`, `KiloViewers` `:134`, `ShareNext` `:174`, `SessionShare` `:175` | Listener build / startup | P3/P4.4 removal scope; must not initialize at startup (LOCK-PERF-3) |
| R-4 | Per-instance bootstrap | `project/bootstrap.ts:21,56,58` (`InstanceBootstrap`: config load, plugins, Kilo bootstrap, per-directory reference/lsp/format/vcs/snapshot/project init) | First-directory access | Keep (harness invariant); measure |
| R-5 | 3.0 MB checked-in models catalog + preset loaders | `kilocode/provider/models-api.json` (3.0 MB checked-in catalog retained per LOCK-006/009 — open residue, build-time snapshot); `kilocode/provider/provider.ts` (deleted P4.4-T6 — `KILO_BUNDLED_PROVIDERS` preset loader deleted/historical; `KILO_MODEL_SCHEMA_EXTENSIONS`/`patchModelsDevModel`/`kiloCustomLoaders` retained as active/open); `provider/provider.ts:178,1383-1392` (`BUNDLED_PROVIDERS` generic SDK loaders retained; models.dev service retained) and `provider/models.ts` (P4.4-T7 — `kilo`/`apertis` injection removed; static `Core` wrapper only) and `provider/model-cache.ts` (deleted 2026-08-27 P4.4 residual package — file physically deleted, no ModelCache service remains; P4.4-T7 invalidation-only `clear` is historical and superseded); `kilocode/provider/metadata.ts` (deleted P4.4-T5 — preset `providerMetadata` helper deleted/historical; optional `Provider.Info` `metadata` field remains optional per LOCK-009) | Config/provider init | LOCK-006 removal (P4.4) — preset display metadata enrichment removed (P4.4-T5); preset `@kilocode/kilo-gateway` bundled loader removed (P4.4-T6); kilo/apertis dynamic fetch/cache removed (P4.4-T7) — `provider/model-cache.ts` deleted 2026-08-27 (no ModelCache service remains), `provider/models.ts` kilo/apertis injection removed, handler `ModelCache` removed; committed `models-api.json` (3.0 MB) is a build-time snapshot and `Core.ModelsDev` (`packages/core/src/models-dev.ts`) retains generic runtime — disk cache, fallback fetch, 60-minute scoped background refresh, explicit `kilo models --refresh` (`bun run refresh:models` only refreshes checked-in snapshot and is not sole runtime refresh); generic adapters/bridge remain open residue — only `kilo`/`apertis` dynamic fetching was removed and ModelCache boundary is deleted not replaced |
| R-6 | 12+ source merge + cold convergence machinery | `config/config.ts:63-67,373,404-808`; `kilocode/server/config-convergence.ts` (+ gate/lease/rebuild files) | Config load / cold save | LOCK-011 target removes process-global rebuild (P4.4) |
| R-7 | CLI/TUI command/config/keymap module graph in the worker | `index.ts:3,12,17`; `cli/cmd/tui/thread.ts:50`; `cli/cmd/tui/config/tui.ts` | Worker module graph | Measure (LOCK-PERF-2); delete with CLI/TUI (P4.5) |
| R-8 | Extension wait-on-backend fetch chain | `KiloProvider.ts:1680-1689` → `:1694` `extensionDataReady` | Readiness chain | LOCK-PERF-4: replace with action-specific gates (P5) |
| R-9 | Autocomplete prewarm of the backend at activation | `extension.ts:257`; `services/autocomplete/ensure-backend.ts:8-21` | Startup | Autocomplete removal (LOCK-004) also removes the prewarm dependency (runtime spec section 6) |
| R-10 | Removed-feature initialization during worker startup (memory, indexing, worktree, notebook, agent-manager, share) | Feature/Session layer services (R-3); `KilocodeBootstrap` paths | Startup | Must be measured and absent after P3/P4.4 (LOCK-PERF-3, runtime spec 10.9-10.10) |

## 8. H-1..H-13 Existing Baseline Entry Map And Gaps

Existing executable entries are the CLI harness implementations and the
uncommitted P0 baseline fixture
(`packages/opencode/test/kilocode/p0-harness-baseline.test.ts`, 1253 lines,
stable in this work unit; runs production services with `TestLLMServer`; line
citations re-verified against the current file). The fixture covers
H-1, H-2, H-7, H-8, H-9, H-10, H-11, H-12, H-13 as live tests and records
H-3, H-4, H-5, H-6 as explicit gaps with references. The earlier
`Service not found: @opencode/SessionRevert` fixture layer wiring gap (4 fail
/ 0 pass) was fixed in this work unit by providing `SessionRevert.defaultLayer`
in the fixture's SessionPrompt layer wiring (fixture `:263`). Re-run observed
2026-08-10: `bun test test/kilocode/p0-harness-baseline.test.ts` → **4 pass /
0 fail / 51 expect() calls**, structured H-1..H-13 JSON summary printed. This
is dynamic evidence: the fixture is executable and green. Tracker P0 exit
checklist row 1 ("Runnable baseline fixture/inventory covering H-1..H-13")
remains PARTIAL because H-3..H-6 are still explicit gaps and no target-surface
parity is proven — not because the fixture fails.

| # | Capability | Existing executable entry (harness) | Baseline fixture coverage | Gap |
|---|---|---|---|---|
| H-1 | Custom agents | `packages/opencode/src/agent/agent.ts`; per-session agent selector (`KiloProvider` agent fetch chain `:1682`, `:2335`) | Executed (H-1 in fixture `:516-704`) | Target-surface parity unproven |
| H-2 | Sub-task delegation | `packages/opencode/src/tool/task.ts` (TaskTool) | Executed (H-2 fixture `:839-1042`, real child session + result flow-back) | Target-surface parity unproven |
| H-3 | Extensible tools | `packages/opencode/src/tool/registry.ts` (`ToolRegistry.defaultLayer`; `:224` `Tool.execute` span); existing tests `test/tool/registry.test.ts`, `test/tool/tool-define.test.ts` | Gap entry with references (fixture `:456-463`) | User-defined-tool invocation in a panel session unproven; plugin install path is a network dependency |
| H-4 | Skills | `packages/opencode/src/skill/discovery.ts`, `skill/index.ts`; existing tests `test/skill/skill.test.ts`, `test/kilocode/agent-skill-permissions.test.ts` | Gap entry with references (fixture `:466-478`) | Skill load/run from a panel-hosted session unproven |
| H-5 | MCP | `packages/opencode/src/mcp/index.ts`, `mcp/auth.ts`; existing test `test/kilocode/mcp-oauth-callback.test.ts` | Gap entry with references (fixture `:480-493`) | MCP tools in a panel session unproven; baseline uses empty MCP registry by convention |
| H-6 | Permission/question flows | `packages/opencode/src/permission/index.ts`, `question/`; extension `src/kilo-provider/handlers/permission-handler.ts`, `question.ts`; existing tests `test/permission/next.test.ts`, `test/question/question.test.ts` | Gap entry with references (fixture `:495-509`) | Inline panel permission resolution unproven; baseline keeps the run deterministic |
| H-7 | Parent-child sessions | `packages/opencode/src/kilocode/session/fork.ts`, `fork-command.ts`; `Session.children` | Executed (H-7 fixture `:839-1042`, parentID hierarchy + persistence) | Navigation shows hierarchy (P1); parity unproven |
| H-8 | Background/parallel execution | `packages/opencode/src/kilocode/background-process/`; Agent Manager parallel sessions | Executed (H-8 fixture `:839-1042`, background job wait + parent cleanup) | Without-worktree parallelism unproven on the panel surface |
| H-9 | User-selected custom-provider models | `packages/opencode/src/provider/provider.ts` (custom providers), `kilocode/provider/provider.ts`; per-session model selector | Executed (H-9 fixture `:516-704`, custom provider model) | Selector independence unproven; preset-provider removal not done (LOCK-006) |
| H-10 | Persistence | `packages/opencode/src/storage/`, `session/session.ts` | Executed (H-10 fixture `:516-704`, instance lifecycle boundary reload) | Panel restart resume unproven; ADR-0001 not evidence |
| H-11 | Lifecycle correctness | `packages/opencode/src/session/run-state.ts`, `session/processor.ts`; server session routes | Executed (H-11 fixture `:516-704`, create/prompt-loop/tool-execute/idle/remove) | Panel-driven lifecycle unproven |
| H-12 | Checkpoint rollback | `packages/opencode/src/session/revert.ts` (`SessionRevert.revert` `:40`, `unrevert`), `snapshot/index.ts` | Executed (H-12 fixture `:710-833`, `SessionRevert.defaultLayer` provided at fixture `:263`) | Unrevert/cleanup via panel unproven; distinct from ADR-0001 |
| H-13 | Internal context-overflow safeguard | `packages/opencode/src/kilocode/session/overflow.ts` (`KiloSessionOverflow`), `session/overflow.ts` (`usable`, `isOverflow`); `SessionCompaction` | Executed (H-13 fixture `:1048-1202`, detection/compaction/safety pass) | Invisible safeguard, no product UI unproven on panel surface |

Gap summary: every H-1..H-13 has an existing executable harness entry or an
explicit gap entry with references. No target-surface acceptance criterion is
proven (tracker section 6 statuses remain `Not proven`); the fixture carries
`parity: "unproven"` for every entry.

## 9. Approved Baseline Count Definitions (Q3 Resolved 2026-08-12)

**Resolved 2026-08-12.** The hub approved the exact definitions for tracker
open question 3 ("What exact counts form the P0 complexity baseline: message
types, provider methods, webview entry points"). These definitions are the P0
complexity baseline; later-phase delta comparisons (tracker section 8 "Delta at
P3/P4/P5") must reuse the same definitions and the same reproducible counting
commands (section 11) for before/after comparison.

| Metric | Approved definition | Current value (this artifact) | Counting command (section 11) |
|---|---|---|---|
| Webview message types | Number of distinct `type:` string literals in the `WebviewMessage` union (webview→extension) plus the `ExtensionMessage` union (extension→webview); the union-member sets are disjoint, with each literal counted once (the one file-level shared literal is noted in section 4.1) | 258 (139 + 120 − 1 shared; baseline 2026-08-10: 332 = 189 + 143) | `rg` literal counts over `webview-messages.ts` + `extension-messages.ts` (section 11) |
| Provider methods | Number of public methods on the generated v2 SDK client used by the extension (`@kilocode/sdk/v2/client`) | 250 | `awk` over `sdk.gen.ts` |
| Webview entry points | Number of webview HTML entry points built by `esbuild.js` (excluding the shiki worker asset) | 6 | `esbuild.js` entries |

Alternatives considered and rejected at approval:

- Message types could instead count union members (141 + 132 = 273) instead of
  distinct literals (258) — the baseline arithmetic at the 2026-08-12 approval
  was 199 + 154 = 353 members vs 332 distinct literals; both the rationale and
  the relationship (members > literals) are unchanged. Distinct literals were
  chosen because they count the wire discriminator once.
- Provider methods could count the legacy `src/gen` SDK (78) instead of the
  v2 SDK (250). The v2 SDK is the one actually imported by the extension
  (`connection-service.ts:3`), so it is the faithful protocol surface.
- Webview entry points could count 7 including the shiki worker asset; the
  worker asset is not a webview panel, so 6 was chosen.

Notes and risks: all counts are current-state snapshots and will change as
P3/P4 remove surfaces; the delta-tracking semantics (tracker section 8 "Delta
at P3/P4/P5") must use the same definitions for before/after comparison. The
decision is recorded in the tracker (section 9); this artifact keeps the
approved definitions and the reproducible commands.

## 10. Dynamic Evidence Unknowns

Static analysis cannot resolve these; each requires a runtime probe or
measurement. No claim about any of them is made here.

| # | Unknown | Why static evidence is insufficient | What would resolve it |
|---|---|---|---|
| U-1 | Whether the 4 statically-unused message types are ever dispatched at runtime | Dispatch can be string-built, remote-controlled, or via generic handlers not matched by literal search | Runtime probe: instrument webview `postMessage` senders and extension `onDidReceiveMessage` receivers under representative flows (sidebar, Agent Manager, diff, marketplace) |
| U-2 | Actual per-workspace config source count and merge order | `config.ts` enumerates 15 sources but active sources depend on env, auth records, org membership, and platform (macOS managed prefs) | Runtime log of merged source origins (`instruction_origins`, `skill_path_origins`, config warnings) in a probe workspace |
| U-3 | Which removed-feature services actually initialize at worker startup | The layer graph (`app-runtime.ts:160-177`) declares services; Effect builds lazily per use, so declaration ≠ construction | P0 instrumentation on `KiloListener.build` / `Layer.buildWithMemoMap` construction (runtime spec 10.8) |
| U-4 | Per-stage cold/warm startup durations | Instrumentation points exist (extension `perf/perf-instrument.ts`; CLI `kilocode/perf/instrument`; `cli/cmd/debug/startup.ts`); measurements are now recorded for the measured stages in the six accepted P0 campaigns (tracker section 8 performance rows, evidence links under `specs/vscode-orchestrator/evidence/p0-baseline/`) | Executed — per-stage timings recorded in the tracker (section 8) as descriptive n=5 statistics with evidence links (LOCK-PERF-6); stages without an accepted campaign or an existing extension-owned index (e.g. persisted-selector paint) are later-phase gates (P2/P3/P4.4/P5), not inventory claims |
| U-5 | Cold-save convergence pass counts and durations | `config-convergence.ts` marks `config_commit`/`convergence_complete`; timings are now recorded from the accepted backend campaigns (tracker section 8: `hotPatchMs`, `commitToConvergedMs`, `burstToConvergedMs`, `patchMs`, `heldToReleaseMs`, `releaseToIdleMs`, `convergedToFollowUpMs`, `burstMs`, `convergedToAllModelsMs`; doc: `specs/vscode-orchestrator/evidence/p0-baseline/2026-08-12T06-08-27-792Z/backend.jsonl` and the historical `2026-08-11T04-46-19-926Z/backend.jsonl`) | Executed — instrumented cold saves under backend benchmark scenarios 11/12/13 (runtime spec 10.9), descriptive n=5, not SLA (R7 Open) |
| U-6 | H-1..H-13 fixture green status | Fixture runs production services; the earlier `Service not found: @opencode/SessionRevert` wiring gap (4 fail / 0 pass) was resolved in this work unit by providing `SessionRevert.defaultLayer` in the fixture layer wiring (fixture `:263`) | RESOLVED — re-run 2026-08-10: `bun test test/kilocode/p0-harness-baseline.test.ts` → 4 pass / 0 fail / 51 expect() calls; H-3..H-6 gap capabilities and target-surface parity remain unproven (section 8) |
| U-7 | Which SDK methods the extension actually calls (vs. the 250-member surface) | The extension uses a shared `KiloClient`; call sites are spread across many handler files | Runtime or static call-site census of `client.*` usage across `src/` (see section 4.3 for the known fetch chain) |
| U-8 | Cloud/org provider participation in model fetch for real accounts | Org IDs and well-known remote config depend on live auth records | Probe with a test auth record; do not use real accounts in CI |
| U-9 | Console/KiloClaw test and docs completeness | Static search found no dedicated KiloClaw unit test in `tests/unit/` and no Console docs reference; absence of a search hit is not proof of absence of coverage elsewhere | Targeted search of `packages/kilo-console`/`packages/kilo-jetbrains` test suites and docs tree |
| U-10 | Whether the extension consumes any of the 6 remaining `Kilo` SDK routes (fim, edit, modes, notifications, auth-status) beyond `profile`/`cloudSessions` | Static call-site search found `kilo.profile()` and `kilo.cloudSessions()`; `kilo.fim`/`kilo.edit` are autocomplete-related | Call-site census; note autocomplete removal (LOCK-004) would retire any FIM/edit usage |

## 11. Verification

Commands run against the working tree at commit `6ecc440507` (2026-08-10);
the message-protocol outputs below were re-run against the current working tree
on 2026-08-25 after the P3.1–P3.4 removal commits and the uncommitted
`migration` message-module deletion. The 2026-08-10 baseline outputs were:
webview literals 189, extension literals 143, union members 199/154, 28 + 7
statically-unused. Current values replace them in sections 4.1, 4.4, and 9.
Reproducible counting commands:

```bash
# WebviewMessage / ExtensionMessage distinct type literals
rg -o 'type: "[a-zA-Z0-9_.-]+"' packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts | sort -u | wc -l   # 139
rg -o 'type: "[a-zA-Z0-9_.-]+"' packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts | sort -u | wc -l  # 120

# Union members
sed -n '/^export type WebviewMessage =/,/^export type /p' packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts | grep -c "^\s*|"    # 141
sed -n '/^export type ExtensionMessage =/,/^export type \|^export interface/p' packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts | grep -c "^\s*|"  # 132

# v2 SDK methods (the client the extension imports)
awk '/^class [A-Za-z]+ extends/ {cls=$2} /^  public [a-zA-Z]+</ {count[cls]++} END {total=0; for (c in count) total+=count[c]; print total}' packages/sdk/js/src/v2/gen/sdk.gen.ts   # 250

# SSE GlobalEvent union members
awk '/^export type GlobalEvent =/{f=1;next} f&&/\| Event|\| SyncEvent/{n++} f&&/^}/ {print n; exit}' packages/sdk/js/src/v2/gen/types.gen.ts   # 149

# Webview entry points (esbuild.js lines 209-232): agent-manager, kiloclaw, marketplace, diff-viewer, diff-virtual, main = 6 (+ shiki worker asset)

# Statically-unused message types (excludes type-definition dir)
# webview→extension: literals defined in webview-messages.ts not referenced elsewhere
for t in $(rg -o 'type: "[a-zA-Z0-9_.-]+"' packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts | sed 's/.*type: "//;s/"$//' | sort -u); do
  grep -rq --exclude-dir=messages "\"$t\"" packages/kilo-vscode/src packages/kilo-vscode/webview-ui 2>/dev/null || echo "ONLY-DEFINED: $t"
done   # 3 webview→extension (re-run 2026-08-25)

# extension→webview: literals defined in extension-messages.ts not referenced elsewhere
for t in $(rg -o 'type: "[a-zA-Z0-9_.-]+"' packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts | sed 's/.*type: "//;s/"$//' | sort -u); do
  grep -rq --exclude-dir=messages "\"$t\"" packages/kilo-vscode/src packages/kilo-vscode/webview-ui 2>/dev/null || echo "ONLY-DEFINED: $t"
done   # 1 extension→webview (re-run 2026-08-25)
```

Live checks run:

| Command | Result |
|---|---|
| `bun test test/kilocode/p0-harness-baseline.test.ts` (from `packages/opencode/`, `--timeout 30000`) | PASS — 4 pass / 0 fail / 51 expect() calls; structured H-1..H-13 JSON summary printed; `SessionRevert.defaultLayer` provided at fixture `:263` (re-run 2026-08-10) |
| `bun test tests/unit/p0-perf-instrument.test.ts` (from `packages/kilo-vscode/`) | PASS — 4 pass / 0 fail (22 expect calls) |
| Path validation of every file:line cited in this artifact | PASS — all cited paths exist at the cited lines (spot-verified during collection) |

Not run (out of scope for this artifact): the full P0 performance
instrumentation (requires `KILO_P0_PERF=1` + benchmark scenarios, runtime spec
10.8-10.9), the Extension Host E2E suite, and the JetBrains/Console test
suites.

## 12. Risks And Open Decisions

- **Lock challenges: none.** No LOCK-001..013 or LOCK-PERF-1..7 decision is
  challenged. LOCK-013 is respected: this artifact is migration evidence and
  does not edit canonical architecture docs. LOCK-PERF-6 is respected: no
  performance claim appears anywhere in this file.
- Tracker open question 3 (baseline count definitions) is resolved (2026-08-12):
  the approved definitions are recorded in section 9; the decision is recorded
  in the tracker (section 9).
- Tracker open question 1 (topic meaning), Q4, Q5, and R3/R4/R7 remain open;
  Q3 and R1/R2/R5/R6/R8 are resolved with decisions recorded in the tracker
  (section 9) and the runtime spec (section 9) as applicable. This artifact
  introduces no new decisions and does not modify `migration-tracker.md`.
- The 4 statically-unused message types (section 4.1) and the residual surfaces
  (section 3) are current-state facts. P3 removal phases must treat them as
  cleanup scope, never as retained capabilities (direction spec 1.2, tracker
  section 10 risk row 1).
- The uncommitted P0 instrumentation and baseline fixture in the working tree
  are referenced as current-state facts; if they land or change, the fixture
  status in section 8 and the instrumentation list in section 10 must be
  revisited.

## 13. Change Log

| Date | Change | By |
|---|---|---|
| 2026-08-10 | Initial creation: current-state inventory from static investigation (surfaces, protocols, removals, runtime/config graph, redundancy candidates, H-1..H-13 map, proposed baseline counts, dynamic unknowns); no source changes were part of that inventory unit, no tracker edits, no performance claims | Manifestor execution of P0 inventory task |
| 2026-08-10 | Correction: fixture status updated from "fails all 4 live tests" to current green baseline (4 pass / 0 fail / 51 expect() calls) after the earlier `SessionRevert` layer wiring gap was fixed by providing `SessionRevert.defaultLayer` (fixture `:263`) in this work unit; fixture line count/citations updated to the stable 1253-line state (H-1/H-9/H-10/H-11 `:516-704`, H-12 `:710-833`, H-2/H-7/H-8 `:839-1042`, H-13 `:1048-1202`); U-6 and the section 11 live-check table updated consistently; H-3..H-6 gaps and unproven target-surface parity unchanged; no tracker/code edits, no performance claims | Manifestor correction of P0 inventory fixture status |
| 2026-08-25 | Amendment: clarified provenance split between the 2026-08-10 `6ecc440507` baseline and the 2026-08-25 extension importer/Roo removal; the "Legacy migration / Roo import" surface row and section 3 note now record the post-removal state (extension legacy-migration/Roo trees removed, assertions `p3-4-removal.test.ts:420-444`) while the CLI/TUI migration helper remains retained open work; no other row reclassified, no tracker/spec edits, no performance claims | Manifestor correction of P0 inventory post-removal state |
| 2026-08-25 | Correction: message-protocol counts and line citations refreshed after the P3.1–P3.4 removal commits and the uncommitted `migration` message-module deletion in the working tree. WebviewMessage union: 199 → 141 members, 189 → 139 distinct literals (`webview-messages.ts:963-1104`); ExtensionMessage union: 154 → 132 members, 143 → 120 distinct literals (`extension-messages.ts:992-1124`); combined distinct literals 332 → 258 (139 + 120 − 1 shared `retryProviderCleanup`, section 4.1). Statically-unused types 28 + 7 → 3 + 1 (`agentManager.setDefaultBaseBranch`, `filterMarketplaceItems`, `selectSource`; `agentManager.multiVersionProgress`). Sections 4.1, 4.4, 9, 10 (U-1), 11, and 12 updated consistently; the 2026-08-10 baseline values are preserved as labeled historical baselines in sections 4.1, 9, and 11. No source changes, no tracker/spec edits, no performance claims | Manifestor correction of P0 inventory message counts |
| 2026-08-27 | Correction (audit): updated stale references at/near lines 22, 119, 127-130 that said `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts` remains; the file is now physically deleted in the P4.4 residual package (zero active callers since T27; `Flag.KILO_TUI_CONFIG` also deleted; canonical loader `resolveWorktree`/`canonicalRoot` + `ConfigPaths.fileInDirectory(root, "tui")` + `path.join(root, ".kilo")` only preserved). Amendment header, surface row, and section 3 note now distinguish historical retention (2026-08-25) from current deletion (2026-08-27) and identify remaining broader residue (`theme.tsx:564` `[".kilocode", ".kilo"]`, `ConfigPaths.files`/`fileInDirectory` retained per LOCK-003, not active TUI source). No code/tests/other docs/source-links/tracker/changeset modified; no P4.4/row completion claimed; P4.4 remains Active/residual per LOCK-001; documentation-only per LOCK-002 | Manifestor correction of P0 inventory tui-migrate audit |
