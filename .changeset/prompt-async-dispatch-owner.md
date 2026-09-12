---
"@kilocode/cli": patch
---

Route `prompt_async` with `messageID` through the same `SessionPromptDispatch` owner as the private carrier with stable identity and typed 204/400/404/409/500 responses. Duplicate `messageID` replays return accepted without creating a second user message or generation. Calls without `messageID` keep the existing legacy behavior.
