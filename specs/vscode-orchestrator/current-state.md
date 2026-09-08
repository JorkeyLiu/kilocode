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
- Agent Manager session-list paging is private-first via the standalone no-lease canonical-DB projection (`observation/list` `PrivateObservationService` → `createSessionListDeps` over `SessionTable` with `directory` + `archived` + `time_updated DESC, id DESC`, `limit` 1..500, fields `id/title/parentID/directory/projectID/createdAt/updatedAt`, `nextCursor` iff truncated, `privateSessionReader` (`isEnabled`/`isStarted`/`list`/`get`/`messages`) injected non-owningly via `VscodeHost` → `KiloProvider` `sessionRefreshContext.listSessions` with `archived:false` and `normalizeSessionListNextCursor` reuse, bounded exactly-one SDK `experimental.session.list` fallback on gate-off/not-started/worker error/protocol invalidity preserving detached parity diagnostics). Paged list + bounded detail + paged messages are now private-first; lifecycle stays extension-owned; no sole private runtime authority beyond these surfaces.
- Standalone no-lease `observation/get` detail projection (`observation/get` `PrivateObservationService` → `createSessionGetDeps` over `SessionTable` by `sessionId` with canonical directory scoping, statuses `found`/`not_found`/`scope_mismatch` as versioned result union, fields `id/title/parentID/directory/projectID/createdAt/updatedAt` plus optional `agent`/`summary`/`revert`) is private-first for narrow `SessionDetail` via `PrivateSessionReader.get` (`validatePrivateGetResult` defensively revalidates `found` at provider boundary, `sdkSessionToDetail`/`observationSessionToDetail`/`detailToWebview` pure mappers preserve `parentID`/`revert`/`summary` null and ISO semantics plus empty `agent`/`summary`/`revert`). `found` is authoritative with no SDK and no parity; `not_found`/`scope_mismatch` are authoritative terminals with no SDK and no raw directory/id log; malformed/`InternalError`/`MethodNotFound`/transport/host-closed are bounded warnings then exactly one SDK `client.session.get` with `AbortSignal` preserved for strict `replace` and detached parity. `refreshSessionDetails`, strict `focus`/`replace` preludes, `handleSyncSession` (with `session.messages` via `Promise.all`), and `exportTranscript` (narrowed formatter) all use the central `getSessionDetail`; creation/rename/revert/unrevert/SSE writers map SDK `Session` → `SessionDetail`. `currentSession`/`setCurrentSession` narrowed to `SessionDetail`; dead `Host.getSessionInfo` full-`Session` promise removed. Lifecycle remains extension-owned; `KiloProvider`/`VscodeHost` never init/reconnect/dispose the private service.
- Bounded raw `observation/messages` page (`observation/messages` → `createSessionMessagesDeps` over `MessageTable`/`PartTable` with continuation `(time_created < t) OR (= and id < id)`, `time_created DESC, id DESC`, `limit` 1..100, `nextCursor` iff truncated, chronological ASC, storage-stripped via shared `message-read`) is private-first for paged reads via `PrivateSessionReader.messages` (`validatePrivateMessagesResult` defensively revalidates `found`/order/cursor/session binding plus per-part `sessionID`/`messageID` ownership at provider boundary, `found`/`not_found`/`scope_mismatch` authoritative with no SDK and private-authoritative paged results run no detached parity, malformed/`InternalError`/`MethodNotFound`/transport/closed bounded warnings then per bounded page read at most one private attempt and exactly one SDK `session.messages` with original `AbortSignal`, SDK paths including paged fallback and `limit=0` full reads retain detached parity bounded once per outer `fetchMessagePage` operation so multi-page assistant-boundary fill may issue one SDK request per page, `limit=0` full reads stay SDK-only); `messagesLoaded` then `drainSince` reconciliation plus stale-generation checks unchanged; lifecycle stays extension-owned and `KiloProvider`/`VscodeHost` never init/reconnect/dispose the private service.

## Unknowns that matter next

- FD carriers terminate in the same backend `AppLayer` and remain diagnostics-only; standalone observation is the ownership path.
- Agent Manager session-list paging, bounded single-session detail, and paged messages now consume the private `observation/list` + `observation/get` + `observation/messages` projections; the remaining unresolved boundary is that full-read (`limit=0`) messages, transcript export, and session lifecycle still depend on the SDK path, with no private authority beyond paged list + detail + paged messages and no transport removal.

No backlog lives here. Anything that does not change the next judgment is
omitted.
