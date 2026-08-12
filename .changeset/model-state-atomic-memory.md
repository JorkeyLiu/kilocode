---
"kilo-code": patch
"@kilocode/cli": patch
---

Serialize all shared model.json reads and writes in the extension into one atomic critical section so concurrent model/strength saves can no longer lose updates, and write the file atomically so partial data can never be observed or destroyed; reset now also clears the migrated VS Code memory so cleared values cannot come back. Delegated agents now apply remembered thinking strength to the finally selected model even when the agent has no saved model, and restored sessions no longer show a stale remembered strength while their history is still loading.
