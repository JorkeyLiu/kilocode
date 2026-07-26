---
"kilo-code": minor
---

Support viewing and updating saved API keys for supported providers (source=api) in the Provider Connect dialog. When managing an existing API-key provider, the dialog fetches the credential on demand, displays it in a password field with a show/hide toggle, and provides explicit Update/Remove semantics with unchanged-value and empty-value guards. Config and env-sourced providers are excluded from key management.
