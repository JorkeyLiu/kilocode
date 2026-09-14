---
"kilo-code": patch
---

Temporarily limit VS Code provider settings to custom providers only: built-in provider setup, sign-in, and account management show as unavailable while custom provider creation, editing, and model discovery keep working. Already-configured non-custom entries cannot be overwritten or removed through custom flows; new custom providers may use ordinary IDs and any future built-in ID collision will be handled if it arises.
