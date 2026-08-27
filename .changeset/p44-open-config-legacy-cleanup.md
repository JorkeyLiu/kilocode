---
"kilo-code": patch
---

Remove legacy config-file picker choices from Open Config. The diagnostic picker now enumerates only canonical `kilo.jsonc` at the resolved global config root (including when `KILO_CONFIG_DIR` controls that root) and `<workspaceRoot>/.kilo/kilo.jsonc`; legacy home/`.kilocode`/`.opencode`/project-root filenames, `KILO_CONFIG`/`KILO_CONFIG_CONTENT` labels, and legacy loaded badges are removed. Canonical config authority, `KILO_CONFIG_DIR` resolved-root compatibility (`Flag.KILO_CONFIG_DIR` + `Global.Path.config` override + sandbox deny), `KILO_DISABLE_PROJECT_CONFIG` semantics, and creation/opening behavior are preserved. P4.4 remains Active/residual.
