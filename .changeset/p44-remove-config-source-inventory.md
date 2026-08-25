---
"@kilocode/cli": major
"@kilocode/sdk": major
---

BREAKING: remove the legacy effective-config source-inventory public API: the diagnostic source listing (`/config/sources`, `ConfigSourcesResponse`, and the `config.sources` SDK method) is removed, and the config overlay response no longer echoes a `sources` list. Canonical global/project `kilo.jsonc` files and assets remain the sole effective-config authority; the retained config-console bridge endpoints (`/config/overlay`, `/config/effective`, `/config/transaction`, rules, model-state, TUI config/keybinds) are unchanged.