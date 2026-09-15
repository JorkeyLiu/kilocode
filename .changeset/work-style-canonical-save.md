---
"kilo-code": patch
---

Work Style presets now save through the file-authoritative canonical config service instead of a direct backend write, so permission and display choices persist to `kilo.jsonc` with validation, stale-write protection, and rollback on failure.
