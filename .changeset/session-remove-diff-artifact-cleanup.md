---
"@kilocode/cli": patch
---

Deleting a session now also removes its orphaned session diff artifacts. Previously the `session_diff` and `session_diff_base` files were left behind in the storage directory when a session was removed.
