---
"kilo-code": patch
---

Agent Manager session timers now show cumulative active-generation runtime that persists across panel close/reopen and extension restarts. The timer stops and keeps its final value when a session goes idle, resumes appending on the next run, and is pruned when a session is forgotten or deleted.
