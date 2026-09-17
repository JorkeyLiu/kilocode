---
"@kilocode/cli": patch
---

Bind explicit port 0 directly to one OS-assigned ephemeral port instead of probing 4096 first, so `kilo serve --port 0` and `kilo web --port 0` start with a single app/transport build even when 4096 is occupied. An omitted port with no configured server port still prefers 4096, falling back to ephemeral only on bind conflict.
