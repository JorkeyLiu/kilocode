---
"kilo-code": patch
---

Fix missing live chat text when switching sessions while a reply is streaming. Post-boundary full part updates and new tail parts that arrive during history load are preserved after the history snapshot instead of being dropped. Deltas for parts already present in the snapshot are deferred to the backend's durable full part update rather than applied from ambiguous ephemeral chunks.
