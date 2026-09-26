---
"@kilocode/cli": patch
"@opencode-ai/core": patch
"kilo-code": patch
---

Treat symlinked spellings of the same workspace directory as one session scope: opening the workspace through a symlink (for example `/var` versus `/private/var`) shows the same sessions, while a genuinely different directory is still rejected and existing sessions remain readable.
