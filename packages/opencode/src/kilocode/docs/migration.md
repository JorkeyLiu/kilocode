# Kilo CLI Migration Reference

This page records retired migration surfaces for historical reference. The retained configuration path is canonical-only and does not run compatibility readers or import tools.

## Retired sources

The current CLI does not read or convert the following retired sources into effective configuration:

- legacy mode files such as `.kilocodemodes` and `custom_modes.yaml`
- legacy workflow files under `.kilo/workflows/` or `.kilocode/workflows/`
- legacy rule files such as `.kilocoderules` and legacy rules directories
- legacy MCP settings files such as `mcp_settings.json`
- `.kilocodeignore` as a CLI permission import source
- `.opencode` configuration files and legacy config filenames

Convert retained user intent manually into canonical files when needed:

- agents: `${Global.Path.config}/agent/*.md` or `canonicalRoot/.kilo/agent/*.md`
- commands: `${Global.Path.config}/command/*.md` or `canonicalRoot/.kilo/command/*.md`
- instructions: `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, or the canonical `instructions` config field
- MCP: the canonical `mcp` config field
- permissions: the canonical `permission` config field

The VS Code extension retains its separately owned legacy migration flow for old extension data. That flow is not a CLI reader and is outside the CLI effective-config boundary.

## Retained discovery

The CLI reads two authored configuration scopes:

1. `${Global.Path.config}/kilo.jsonc` and typed assets directly under the global config root.
2. `canonicalRoot/.kilo/kilo.jsonc` and typed assets under the workspace/worktree `.kilo` directory.

Project `{file:}` substitutions are confined to `canonicalRoot`. Loader reads are side-effect free. Retained mutations use the shared discovery lock and atomic JSONC writes.

## Skill discovery (canonical)

Skills are discovered only from canonical `.kilo` locations. The scanner does not walk legacy `.kilocode` directories or VS Code extension storage paths as a CLI source.

| Scope | Pattern |
|---|---|
| Project | `canonicalRoot/.kilo/skill/<name>/SKILL.md` or `canonicalRoot/.kilo/skills/<name>/SKILL.md` |
| Global | `${Global.Path.config}/skill/<name>/SKILL.md` or `${Global.Path.config}/skills/<name>/SKILL.md` |
| Additional | `skills.paths` entries resolved relative to canonical roots; `skills.urls` for remote |

Within a canonical `.kilo` root, both `skill/` and `skills/` directory names are supported. Symlinked skill directories are followed. Explicit `skills.paths` and `skill` discovery are ordered by `ConfigService.directories()`; global before project. The VS Code extension may still expose marketplace skills via its own storage, but that path is not a CLI discovery root.

## Kilo Notifications

When connected to Kilo Gateway, the CLI fetches and displays notifications from the Kilo API. This allows Kilo to communicate announcements, feature updates, and tips.

- **On startup**, if authenticated with Kilo Gateway, the CLI fetches from `https://api.kilo.ai/api/users/notifications`
- **Filtering**: only notifications with `showIn` containing `"cli"` (or no `showIn` restriction) are displayed
- **Display**: the first notification is shown as a toast after a short delay

Notification payload:

```typescript
interface KilocodeNotification {
  id: string
  title: string
  message: string
  action?: { actionText: string; actionURL: string }
  showIn?: string[] // target platforms: ["cli", "vscode"]
}
```

Display conditions: notifications appear only when connected to Kilo Gateway and the API returns at least one `showIn: ["cli"]` entry. No notification slash command or command-palette toggle exists; notification attention is managed via `attention` in `tui.json`/`tui.jsonc`.

## Rules contract gap

`rules` remains a registered typed-asset class. The current opencode effective snapshot does not materialize it, and this page does not define a rules runtime or loader. The contract gap remains deferred.

## Deferred boundaries

Transport narrowing and deletion of old CLI, TUI, and Console surfaces remain separate concerns and are not covered by this cleanup.
