---
"kilo-code": patch
"@kilocode/cli": patch
---

Remove the reference-only `.opencode` filesystem scanner and synthetic migration notification. The local `kilo.local.opencode-config-detected` notice is no longer synthesized in `kilo notifications`; cloud notifications remain. Canonical `isConfigDir` (`.kilo` only) and `Global.Path.config` + `KILO_CONFIG_DIR` override with sandbox deny are preserved. P4.4 remains Active/residual with no phase or row closure.
