---
"kilo-code": patch
---

Fix webview actions sometimes failing to update open panels: messages posted from the chat panel now dispatch in the host window realm so in-webview listeners reliably receive them alongside the extension.
