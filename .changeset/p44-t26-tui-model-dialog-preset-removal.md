---
"@kilocode/cli": patch
---

Remove Kilo recommendation ranking and Popular providers presentation from the CLI TUI model dialog. The dialog now groups models under the provider display name when connected, with no `Recommended` Kilo category or disconnected `Popular providers` shortcut and no `kiloRank`/`recommendedIndex` ordering. Free/BYOK/May-train disclosures, favorites/recents, ModelInfoPanel, provider-scoped newest-first and footer free-first ordering, and generic DialogProvider flow remain. No provider catalog, data schema, transport, storage, SDK, ConfigPaths, or P5 behavior is changed, and no phase or matrix row is marked complete.
