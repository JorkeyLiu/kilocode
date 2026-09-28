---
"kilo-code": patch
---

Stop reissuing VS Code operations after an uncertain result. Abort, fork, create, delete, rename, revert, prompt, command, permission, suggestion, notebook, and instance reload now return an explicit unresolved status or re-observe the exact operation once instead of running a second mutation, with no fabricated success. Show runtime-restart interruptions in Agent Manager as "Stopped after runtime restart" instead of "Cancelled".
