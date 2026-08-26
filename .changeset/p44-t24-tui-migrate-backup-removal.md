---
"@kilocode/cli": patch
---

Stop creating backup files and stripping legacy fields during TUI migration. `tui-migrate` now only materializes a missing `tui.json` from legacy `theme`, `keybinds`, and `tui` fields in `kilo.json`/`kilo.jsonc` without modifying the source file or creating `*.tui-migration.bak` files. Existing `tui.json` is still preserved and legacy TUI directory discovery is unchanged.
