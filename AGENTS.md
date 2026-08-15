# AGENTS.md

Kilo CLI is an open source AI coding agent that generates code from natural language, automates tasks, and supports 500+ AI models.

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- You may be running in a git worktree. All changes must be made in your current working directory — never modify files in the main repo checkout.

## Repository Identity

This repository is independently governed. There is no upstream merge stream and no compatibility obligation to OpenCode, Kilo Code cloud, or any external project.

- Code inherited from earlier projects, and current package names and dependencies, are legacy implementation facts — not architecture commitments. Refactor, rename, replace, or remove inherited code and CLI/SDK boundaries freely when it serves this repository's quality and functionality.
- Do not optimize for upstream diff size, marker placement, shared-file preservation, cloud schema mirroring, external SDK aggregation, or inherited CLI/SDK boundaries.
- Independent correctness standards still apply: tests, types, security, resource ownership, architecture documentation, and generated-code consistency while the generator remains in use.

## Build and Dev

- **Dev**: `bun run dev` (runs from root) or `bun run --cwd packages/opencode --conditions=browser src/index.ts`
- **Dev with params**: `bun dev -- help`
- **Extension**: `bun run extension` (build + launch VS Code with the extension in dev mode). Pass `--no-build` to skip the build.
- **Typecheck**: `bun turbo typecheck` (uses `tsgo`, not `tsc`). Includes the JetBrains plugin and requires Java 21; do not run `java -version` as a routine preflight. Only check Java when a Gradle/Java command fails with a Java-version or missing-Java error. If missing, install via SDKMAN: `sdk install java 21-tem && sdk use java 21-tem`. If SDKMAN is not installed, see https://sdkman.io/install.
- **Test**: `bun test` from `packages/opencode/` (NOT from root -- root blocks tests)
- **Single test**: `bun test ./test/tool/tool-define.test.ts` from `packages/opencode/`
- **CLI build artifact size check**: after `bun run script/build.ts --single --skip-install` in `packages/opencode/`, use `du -h dist/*/*/bin/kilo` (scoped package output lives under `dist/@kilocode/`)
- **SDK regen**: After changing server endpoints in `packages/opencode/src/server/`, run `./script/generate.ts` from root to regenerate `packages/sdk/js/`
- **Knip** (unused exports): `bun run knip` from `packages/kilo-vscode/`. CI runs this — all exported types/functions must be imported somewhere. Remove or unexport unused exports before pushing.
- **Source links**: After adding or changing URLs in `packages/kilo-vscode/`, `packages/kilo-vscode/webview-ui/`, or `packages/opencode/src/`, run `bun run script/extract-source-links.ts` from the repo root and commit the updated `packages/kilo-docs/source-links.md`. CI runs this check — the build fails if the file is stale.
- **Effect facade ratchet**: Do not add runtime-backed Promise facades to shared `packages/opencode/src` Effect services; use service dependencies, `AppRuntime`, or Kilo-owned boundaries. Run `bun run script/check-opencode-promise-facades.ts` when touching service adapters.
- **workflow allowlist**: `bun run script/check-workflows.ts` from repo root. CI runs this in the repository-guards workflow — any `.yml` / `.yaml` file added to or removed from `.github/workflows/` must be reflected in the hardcoded list in `script/check-workflows.ts`. Prevents unvetted workflows from silently running with repository privileges in CI.
- **Architecture docs impact**: Changing system boundaries, state ownership, lifecycle, persistence, concurrency, public protocol, config application semantics, a cross-client contract, or a guard/workflow model requires reviewing the [canonical architecture docs](packages/kilo-docs/pages/contributing/architecture/index.md) and, for high-impact changes, a `## Documentation Impact` declaration in the PR body. Before claiming completion or committing, run `bun run script/check-architecture-impact.ts --worktree` from the repo root and apply the Architecture documentation completion gate under Quality Checks — the PR declaration persists that same local decision and CI validates it. See [Documentation impact governance](packages/kilo-docs/pages/contributing/architecture/index.md#documentation-impact-governance).
- **Backend/SDK programmatic testing**: see [TESTING.md](./TESTING.md) for spawning the local main-branch backend (`bun dev serve`) and driving it via `curl` — use this instead of `kilo serve` (prod binary) when testing backend fixes.

## Runtime Conventions

### Config Update Lifecycle

- Classify every new config field as hot or cold at introduction. Hot saves persist, invalidate caches, and emit `config-updated` without a runtime rebuild; cold saves require runtime convergence.
- Cold saves validate, persist, and acknowledge immediately after the backend transaction and synchronous side effects; they never await active generation drain, and later saves do not queue behind an earlier convergence.
- Before cold persistence, affected directories receive a generation-admission fence: in-flight generations keep the config snapshot they started with, while new generations and readers wait until the latest convergence lands.
- Later writes, write-intent operations, and drain-control operations remain available during convergence and do not queue behind it.
- Cold obligations coalesce and version: the pass drains readers and write/control leases, disposes the exact pre-fence identities, boots the latest disk state, and releases the fence only after the latest committed version converges.
- Reload/load during a fence and runtime shutdown ownership are part of the model. See [CLI Runtime config update lifecycle](/docs/contributing/architecture/cli-runtime#config-update-lifecycle) for the full architecture.
- Tests must cover saving during active streaming, not only idle PATCH.

### Runtime Path Parity

- When clients use production `Server.listen`/`AppLayer`, validate that path; `Server.Default` alone is insufficient evidence.
- When `bun run extension` is used as evidence, prove the backend comes from the current workspace via process ancestry or launch path. Manual launch does not replace typecheck and tests.
- Verify provider/model UI from cold provider state; cached metadata is not sufficient.
- Cross-reference TESTING.md instead of duplicating binary commands.

### Effect Service Ownership

- Kilo wrappers and inherited core services use runtime-distinct Context keys.
- AppLayer provides one canonical instance of each stateful service; feature layers reuse it rather than embedding an independent `defaultLayer`.
- Injectable tests preserve the production dependency graph and real service wiring, not mocks.
- Complement, not weaken, the existing Effect facade ratchet.

## Resource Lifecycle

- **Ownership**: Every spawned process, open listener, bound port, or created file path has an owner. Ownership follows the owner's lifecycle, not the test or task that created the resource. The owner releases it explicitly before finishing; transfer cleanup authority only by explicit hand-off, and the new owner is responsible from that point.
- **Tracked processes**: When a framework, test runner, or utility provides process tracking (e.g. a test fixture registry that maps handles to cleanup hooks), register long-running servers, watchers, and test helpers through it. Dispose or kill via the tracker, not by name. A raw `child_process` handle does **not** guarantee OS process termination or descendant cleanup, and an `Effect.Fork` fiber tracks only the in-process handle. Attach explicit cleanup (kill/signal) to a scope, finalizer, or teardown hook.
- **Effect forks**: `forkScoped` and `forkIn` bind the fiber to a scope that interrupts it when closed. `forkDetach` attaches the fiber to the global scope — it escapes the caller's scope and may outlive the caller — so the owner must retain the returned `Fiber` and interrupt it explicitly when ownership ends. Detached work is not stopped by test or task end.
- **Fallback**: When no framework-provided tracker is available, record the exact child handle or PID and command, or use a unique run-owned path (e.g. `tmpdir()` per test). Attach cleanup to a scope or finalizer. Do not rely on process names or global patterns.
- **Pre-existing resources**: Do not terminate processes or delete files you did not create. If a fixture or helper creates a resource, only that same fixture or helper should dispose it.
- **No global termination**: Never use process-name kills, `pkill`, pattern-based signal sends, or shared-location glob deletion to clean up. These are unsafe in shared environments.
- **Release before delete**: Before removing owned directories or files, close all listeners, sockets, file handles, and environment overrides that reference them. Delete only after detached work and the runtimes that can touch those paths have quiesced — a detached install can recreate a path after an earlier cleanup pass.
- **Scoped cleanup**: Use `await using`, `try/finally`, Effect `Scope`/finalizers, or test framework teardown hooks to ensure cleanup runs on both success and failure paths.

## Quality Checks

Before saying an implementation is ready, run the smallest relevant checks that can catch lint, typecheck, and test failures for the touched package. Do not rely on manual extension launch to discover build problems. Fix failures you introduced before the final response, or state exactly which check is still failing or could not be run.

### Test layer selection

Choose the smallest test layer that proves the risk:

- Unit tests for pure logic/state.
- Storybook Playwright for isolated rendering, component interaction, visual, and a11y.
- `bun run test:e2e` (real VS Code Extension Host, explicit/manual) only for real Extension Host/API behavior, extension↔webview messaging, command routing, bundle/surface registration, process/backend lifecycle, or when manual runtime contradicts static/unit evidence.

Copy, CSS, isolated components, and faithfully reproducible Storybook UI do not require Extension Host E2E. E2E is never automatic — no push/PR/schedule trigger, hook, or aggregate package script invokes it. A maintainer may dispatch it explicitly on Linux under Xvfb via the manual-only `vscode-e2e` workflow (`.github/workflows/vscode-e2e.yml`); macOS runs stay local-only. Details live in `packages/kilo-vscode/AGENTS.md` and root `TESTING.md`.

| Area | Checks |
|---|---|
| Root / cross-package | `bun run lint`, `bun run typecheck` |
| CLI | From `packages/opencode/`: `bun run typecheck`, `bun test` or targeted `bun test ./path/to/file.test.ts` |
| VS Code extension | From `packages/kilo-vscode/`: `bun run typecheck`, `bun run lint`, `bun run test:unit` or `bun run test` |
| Extension build/package | From `packages/kilo-vscode/`: `bun run compile` or `bun run package` when touching build, packaging, SDK, or webview integration paths |
| JetBrains plugin | From `packages/kilo-jetbrains/`: `./gradlew typecheck`, `./gradlew test`. Requires Java 21; do not run `java -version` as a routine preflight. Check Java only after a Java-version or missing-Java failure. |
| CI-only guards | Run affected guards documented above, such as `bun run knip` or source link extraction |
| Architecture docs governance | From repo root: run `bun run script/check-architecture-impact.ts --worktree` before claiming completion or committing — see the Architecture documentation completion gate below; CI validates the PR body `## Documentation Impact` declaration — evidence only, reviewers own semantic accuracy |

Never run root `bun test`; the root script prints `do not run tests from root` and exits with code 1. Use package-level tests instead.

### Architecture documentation completion gate

Architecture documentation impact is a mandatory local completion gate, not a PR-only concern. Before claiming an implementation is complete or ready, and before creating a commit, do all of the following — even when no PR will be opened:

1. **Inspect the complete intended diff** — staged, unstaged, and untracked changes (`git status`, `git diff`, and review of untracked files).
2. **Run the checker** — `bun run script/check-architecture-impact.ts --worktree` from the repo root. Checker output is evidence, not a semantic substitute; apply your own judgment on top of it.
3. **High signal** — read the mapped canonical docs under the [canonical architecture docs](packages/kilo-docs/pages/contributing/architecture/index.md). If the architecture meaning changed, update the docs in the same local work unit before claiming completion or committing. If not, record a concrete no-update rationale in the completion/commit-preparation report.
4. **Medium or no signal** — still report the outcome concisely in the completion/commit-preparation report.

The gate does not block commit creation (code, tests, and docs may land as separate edits) and requires no commit trailer or PR, but following it is a mandatory Agent instruction. When a PR exists, the same decision is persisted in the PR body `## Documentation Impact` declaration and CI validates it.

## Products

All products are clients of the **CLI** (`packages/opencode/`), which contains the AI agent runtime, HTTP server, and session management. Each client spawns or connects to a `kilo serve` process and communicates via HTTP + SSE using `@kilocode/sdk`.

| Product | Package | Description |
|---|---|---|
| Kilo CLI | `packages/opencode/` | Core engine. TUI, `kilo run`, `kilo serve`. Originated from OpenCode; independently governed. |
| Kilo VS Code Extension | `packages/kilo-vscode/` | VS Code extension with Agent Manager and editor-tab chat. Bundles the CLI binary, spawns `kilo serve` as a child process. Includes the **Agent Manager** — a multi-session orchestration panel with git worktree isolation. |

**Agent Manager** refers to a feature inside `packages/kilo-vscode/` (extension code in `src/agent-manager/`, webview in `webview-ui/agent-manager/`). It is not a standalone product. See the extension's `AGENTS.md` for details.

In each VS Code extension host, one `KiloConnectionService` is created for every Kilo editor tab and the Agent Manager; it lazily starts and reuses one current `kilo serve` backend at a time. Agent Manager worktree sessions pass a directory context to this shared backend rather than starting one per worktree. State captured by the active service layer, such as Snapshot `trackState`, is shared across those requests; only directory-keyed `InstanceState` data is isolated.

Extension-specific settings should live in the Kilo extension settings, not default VS Code settings, unless they are intentionally VS Code-wide. Experimental flags should follow existing flag patterns, not VS Code settings; they usually belong in the Kilo Experimental settings section.

## Package Instructions

- When a task primarily touches `packages/kilo-jetbrains/`, read `packages/kilo-jetbrains/AGENTS.md` before planning or editing. It covers split-mode architecture, IntelliJ source lookup, threading fundamentals, UI guidelines, and session component architecture.

## Monorepo Structure

Turborepo + Bun workspaces. The packages you'll work with most:

| Package | Name | Purpose |
|---|---|---|
| `packages/opencode/` | `@kilocode/cli` | Core CLI -- agents, tools, sessions, server, TUI. This is where most work happens. |
| `packages/sdk/js/` | `@kilocode/sdk` | Auto-generated TypeScript SDK (client for the server API). Do not edit `src/gen/` by hand. |
| `packages/kilo-vscode/` | `kilo-code` | VS Code extension with Agent Manager and editor-tab chat. See its own `AGENTS.md` for details. |
| `packages/kilo-gateway/` | `@kilocode/kilo-gateway` | Kilo auth, provider routing, API integration |
| `packages/kilo-telemetry/` | `@kilocode/kilo-telemetry` | PostHog analytics + OpenTelemetry |
| `packages/kilo-i18n/` | `@kilocode/kilo-i18n` | Internationalization / translations |
| `packages/kilo-ui/` | `@kilocode/kilo-ui` | SolidJS component library shared by the extension webview and docs screenshot stories |
| `packages/util/` | `@opencode-ai/util` | Shared utilities (error, path, retry, slug, etc.) |
| `packages/plugin/` | `@kilocode/plugin` | Plugin/tool interface definitions |

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

- Keep things in one function unless composable or reusable
- Avoid unnecessary destructuring. Instead of `const { a, b } = obj`, use `obj.a` and `obj.b` to preserve context
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity

### Avoid let statements

Prefer `const`. Replace `let` + if/else assignment with a ternary or an IIFE. Reassignment is the only legitimate reason to reach for `let`.

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Examples to avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.

### Avoid else statements

Prefer early returns (or an IIFE) over `else`. After an `if` that returns/throws, the `else` is redundant.

### No empty catch blocks

Never leave a `catch` block empty. An empty `catch` silently swallows errors and hides bugs. If you're tempted to write one, ask yourself:

1. Is the `try`/`catch` even needed? (prefer removing it)
2. Should the error be handled explicitly? (recover, retry, rethrow)
3. At minimum, log it via `log.error("...", { err })` so failures are visible — never `catch {}` or `catch (e) {}` with no body.

### Prefer single word naming

Default to a single-word name for variables, parameters, and helper functions. Reach for a multi-word name only when a single word would be genuinely ambiguous in context — not just because the longer name "reads nicer". The rule is about meaning, not character count: don't introduce camelCase compounds like `inputPID`, `existingClient`, `connectTimeout`, or `workerPath` when `pid`, `client`, `timeout`, or `path` is already clear from the surrounding code. See the "Naming Enforcement" section above for the preferred vocabulary.

## Testing

You MUST avoid using `mocks` as much as possible.
Tests MUST test actual implementation, do not duplicate logic into a test.

## Markdown Tables

Do not pad markdown table cells for column alignment. Use the compact form with single-space-padded content cells and a minimal separator row:

```
| Command | What it runs |
|---|---|
| `kilo serve` | The prod CLI on `$PATH`. |
```

Do **not** right-pad cells to line up columns:

```
| Command                       | What it runs             |
| ----------------------------- | ------------------------ |
| `kilo serve`                  | The prod CLI on `$PATH`. |
```

Padding makes every content change rewrite the entire table, which blows up diffs on untouched rows. Markdown files are excluded from prettier (see `.prettierignore`) so running the formatter won't re-pad them, and `script/check-md-table-padding.ts` enforces the rule in CI. Run `bun run script/check-md-table-padding.ts --fix` to auto-rewrite padded tables.

## Commit Conventions

[Conventional Commits](https://www.conventionalcommits.org/) with scopes matching packages: `vscode`, `cli`, `agent-manager`, `sdk`, `ui`, `i18n`, `kilo-docs`, `gateway`, `telemetry`, `desktop`. Omit scope when spanning multiple packages.

## Changesets

User-facing changes (features, fixes, breaking changes) require a changeset file for release notes. Prefer one concise changeset per PR, grouping related changes when possible. Run `bunx changeset add` or manually create `.changeset/<slug>.md`. Use `patch` for bug fixes, `minor` for new features, `major` for breaking changes. See `.changeset/README.md` for details.

Changeset descriptions appear directly in release notes and are read by end users. Keep them concise and feature-oriented — describe **what changed from the user's perspective**, not implementation details. Write in imperative mood (e.g. "Support exporting conversations as markdown" not "Add a new export handler that serializes session messages to .md files").

## Pull Requests

PR descriptions should explain **what** changed, **why** the change is needed, and the intent or constraints a reviewer cannot infer from the diff alone. Keep simple PRs brief, but give non-trivial changes enough context to stand on their own. Skip file-by-file inventories, test result summaries, and anything obvious from the code itself.

## GitHub Issues

When creating or managing GitHub issues for the VS Code extension or JetBrains plugin via `gh`, load `.kilo/skills/gh-issues/SKILL.md`. It covers templates, project boards (`VS Code Extension`, `Jetbrains Plugin`), title conventions, and the `gh auth refresh -s project` recovery path.
