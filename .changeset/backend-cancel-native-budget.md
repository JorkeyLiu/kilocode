---
"@kilocode/cli": patch
"@opencode-ai/core": patch
---

Converge orphaned cancelQueued operations to an explicit terminal on backend restart instead of fabricating success, and count each V1 native provider retry against the shared per-response budget so rate-limit and server errors stop when the budget is exhausted.
