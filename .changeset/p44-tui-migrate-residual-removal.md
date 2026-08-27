---
"@kilocode/cli": patch
---

Remove the dead legacy TUI migration helper and its unused config flag. The file `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts` (`migrateTuiConfig`/`normalizeTui`/`TUI_SCHEMA_URL`) and the `Flag.KILO_TUI_CONFIG` getter have been physically deleted (2026-08-27 residual package, zero active callers since T27; no production reader). Canonical TUI loading remains global → direct root file → `<workspaceRoot>/.kilo` through `ConfigPaths.fileInDirectory` (`ConfigPaths.files` retained with no active TUI call), `KILO_CONFIG_DIR` getter, `Global.Path.config` override, sandbox policy, and theme handling unchanged. P4.4 remains Active/residual.
