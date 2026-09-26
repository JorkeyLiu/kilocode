---
"kilo-code": patch
"@kilocode/cli": patch
---

Route private serve realtime events over the fd `event/notify` stream instead of `/global/event` SSE, with SSE fallback when the peer is unavailable or unnegotiated
