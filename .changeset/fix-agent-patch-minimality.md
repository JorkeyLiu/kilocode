---
"kilo-code": patch
---

Editing, creating, or importing an agent no longer persists unrelated resolved fields by routing all config updates through a shared `agentPatch` helper that emits only the targeted agent entry.
