---
"kilo-code": patch
"@kilocode/cli": patch
---

Remove legacy `.opencode/plans/*.md` allow from legacy V1/CLI plan-mode permission composition (`packages/opencode/src/kilocode/agent/index.ts`, `packages/opencode/src/agent/agent.ts`). Legacy V1/CLI plan edits now allow only canonical `.kilo/plans/*.md`, `plans/*.md`, `.plans/*.md`, and the global data `plans/*.md` path; legacy `.opencode/plans` edits are denied there. Core V2 `packages/core/src/plugin/agent.ts` permission composition is a separate residual boundary not changed by this release. P4.4 remains Active/residual with no phase or row closure.
