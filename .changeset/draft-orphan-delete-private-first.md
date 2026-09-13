---
"kilo-code": patch
---

Avoid showing a misleading send failure when closing a draft that is still being created; its leftover session is now cleaned up through the same reliable delete path and stays silent if cleanup fails.
