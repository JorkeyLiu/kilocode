---
title: "VS Code Extension Architecture"
description: "Architecture of the Kilo VS Code extension and Agent Manager"
---

# VS Code Extension Architecture

The VS Code extension (`packages/kilo-vscode/`) is a client of [Kilo CLI runtime](/docs/contributing/architecture/cli-runtime). It bundles platform CLI binary, starts one shared editor-owned `kilo serve` server on demand, and drives that server through generated SDK HTTP calls plus global SSE.

{% callout type="info" title="Scope" %}
This page covers extension-host ownership, webview routing, Agent Manager, local terminal paths, recovery, bundled resources, and build outputs. It is not full extension feature inventory.
{% /callout %}

## Shared server ownership

[CLI Runtime](/docs/contributing/architecture/cli-runtime) defines shared local-server authentication, directory routing, provider routing, persistence, and SSE contracts. This page starts at VS Code client boundary.

Activation creates one `KiloConnectionService`. It owns one `ServerManager`, one active SDK client, and one SSE adapter. `ServerManager` owns child process lifecycle. This editor-owned child is separate from detached local daemon managed by `kilo daemon`.

```mermaid
flowchart LR
  subgraph host ["VS Code extension host"]
    consumers["Tabs, panels, services"]
    service["KiloConnectionService"]
    manager["ServerManager"]
    sdk["Generated SDK client"]
    sse["SdkSSEAdapter"]
  end

  server["bin/kilo serve --port 0"]
  runtime["Kilo CLI runtime"]

  consumers --> service
  service --> manager --> server
  service --> sdk --> server
  service --> sse -->|/global/event| server
  server --> runtime
```

| Area | Behavior |
|---|---|
| Startup | Lazy on client demand; autocomplete prewarm can start server during activation |
| Binary | Uses extension `bin/kilo`, or `bin/kilo.exe` on Windows |
| Port | Starts `kilo serve --port 0`; CLI server prefers `4096`, then asks OS for free port |
| Authentication | Generates random 32-byte hex password per spawn and passes it as `KILO_SERVER_PASSWORD`; username defaults to `kilo` |
| Reuse | Editor tabs, panels, Agent Manager, and host services share active server |
| Exit | `ServerManager` clears dead child; connection service clears SDK/SSE state and enters error state |
| Replacement | Later retry or connection attempt starts replacement server |

## Chat surfaces (P3.1 sidebar removal)

The ordinary single-chat **Activity Bar sidebar** (`kilo-code.SidebarProvider` webview view under the `kilo-code-ActivityBar` views container) is **permanently removed**. It is not deferred, gated, or re-registered: no `viewsContainers`/`views` contribution, no `registerWebviewViewProvider`, no `kilo-code.new.sidebarVisible` context, and no `sidebarTitle.*` commands or view-title menus remain. The one-time deprecation step shipped as the P1/P2 migration surface plus the release note; there is no temporary feature flag and no retained old surface.

Chat now opens through the preserved editor surfaces:

| Surface | How it opens |
|---|---|
| Agent Manager | `Cmd/Ctrl+Shift+M` (`kilo-code.new.agentManagerOpen`) — multi-session orchestration panel |
| Open in Tab | `kilo-code.new.openInTab` / the editor-title "Open in Tab" button — a `kilo-code.new.TabPanel` webview with the shared chat UI |

Commands that previously fell back to the sidebar chat now resolve a chat target at runtime: the active editor-tab `KiloProvider` when one is focused, otherwise the Agent Manager panel (opened on demand). The decision rules live in the vscode-free `services/code-actions/chat-target.ts` helper. Delivery is readiness-gated: toolbar/code/terminal/review-comment posts wait for the chosen surface's webview to report ready and are skipped when it never does, and the cloud-session deep link waits for a newly created/restored tab's readiness (bounded) before posting `openCloudSession`, surfacing a warning instead of silently dropping the message. Deep links (cloud session / linked model selection) open or reuse an editor tab. The auto-approve directory source and shared commands that target the focused session resolve from active tabs and the Agent Manager instead of a sidebar provider. No surrogate hidden sidebar provider or duplicate state owner is created.

**Rollback path.** This removal is a breaking product change, not a flag-gated migration. The only supported rollback is reverting the P3.1 removal commit(s) in git (the removed manifest contributions, `registerWebviewViewProvider`, `KiloProvider.viewType`/`resolveWebviewView`/`setSidebarVisible`, and the `sidebarTitle.*` wrapper commands are all preserved in git history); no runtime shim or compatibility surface is retained. After a revert, verify the `sidebar-removal` E2E scenario and the manifest-level absence contract (`tests/unit/sidebar-removal.test.ts`) fail, confirming the surface is actually restored.

## Shared consumers

Shared service has more consumers than chat tabs:

| Family | Consumers |
|---|---|
| Chat | Editor-tab providers and the Agent Manager's embedded chat |
| Panels | Settings, profile and marketplace surfaces, sub-agent viewers, Agent Manager, KiloClaw |
| Diffs | Inline permission diffs in chat, RevertBanner session revert, and local git-change summaries |
| Editor assistance | Autocomplete and commit-message generation |
| Integrations | Browser automation MCP registration and KiloClaw bootstrap |

New mutable state must account for concurrent consumers and multiple directory contexts on one process.

## Webview bridge

Main chat webviews use host-mediated message bridge:

```text
webview vscode.postMessage()
  -> KiloProvider host handler
  -> generated SDK HTTP request
  -> CLI runtime
  -> /global/event SSE
  -> SdkSSEAdapter
  -> KiloConnectionService subscribers
  -> KiloProvider directory/session filtering and stream coalescing
  -> webview postMessage()
```

Global SSE carries wrapped events for multiple directories. Connection service broadcasts incoming payload plus directory to subscribers. Providers resolve session scope, maintain message-to-session lookup where events omit direct session ID, filter for relevant views, and coalesce high-frequency stream updates before posting UI messages.

## Agent Manager

Agent Manager is an extension feature, not a separate product. It opens as an editor tab and runs multiple independent AI sessions in parallel at the workspace root. With the P3.1 sidebar removal, Agent Manager is the primary chat entry point (alongside "Open in Tab" editor panels). There is no per-session worktree isolation, no setup/run scripts, and no branch/PR import; all sessions share the workspace directory.

| Aspect | Agent Manager |
|---|---|
| Primary use | Multi-session orchestration (single-chat surfaces live in editor tabs / the Agent Manager) |
| Working directory | Workspace root — all sessions share it, no isolation |
| Backend | Shared `kilo serve` process |
| Request routing | Workspace root passed as SDK `directory` |
| CLI instance key | Normalized workspace directory |

Agent Manager request path is:

```text
workspace root -> SDK directory -> CLI directory-routing middleware -> InstanceStore directory key
```

Agent Manager persists presentation state (open tabs, active tab, sidebar) through the VS Code webview state API, versioned in `webview-ui/agent-manager/local-ui-state.ts`. There is no `.kilo/agent-manager.json` state file and no `.kilo/worktrees/` directory; the removed worktree manager wrote both. Startup migration handles legacy webview state keys only.

### Durable session runtime timer

The right-bottom working indicator in Agent Manager shows a session's cumulative active-generation runtime. The extension host owns the timing state and the webview only renders extension snapshots.

| Aspect | Behavior |
|---|---|
| Owner | Extension host (`src/agent-manager/session-timing.ts`), a vscode-free module driven by `session.status` SSE events |
| Durable storage | VS Code `workspaceState` via the Host `Store` contract (`VscodeHost.workspaceStore`) — a versioned key |
| Counting | Only non-idle statuses count (busy, retry, offline). Idle settles the segment; duplicate events are idempotent |
| Persistence | Writes on status boundaries only, never per display tick |
| Shutdown | `AgentManagerProvider.disposeAsync()` settles active segments and awaits the durable write, so normal shutdown does not count later downtime |
| Pruning | Explicit forget in Agent Manager and backend `session.deleted` prune the session's timing entry; tab close is view lifecycle and retains it |
| Webview bridge | Snapshots ride `agentManager.state` pushes and land in the shared `SessionContext` (`timingFor`/`setTimingSnapshots`). The shared `WorkingIndicator` prefers a snapshot when present (cumulative + running segment) and falls back to the legacy `busySince` timestamp otherwise, keeping editor-tab behavior unchanged |

An abnormal crash can leave a stale active-segment marker persisted; the backend supplies no segment start timestamp, so the marker is preserved conservatively and the segment keeps counting until the next status event settles it.

## State boundaries

Directory-keyed CLI state is isolated by the workspace directory path. Process-owned state remains shared because all Agent Manager sessions use one CLI process and share the workspace directory. Snapshot implementation state is directory-keyed, but slow-snapshot prompt guard belongs to shared `Snapshot.Service` scope. Managed Agent Manager prompts pass `snapshotInitialization: "wait"` so slow baseline setup waits without interrupting concurrently started sessions.

## Shared model state (model.json)

Per-mode model selections and thinking-strength usage memory are shared between the CLI TUI and the VS Code extension through `~/.local/state/kilo/model.json` (the state directory reported by the CLI path endpoint). The extension is one writer among others (the CLI TUI writes the same file in-process); both run against the same state directory.

| Concern | Contract |
|---|---|
| Canonical ownership | `model.json` is the canonical shared boundary for per-mode model choices and for thinking-strength usage memory. VS Code `globalState` `variantSelections` entries are migration input or a synchronized compatibility cache only — never a higher-priority independent source. Ephemeral `session/` keys are local webview state: never canonical file entries and never rehydrated cache data |
| Migration | One-way, non-destructive: legacy cache entries fill only gaps in the canonical file; existing canonical entries always win; nothing is cleared from the cache by migration. Migration and cache sync run inside the extension's serialized model-state critical section and prune `session/` keys so they cannot accumulate in `globalState` |
| Serialization | All model.json read-modify-write operations in the extension process (`persistModelSelection`, `clearModelSelection`, `persistVariant`, `requestVariants`, `reset`) run as one module-level queued critical section, so in-process lost updates are impossible: concurrent messages cannot overwrite each other's keys from stale snapshots |
| Atomicity | Every file write is atomic (same-directory temp file + rename) so readers never observe partial JSON. Only ENOENT (missing file) means a fresh document; any other read error (EACCES/EMFILE/EISDIR...) or malformed/partial content is reported and never silently treated as an empty document that a read-modify-write would destructively replace. Non-ENOENT and malformed reads are logged visibly at the extension boundary |
| Reset | `reset` is self-contained and durable: when the canonical file reads successfully (a missing file is a fresh document) it clears the model/variant maps and the migration cache in one critical section; an unreadable or malformed canonical file is preserved untouched (the read is logged) while the live store and migration cache are still cleared. Its `variantsLoaded {}` post uses replace semantics in the webview so persistent memory is cleared from the live store without a reload (session-scoped picks stay) — a later `requestVariants` cannot resurrect reset values |
| Residual risk | Cross-process key-level last-writer-wins remains: the CLI TUI and the extension can edit the same keys concurrently and the last atomic rename wins for the whole document. This is a documented residual, not an in-process data loss |

The CLI-side reader (`KiloTask.savedModel` in `packages/opencode/src/kilocode/tool/task.ts`) resolves the delegated agent's final model first and then applies usage-memory variant for that exact agent+model (agent+model key, then model-only legacy key), so a legacy model-only variant still drives delegated thinking strength even when the agent has no saved model entry.

## Terminal surfaces

VS Code extension has two terminal paths:

| Surface | Owner | Use |
|---|---|---|
| VS Code integrated terminal | VS Code host | Generic shell terminals surfaced through the editor |
| CLI PTY WebSocket tab | Agent Manager and `kilo serve` server | Server-created PTY session streamed over loopback WebSocket |

Agent Manager PTY WebSocket URL uses `auth_token=<base64 kilo:password>` query mode because browser WebSocket API cannot attach Basic header. Webview CSP permits loopback HTTP and WebSocket origins for active server port. CLI also exposes scope-bound short-lived PTY ticket API as alternate browser WebSocket auth mode.

## Config split

| Config owner | Examples |
|---|---|
| VS Code settings | `kilo-code.new.*` extension UI, proxy, autocomplete, and integration settings |
| CLI config | Global and project `kilo.jsonc`, `kilo.json`, compatible OpenCode files, provider auth, tools, permissions, modes |

Extension-specific behavior belongs in VS Code settings. Agent runtime behavior belongs in CLI config so TUI, Console, VS Code, and JetBrains can share it.

## Bundled resources

| Resource | Behavior |
|---|---|
| CLI executable | Platform binary under extension `bin/`; Windows uses `kilo.exe` |
| CLI Tree-sitter WASM | Copied under `bin/tree-sitter`; backend spawn sets `KILO_TREE_SITTER_WASM_DIR` |
| FFmpeg helper | Bundled for supported targets for speech capture; capture code also checks system fallback paths |
| Empty-window cwd | Uses extension global storage directory when no VS Code workspace folder exists |
| Empty-window indexing | Sets `KILO_DISABLE_CODEBASE_INDEXING=vscode-no-workspace` so CLI reports indexing disabled |

Speech-to-text captures audio locally, then sends completed recording through shared editor-owned `kilo serve` server to authenticated Kilo Gateway transcription path. It is batch transcription, not direct provider streaming.

## Recovery

| Failure signal | Response |
|---|---|
| Missing SSE events for 15 seconds | SSE adapter aborts attempt and reconnects |
| SSE reconnect | Starts at 250 ms delay and backs off to 5 seconds until stream opens |
| Health poll | Every 10 seconds, checks `/global/health` with 3 second timeout; failure forces SSE reconnect |
| Server exit | Clears connection state, reports error, and lets later retry or connection attempt spawn replacement |
| Extension disposal | Stops polls, disposes SSE, and sends server process group termination with kill fallback |

## Builds

| Build | Source | Output |
|---|---|---|
| Extension host | `src/extension.ts` | `dist/extension.js` |
| Editor chat webview (Open in Tab) | `webview-ui/src/index.tsx` | `dist/webview.js` |
| Agent Manager webview | `webview-ui/agent-manager/index.tsx` | `dist/agent-manager.js` |
| KiloClaw webview | `webview-ui/kiloclaw/index.tsx` | `dist/kiloclaw.js` |
| Shared Shiki worker | synthetic worker entry | `dist/shiki-worker.js` |

Extension host bundle targets Node/CommonJS. Browser webviews and shared worker use esbuild browser bundles. Run `bun run typecheck`, `bun run lint`, and targeted unit tests from `packages/kilo-vscode/` after changing this area. `typecheck` and `lint` also cover the E2E sources without launching VS Code.

## Extension Host E2E testing

`packages/kilo-vscode/` owns a real Extension Host E2E harness (`bun run test:e2e`, entry `script/e2e-probe.ts`). It is explicit/manual only: no automatic trigger or package hook invokes it, and normal dev/build/run paths have zero effect from it. The sole automation is the manual-dispatch-only `vscode-e2e` workflow (below).

| Concern | Behavior |
|---|---|
| Real host | `@vscode/test-electron` spawns a real VS Code workbench loading the current workspace extension; the runner (`tests/e2e/runner.ts`) activates the extension and drives a deterministic offline scenario through production message shapes and the production `SessionInfo` type |
| CDP control | The harness connects Playwright to the workbench over a uniquely owned loopback CDP port (`--remote-debugging-port`) and asserts real webview DOM: tab order, then clicks the production sub-agent open button |
| Fixture bridge | `kilo-code.new.e2eFixture.*` commands are registered in `src/extension.ts` only when `KILO_E2E_FIXTURE` is set; they expose panel readiness, typed webview posting, deterministic session-list settlement, a read-only served-backend snapshot (`backendSnapshot`), MCP disconnect, transport/process probes over the single shared connection service (`sseReconnect`, `killServer`, `reconnectServer`), and a fail-closed generation-request collector (`llmRequests` / `llmRequestsReset`) that records every backend `service=llm` line through the ServerManager stderr relay into a run-owned append-only store. Zero production effect when the env var is absent — no commands registered and no webview code runs |
| Real scenarios | Four focused-only scenarios drive REAL backend sessions through the production webview path and assert served-backend truth through the snapshot bridge: `real-session` (create/prompt/reopen), `real-completed` (completed turns, MCP disconnect, H-12 rollback), `real-overflow` (H-13 internal context-overflow compaction), and `real-restart` (SSE reconnect, exact-owned worker restart, true window reload re-entry). Each seeds `small_model`/`subagent_model` to the run-owned provider and asserts at the request level that every generation (agent turns, titles, summaries, subagents) used `e2e-local/e2e-model` — any `kilo/kilo-auto/*` line fails the scenario |
| P3.1 removal | `sidebar-removal` (focused-only) runs assertions in the Extension Host runner: the loaded manifest contributes no Activity Bar sidebar surface under the forbidden ids/prefixes (`kilo-code-ActivityBar`, `kilo-code.SidebarProvider`, `sidebarTitle.*`) — identifier-based, so unrelated future views are not banned — and the production "Open in Tab" editor panel opens and reaches webview readiness through the env-gated `openInTabReady` fixture bridge, with the Agent Manager still ready afterwards. No CDP DOM driving |
| Session-load serialization | `KiloProvider` serializes session-list loads (full refreshes, load-more, deferred flushes) so the bridge's awaited refresh is the last applied, making fixture survival deterministic without timers |
| Process lifecycle | All owned processes are terminated by exact PID matched to the unique user-data dir, the CDP port is verified released, then the scratch dir is deleted — on success and failure paths |
| Binary resolution | `VSCODE_TEST_EXECUTABLE` (must exist) → cached `.vscode-test/` → `@vscode/test-electron` auto-download into `.vscode-test/`; clean checkouts need no preinstalled binary |
| Platforms | macOS and Linux. Windows fails fast because exact-owned termination relies on `ps` PID+args inspection |

This harness spans a real Extension Host, Electron/CDP, and fixture lifecycle boundary and is owned by the extension package.

### Linux E2E workflow (manual dispatch only)

`vscode-e2e` (`.github/workflows/vscode-e2e.yml`) runs the same `bun run test:e2e` entrypoint on Linux under Xvfb, dispatched explicitly from the Actions UI. It is the only automation that invokes the harness, and it is never automatic.

| Guard | Behavior |
|---|---|
| Trigger | `workflow_dispatch` only — no `push`, `pull_request`, `schedule`, `workflow_call`, hook, or package-script aggregation |
| Immutable-ref checkout | The requested same-repository branch is validated before checkout and resolved with `git ls-remote` to one 40-hex commit SHA; `actions/checkout@v6` checks out exactly that SHA with `persist-credentials: false` and `fetch-depth: 1` |
| Permissions | Job scope is `contents: read` only; no repository secrets are used; nothing in the target branch can write, push, or act with credentials |
| Display | `xvfb-run -a bun run test:e2e` — the unmodified package entrypoint; no harness logic is duplicated in YAML |
| Xvfb | Verified or installed explicitly (`apt-get install -y xvfb`) before the run |
| Cache scope | Only `packages/kilo-vscode/.vscode-test` (the VS Code download) is cached, keyed Linux/x64 by the resolved target SHA and the extension package manifest; scratch, user-data, workspace, and profile are never cached, and an executable cache from a different target commit is never restored |
| Clean checkout | Each run starts from a fresh checkout of the immutable SHA, runs `bun install`, and builds the bundled CLI (`bun script/local-bin.ts`) with `KILO_SKIP_BUNDLED_BWRAP=1` scoped to that one step: the Linux runner installs no Zig, the E2E fixture coverage never invokes sandbox tooling, and production `ServerManager` tolerates a missing local bwrap, so the CLI runs without a bundled bwrap; release/package validation (`bun run package:vsix`) remains the separate path that stages bundled sandbox resources. The probe then builds the extension/webview bundles and auto-downloads VS Code — proving the harness works from scratch |
| Failure diagnostics | Complete E2E stdout/stderr is captured via `set -o pipefail` + `tee` into a runner-owned diagnostics directory and uploaded on failure or cancellation (`if: failure() || cancelled()`) with 7-day bounded retention; GitHub hard job cancellation can still prevent later steps. Harness scratch and exact-PID cleanup are untouched |
| Resource lifecycle | Workflow timeout is bounded above the harness watchdog (`KILO_E2E_TIMEOUT`); no broad process killing or global cleanup — the harness's exact-owned termination and CDP-port verification are the only process controls |

E2E remains never-automatic: the workflow is a read-only, explicit, manual act, and macOS runs stay local-only.

## Source map

Paths below are relative to [`Kilo-Org/kilocode`](https://github.com/Kilo-Org/kilocode).

| Concern | Source path |
|---|---|
| Activation | `packages/kilo-vscode/src/extension.ts` |
| Editor-owned server child process | `packages/kilo-vscode/src/services/cli-backend/server-manager.ts` |
| Shared SDK and SSE ownership | `packages/kilo-vscode/src/services/cli-backend/connection-service.ts` |
| SSE reconnect adapter | `packages/kilo-vscode/src/services/cli-backend/sdk-sse-adapter.ts` |
| Agent Manager | `packages/kilo-vscode/src/agent-manager/` |
| Env-gated E2E fixture bridge | `packages/kilo-vscode/src/extension.ts` (registration), `packages/kilo-vscode/src/agent-manager/AgentManagerProvider.ts` (settlement), `packages/kilo-vscode/src/agent-manager/fixture-backend.ts` (snapshot normalization), `packages/kilo-vscode/src/services/cli-backend/connection-service.ts` (transport/process probes), `packages/kilo-vscode/src/services/cli-backend/llm-request-collector.ts` (generation-request store) |
| E2E harness | `packages/kilo-vscode/script/e2e-probe.ts` (probe), `packages/kilo-vscode/script/e2e-probe-restart.ts` (restart phases), `packages/kilo-vscode/tests/e2e/runner.ts` (Extension Host runner) |
| Build entries | `packages/kilo-vscode/esbuild.js` |

## Related pages

- [Architecture Overview](/docs/contributing/architecture) - local and hosted execution map
- [CLI Runtime](/docs/contributing/architecture/cli-runtime) - shared local-server, routing, persistence, and SSE behavior
- [JetBrains Plugin](/docs/contributing/architecture/jetbrains-plugin) - corresponding editor-client architecture for JetBrains
- [Development Patterns](/docs/contributing/architecture/development-patterns) - choose code-ownership seam and validation workflow before editing extension contracts
