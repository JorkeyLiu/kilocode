---
"kilo-code": patch
"@kilocode/cli": patch
---

Ensure persisted operation records are redacted before storage. `SessionOperation.put` now validates and runs `normalizeRecord` (secret scrub, length caps 500/1000/2000) before persistence, closing the prior boundary where caller-supplied records could bypass redaction. Bounded provider lifecycle wiring (`processor.ts` in-flight/terminal) remains the only production R11-R14 wiring; private-worker transport, retry, crash, and five-boundary convergence remain open and P4-G7 stays Active.
