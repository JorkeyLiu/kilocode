---
"@kilocode/cli": patch
---

Lower journal read overhead for large reverts by loading all revert facts in one bounded batch instead of one query per file.
