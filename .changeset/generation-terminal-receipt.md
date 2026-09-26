---
"@kilocode/cli": patch
"@opencode-ai/core": patch
---

Record generation-linked terminal outcomes with their last retry timing: each finished chat and provider attempt keeps its linked generation plus the last billed retry layer, occurrence, and schedule in the same atomic write, unknown generations stay explicit, and a chat can belong to only one generation so retried submissions never run twice.
