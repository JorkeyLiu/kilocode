---
"kilo-code": patch
"@kilocode/cli": patch
---

Fix bounded permission evaluator (R18): separate `question` and `question_tool` as distinct scalar permissions, correct hard-deny provenance to exact rule identity, and close the 18-test production-path matrix through `Permission.ask` (ceilings, exact approvals, ordinary-only allow-everything, child isolation, ordering). No P4.4/P4.5/P5 or transport closure; SDK HTTP/SSE bridge remains retained and private worker stays observation-only.
