---
"@kilocode/cli": patch
"kilo-code": patch
---

Route Agent Manager PTY creation private-first over the CLI private channel into the dedicated AppLayer-owned PtyServiceMap (same `PtyPreparation.prepareCreate` as HTTP `POST /pty`, no second owner) with exactly one same-tuple SDK fallback and no retry on either path. PTY WebSocket connect remains SDK/WS unchanged.
