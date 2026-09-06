---
"kilo-code": patch
---

Fix CLI HTTP server stalling on startup when Bun-internal file descriptors are present without the extension private channel. The private carrier now activates only when both descriptors are sockets, so the server starts normally while extension session-list behavior is unchanged.
