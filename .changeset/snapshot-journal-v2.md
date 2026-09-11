---
"@kilocode/cli": patch
"kilo-code": patch
---

Add a durable Snapshot v2 file mutation journal for edit, write, and apply_patch.

Each file change records complete before/after bytes in a content-addressed store.
Facts are queryable per session, message, call, path, and status.
File tools require the canonical journal from ToolRegistry and AppLayer.
Mutations carry item and sub indexes with a stable target-first move order.
Partial-batch failures preserve applied and failed facts for inspection.
Snapshot restore and session revert stay on the old Snapshot path.
