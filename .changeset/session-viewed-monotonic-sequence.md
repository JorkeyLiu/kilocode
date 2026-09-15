---
"kilo-code": patch
---

Require a monotonic `sequence` on every `session/viewed` snapshot so an older in-flight presence snapshot can never overwrite a newer accepted one. Each viewer sends a strictly increasing non-negative sequence with every snapshot (including detach/empty); the backend keeps the newest sequence per viewer, silently drops stale or duplicate snapshots without refreshing the 120s TTL, and still unions attachment across viewers with the existing 60s keepalive.
