---
"kilo-code": patch
"@kilocode/cli": patch
---

Private observation now safely refuses to start when a recovery marker (`.cutover-*.marker.json` or `.rollback-*.marker.json`) is present, preventing use of an unrecovered store.
