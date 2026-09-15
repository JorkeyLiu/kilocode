---
"@kilocode/cli": patch
"kilo-code": patch
---

Sandbox availability checks now prefer the trusted private channel with the same backend owner, falling back to the existing request only when needed. No behavior change when the backend is reachable.
