---
"@kilocode/cli": patch
---

Cap locally computed session retry backoff at 30 seconds. Previously, an error response with ordinary headers that contained no usable `retry-after` value fell back to uncapped exponential delays; now the retry wait grows to 2s, 4s, 8s, 16s, and then stays at 30s for all later attempts. Valid server-provided `retry-after` values (including delays over 30 seconds) are still respected unchanged.
