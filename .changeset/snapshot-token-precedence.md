---
"kilo-code": patch
---

Fix replace/reconcile snapshot races with deterministic scheduler commit precedence: capture flushes pre-token queued state, same-session captures are latest-wins with scheduler commit as the authoritative validation taking the live queue before deleting it, so real full updates replay correctively after the snapshot, snapshot-present deltas drop, and snapshot-absent delta-derived updates emit only the unflushed pending queue while already flushed deltas stay in the projection without duplicating delta text. Non-keyable updates stay outside the guarantee.
