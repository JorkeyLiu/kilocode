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
- Agent Manager `agentManager.requestState` session-list re-observation decision is now owned by the extension standalone `PrivateObservationService` (snapshot/read/ack) per panel hydration; the generated SDK remains the sole data authority, changefeed entries are decision/provenance only, and the old unconditional `refreshSessions()` is removed.

## Unknowns that matter next

- Which private carrier, if any, is proven far enough to widen beyond
  diagnostics without changing the SDK authority.

No backlog lives here. Anything that does not change the next judgment is
omitted.
