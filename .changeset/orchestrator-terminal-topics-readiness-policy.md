---
"kilo-code": patch
"@kilocode/cli": patch
---

Remove Agent Manager terminal tabs and integrated-terminal context actions, including the `@terminal` mention. Topics search and keyboard navigation now share the same derived thread order, the composer waits visibly until the runtime is ready instead of stalling silently, and permission decisions stay pinned to the config version each request started with. Runtime cleanup is more resilient across backend restarts, stopping only still-owned processes before a replacement starts.
