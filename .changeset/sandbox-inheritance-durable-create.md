---
"@kilocode/cli": patch
"kilo-code": patch
---

Make `sandboxInheritanceToken` durable via `session/create`: hash token immediately, persist `sandbox_token_hash/source` with per-op reservation singleflight, private-first with same tuple+token fallback, one session and one grant deduction on replay/timeout.
