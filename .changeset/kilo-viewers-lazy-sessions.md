---
"@kilocode/cli": patch
---

Delay the KiloSessions heavy module graph out of KiloViewers layer build until the first viewed snapshot needs attachment, so startup no longer pays the import cost when presence is never used.
