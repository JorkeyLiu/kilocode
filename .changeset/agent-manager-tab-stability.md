---
"kilo-code": patch
---

Keep Agent Manager tabs stable while the backend initializes, refreshes the session catalog, and closes the last tab: open tabs no longer vanish during startup or refresh, the first real session replaces the fresh empty draft instead of duplicating beside it, and closing a session keeps its committed tab state even when stopping background processes fails.
