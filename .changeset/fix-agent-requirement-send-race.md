---
"kilo-code": patch
---

Fix sending a message immediately after selecting an agent failing with "Agent requirement check was superseded". The send now shares the in-flight agent requirement check with the agent pick instead of racing it, so the first send goes through.
