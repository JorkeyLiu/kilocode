---
title: "CLI Runtime Architecture"
description: "Architecture of the Kilo CLI runtime, daemon, server, config update lifecycle and convergence, persistence, and SDK"
---

# CLI Runtime Architecture

The CLI (`packages/opencode/`) is Kilo Code's local agent engine. It owns agent execution, tools, sessions, provider integration, configuration, local persistence, directory routing, and HTTP surfaces used by editor clients.

{% callout type="info" title="Scope" %}
This page describes repository-defined local runtime behavior. It is not an endpoint catalog or a statement about cloud deployment configuration.
{% /callout %}

## Concepts

These terms describe local execution. They are separate from hosted Cloud Agent sessions described in [Cloud Platform](/docs/contributing/architecture/cloud-platform).

| Term | Meaning |
|---|---|
| Kilo CLI runtime | Local agent engine in `packages/opencode/` |
| `kilo serve` server | Local HTTP and SSE process used by editor clients; selected browser-oriented paths also use WebSocket |
| Local daemon | Detached reusable `kilo serve` server managed by `kilo daemon` commands |
| Directory context | Normalized local filesystem directory used to select local runtime state |
| Local runtime instance | Directory-keyed runtime context inside one Kilo CLI process |
| Local routing workspace | Optional routing context that can resolve to a local directory or remote target |
| Worktree directory | Alternate git worktree path used as directory context for isolated concurrent work |
| Process-shared state | Runtime service state shared by every directory context in one Kilo CLI process |
| Modes | Configurable agent presets for tools, prompts, restrictions, and behavior |
| MCP | Protocol for extending agent tools |

One `kilo serve` process can host several local runtime instances. Directory-keyed state stays isolated. Process-shared service state does not.

## Command entry points

| Entry point | Command or caller | Runtime model |
|---|---|---|
| Interactive TUI | `kilo` | Attaches to local daemon when available; otherwise starts Bun worker and sends SDK-shaped requests over RPC |
| Headless run | `kilo run` | Uses daemon attach when available, then embedded server fetch fallback |
| Attached run | `kilo run --attach <url>` | Targets explicit running `kilo serve` server |
| Explicit API server | `kilo serve` | Starts HTTP + SSE server for external local clients |
| Local daemon | `kilo daemon start` | Starts detached `kilo serve` child for reuse |
| Editor-spawned server | VS Code client | Starts bundled `kilo serve --port 0` child owned by editor client, not local daemon manager |

```mermaid
flowchart LR
  run["kilo run"]
  tui["kilo TUI"]
  daemon["Detached daemon: kilo serve"]
  worker["Bun worker"]
  rpc["RPC-backed fetch and global events"]
  embedded["Embedded Server.Default().app.fetch"]
  serve["Explicit kilo serve"]
  editors["VS Code"]
  editorServer["Editor-owned kilo serve --port 0"]
  runtime["Kilo CLI runtime"]

  run -->|"default first choice"| daemon
  run -->|"fallback"| embedded
  run -->|"--attach"| serve
  tui -->|"default when available"| daemon
  tui -->|"fallback"| worker --> rpc --> embedded
  editors --> editorServer
  daemon --> runtime
  embedded --> runtime
  serve --> runtime
  editorServer --> runtime
```

TUI fallback is not direct call from UI thread to embedded fetch. UI thread starts `worker.ts`; worker RPC method constructs request, calls `Server.Default().app.fetch()`, and forwards global events back to UI thread.

## One server with multiple directory contexts

Each running editor host starts one editor-owned `kilo serve` server. That server can handle coding sessions for workspace root and additional worktree directories at same time. It does not start separate server process for each directory.

```mermaid
flowchart LR
  views["Editor views<br/>Workspace root and worktrees"]
  server["One editor-owned<br/>kilo serve server"]
  store["InstanceStore"]
  root["Workspace-root<br/>local runtime instance"]
  worktree["Worktree<br/>local runtime instance"]
  sse["One process-wide<br/>/global/event stream"]

  views -->|"request includes directory"| server
  server --> store
  store -->|"select by directory"| root
  store -->|"select by directory"| worktree
  root -->|"event includes directory metadata"| sse
  worktree -->|"event includes directory metadata"| sse
  sse -->|"client routes event to matching view"| views
```

| Step | What happens | Why it matters |
|---|---|---|
| Send request | Editor client includes directory with local API request | CLI can distinguish workspace root from other directory contexts |
| Select state | `InstanceStore` normalizes directory and selects directory-keyed local runtime instance | Sessions for alternate directories keep isolated runtime state |
| Return events | Server publishes event with directory metadata through shared `/global/event` SSE stream | Editor client routes event to matching directory and session view |

This distinction matters for directory-scoped workspace requests. Directory-keyed state stays isolated. Process-wide event stream and server-owned service state remain shared; snapshot slow-track guard is one example. Authentication, provider routing, SSE, and snapshots appear in later sections.

## Authentication boundaries

Three credential boundaries coexist. Keep them separate when tracing request path or changing authentication code.

| Boundary | Protects | Owner |
|---|---|---|
| Local `kilo serve` access | HTTP, SSE, and selected WebSocket access to local server | Kilo CLI server and spawning local client |
| Outbound provider authentication | Model provider, Kilo Gateway, catalog, and indexing access | Kilo CLI provider router and auth stores |
| Remote MCP OAuth | Browser authorization and credentials for remote MCP server | Kilo CLI MCP runtime |

### Local `kilo serve` access

Server Basic Auth is optional. It becomes required when `KILO_SERVER_PASSWORD` is non-empty. Default username is `kilo`; `KILO_SERVER_USERNAME` can override it.

| Path or mode | Authentication behavior |
|---|---|
| Normal HTTP and SSE | Basic `Authorization` header when server password is configured |
| Browser WebSocket | `auth_token` query parameter accepts base64 `username:password` because browser WebSocket constructors cannot set arbitrary headers |
| Public UI assets | Selected manifest and icon GET paths bypass Basic Auth so browser metadata can load |
| PTY ticket issue | Authenticated `POST /pty/{ptyID}/connect-token` requires expected ticket header and allowed origin |
| PTY ticket connect | `GET /pty/{ptyID}/connect?ticket=...` bypasses Basic middleware, then consumes single-use, scope-bound ticket in PTY handler |
| PTY shell child | Removes `KILO_SERVER_PASSWORD` and `KILO_SERVER_USERNAME` from spawned user-shell environment |

PTY connect supports two browser-oriented modes: loopback query credential mode (`auth_token`) used by the VS Code Agent Manager path, and short-lived ticket mode exposed by server API.

### Outbound provider authentication

Provider auth records use `api`, `oauth`, or `wellknown` variants in `${Global.Path.data}/auth.json`, written with mode `0600`. `KILO_AUTH_CONTENT` can supply process-local auth JSON. Separate v2 multi-account auth store also exists for account-oriented flows.

| Path | Behavior |
|---|---|
| Direct providers | Use provider-specific keys, OAuth records, environment values, and configured endpoints |
| Kilo Gateway | Resolves Kilo model access and model catalog through gateway client |
| Anonymous Kilo | If no Kilo key exists, provider loader sets API key value `anonymous`; gateway model catalog can fall back to public unauthenticated endpoint |
| Organization catalog | Kilo model fetch includes organization ID when resolved from config, auth, or environment |
| Model cache | Caches provider model results for five minutes; failed loads invalidate cache for retry |
| Custom endpoints | Provider config can override endpoint and credential options |

### Remote MCP OAuth

Remote MCP OAuth belongs to CLI runtime. Static headers remain supported. For OAuth servers, CLI handles browser authorization and stores credentials in protected local state; editor clients invoke CLI-owned flow instead of storing MCP credentials themselves.

## Directory routing and local runtime instances

Instance routes select directory context in this order:

1. `directory` query parameter.
2. `x-kilo-directory` request header.
3. Server process cwd.

Local routing workspace selection is separate. Session workspace, `workspace` query parameter, and `KILO_WORKSPACE_ID` can select workspace context. Configured `KILO_WORKSPACE_ID` keeps requests local to current workspace runtime. Other selected workspaces resolve through workspace-routing adapter to local directory or remote target.

| Request plan | Behavior |
|---|---|
| Local | Provides resolved directory and optional workspace ID to request handlers |
| Remote | Proxies HTTP or WebSocket request to adapter target |
| Missing workspace | Returns workspace-not-found response |
| Workspace-routing local | Keeps selected local routes on local server instead of proxying |

Remote HTTP proxy responses can include sync fence metadata. Router waits for matching sync progress before returning. `InstanceStore` normalizes directory keys, deduplicates concurrent boots with deferred entry, and disposes directory state through registered cleanup hooks.

## Core subsystems

| Subsystem | Purpose |
|---|---|
| Agent runtime | Orchestrates messages, model calls, permissions, questions, and multi-step execution |
| Tool registry | Loads built-in, Kilo-specific, and MCP tools |
| LSP client | Provides diagnostics and language intelligence |
| Config service | Merges global, project, organization, managed, and runtime inputs |
| Instance store | Caches normalized directory-scoped runtime contexts |
| SQLite and storage services | Persist structured records and remaining JSON-owned data |
| Snapshot service | Tracks git-backed file baselines for diffs and revert flows |
| Provider router | Resolves direct providers, Kilo Gateway, custom endpoints, and credentials |
| HTTP server | Publishes REST, WebSocket, and SSE surfaces |

## Daemon lifecycle

`kilo daemon start|status|stop|restart` manage a detached local `kilo serve` child, with bare `kilo daemon` equivalent to `kilo daemon start`.

| Area | Behavior |
|---|---|
| State file | `${Global.Path.state}/daemon.json`, written with mode `0600` |
| Log file | `${Global.Path.log}/daemon.log`, created with mode `0600` |
| Port allocation | For `--port 0`, scans `4097..4116` and chooses available port |
| Child process | Detached `kilo serve --hostname <host> --port <port>` process |
| Foreground mode | `--foreground` / `-f` keeps the invoking command attached; SIGINT, SIGTERM, or SIGHUP stops only the daemon identity it started or reused |
| Health | Probes authenticated `/global/health` with 2 second timeout |
| Reuse | Reuses daemon only when process is alive, health succeeds, and installed version matches |
| Cleanup | Terminates stale process when present, clears stale state, then starts replacement |
| Opt-out | `KILO_NO_DAEMON` disables automatic attach by clients; explicit daemon commands still manage daemon |

Daemon credentials differ from editor-spawned server credentials. Current daemon source stores username `kilo`, password `kilo`, and base64 Basic token in `daemon.json`. File permissions protect this local credential record. Editor clients generate random passwords per spawned server.

## Persistence

SQLite is default structured store.

| Area | Behavior |
|---|---|
| Default database | `${Global.Path.data}/kilo.db` |
| Override | `KILO_DB`; relative paths resolve under data directory; `:memory:` is accepted |
| Runtime pragmas | WAL journal, normal sync, 5 second busy timeout, foreign keys, passive checkpoint, bounded cache |
| Fresh DB auto-vacuum | Newly created canonical DBs use `PRAGMA auto_vacuum = INCREMENTAL`; existing legacy DBs keep their current mode |
| Schema changes | Drizzle migrations load from bundled journal in compiled binary or migration directories in development |
| Main tables | Projects, sessions, messages, parts, todos, permissions, session messages, workspaces, sync events, accounts, and account state |
| Retention tables | `session_changefeed` (payload-free delete tombstones, global monotonic `seq`, no FK to `session`, unique `session_id, revision, kind`) and `retention_obligation` (durable artifact-cleanup obligations) |
| Legacy migration | On first database creation, CLI runs one-time JSON-to-SQLite migration for projects, sessions, messages, parts, todos, permissions, and shares |

Some JSON-backed storage remains. Session diffs still use storage path `session_diff`, and configuration, auth, and selected local state files retain their own owners. Snapshot storage is separate from SQLite and JSON storage.

### Automatic retention (S2)

Invisible private-runtime maintenance under internal byte-budget watermarks. Not a UI, config, or manual cleanup surface.

| Aspect | Behavior |
|---|---|
| Budget | High 8 GiB, low 6 GiB (25% hysteresis, resource bound, not a performance SLA). Values change only via recorded architecture decision |
| Scope | Physical bytes of active DB main file + WAL + registered session-family artifacts (`session_diff`, `session_diff_base`, `session_share`). Offline archives, logs/cache, and project-owned `snapshot` storage are excluded |
| Family | Root + descendants + owned messages/parts + registered family artifacts. Deletion is complete-family only, never partial transcript truncation |
| Eligibility | Protected when max activity across root+descendants is within 7 days, or any member is busy/in-flight (`SessionStatus`/`SessionRunState`) or holds a maintenance/read lease. Protections are revalidated in the same `BEGIN IMMEDIATE` transaction as deletion |
| Ordering | Eligible roots ordered by activity ascending, then root ID |
| Deletion | One `BEGIN IMMEDIATE` transaction per family: final `revision = current + 1`, payload-free `deleted` tombstone in `session_changefeed` (no FK), `retention_obligation` insert, then cascade hard-delete of the family. File cleanup is durable and idempotent via the obligation; crash after commit replays obligations at boot/off-hot-path |
| Registry | Closed artifact registry: `session_diff`, `session_diff_base`, `session_share` are family-owned file artifacts; `snapshot` is project-owned and never family-pruned; `session-export.db` is legacy cutover material. New artifact writes require a registry entry and unregistered writes fail closed |
| Reclamation | After pruning, `PRAGMA wal_checkpoint(TRUNCATE)` and bounded `PRAGMA incremental_vacuum(100)` run off the hot path when idle. WAL-inclusive before/after accounting |
| Maintenance | Coalesced after boot and canonical commits, runs only when idle and above high. If no eligible family or floor prevents reaching low, it stops safely and emits pressure diagnostics |
| Diagnostics | Per-run structured diagnostics (trigger, before/after bytes, selected/deleted/skipped counts with reasons, rows/artifact bytes reclaimed, checkpoint/vacuum result, failures) logged via `Effect.logInfo`. Not a UI surface |

## Snapshot state boundary

Snapshot baselines use separate git directory per project worktree:

```text
${Global.Path.data}/snapshot/<project-id>/<worktree-hash>
```

Snapshot implementation state is directory-keyed through `InstanceState`. One `Snapshot.Service` also owns process-shared slow-snapshot guard state outside directory cache. This distinction matters when multiple root-local VS Code sessions share one `kilo serve` process.

Snapshots are project-owned file artifacts (`snapshot`, owner `project`, retention `project` — not session-family pruned; `Artifact.familyKinds` excludes it). Cleanup is project-scoped live-ref aware and fail-safe:

| Aspect | Behavior |
|---|---|
| Live set | Project-scoped `Session.revert.snapshot` plus snapshot-bearing `Part` rows (`snapshot`/`patch`/`step-start`/`step-finish`) via `live-collector` |
| Prune | Aged refs `refs/kilo/snapshots/<timestamp>/<hash>` with timestamp < now−7 days and hash not in the live set are deleted; aged live refs and recent refs are retained |
| Unavailable data | If Database is unavailable or `fetchLiveHashes` fails, `resolveLiveForPrune` returns `null` and `shouldPrune` skips pruning before `git gc --prune=7.days` |
| Family retention | Family byte-budget pruning never deletes `snapshot`; it is collected only by project reachability |

Slow initial tracking has guarded behavior:

| Condition | Behavior |
|---|---|
| Fast track | Returns snapshot hash normally |
| Slow interactive track | After default 10 seconds, can prompt to keep waiting or disable snapshots for project |
| Managed Agent Manager turn | Sends `snapshotInitialization: "wait"`; waits without inline question so concurrent started sessions retain baselines |
| Visible long track | Adds temporary progress part after short delay, updates spinner, and removes part when done |
| Disable choice | Writes `"snapshot": false` to project config without disposing active turn |
| Dismissed or untargeted timeout | Interrupts or skips track and suppresses repeat prompt for active service scope |

## SDK contract

CLI server contract flows through generated and handwritten layers. This describes the current pipeline; the SDK and generated-client boundary is an implementation choice that may be refactored or removed, so compatibility with generated clients is present state, not a future invariant:

1. Effect `HttpApi` groups under `packages/opencode/src/server/routes/instance/httpapi/` define routes.
2. `packages/opencode/src/server/routes/instance/httpapi/public.ts` normalizes public OpenAPI to legacy-compatible request and response shapes.
3. Kilo-specific API groups and handlers live under `packages/opencode/src/kilocode/server/httpapi/` and enter shared API through narrow injection seams.
4. `packages/sdk/js/script/build.ts` generates TypeScript v2 client from CLI OpenAPI.
5. `packages/sdk/js/src/v2/client.ts` adds `createKiloClient()` wrapper for directory and workspace routing, Electron and Node fetch compatibility, and clearer empty-response errors.
6. Root `./script/generate.ts` runs SDK generation, emits tracked OpenAPI artifact, updates CLI docs, and formats outputs.

Regenerate checked-in JavaScript SDK output after server endpoint changes. Do not hand-edit generated client files.

## Config precedence

Later sources override earlier values during instance config load:

| Order | Source |
|---|---|
| 1 | Legacy Kilo migrations |
| 2 | Organization modes |
| 3 | Auth-record `.well-known/opencode` remote config |
| 4 | Global config files |
| 5 | Explicit `KILO_CONFIG` file |
| 6 | Project `kilo.json[c]` and `opencode.json[c]` files plus discovered config directories |
| 7 | `KILO_CONFIG_DIR` directory |
| 8 | `KILO_CONFIG_CONTENT` |
| 9 | Active Kilo Cloud organization config |
| 10 | Managed config directory |
| 11 | macOS managed preferences |
| 12 | Runtime flag-derived permission, tool, compaction, and plugin behavior |

Global config files load from `${Global.Path.config}`. Project updates prefer existing config files found in ancestor `.kilo` or legacy `.kilocode` directories, then existing project root config files, then create `.kilo/kilo.json`.

Signed-in organization modes become normal agent configuration during load. They override migrated legacy modes and remain overridable by later config sources in table.

How a config change applies at runtime is a separate concern from merge order: every field is classified hot or cold at introduction, and saves converge as described in [Config update lifecycle](#config-update-lifecycle).

Runtime config loading is separate from editor-facing JSON Schema publication. A cloud-served schema currently improves validation and completion for `kilo.json` and `kilo.jsonc`; it does not load, apply, or override effective runtime config, and it is a non-authoritative external surface. When adding or changing a config key, follow [CLI Config Schema](/docs/contributing/architecture/config-schema); the key completes within this repository regardless of the overlay.

## Config update lifecycle

Every config save is classified hot or cold. Schema shape lives in `Config.Info` in `packages/opencode/src/config/config.ts`; runtime hot classification lives in `packages/opencode/src/kilocode/config/hot-keys.ts`, and a field absent from the hot-key set is cold. Hot saves converge without a runtime rebuild; cold saves converge through a background pass that swaps the runtime for affected directories. Merge order for the sources is in [Config precedence](#config-precedence). The editor-facing schema surface is separate and non-authoritative — see [CLI Config Schema](/docs/contributing/architecture/config-schema).

| Component | Responsibility |
|---|---|
| `ConfigConvergence` | Coordinator that raises the admission fence before a cold mutation persists, assigns a monotonic sequence to each committed cold obligation, and runs serialized convergence passes |
| `GenerationGate` | Writer-preferring admission gate; convergence fences block new reader admission per directory or globally, never writers |
| `ControlLease` | Identity-keyed lifetime leases for drain-control and write-intent handlers; an identity is sealed and drained before it is disposed |
| Config snapshot | Generation-scoped `Config.Info` capture; every `Config.get` inside a generation returns the config it started with |
| `InstanceStore` | Directory-keyed runtime cache; disposal is identity-safe so an explicit reload survives convergence |

```mermaid
flowchart LR
  patch["Config PATCH"]
  classify{"Any cold field?"}
  hot["Persist, invalidate caches,<br/>emit config-updated"]
  fence["Raise admission fence<br/>for affected directories"]
  persist["Persist and acknowledge<br/>without drain wait"]
  register["Register convergence pass,<br/>then emit config-updated"]
  pass["Drain readers and write/control leases,<br/>dispose exact identities,<br/>boot latest disk state"]
  release["Release fence after latest<br/>committed version converges"]

  patch --> classify
  classify -->|"no"| hot
  classify -->|"yes"| fence --> persist --> register --> pass --> release
```

| Aspect | Hot save | Cold save |
|---|---|---|
| Runtime rebuild | None | Background convergence pass |
| Admission fence | Never | Raised before persistence for affected directories |
| Acknowledge | Immediately after persistence and cache invalidation | Immediately after the backend transaction and synchronous side effects |
| Generation drain wait | None | None — saves never await an active generation |
| `config-updated` | Emitted immediately | Emitted only after rebuild registration owns the fence |

Cold flow details:

- **Admission lanes.** A fence blocks new readers only. Hot config writes, write-intent operations, and drain-control operations keep working during a convergence cycle. In-flight generations hold reader leases and keep their startup config snapshot; new generations and readers wait until the fence releases, then bind to the post-convergence runtime.
- **Scope.** A project cold change fences and rebuilds only its directory; a global cold change covers every loaded directory. A cycle strengthens to global, never weakens.
- **Coalescing and latest state.** Obligations committed before a pass's turn coalesce into one drain→dispose→boot burst. A mutation racing the pass stays pending and forces another pass, so the fence releases only after the latest committed version converges. The newest pre-fence identity wins; `InstanceStore.dispose` is identity-safe, so an explicit reload between saves survives.
- **Reload and load during a fence.** Loads admitted under an active fence register with the fence; the coordinator converges confirmed directories before the fence can drop, so no runtime cached during convergence survives it.
- **Failure and shutdown.** A failed save aborts its obligation: the fence ref releases and no rebuild is registered, so a failed save never leaves the fence up. Shutdown rejects new work, interrupts and joins owned passes, and releases fences without rebooting.

Testing expectations: tests must cover saving during active streaming, not only idle PATCH. Drive a real handler with a held LLM stream and assert the save acknowledges before the stream releases, that hot saves never wait on a cold fence, that a cold burst coalesces into the intended disposal count, and that the final runtime serves the latest persisted config. Sequence races with Deferreds and admission side effects, not sleeps; await rebuild quiescence through the rebuild tracker.

## Global and instance SSE

| Stream | Scope | Payload |
|---|---|---|
| `/event` | One local runtime instance bus | Direct event payloads until instance disposal |
| `/global/event` | Process-wide multiplexed bus | Wrapper with payload and available directory, project, and workspace metadata |

Both streams send initial `server.connected` event and heartbeat every 10 seconds. VS Code consumes `/global/event` so one server connection can route events for multiple directories.

## Source map

Paths below are relative to [`Kilo-Org/kilocode`](https://github.com/Kilo-Org/kilocode).

| Concern | Source paths |
|---|---|
| CLI entry points | `packages/opencode/src/cli/cmd/` |
| Daemon | `packages/opencode/src/kilocode/daemon/` |
| HTTP server | `packages/opencode/src/server/` |
| Directory and workspace routing | `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` |
| SQLite | `packages/opencode/src/storage/db.ts` |
| Snapshots | `packages/opencode/src/snapshot/index.ts`{% linebreak /%}`packages/opencode/src/kilocode/snapshot/track.ts` |
| SDK | `packages/sdk/js/`{% linebreak /%}`script/generate.ts` |
| Config update lifecycle and convergence | `packages/opencode/src/kilocode/server/config-convergence.ts`{% linebreak /%}`packages/opencode/src/kilocode/server/config-rebuild.ts`{% linebreak /%}`packages/opencode/src/kilocode/server/generation-gate.ts`{% linebreak /%}`packages/opencode/src/kilocode/server/control-lease.ts` |
| Config schema shape | `packages/opencode/src/config/config.ts` |
| Config save classification (hot/cold) | `packages/opencode/src/kilocode/config/hot-keys.ts` |
| Provider routing and lifecycle | `packages/opencode/src/kilocode/provider/provider.ts` |
| Provider auth lifecycle | `packages/opencode/src/kilocode/server/provider-auth-lifecycle.ts` |
| Custom provider lifecycle | `packages/opencode/src/kilocode/custom-provider.ts`{% linebreak /%}`packages/opencode/src/kilocode/server/custom-provider-save.ts`{% linebreak /%}`packages/opencode/src/kilocode/server/custom-provider-delete.ts` |

## Related pages

- [Architecture Overview](/docs/contributing/architecture) - local and hosted execution map
- [VS Code Extension](/docs/contributing/architecture/vscode-extension) - extension-host ownership, Agent Manager, and webview bridge
- [Development Patterns](/docs/contributing/architecture/development-patterns) - API generation, code-ownership seams, and modular-boundary rules
- [CLI Config Schema](/docs/contributing/architecture/config-schema) - editor-facing schema surface for CLI config keys
