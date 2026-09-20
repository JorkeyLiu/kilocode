---
"kilo-code": patch
---

Improve prompt and slash command reliability by retrying once on the same private transport when the first response is ambiguous, timed out, or the peer closes, before falling back to HTTP — reducing spurious failures without changing generation or duplicating messages.
