# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Product Context

Kilo Code is an open source AI coding agent platform. It ships as a CLI and editor clients that all build on the same backend. This package (`packages/kilo-vscode/`) is the **VS Code extension**.

### Products and How They Relate

All products are thin clients over the **CLI** (`packages/opencode/`, published as `@kilocode/cli`). The CLI originated as a fork of [OpenCode](https://github.com/anomalyco/opencode) and is now independently governed, with Kilo-specific additions (gateway auth, telemetry, migration, code review, branding). It contains the full AI agent runtime, tool execution, session management, provider integrations (500+ models), and an HTTP API server.

Every client spawns or connects to a `kilo serve` process and communicates via HTTP REST + SSE using the auto-generated `@kilocode/sdk`.

```
                        @kilocode/cli  (packages/opencode/)
                     ┌────────────────────────────────┐
                     │  AI agents, tools, sessions,    │
                     │  providers, config, MCP, LSP    │
                     │  Hono HTTP server + SSE         │
                     └──┬──────────┬──────────────────┘
                        │          │
                ┌───────┴──┐ ┌────┴────┐
                │ TUI      │ │ VS Code │
                │ (builtin)│ │Extension│
                └──────────┘ └─────────┘
```

| Product | Package | What it is | How it uses the CLI |
|---|---|---|---|
| Kilo CLI (TUI) | `packages/opencode/` | Interactive terminal UI (SolidJS + OpenTUI) | In-process — TUI and server run together |
| Kilo CLI (`kilo run`) | `packages/opencode/` | Non-interactive headless mode for scripting | In-process — no network socket |
| **Kilo VS Code Extension** | **`packages/kilo-vscode/`** | VS Code extension with Agent Manager and editor-tab chat | Bundles CLI binary, spawns `kilo serve --port 0` as child process |

### Kilo-Domain Packages

| Package | Name | Role |
|---|---|---|
| `packages/kilo-vscode/` | `kilo-code` | **This package.** VS Code extension. |
| `packages/kilo-gateway/` | `@kilocode/kilo-gateway` | Auth (device flow), AI provider routing (OpenRouter), Kilo API integration (profile, balance, teams) |
| `packages/kilo-ui/` | `@kilocode/kilo-ui` | SolidJS component library (40+ components, built on `@kobalte/core`). Shared by this extension's webview and docs screenshot stories |
| `packages/kilo-telemetry/` | `@kilocode/kilo-telemetry` | PostHog analytics + OpenTelemetry tracing for the CLI |
| `packages/kilo-i18n/` | `@kilocode/kilo-i18n` | Translation strings (16 languages) |
| `packages/kilo-docs/` | `@kilocode/kilo-docs` | Documentation site (Next.js + Markdoc) |

### Inherited Core Packages (not Kilo-specific)

| Package | Name | Role |
|---|---|---|
| `packages/opencode/` | `@kilocode/cli` | Core CLI — originated from OpenCode. AI agents, tools, sessions, server. |
| `packages/sdk/js/` | `@kilocode/sdk` | Auto-generated TypeScript SDK client for the server API. Do not edit `src/gen/` by hand. |
| `packages/ui/` | `@opencode-ai/ui` | Shared UI primitives |
| `packages/util/` | `@opencode-ai/util` | Shared utilities (error, path, retry, slug) |
| `packages/plugin/` | `@kilocode/plugin` | Plugin/tool interface definitions |

## Commands

```bash
bun run extension        # Build + launch VS Code with the extension in dev mode
bun run compile          # Type-check + lint + build
bun run watch            # Watch mode (esbuild + tsc)
bun run test             # Run tests (requires pretest compilation)
bun run lint             # ESLint on src/
bun run format           # Run formatter (do this before committing to avoid styling-only changes in commits)
```

The `extension` commands also work from the repo root. Pass `--insiders` to prefer VS Code Insiders, `--workspace PATH` to open a different folder, `--clean` to wipe cached state, or `--wait` to block until VS Code closes. VS Code is auto-detected on macOS, Linux, and Windows; override with `--app-path` or `VSCODE_EXEC_PATH`.

Single test: `bun run test -- --grep "test name"`

## E2E Testing (real VS Code)

`bun run test:e2e` runs the real Extension Host E2E probe (`script/e2e-probe.ts`, Node-only — Playwright's CDP transport hangs under Bun). It is explicit/manual only: no preinstall/postinstall/git hook, no other package script invokes it, and no push/PR/schedule trigger runs it. The only automation is the manual-dispatch-only `vscode-e2e` workflow (`.github/workflows/vscode-e2e.yml`), which runs the identical `bun run test:e2e` entrypoint on Linux under Xvfb from a clean immutable-SHA checkout; macOS runs stay local-only. The canonical operational standard and the test-layer matrix live in the root `TESTING.md`.

Mandatory rules:

- Never wire `test:e2e` (or any E2E resource download/launch) into another script, a hook, or an automatic workflow trigger. `bun install`, `bun run extension`, dev, commit, push, `bun run typecheck`, `bun run lint`, and `bun run test:unit` must not launch or download E2E resources. The only sanctioned automation is the manual-dispatch-only `vscode-e2e` workflow, which invokes the unmodified `bun run test:e2e` entrypoint.
- The fixture bridge (`kilo-code.new.e2eFixture.*` commands, `KILO_E2E_*` env behavior) is gated behind `KILO_E2E_FIXTURE` and is test-only. No production path may depend on it, and the commands must stay unregistered when the env var is absent.
- Runtime evidence is required when a change affects the child-tab open path, tab-order sync, Agent Manager webview rendering, the fixture bridge, or the E2E harness itself: run `bun run test:e2e` and report the outcome. Static checks alone are incomplete for UI-affecting behavior the harness covers.
- VS Code binary resolution: `VSCODE_TEST_EXECUTABLE` (must exist) → cached `.vscode-test/` → automatic download by `@vscode/test-electron` into `.vscode-test/`. A clean checkout works without a binary; do not require one.
- Process ownership: the harness terminates only exact PIDs owning its unique user-data dir, verifies the CDP port is released, then deletes its scratch. Do not add global `pkill`/name-based cleanup.
- Platforms: macOS and Linux. Windows fails fast by design; do not "fix" the fail-fast without implementing taskkill-by-PID cleanup first.
- Keep `bun run typecheck` and `bun run lint` covering E2E sources (`tests/e2e/`, `script/e2e-probe.ts`); these static checks must never launch VS Code.

## CLI Binary

The extension bundles its own CLI binary at `bin/kilo` — it does NOT use a system-installed CLI. To build it:

```bash
bun script/local-bin.ts
```

Or use `--force` to rebuild:

```bash
bun script/local-bin.ts --force
```

The script checks for a prebuilt binary in `packages/opencode/dist/`, builds the CLI if needed, and copies it to `bin/kilo`.

### Packaging a Distributable VSIX

To produce a distributable VSIX (from `packages/kilo-vscode/`):

```bash
bun run package:vsix -- --target <target>
```

`<target>` must equal the current Bun platform/arch (e.g. `darwin-arm64` on Apple Silicon) — the command builds a native CLI for the machine it runs on. The VSIX is written to `out/kilo-vscode-<target>.vsix` (e.g. `out/kilo-vscode-darwin-arm64.vsix`). Unlike `bun script/local-bin.ts` above — a dev-staging helper that can fall back to a source wrapper for local development — `package:vsix` is the supported path for distributable VSIX artifacts.

## Architecture

### Extension ↔ CLI Backend

The extension is a client of the CLI. Activation creates one shared `KiloConnectionService`; on its first connection, which autocomplete may prewarm, `ServerManager` spawns `bin/kilo serve --port 0`, captures the dynamically assigned port from stdout, and communicates over HTTP + SSE. The current child process is reused unless it exits. A random password is generated and passed via `KILO_SERVER_PASSWORD` env var for basic auth.

```
Extension (Node.js)                          CLI Backend (child process)
┌──────────────────────────┐                ┌──────────────────────┐
│ KiloConnectionService    │── HTTP/SSE ──> │ kilo serve --port 0  │
│   ├── ServerManager      │                │   Hono REST API      │
│   ├── HttpClient         │                │   SSE event stream   │
│   └── SSEClient          │                │   Session management │
│                          │                │   AI agent runtime   │
│ KiloProvider (agent mgr) │                └──────────────────────┘
│ KiloProvider (open tabs) │
└──────────────────────────┘
```

- **`KiloConnectionService`** (`src/services/cli-backend/connection-service.ts`) is created once during extension activation and shared across Kilo editor tabs and Agent Manager. It owns the current server process, HTTP client, and SSE connection.
- **`ServerManager`** (`src/services/cli-backend/server-manager.ts`) lazily spawns the CLI binary, reuses its current process, and can start a replacement if that process exits.
- Every **Open in Tab** Kilo panel and the Agent Manager chat provider reuse this connection. Multiple **`KiloProvider`** instances subscribe to it, with SSE events filtered per-webview via a `trackedSessionIds` Set. Agent Manager terminals may use additional PTY/WebSocket channels to the same backend, not separate `kilo serve` processes.
- Backend state follows where it is allocated, not the panel shown in an editor tab. Snapshot repository state uses directory-keyed `InstanceState`, while `trackState` is created once in the active Snapshot service closure. For these shared VS Code session paths, its slow-track `asked` guard spans the root-local requests; choosing **Continue with snapshots** resets `asked` only when continued tracking returns a snapshot hash.

### Builds

Two separate esbuild builds in [`esbuild.js`](esbuild.js):

- **Extension** (Node/CJS): `src/extension.ts` → `dist/extension.js`
- **Webview** (browser/IIFE): `webview-ui/src/index.tsx` → `dist/webview.js` AND `webview-ui/agent-manager/index.tsx` → `dist/agent-manager.js`

### Non-Obvious Details

- Webview uses **Solid.js** (not React) — JSX compiles via `esbuild-plugin-solid`
- Extension code in `src/`, webview code in `webview-ui/src/` with separate tsconfig
- Tests compile to `out/` via `compile-tests`, not `dist/`
- CSP requires nonce for scripts and `font-src` for bundled fonts — see [`KiloProvider.ts`](src/KiloProvider.ts:777)
- HTML root has `data-theme="kilo-vscode"` to activate kilo-ui's VS Code theme bridge
- Extension and webview have no shared state — communicate via `vscode.Webview.postMessage()`
- For editor panels, use [`AgentManagerProvider`](src/agent-manager/AgentManagerProvider.ts) pattern with `retainContextWhenHidden: true`
- esbuild webview build includes [`cssPackageResolvePlugin`](esbuild.js:29) for CSS `@import` resolution and font loaders (`.woff`, `.woff2`, `.ttf`)
- Avoid `setTimeout` for sequencing VS Code operations — use deterministic event-based waits (e.g. `waitForWebviewPanelToBeActive()`)

## Extension ↔ Webview Feature Pattern

When adding a new feature that requires data from the CLI backend to be displayed in the webview:

1. **Types** (`src/services/cli-backend/types.ts`): Add response types for the backend data
2. **HTTP Client** (`src/services/cli-backend/http-client.ts`): Add a fetch method to retrieve the data
3. **KiloProvider** (`src/KiloProvider.ts`): Add a `fetchAndSend*()` method using the cached message pattern, and handle the corresponding `request*` message from the webview in `handleWebviewMessage()`
4. **Message Types** (`webview-ui/src/types/messages.ts`): Add `*LoadedMessage` (extension→webview) and `Request*Message` (webview→extension) types to the `ExtensionMessage` / `WebviewMessage` unions
5. **Context** (`webview-ui/src/context/`): Subscribe to the loaded message **outside** `onMount` (to catch early pushes before mount), add retry logic for the request message, expose state via context
6. **Component** (`webview-ui/src/components/`): Consume context, render UI

Key patterns:

- **Cached messages** (e.g. `cachedProvidersMessage`, `cachedAgentsMessage` in KiloProvider): Ensures webview refreshes get data immediately without waiting for a new HTTP round-trip
- **Retry timers** (e.g. `agentRetryTimer` in session context): Handles race conditions where the extension's HTTP client isn't ready when the webview first requests data

## Agent Manager

The Agent Manager is a feature within this extension (not a separate product). It opens as an **editor tab** (`Cmd+Shift+M`) and provides multi-session orchestration — running multiple independent AI sessions in parallel at the workspace root. Since the P3.1 sidebar removal, it is the primary chat entry point together with "Open in Tab" editor panels.

### How It Compares to Open-in-Tab Editor Panels

| Aspect | Open in Tab panel | Agent Manager |
|---|---|---|
| Location | Editor tab | Editor tab (full panel) |
| Sessions | Single session at a time | Multiple parallel sessions with tabbed UI |
| Working directory | Uses workspace root | Uses workspace root — sessions share it, no isolation |
| State | No dedicated state file | Webview-local UI state (VS Code webview state API) |
| Terminals | None | Dedicated VS Code terminal per session |
| Setup scripts | None | None |
| Multi-version | Not supported | Not supported — all sessions are independent tasks |

### Architecture

Agent Manager root-local sessions use the current shared `kilo serve` process owned by `KiloConnectionService`; no session starts its own backend. Their CLI requests pass the workspace root as `directory`, which resolves directory-scoped backend state. Terminal PTYs, git subprocesses, and the extension host are separate process or extension-host boundaries, not per-session `kilo serve` instances. Because every session runs in the same workspace directory, concurrent sessions can conflict on file edits; sessions targeting distinct areas of work are the safe pattern.

Extension-side code lives in `src/agent-manager/`, webview code in `webview-ui/agent-manager/`. The webview reuses the shared chat provider chain and `ChatView` component with a root-local tab layout; there is no worktree-mode context provider.

## Webview UI (kilo-ui)

New webview features must use **`@kilocode/kilo-ui`** components instead of raw HTML elements with inline styles. This is a Solid.js component library built on `@kobalte/core`.

- Import via deep subpaths: `import { Button } from "@kilocode/kilo-ui/button"`
- Available components include `Button`, `IconButton`, `Dialog`, `Spinner`, `Card`, `Tabs`, `Tooltip`, `Toast`, `Code`, `Markdown`, and more
- Provider hierarchy in [`App.tsx`](webview-ui/src/App.tsx:113): `ThemeProvider → I18nProvider → DialogProvider → MarkedProvider → VSCodeProvider → ServerProvider → ProviderProvider → SessionProvider`
- Global styles imported via `import "@kilocode/kilo-ui/styles"` in [`index.tsx`](webview-ui/src/index.tsx:2)
- [`chat.css`](webview-ui/src/styles/chat.css) is being progressively migrated — when replacing a component with kilo-ui, remove the corresponding CSS rules from it
- New CSS for components not yet in kilo-ui goes into `chat.css` grouped by comment-delimited sections (`/* Component Name */`). Once a kilo-ui equivalent exists, remove the section.
- **Check existing webview usages first**: `webview-ui/src/` and `packages/kilo-ui/src/stories/` show how kilo-ui components are composed. Do not rely only on the component API in isolation.
- **`data-component` and `data-slot` attributes carry CSS styling** — kilo-ui uses `[data-component]` and `[data-slot]` attribute selectors, not class names. Reuse existing component slots where available so shared styles apply consistently.
- **Prefer kilo-ui styles**: Always reuse existing kilo-ui CSS variables, tokens, and component styles instead of writing custom CSS. If a style doesn't exist in kilo-ui yet, add it there and reuse it rather than inlining or duplicating styles in the webview.
- **Icons**: kilo-ui has 75+ custom SVG icons in [`packages/ui/src/components/icon.tsx`](../../packages/ui/src/components/icon.tsx). To list all available icon names: `node -e "const c=require('fs').readFileSync('../../packages/ui/src/components/icon.tsx','utf8');[...c.matchAll(/^\\s{2}[\"']?([\\w-]+)[\"']?:\\s*\x60/gm)].map(m=>m[1]).sort().forEach(n=>console.log(n))"`. Icon names use both hyphenated (`arrow-left`) and bare-word (`brain`, `console`, `providers`) keys.

### Diff Rendering Performance

- Preserve hunk-bounded unified `patch` data through Changes/review detail flows and pass patch-derived `FileDiffMetadata` to Pierre when available. Do not eagerly render Pierre from complete `before`/`after` contents based only on changed-line counts: a tiny patch in a large source file can otherwise parse and render the entire file while the user sees a placeholder.
- Pierre workers can offload highlighted updates, but they do not make an expensive synchronous initial render safe. Keep initial rendering hunk-bounded, and keep patch parsing behind deferred visibility/activation where session-switch responsiveness depends on it.
- When changing diff scheduling, verify both rapid session switching and fast scrolling through a review. Improving one by shifting work into the other is a regression, not an optimization.

## Docs Screenshot Stories

When adding or updating Storybook stories for screenshots used by docs, make the story content match the docs page closely before replacing the docs image. Do not replace screenshots from VSCode Legacy docs tabs or sections.

Generated screenshot baselines live under `packages/kilo-docs/public/img/screenshot-tests/` and are referenced from docs as `/docs/img/screenshot-tests/...`. If a generated VS Code visual-regression screenshot is used in docs, add the docs usage to the `DOCS` map in `tests/visual-regression.spec.ts` and keep `tests/visual-regression.spec.mts` in sync while that file exists.

Visual regression baselines are Linux Chromium only and are never produced or committed by PR runs: `visual-regression.yml` compares read-only on `pull_request` and fails with uploaded Playwright results when screenshots differ. A maintainer regenerates and commits baselines by triggering the `Visual Regression Tests` acceptance workflow (`workflow_dispatch` with `ref` set to the branch and `scope: kilo-vscode`); see [Development Patterns - Visual regression baselines](/docs/contributing/architecture/development-patterns#visual-regression-baselines).

## Debugging

- Extension logs: "Extension Host" output channel (not Debug Console)
- Webview logs: Command Palette → "Developer: Open Webview Developer Tools"
- In Chrome/VS Code performance traces, associate CPU `ProfileChunk` events to their `Profile.id` target before attributing work to a thread. `v8:ProfEvntProc` is a profile delivery thread, not evidence that application work ran off the webview main thread.
- All debug output must be prepended with `[Kilo New]` for easy filtering

## Naming Conventions

- All VSCode commands must use `kilo-code.new.` prefix (not `kilo-code.`)
- All view IDs must use `kilo-code.new.` prefix. The legacy `kilo-code.SidebarProvider` Activity Bar view was removed in P3.1 and must not be reintroduced; "sidebar" in Agent Manager code refers to the Agent Manager's internal session sidebar, which stays.

## Process Spawning (Windows)

On Windows, any `spawn`/`execFile`/`exec` call that does not set `windowsHide: true` will flash a cmd.exe console window at the user. To prevent this, **never import `spawn`, `execFile`, or `exec` from `child_process` directly**. Use the wrappers in `src/util/process.ts` instead — they enforce `windowsHide: true` automatically:

```ts
import { spawn, exec } from "../util/process"
```

The `spawn` wrapper covers long-lived processes (e.g. `kilo serve`). The `exec` wrapper covers short commands (e.g. `git`, `tar`). If you need the raw callback form of `execFile` for some reason, pass `windowsHide: true` explicitly in the options object.

## Style

Follow monorepo root AGENTS.md style guide:

- Prefer `const` over `let`, early returns over `else`
- Single-word variable names when possible
- Avoid `try`/`catch`, avoid `any` type
- ESLint enforces: curly braces, strict equality, semicolons, camelCase/PascalCase imports

## File Size Caps (maxLines)

Large files in `src/agent-manager/` have `maxLines` caps enforced by `tests/unit/agent-manager-arch.test.ts`. **Do not raise these caps.** If adding a feature would exceed a cap, extract logic into a vscode-free helper module and call it from the provider. See `format-keybinding.ts` for an example of this pattern.

## Markdown Tables

Do not pad markdown table cells for column alignment. Use `| content |` with single spaces, not `| content       |` with extra padding. Padding creates spurious diffs. Markdown files are excluded from prettier (via `.prettierignore`) to prevent auto-reformatting of tables.

## Committing

- Before committing, always run `bun run format` so commits don't accidentally include formatting/styling-only diffs.
- Root AGENTS.md **Architecture documentation completion gate** applies before claiming completion and before commits: inspect the full intended diff, run `bun run script/check-architecture-impact.ts --worktree` from the repo root, and read mapped canonical docs for high signals. This package owns cross-client contract and arch-adjacent surfaces (`src/services/cli-backend/`, `src/agent-manager/`); canonical governance lives in `packages/kilo-docs/pages/contributing/architecture/`. See the root rule — do not restate it here.
