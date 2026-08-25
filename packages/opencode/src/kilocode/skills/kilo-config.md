# Kilo CLI Configuration Reference (Canonical, P4.3)

All effective config is the deterministic merge of exactly two authored JSONC scopes plus retained legal inputs. Later scopes override earlier scalars. Objects deep-merge; arrays generally replace, except `instructions` arrays are concatenated and deduplicated and `plugin` entries are deduplicated by identity. Canonical loader reads are side-effect free; all writes use shared discovery locks and `KilocodeAtomicWrite` (temp-file + rename).

### Canonical sources (P4.3, low → high precedence)

| Order | Scope | File / assets | Semantics |
|---|---|---|---|
| 1 | Global | `${Global.Path.config}/kilo.jsonc` (`~/.config/kilo/kilo.jsonc` or `$XDG_CONFIG_HOME/kilo/kilo.jsonc`) plus `${Global.Path.config}/{command,commands,agent,agents,skill,skills,rules}` typed assets directly under the global root | Trusted. Empty when missing; created only by `prepare`/`commit` under the global discovery lock. |
| 2 | Workspace / worktree | `canonicalRoot(directory, worktree)/.kilo/kilo.jsonc` and `canonicalRoot/.kilo/{command,commands,agent,agents,skill,skills,rules}` typed assets | Untrusted; `{file:}` reads confined to `canonicalRoot`. `canonicalRoot(directory, worktree)` is `worktree` when present and not `"/"` else `directory`. No ancestor walk. |

Retained legal inputs beyond these two files: opaque `SecretStorage` credential refs and runtime defaults. No other source participates in retained effective config or mutations.

Discovery locks and atomic persistence: every mutation serializes through a shared cross-process `EffectFlock` discovery lock held **before** target resolution.

| Domain | Lock key |
|---|---|
| Global | `config:discover:global:<hash(Global.Path.config)>` |
| Project | `config:discover:project:<hash(canonicalRoot)>` |

The locked key is always the written path; `$schema` injection for missing files is in-memory only.

## Commands (`.kilo/command/*.md` and `.kilo/commands/*.md`)

Canonical only: `canonicalRoot/.kilo/command/**/*.md` and `canonicalRoot/.kilo/commands/**/*.md`, plus the same directly under the global `${Global.Path.config}` (e.g., `${Global.Path.config}/command/**/*.md` and `${Global.Path.config}/commands/**/*.md`). No `.kilocode` / `.opencode` fallback. Do not create a global `.kilo` subdirectory — global assets live directly under `${Global.Path.config}/`.

Markdown files with YAML frontmatter. The filename (minus `.md`) becomes the command name invoked via `/name`.

```yaml
---
description: Run tests # optional, shown in command list
agent: code # optional, route to a specific agent
model: anthropic/claude-sonnet # optional, override model
subtask: true # optional, run as subtask
---
Run all tests in $1 and fix failures.
Use $ARGUMENTS for the full arg string.
Reference files with @file and shell output with !`cmd`.
```

Template variables: `$1`-`$N` (positional args), `$ARGUMENTS` (full string), `@file` (file contents), `` !`cmd` `` (shell output).

### Finding a named command (canonical only)

Search these canonical roots explicitly with explicit `path`:

1. `${Global.Path.config}/` (global, e.g., `~/.config/kilo/`)
2. `canonicalRoot/.kilo/` (workspace/worktree root)

Use exact patterns:
- `**/command/<name>.md`
- `**/commands/<name>.md`

If not found in those canonical roots, the command is not present in loaded config. Do not search `.kilocode`, `.opencode`, `KILO_CONFIG_DIR`, or ancestor directories.

## Agents (`.kilo/agent/*.md` and `.kilo/agents/*.md`)

Canonical only: `canonicalRoot/.kilo/agent/**/*.md` / `canonicalRoot/.kilo/agents/**/*.md` and the same directly under the global `${Global.Path.config}` (e.g., `${Global.Path.config}/agent/**/*.md`). Do not create a global `.kilo` subdirectory — global assets live directly under `${Global.Path.config}/`.

```yaml
---
description: When to use this agent
mode: primary # primary | subagent | all
model: anthropic/claude-sonnet # optional override
steps: 25 # max agentic iterations
hidden: false # hide from @ menu (subagent only)
color: "#FF5733" # hex or theme name
permission: # optional, agent-level permissions
  bash: allow
  edit:
    "src/**": allow
    "*": ask
---
System prompt for this agent.
```

`mode` values: `primary` = selectable as main agent, `subagent` = only via Task tool, `all` = both.

## Agent Manager

For the full product guidance, use the canonical [Agent Manager reference](https://kilo.ai/docs/automate/agent-manager). Prefer these links instead of guessing documentation paths.

Agent Manager runs sessions locally in the current workspace root. Parallel Agent Manager sessions share the root directory; there are no per-session git worktrees, no setup/run scripts, and no `.kilo/worktrees/` checkouts. Terminal and chat routing use the workspace root.

## Permissions

Scalar form applies to all patterns. Object form maps glob patterns to actions. All rules across sources are flattened; the **last matching rule wins** (`findLast`). Put broad patterns first, specific overrides after.

```jsonc
{
  "permission": {
    "bash": "allow",
    "edit": {
      "src/**": "allow",
      "*.lock": "deny",
      "*": "ask",
    },
    "read": "ask",
    "skill": { "my-skill": "allow" },
    "external_directory": "deny",
  },
}
```

Actions: `"allow"`, `"ask"`, `"deny"`. Set `null` to delete an inherited key.

Tool permissions: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `webfetch`, `websearch`, `lsp`, `skill`, `external_directory`, `todowrite`, `todoread`, `question`, `doom_loop`.

## MCP Servers

```jsonc
{
  "mcp": {
    "local-server": {
      "type": "local",
      "command": ["node", "server.js"],
      "environment": { "PORT": "3000" },
      "enabled": true,
      "timeout": 10000,
    },
    "remote-server": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "headers": { "Authorization": "Bearer ..." },
      "oauth": { "clientId": "...", "scope": "read" },
      "enabled": true,
    },
  },
}
```

Disable an inherited server: `{ "server-name": { "enabled": false } }`.

### MCP Tool Permissions

MCP tools use the same permission system as built-in tools. Each MCP tool's permission key is `{server}_{tool}` (e.g. `github_create_pull_request`). Glob patterns are supported.

```jsonc
{
  "permission": {
    "github_*": "ask",
    "github_get_file_contents": "allow",
    "github_delete_file": "deny",
  },
}
```

## Providers

```jsonc
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "sk-...",
        "baseURL": "https://custom.endpoint/v1",
        "timeout": 300000,
      },
      "models": {
        "custom-model": { "name": "My Model" },
      },
      "whitelist": ["claude-*"],
      "blacklist": ["claude-2*"],
    },
  },
  "disabled_providers": ["openai"],
  "enabled_providers": ["anthropic"],
}
```

### Disabling Built-in Providers

Use `disabled_providers` to prevent specific providers from loading. This is useful when you want to exclude providers that are built-in, or auto-detected via environment variables, from appearing in the model picker.

For example, this configuration will hide all models from the built-in Kilo Gateway as well as any from the OpenAI provider which may be enabled automatically through environment variables.

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "disabled_providers": ["kilo", "openai"],
}
```

The provider ID is the lowercase name used in the `provider/model` format (e.g., `kilo`, `openai`, `anthropic`, `google`, `groq`).

**Interaction with `enabled_providers`:**

- `disabled_providers` removes specific providers from the auto-loaded set
- `enabled_providers` is more restrictive — when set, ONLY the listed providers will be enabled, ignoring all others
- If both are set, providers must appear in `enabled_providers` and not appear in `disabled_providers`

To disable all auto-detected providers except one:

```jsonc
{
  "enabled_providers": ["anthropic"],
}
```

## Skills

Canonical only: `canonicalRoot/.kilo/skill/<name>/SKILL.md` or `canonicalRoot/.kilo/skills/<name>/SKILL.md` and the same directly under the global `${Global.Path.config}` (e.g., `${Global.Path.config}/skill/<name>/SKILL.md`). Do not create a global `.kilo` subdirectory — global assets live directly under `${Global.Path.config}/`. Additional skill directories may be listed in `skills.paths` (resolved relative to canonical roots; no legacy `.kilocode` discovery).

```jsonc
{
  "skills": {
    "paths": ["./my-skills", "~/shared-skills"],
    "urls": ["https://example.com/.well-known/skills/"],
  },
}
```

## Other Top-Level Fields

| Field | Type | Description |
|---|---|---|
| `model` | `"provider/model"` | Default model |
| `small_model` | `"provider/model"` | Model for titles/summaries |
| `default_agent` | `string` | Default primary agent (fallback: `code`) |
| `instructions` | `string[]` | Glob patterns for additional instruction files |
| `plugin` | `string[]` | Plugin specifiers (npm packages or `file://` paths) |
| `snapshot` | `boolean` | Enable git snapshots |
| `share` | `"manual"\|"auto"\|"disabled"` | Session sharing mode |
| `autoupdate` | `boolean\|"notify"` | Auto-update behavior |
| `username` | `string` | Display name override |

## TUI Settings (Ctrl+P Command Palette)

The CLI TUI has runtime settings accessible via `Ctrl+P` (command palette) or slash commands. **These are user-interactive only — the agent cannot change them programmatically.** When users ask to change these settings, tell them which command palette entry, keybind, or slash command to use.

Leader key default: `ctrl+x`. Keybinds below use `<leader>` prefix (e.g. `<leader>t` = `ctrl+x` then `t`).

### Theme & Appearance

| Action | Keybind | Slash | Notes |
|---|---|---|---|
| Switch theme | `<leader>t` | `/themes` | Pick from 35+ built-in themes (kilo, catppuccin, dracula, github, gruvbox, nord, tokyonight, etc.) |
| Toggle appearance (dark/light) | — | — | Ctrl+P → "Toggle appearance" |

Custom themes: place JSON files in `~/.config/kilo/themes/` or `.kilo/themes/`.

### Session

| Action | Keybind | Slash |
|---|---|---|
| List sessions | `<leader>l` | `/sessions` |
| New session | `<leader>n` | `/new`, `/clear` |
| Share session | — | `/share` |
| Rename session | `ctrl+r` | `/rename` |
| Jump to message | `<leader>g` | `/timeline` |
| Fork from message | — | `/fork` |
| Undo message | `<leader>u` | `/undo` |
| Redo | `<leader>r` | `/redo` |
| Copy last response | `<leader>y` | `/copy` |
| Copy transcript | — | `/copy-session` |

### Agent & Model

| Action | Keybind | Slash |
|---|---|---|
| Switch model | `<leader>m` | `/models` |
| Switch agent | `<leader>a` | `/agents` |
| Toggle MCPs | — | `/mcps` |
| Cycle agent | `tab` / `shift+tab` | — |

### Display Toggles (via Ctrl+P)

Toggle animations, Toggle diff wrapping, Toggle sidebar (`<leader>b`), Toggle thinking (`/thinking`), Toggle tool details, Toggle timestamps (`/timestamps`), Toggle scrollbar, Toggle header, Toggle code concealment (`<leader>h`).

Notification settings are managed through `attention` in `tui.json` / `tui.jsonc`. There is no notification slash command or command-palette toggle.

### System

| Action | Slash |
|---|---|
| View status | `/status` |
| Help | `/help` |
| Exit | `/exit`, `/quit`, `/q` |
| Open editor | `/editor` |

## Config File Locations (canonical only)

| Scope | Path |
|---|---|
| Project | `canonicalRoot/.kilo/kilo.jsonc` |
| Global | `~/.config/kilo/kilo.jsonc` (or `$XDG_CONFIG_HOME/kilo/kilo.jsonc`) |

No other filenames are read in retained paths. In particular: `kilo.json`, `opencode.json`, `opencode.jsonc`, `config.json`, and any file outside the canonical roots is not a retained source. The project canonical directory `canonicalRoot/.kilo/` may contain `command/`, `commands/`, `agent/`, `agents/`, `skill/`, `skills/`, `rules/` typed assets; the global canonical directory `${Global.Path.config}/` may contain the same typed asset directories directly under the global root (e.g., `${Global.Path.config}/agent/`, `${Global.Path.config}/command/`). Do not create `${Global.Path.config}/.kilo/` — implementation does not read it.

> **Rules — canonical registered asset class, deferred materialization (P4.3 LOCK-006):** `rules` is a normative canonical typed-asset class in the extension registry/spec (`ASSET_DIRECTORIES` includes `rules`, R10) and is therefore a legal canonical file location as above. However, the current opencode effective-snapshot / materialization path does **not** yet consume `rules` assets into its effective config — no `rules` loader participates in `Config.Service`/`overlay`. This is a recorded contract gap, not a P4.3 reader to invent. See `specs/vscode-orchestrator/evidence/p4.3-rules-contract-gap.md`; no new rules loader/composition is created here.

### Config directories (canonical only)

Exactly two directories are considered:

1. Global: `~/.config/kilo/` (or `$XDG_CONFIG_HOME/kilo/`)
2. Workspace/worktree: `canonicalRoot/.kilo/`

No ancestor walk, no `.kilocode`/`.opencode` fallback, no `KILO_CONFIG_DIR`, no home `~/.kilo` / `~/.kilocode` scan in retained paths.

### Commands, agents, plugins (canonical only)

| Type | Pattern (inside each canonical root: `canonicalRoot/.kilo/` for project, `${Global.Path.config}/` for global) |
|---|---|
| Command | `{command,commands}/**/*.md` |
| Agent | `{agent,agents}/**/*.md` |
| Plugin | `{plugin,plugins}/*.{ts,js}` |

### Skills and instructions (canonical only)

| Scope | Path |
|---|---|
| Skills | `{skill,skills}/<name>/SKILL.md` inside a canonical `.kilo` |
| Instructions | `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, glob patterns from `instructions` config field |

## Retired sources — historical context only (not active)

The following were active before the P4.3 atomic legacy-reader cutover and are now retired. They are listed here so older docs and configs can be understood, but they must not be used for current instructions and no retained loader/mutation reads them.

- Legacy Kilo migrations (`.opencode` → `.kilo` conversions of modes, workflows→commands, rules/instructions, MCP servers, `.kilocodeignore` patterns)
- `mode`/`modes` typed assets (`{mode,modes}/*.md` and `{mode,modes}/**/*.md`) — legacy agent mode presets; not retained canonical assets in P4.3 and not scanned by the retained overlay/effective config
- Organization agent modes and Active Kilo Cloud organization config (fetched via OAuth / `<url>/api/config`)
- Auth-record `.well-known/opencode` remote config and optional `remote_config` URL
- Explicit env overrides: `KILO_CONFIG` (file), `KILO_CONFIG_DIR` (directory), `KILO_CONFIG_CONTENT` (inline JSON), `KILO_PERMISSION` (permission-only overlay), `KILO_DISABLE_PROJECT_CONFIG`
- Ancestor `.kilo`/`.kilocode` discovery walking CWD up to worktree root and primary-worktree fallback dirs; home `~/.kilocode`/`~/.kilo` scans
- Legacy filenames: `kilo.json`, `opencode.json`/`opencode.jsonc`, `config.json` (including global legacy TOML `config` auto-migration)
- Managed config dir (`/etc/kilo/`, `/Library/Application Support/kilo/`, `%ProgramData%\kilo\`) and macOS managed preferences (`ai.opencode.managed.plist` under `/Library/Managed Preferences/`)

Residual `.opencode` directories are detected only for the reference-only `kilo.local.opencode-config-detected` notification via `KilocodeConfig.detectOpencodeConfig` and are never read as config. The legacy source-inventory/Console reporting reader that listed the retired sources above was physically removed (P4.4); no diagnostic source-listing reader or reporting endpoint remains.

## Rules contract gap (P4.3 deferred — LOCK-006)

`rules` is a normative canonical typed-asset class in the extension registry/spec (R10, `ASSET_DIRECTORIES` includes `rules`), but the current opencode effective snapshot does not consume it. The class is preserved as the canonical registered definition; its opencode materialization (loader/composition/snapshot participation) is deferred follow-up. No new rules runtime was created in P4.3. See `specs/vscode-orchestrator/evidence/p4.3-rules-contract-gap.md`.

## Deferred boundaries

- **P4.4 open:** per-row inactive/removal evidence for the 13 retired removal classes and transport narrowing. The legacy source-inventory reader and its reporting endpoint are removed; the unreachable `config/managed.ts` helper is deleted (P4.4-T3); the orphaned `primary-worktree` helper is deleted (P4.4-T2); remaining inventory-adjacent residues (TUI/instruction/`ConfigPaths`, sandbox policy, SDK wrapper forwarding) and provider/catalog (LOCK-006) work stay open. Do not assume row-level evidence is complete.
- **P4.5 open:** deletion of old CLI/TUI/Console surfaces (`packages/opencode/src/cli`, `src/kilocode/tui`, and TUI handlers). Those surfaces remain in the repository during P4.3 and must not be edited as part of a P4.3 config change.

Configuration behavior described above is canonical-only as of P4.3 (LOCK-002). For runtime hot/cold classification and convergence, see `packages/opencode/src/kilocode/config/hot-keys.ts` and `packages/kilo-docs/pages/contributing/architecture/cli-runtime.md#config-update-lifecycle`.
