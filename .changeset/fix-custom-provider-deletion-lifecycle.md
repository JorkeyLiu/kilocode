---
"@kilocode/cli": patch
"kilo-code": patch
---

Fix custom provider deletion interrupting active generations by coordinating through a single atomic backend endpoint with GenerationGate write ticket
