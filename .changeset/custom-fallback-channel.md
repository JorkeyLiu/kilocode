---
"@kilocode/cli": patch
"kilo-code": patch
---

Support arming one custom provider channel as the session fallback for rate limits: pick a configured provider/model, check it with a one-token availability probe, and let exhausted pre-output Kilo 429s take over once through the fallback and stay sticky for that session
