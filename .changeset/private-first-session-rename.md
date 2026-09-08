---
"kilo-code": patch
"@kilocode/cli": patch
---

Make session rename private-first: the extension attempts the private title-only update first and only falls back to one SDK update with the same durable identity on timeout, invalid result, or transport failure, while the CLI carrier commits the title update authoritatively.
