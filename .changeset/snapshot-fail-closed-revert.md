---
"@kilocode/cli": patch
---

Make session revert and unrevert fail loudly instead of silently succeeding when file restore fails, and serialize concurrent revert operations per session.
