---
"kilo-code": patch
---

Fix stored provider credentials lingering in the extension host after every provider refresh. Fetching models for a saved custom provider without retyping its key now runs through a narrow runtime endpoint that holds the key server-side for the exact provider and base URL only, instead of caching the key from the broad provider list.
