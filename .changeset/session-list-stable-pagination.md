---
"@kilocode/cli": patch
"kilo-code": patch
---

Continue long session lists reliably with an opaque page cursor: loading more sessions no longer skips or repeats entries when several sessions share the same update time, and outdated numeric cursors are rejected with a clear validation error instead of silently restarting the list.
