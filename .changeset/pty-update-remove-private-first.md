---
"@kilocode/cli": patch
"kilo-code": patch
---

Route Agent Manager PTY resize and close/dispose private-first over the CLI private channel into the dedicated AppLayer-owned PtyServiceMap (no process-global singleton) with exactly one same-tuple SDK fallback. PTY create and WebSocket connect remain SDK/WS unchanged.
