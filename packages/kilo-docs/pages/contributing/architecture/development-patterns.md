---
title: "Development Patterns"
description: "Contributor patterns for Kilo architecture implementation and modular boundaries"
---

# Development Patterns

This page turns architecture boundaries into contributor decisions. Read [Architecture Overview](/docs/contributing/architecture) and relevant subsystem page first, then use this guide before editing architecture-facing code in `Kilo-Org/kilocode`.

{% callout type="info" title="Default rule" %}
Prefer narrow, well-scoped seams and Kilo-owned packages for additive behavior. Follow neighboring style when changing existing modules.
{% /callout %}

## How to use this page

1. Identify owning subsystem in architecture docs.
2. Choose narrowest source boundary that can hold change.
3. Update generated artifacts when public surface changes.
4. Run smallest relevant checks plus affected repository guards.

## Where should change live?

| Change shape | Preferred location or action | Reason |
|---|---|---|
| Additive Kilo CLI behavior | `packages/opencode/src/kilocode/` | Concentrates Kilo-only behavior in Kilo-owned paths |
| Kilo CLI test for additive behavior | `packages/opencode/test/kilocode/` | Avoids shared tests that encode only Kilo behavior |
| Required shared engine edit | Small import, route, or injection seam in shared file | Keeps the edit local and reviewable |
| VS Code, JetBrains, docs, indexing, UI, gateway, or telemetry change | Existing Kilo-owned package | These packages are Kilo-owned; no shared-file seam needed |
| CLI server endpoint change | Effect `HttpApi` route plus handler; then run root SDK generator | Keeps server contract and generated JavaScript SDK aligned |
| JetBrains API contract change | Shared CLI OpenAPI change; let Gradle regenerate build-local Kotlin client | Kotlin client is generated during JetBrains build |
| Kilo-only config-key change | Update CLI Effect Schema and classify the key in the hot-key set | Config schema and hot/cold classification are complete within this repository |
| Docs page move or removal | Update nav and add permanent redirect | Preserves external links and bookmarks |

## Kilo-owned boundaries

The Kilo CLI runtime began as a fork of OpenCode. Prefer Kilo-owned directories and packages for additive behavior — this is modular guidance, not an upstream-merge obligation:

| Prefer | Avoid unless necessary |
|---|---|
| `packages/opencode/src/kilocode/` | Broad edits to shared `packages/opencode/src/` files |
| `packages/opencode/test/kilocode/` | Shared tests that encode only Kilo behavior |
| `packages/kilo-vscode/`, `packages/kilo-jetbrains/`, `packages/kilo-docs/`, `packages/kilo-indexing/` | Moving Kilo-only behavior into shared engine modules |
| Narrow import or route seams in shared files | Refactors that broadly restructure shared engine files |

## Shared engine files

Shared engine files historically carried `kilocode_change` markers identifying Kilo-specific additions. That marker mechanism is retired: the annotation guard and the editor-client marker check have been removed, and no marker is required for current edits. Existing markers in the tree are historical provenance: trailing `// kilocode_change` comments, `// kilocode_change start` / `// kilocode_change end` blocks, and JSX comment equivalents record where Kilo-specific additions were made, but they are retired and non-normative for current edits.

Keep changes to shared engine files small and well-scoped so they stay reviewable.

| Guard | When to run |
|---|---|
| `bun run script/check-opencode-promise-facades.ts` | Service adapter changes; prevents new runtime-backed Promise facades in shared Effect services |
| `bun run script/check-model-tool-network.ts` | Tool networking changes; keeps tool network boundaries explicit |
| `bun run script/check-workflows.ts` | Workflow add or remove changes; keeps workflow allowlist explicit |
| `bun run script/check-architecture-impact.ts --worktree` | Architecture-facing change; local semantic assessment is primary — inspect the full diff, read mapped canonical docs for high signals, update them or record a rationale. CI validates the PR body `## Documentation Impact` declaration when a PR is opened — see [Documentation impact governance](/docs/contributing/architecture#documentation-impact-governance) |

The first three run in CI through `.github/workflows/check-repository-guards.yml`.

## CLI server API

CLI server uses Effect `HttpApi` and publishes OpenAPI-compatible HTTP + SSE surfaces consumed by JavaScript SDK and JetBrains build-local Kotlin client.

| Rule | Reason |
|---|---|
| Define shared routes under `packages/opencode/src/server/routes/instance/httpapi/` | Keeps route contract close to runtime handlers |
| Normalize public spec in `packages/opencode/src/server/routes/instance/httpapi/public.ts` | Preserves legacy-compatible request and response shapes during Effect migration |
| Put additive Kilo groups and handlers under `packages/opencode/src/kilocode/server/httpapi/` | Concentrates Kilo-specific server code in Kilo-owned paths |
| Inject Kilo APIs through narrow shared seam | Keeps the injection seam local and Kilo additions identifiable |
| Preserve route spans and stable attributes | Keeps diagnostics and telemetry understandable |

## SDK generation

[CLI Runtime SDK contract](/docs/contributing/architecture/cli-runtime#sdk-contract) owns generation pipeline detail. Contributor rules are short. These describe the current pipeline; the SDK boundary is an implementation choice that may be refactored or removed, so treat compatibility with generated clients as present state, not a permanent contract:

| Change | Action |
|---|---|
| Add or change CLI server endpoint | Run root `./script/generate.ts` after route and handler edits |
| JavaScript SDK generated files under `packages/sdk/js/src/v2/gen/` | Do not edit by hand |
| JavaScript SDK wrapper behavior | Edit handwritten `packages/sdk/js/src/v2/client.ts` |
| JetBrains generated Kotlin client | Let Gradle regenerate build-local client from normalized OpenAPI |

## CLI config schema

Runtime config loading and editor validation are separate paths. A new Kilo-only config key requires a CLI Effect Schema change and a hot/cold classification in `Kilo-Org/kilocode`; that completes the key within this repository. Classify the field hot or cold at introduction — hot saves converge without a runtime rebuild, cold saves require runtime convergence; the full model is in [CLI Runtime config update lifecycle](/docs/contributing/architecture/cli-runtime#config-update-lifecycle). A cloud-served JSON Schema overlay currently exists as an external compatibility surface for editor completion; it is non-authoritative and does not gate runtime acceptance. Follow [CLI Config Schema](/docs/contributing/architecture/config-schema) for exact workflow.

## Module export pattern

For new public APIs, prefer flat ESM exports inside module, then namespace re-exports from index files when grouped access helps callers.

```typescript
// packages/opencode/src/session/session.ts
export const create = fn(CreateSchema, async (input) => {
  // ...
})

export const list = fn(ListSchema, async (input) => {
  // ...
})

// packages/opencode/src/session/index.ts
export * as Session from "./session"
```

Import specific export when practical. Use namespace shape (`Session.create`) when preserving existing API or grouped module access improves clarity. Existing Kilo-owned namespaces remain valid; do not refactor them solely for style.

## Tool implementation

Tools use `Tool.define("id", Effect.gen(...))` with Effect Schema validation and typed execution.

```typescript
export const ExampleTool = Tool.define(
  "example",
  Effect.gen(function* () {
    return {
      description: "Example tool",
      parameters: Schema.Struct({
        value: Schema.String,
      }),
      execute(args) {
        return Effect.succeed({
          title: args.value,
          metadata: {},
          output: args.value,
        })
      },
    }
  }),
)
```

Reuse tool helpers, permission gates, and telemetry conventions before adding abstractions. Tests should exercise implementation behavior rather than duplicating logic in mocks.

## Build system

| Area | Tooling |
|---|---|
| Package manager | Bun workspaces |
| Task orchestration | Turborepo |
| CLI executable | Bun compile build in `packages/opencode/script/build.ts` |
| VS Code extension and webviews | esbuild |
| JetBrains plugin | Gradle, Kotlin JVM toolchain 21, build-local OpenAPI generation |
| Type checking | `tsgo` through `bun turbo typecheck`; Gradle compile checks for JetBrains |
| Tests | Package-level Bun test, Vitest, or Gradle test depending on package |
| Docs | Next.js, Markdoc, Mermaid, and custom Markdoc components |

## Documentation changes

When adding or moving docs pages:

- Create page under `pages/`.
- Update matching navigation file in `lib/nav/`.
- Add redirects when removing or moving routes.
- Use compact markdown tables with unpadded cells.
- Use `/docs` prefix for docs image paths.

## Source map

Paths below are relative to [`Kilo-Org/kilocode`](https://github.com/Kilo-Org/kilocode).

| Concern | Source path |
|---|---|
| Tool definition API | `packages/opencode/src/tool/tool.ts` |
| Tool example | `packages/opencode/src/tool/read.ts` |
| Server APIs | `packages/opencode/src/server/routes/instance/httpapi/` |
| Public OpenAPI normalization | `packages/opencode/src/server/routes/instance/httpapi/public.ts` |
| Kilo route seam | `packages/opencode/src/kilocode/server/httpapi/` |
| JavaScript SDK generation | `packages/sdk/js/script/build.ts`{% linebreak /%}`script/generate.ts` |
| JetBrains client generation | `packages/kilo-jetbrains/backend/build.gradle.kts` |

## Historical upstream merge workflow

This repository is independently governed and has no ongoing upstream merge or update stream. The upstream merge automation (`script/upstream/`), the annotation guard, and the editor-client marker checks have been removed. `bun install` still runs `script/setup-git.ts`, which keeps `merge.conflictStyle=zdiff3` set repo-locally; base-aware conflict markers make manual conflict resolution easier, and that is now their only purpose.

No future merge work is planned or required by these pages.

## Related pages

- [Architecture Overview](/docs/contributing/architecture) - system layers and reading paths
- [CLI Runtime](/docs/contributing/architecture/cli-runtime) - local runtime ownership and SDK contract
- [CLI Runtime config update lifecycle](/docs/contributing/architecture/cli-runtime#config-update-lifecycle) - hot/cold save classification and convergence obligations
- [CLI Config Schema](/docs/contributing/architecture/config-schema) - config-key workflow
