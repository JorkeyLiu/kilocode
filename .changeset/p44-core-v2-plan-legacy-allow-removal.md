---
"kilo-code": patch
"@kilocode/cli": patch
---

Remove legacy `.opencode/plans/*.md` allow from core V2 plan-mode permission composition (`packages/core/src/plugin/agent.ts`). Core V2 plan edits now allow only the canonical `Global.Path.data/plans/*` (`external_directory`) and worktree-relative `Global.Path.data/plans/*.md` (`edit`) paths; legacy `.opencode/plans` edits are denied there. Preserves the prior V1/CLI removal (`packages/opencode/src/kilocode/agent/index.ts`, `packages/opencode/src/agent/agent.ts`). Bounded residual closure; P4.4 remains Active/residual with no phase, row, P4.4-G1/G2/G3/G4, P4.5, or P5 closure; SDK HTTP/SSE bridge retained, private worker observation-only.
