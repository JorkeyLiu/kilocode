---
"@kilocode/cli": patch
---

Clean up historical P4.4-T24 TUI migration backup behavior: the final artifact does not create legacy TUI migration backup files (`*.tui-migration.bak`) and does not strip or materialize legacy `theme`/`keybinds`/`tui` fields into `tui.json` (no `tui.json` materialization side effect on load).
