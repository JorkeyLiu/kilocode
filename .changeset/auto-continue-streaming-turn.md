---
"@kilocode/cli": patch
---

Automatically continue replies that the provider cuts off mid-stream (finish "unknown"), at most once per turn, so responses no longer end mid-sentence. When a subagent task is continued this way, the parent now receives the full text — including the part before the cutoff — in a single task report.
