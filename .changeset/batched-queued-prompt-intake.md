---
"@kilocode/cli": patch
---

Adopt follow-up messages sent while a session is generating into the current turn at the next safe boundary instead of closing the turn as interrupted. All prompts queued while the assistant streams are answered together in one continuous run, each new prompt still resolves with the final assistant result.
