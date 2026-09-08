---
"kilo-code": patch
"@kilocode/cli": patch
---

Make session fork private-first: the extension attempts the private fork first and only falls back to one SDK fork with the same durable identity on timeout, invalid result, or transport failure, while the CLI carrier commits the fork authoritatively.
