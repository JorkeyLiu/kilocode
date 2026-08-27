---
"@kilocode/cli": patch
---

Remove legacy TUI configuration discovery sources so the TUI uses only the file-authoritative canonical inputs (global config root and `<workspaceRoot>/.kilo/`). Ancestor `.kilo`/`.kilocode` directory walks and the `KILO_CONFIG_DIR` environment override are no longer effective TUI config sources; `Global.Path.config` override and sandbox deny-list remain for compatibility/safety but do not affect TUI effective config. Workspace `tui.json` and `.kilo/tui.json` at the workspace root remain supported with deterministic global → direct → `.kilo` precedence. No provider catalog, SDK, transport, storage, or theme behavior is changed and no phase is marked complete.
