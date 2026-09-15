---
"@kilocode/cli": patch
"kilo-code": patch
---

Set session sandbox state explicitly and idempotently. The VS Code toggle now requests the displayed target state private-first over the CLI private channel with exactly one SDK fallback, and repeating the same target never duplicates side effects.
