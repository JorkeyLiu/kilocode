---
"kilo-code": patch
"@kilocode/cli": patch
---

Harden panel failure projection against direct raw-secret records. `buildPanelEnvelope()` now normalizes caller-supplied `FailureRecord` via `normalizeRecord` (secret scrub, caps 500/1000/2000, idempotent) before `select(..., "project")` in both `packages/opencode/src/private-worker/failure.ts` and `packages/kilo-vscode/src/private-worker/failure.ts` (parity), closing the prior projection boundary where unnormalized records could be projected. Version `1.0` and tier behavior unchanged. P4-G7 remains Active for transport/retry/crash/five-boundary.
