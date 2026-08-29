---
"kilo-code": patch
"@kilocode/cli": patch
---

Remove legacy configuration discovery from core Config. Canonical effective config now resolves only from `Global.Path.config/kilo.jsonc` and `<workspace>/.kilo/kilo.jsonc` with deterministic global → workspace order; ancestor `.opencode` directory walks and legacy filenames (`config.json`, `opencode.json`, `opencode.jsonc`) no longer contribute. P4.4 remains Active/residual with no phase, row, transport, storage, convergence, or P4.5/P5 closure.
