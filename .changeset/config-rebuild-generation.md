---
"kilo-code": patch
---

Fix config saves interrupting active sessions: cold config changes now persist immediately and rebuild instances only after in-flight prompt and shell work finishes, instead of aborting running streams. The Settings Save button now saves directly without showing an interruption warning when sessions are busy. Invalid config saves return a clear 400 with the file path and validation issues instead of a generic 500, and the VS Code settings panel shows those details without losing your edits.
