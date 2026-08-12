---
"kilo-code": patch
---

Start new sessions from configured agent, model, and thinking-strength values instead of the last used ones; restored sessions keep their actual historical model and strength — including sessions that ran with the provider default strength, which no longer fall through to stale remembered values; thinking-strength memory now shares the model.json variant map between the extension and the CLI, with existing VS Code memory migrated in without overwriting shared entries; explicit model and strength picks made in a fresh composer win for the upcoming session and are then remembered.
