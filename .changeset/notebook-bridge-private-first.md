"@kilocode/cli": patch
"kilo-code": patch
---

Migrate the active notebook bridge to private-first over the CLI private channel with exactly one SDK fallback. Notebook list, reply, and reject keep existing accepted/stale behavior with zero SDK on private success.
