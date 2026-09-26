---
"@kilocode/cli": patch
"@opencode-ai/core": patch
---

Record each accepted generation with a durable owner and its accepted prompt members: the Runner prelude inserts the owner plus base member before any network, adopted queue prompts join in the same step, and exit closes the owner. Synthetic retargets and terminal prompts never become members. A restart closes orphaned owners as crashed with no replay and no changefeed.
