---
"kilo-code": patch
"@kilocode/cli": patch
---

Fix bounded permission evaluator (R18): separate `question` and `question_tool` as distinct scalar permissions with stable literal patterns (`free-form` free-form inquiry vs `ask-user` tool identity), correct hard-deny provenance to exact rule identity, remove the shared V1/V2 default `question` deny while keeping dedicated-agent/child explicit denies, and close the 18-test production-path matrix through `Permission.ask` (ceilings, exact approvals, ordinary-only allow-everything, child isolation, ordering). No P4.4/P4.5/P5 or transport closure; SDK HTTP/SSE bridge remains retained alongside the private FD carriers.
