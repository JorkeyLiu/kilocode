---
"@kilocode/cli": patch
"kilo-code": patch
---

Fix custom provider deletion interrupting active generations by coordinating through a single atomic backend endpoint that raises the convergence fence and rebuilds after active generations drain
