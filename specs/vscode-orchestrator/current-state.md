# VS Code Orchestrator — Current State

Reality that changes the next judgment. Code and observed behavior outrank
this note; when they disagree, the code is right.

## What holds today

- Agent Manager is the only chat surface in the product. The older single-chat
  sidebar and editor-tab chat are gone from the tree.
- The extension still runs as a client of one shared editor-owned backend
  process reached over HTTP with server-sent events through the generated SDK.
  That path is the current authority for sessions, not a future contract.
- Private file-descriptor carriers into the same backend exist as incremental
  work. They provide parity and diagnostics only; the SDK path stays
  authoritative and there is no cutover.
- Durable session operations with an atomic commit plus a bounded derived
  changefeed exist as an incremental foundation. They are not yet the
  authoritative history.
- A canonical file-authoritative configuration service and a private
  observation service exist in the extension, but the target ownership and
  cutover are unfinished. Effective configuration still comes from the CLI
  loader with its multi-source merge and convergence pass.
- Production permission decisions come only from
  `packages/opencode/src/permission/evaluator.ts`. Across
  global/project/agent/session-restriction layers, deny wins first,
  ask/ceiling next, and allow holds only when every applicable layer allows.
  The old last-match helper is not on this path.
- The extension restrictive `{global,project}` product from
  `packages/kilo-vscode/src/config/compose.ts` feeds only extension
  materialization/webview projection today, not CLI evaluator input; the CLI
  still assembles its layers from canonical files.
- The private runtime and storage cutover is unfinished. The legacy store
  still serves sessions until that landing.
- Agent Manager session-list re-observation decision is now owned by the extension standalone `PrivateObservationService` (snapshot/read/ack with observation coordinator, generation and singleflight) at `requestState` plus panel `visible` and active session-switch boundaries; the generated SDK remains the sole data authority, changefeed entries are decision/provenance only, and the old unconditional `refreshSessions()` is removed. Worker-restart/peer-close now drives the provider from the one bounded `PrivateObservationLifecycleTriggers.onPeerClosed()` reconnect+`read(persistedCursor)` — read failure (result absent, `readError`, `requestedCursor`/`readResult` absent/invalid, validated via `decideFromReadResult` without second read) -> precomputed singleflight fallback with `{shouldRefresh:true}`, exactly one SDK `refreshSessions()`, no second private read, no ack (singleflight-shared with `requestState`/`visible`); temporal staleness (current persisted `undefined` or not exactly equal to `requestedCursor`, whether < or >) -> normal fresh `handleObservationRefresh()` decision which may read again (the only second read); valid fresh -> no second read, re-checked before ack to avoid stale ack/regression. Window and config lifecycle reads remain observation-only. Extension `activate` constructs `PrivateObservationService`/triggers before the provider but defers `initialize()` until after `AgentManagerProvider` and `wirePeerCloseObservation` hook (fire-and-forget fail-closed, no TDZ), closing the activation race. Shared SDK/SSE transport reconnect (`KiloConnectionService` `onStateChange` `connected`) is distinct from private `peer:closed`; it re-enters the same private decision only after the provider has observed a prior `connected` baseline (`seenConnected` initialized from `getConnectionState()==="connected"` at construction), first `connected` remains owned by `requestState` hydration, and visibility is rechecked after `stateReady` with generation/sessions identity.
- Agent Manager session-list paging is private-first via the standalone no-lease canonical-DB projection (`observation/list` `PrivateObservationService` → `createSessionListDeps` over `SessionTable` with `directory` + `archived` + `time_updated DESC, id DESC`, `limit` 1..500, fields `id/title/parentID/directory/projectID/createdAt/updatedAt`, `nextCursor` iff truncated, `privateSessionList` injected non-owningly via `VscodeHost` → `KiloProvider` `sessionRefreshContext.listSessions` with `archived:false` and `normalizeSessionListNextCursor` reuse, bounded exactly-one SDK `experimental.session.list` fallback on gate-off/not-started/worker error/protocol invalidity preserving detached parity diagnostics). Full session detail/messages remain on existing SDK paths, lifecycle stays extension-owned; no sole private runtime authority beyond this list surface.
- Standalone no-lease `observation/get` detail projection (`observation/get` `PrivateObservationService` → `createSessionGetDeps` over `SessionTable` by `sessionId` with canonical directory scoping, statuses `found`/`not_found`/`scope_mismatch` as versioned result union, fields `id/title/parentID/directory/projectID/createdAt/updatedAt` plus optional `agent`/`summary`/`revert` with canonical `Session.Summary`/`Snapshot.SummaryFileDiff`/`Session.Revert` alignment) is available but not consumed; SDK remains the detail authority. This is continuity state, not architecture completion.

## Unknowns that matter next

- FD carriers terminate in the same backend `AppLayer` and remain diagnostics-only; standalone observation is the ownership path.
- Agent Manager session-list paging now consumes the private `observation/list` projection; the remaining unresolved boundary is that session detail/messages and session lifecycle still depend on the SDK path, with no private authority beyond the paged list and no transport removal.

No backlog lives here. Anything that does not change the next judgment is
omitted.
