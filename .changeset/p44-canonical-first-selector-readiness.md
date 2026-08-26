---
"kilo-code": patch
---

Publish provider, agent, and config selectors from canonical materialization without waiting for backend connectivity. Selectors render from extension-owned indexes as soon as canonical config is ready, independently of HTTP/SSE connection or global data-ready, with the SDK/SSE bridge retained for noncanonical/background reconciliation.
