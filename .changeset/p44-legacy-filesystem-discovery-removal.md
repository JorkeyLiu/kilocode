---
"kilo-code": patch
"@kilocode/cli": patch
---

Remove legacy filesystem discovery fallbacks for configuration and project identity. Global skill discovery now scans only `~/.kilo`, workspace skills only `.kilo`, project ID resolution only `.kilo/config.json`, and permission config protection only `.kilo/` (legacy `.kilocode`/` .opencode` fallbacks removed). Canonical `.kilo` behavior, `KILO_CONFIG_DIR -> Global.Path.config` compatibility and sandbox protections remain; TUI theme compatibility (`theme.tsx` `[".kilocode",".kilo"]`) is preserved. P4.4 remains Active/residual with no phase or row closure.
