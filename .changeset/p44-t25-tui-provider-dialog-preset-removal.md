---
"@kilocode/cli": patch
---

Remove preset-Kilo popularity, priority ordering, and recommendation display from the CLI TUI provider dialog. The dialog now uses deterministic generic ordering (display name case-insensitive with id tie-break) and a constant `Providers` category, with no `Popular` grouping or `(Recommended)` / preset hints, and no `OpenAI / Codex` title override. The Kilo Gateway recommended API-key guidance is removed while local `atomic-chat` guidance and generic failed-state, disabled-state, custom-provider, and auth flows remain. No provider catalog, transport, storage, SDK, ConfigPaths, or P5 behavior is changed, and no phase or matrix row is marked complete.
