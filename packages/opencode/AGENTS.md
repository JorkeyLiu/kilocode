# Kilo CLI package guidelines

## Build/Test

- **Run**: `bun run --conditions=browser ./src/index.ts`
- **Test**: `bun test` (all tests) or `bun test test/tool/tool.test.ts` (single test)
- **Typecheck**: `bun run typecheck` (runs `tsgo --noEmit`)

## Architecture documentation

The root AGENTS.md **Architecture documentation completion gate** is mandatory before claiming implementation complete/ready or creating a commit: inspect the full intended diff, run `bun run script/check-architecture-impact.ts --worktree` from the repo root, and read mapped canonical docs for high signals. This package owns most high-signal surfaces — runtime lifecycle, provider lifecycle, hot/cold config classification, executable config schema, HTTP API contract, Effect runtime boundary. Canonical governance lives in `packages/kilo-docs/pages/contributing/architecture/`; follow the root rule, do not restate it here.

## Import Aliases

- `@/*` maps to `./src/*`
- `@tui/*` maps to `./src/cli/cmd/tui/*`

## Key Patterns

**Namespace modules** -- Code is organized as TypeScript namespaces, not classes. Each module exports a namespace with its Zod schemas, types, and functions:

```ts
export namespace Session {
  export const Info = z.object({ ... })
  export type Info = z.infer<typeof Info>
  export const create = fn(z.object({ ... }), async (input) => { ... })
}
```

**`Instance.state(init, dispose?)`** -- Per-project lazy singleton. Many modules register state this way. The state is tied to the project directory via `AsyncLocalStorage`:

```ts
const state = Instance.state(async () => {
  // initialized once per project, cached
  return { ... }
})
// later: (await state()).someValue
```

**Service-closure state vs. directory state** -- A value created in a service-layer closure, outside `InstanceState`, is shared by that service instance rather than keyed by request directory. The shared VS Code session paths use one active Snapshot service for the sidebar, Kilo tabs, and Agent Manager local worktree requests, so Snapshot `trackState` and its slow-track `asked` guard span those directories. Choosing **Continue with snapshots** resets the guard only when continued tracking returns a snapshot hash.

**`fn(schema, callback)`** -- Wraps functions with Zod input validation. Used for most exported functions:

```ts
export const get = fn(z.object({ id: z.string() }), async (input) => { ... })
```

**`Tool.define(id, init)`** -- All tools follow this pattern. The `init` returns `{ description, parameters, execute }`. Output is auto-truncated.

**`BusEvent.define(type, schema)` + `Bus.publish()`** -- In-process pub/sub event system for cross-module communication.

**`NamedError.create(name, schema)`** -- Structured errors with Zod schemas. Prefer these over throwing raw errors.

**`iife()`** -- Immediately-invoked function expression helper. Used to avoid `let` statements per style guide.

**Logging** -- Use `Log.create({ service: "name" })` pattern.

## Process Spawning (Windows)

On Windows, any `spawn`/`execFile` call without `windowsHide: true` will flash a cmd.exe console window at the user. Use `Process.spawn` from `src/util/process.ts` — it enforces `windowsHide: true` automatically. For `Bun.spawn`/`Bun.spawnSync`, pass `windowsHide` via the options object if the subprocess could create a visible console.

The MCP `StdioClientTransport` (third-party SDK) is handled separately via a process shim in `src/mcp/index.ts` that sets `process.type = "browser"` when running inside the VS Code extension (`KILO_PLATFORM=vscode`), which causes the SDK's internal `isElectron()` check to return `true` and enable `windowsHide`.

## Storage

Filesystem-based JSON, not a database. Data lives in `~/.local/share/kilo/storage/`. Keys are path arrays: `Storage.write(["session", projectID, sessionID], data)`.

## TUI

Built with **SolidJS + OpenTUI** (`@opentui/solid`) -- a terminal UI framework. JSX renders to the terminal using elements like `<box>`, `<text>`, `<scrollbox>`. The TUI communicates with the server via `@kilocode/sdk`.

## Server

Hono-based HTTP server with OpenAPI spec generation. SSE for real-time events. When you add/change routes, regenerate the SDK (see root AGENTS.md for the command).

## Config lifecycle

Config saves are classified hot or cold at field introduction; hot saves converge without a runtime rebuild, cold saves converge through a background runtime swap. The model is canonical in [CLI Runtime config update lifecycle](/docs/contributing/architecture/cli-runtime#config-update-lifecycle); the coordinator implementation lives in `src/kilocode/server/config-convergence.ts`. Give every new config field its hot/cold classification and route lifecycle questions to that architecture section — do not restate the spec here or in code.

## Providers and Models

Uses the **Vercel AI SDK** as the abstraction layer. Providers are loaded from a bundled map or dynamically installed at runtime. Models come from a canonical committed snapshot at `src/kilocode/provider/models-api.json` (repo path `packages/opencode/src/kilocode/provider/models-api.json`).

Normal builds are offline: `script/generate.ts` reads the committed snapshot and embeds it into the CLI. The only build-snapshot network path is the explicit refresh — `bun run refresh:models` from `packages/opencode/` (or `bun run --cwd packages/opencode refresh:models` from the repo root) — which fetches the current models.dev data and replaces the snapshot. Runtime models.dev caching/refresh is separate and unchanged. A local `MODELS_DEV_API_JSON=<file>` env override exists for development.

## Fork Isolation Rule

`opencode/` is a fork of upstream opencode. When a change must touch a shared upstream file, extract the Kilo-specific logic into a mirror file under `src/kilocode/<same/path>.ts` (tests under `test/kilocode/<same/path>.test.ts`) and call into it from the upstream file behind a single `kilocode_change` marker. Example: a Kilo override for `src/cli/cmd/tui/component/dialog-provider.tsx` lives at `src/kilocode/cli/cmd/tui/component/dialog-provider.tsx`. Avoid inlining Kilo-specific logic directly into shared upstream files. Files and directories whose path contains `kilocode` never need `kilocode_change` markers.
