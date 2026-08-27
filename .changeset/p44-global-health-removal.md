---
"@kilocode/cli": major
"@kilocode/sdk": major
---

BREAKING: remove the deprecated public transport surface `GET /global/health` and its generated SDK/OpenAPI contract (`global.health`, `GlobalHealth`). Connection liveness continues solely through the existing SDK SSE `GET /global/event` heartbeat/reconnect path; no replacement health poll is introduced. Daemon liveness now probes authenticated `GET /global/config`; the retained `GET /api/health` v2 endpoint and all other global routes (`/global/event`, `/global/config`, `/global/dispose`, `/global/upgrade`) remain.
