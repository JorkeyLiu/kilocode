---
"@kilocode/cli": patch
"@opencode-ai/core": patch
---

Converge orphaned prompt + provider in-flight operations to a recorded terminal outcome on backend restart, so a crashed generation never stays in-flight, never orphans ownership, and never silently replays
