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
- Permissions still evaluate under the current last-match behavior, not the
  approved restrictive composition.
- The private runtime and storage cutover is unfinished. The legacy store
  still serves sessions until that landing.

## Unknowns that matter next

- Which private carrier, if any, is proven far enough to widen beyond
  diagnostics without changing the SDK authority.
- What the smallest ownership landing is that moves one real datum from the
  shared backend bridge to the private runtime without a compatibility window.
- Where the permission composition lands first so behavior stays explainable
  while the current evaluation still runs.

No backlog lives here. Anything that does not change the next judgment is
omitted.
