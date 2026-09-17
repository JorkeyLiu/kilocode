---
"@kilocode/cli": patch
---

Extension-owned local serve no longer waits on the telemetry identity network request or telemetry-only global config reads before listening; identity enrichment now settles in the background under CLI ownership.
