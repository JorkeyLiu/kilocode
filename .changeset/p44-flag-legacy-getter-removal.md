---
"@kilocode/cli": patch
---

Remove legacy `KILO_CONFIG`, `KILO_CONFIG_CONTENT`, and `KILO_PERMISSION` Flag overrides. The `Flag` entries for these environment variables are deleted and no longer affect effective configuration. Canonical file-authoritative config (`kilo.jsonc` under the global config root and `<workspaceRoot>/.kilo/`), `KILO_CONFIG_DIR` compatibility (TUI last-wins with `Global.Path.config` override), and sandbox deny-list safety remain unchanged.
