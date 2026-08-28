# R18 Production-Path Integration Evidence — Disk-Authored Config to Enforcement

> **Status: BOUNDED INTEGRATION EVIDENCE — No phase/row closure claimed. P4.4 remains Active/residual; P4 remains Active.**
> This artifact proves the production path from real disk-authored global/project permission files through canonical config layer resolution to `Permission.ask` / evaluator / enforcement, including authored-empty vs absent, b/c ceiling exact approval positive/negative, once/session lifecycle with no durable mutation, child isolation, and provenance correctness. It does not claim transport narrowing, CLI/TUI deletion, or P4.4 completion.

## Artifact Metadata

| Field | Value |
|---|---|
| Title | R18 Production-Path Integration Evidence |
| Date prepared | 2026-08-28 |
| Baseline commit (HEAD at preparation) | `f5a9a3da5c` |
| Baseline tag | R18 bounded production-path subgate |
| Status | Bounded evidence — P4.4 Active/residual, P4 Active; no tracker row closed |
| Evidence kind | Integration — real disk files → canonical layer → Permission.Service → evaluator → provenance |

## Locked Decisions Preserved

| Lock | How preserved |
|---|---|
| LOCK-001 | This package completes R18 production enforcement evidence only; no transport migration, no P4.5 deletion, no P4.4 row closure. |
| LOCK-002 | Evaluator semantics unchanged except concrete defect fixes for ceiling (c) exact approval via service and exact-only protected approval storage (see Defect Fix). No sandbox/path/transport change. |
| LOCK-003 | Canonical-only paths preserved: `KILO_CONFIG_DIR -> Global.Path.config`, workspace `.kilo/plans` exemption, global `.kilo/plans` class-(b) protection, non-configuration `.kilocode` compatibility. |
| LOCK-004 | No P4.4 row closed; evidence bounded to R18 subgate. Class-(c) ceilings require exact, non-glob stored identities; wildcard selector input (`*`, `*.env`) is never stored as a wildcard approval identity — for a fully exact pending protected request it may normalize to that request's exact canonical approval if code retains that behavior, otherwise no wildcard stored. |

## Scope — What Is Proven

| Area | Proven via |
|---|---|
| Real disk-authored global/project files flow to Permission.ask | `r18-production-path.test.ts` disk writes to `Global.Path.config/kilo.jsonc` and `<workspace>/.kilo/kilo.jsonc` then `Permission.ask` |
| Authored-empty vs absent layer distinction | Empty `{"permission":{}}` global file is applicable `ask` vs absent global is non-applicable and allows |
| b ceiling (protected paths) and c ceiling (env) exact approval positive/negative | `edit kilo.json` (b) and `read secret.env` (c) with broad `*` allow cap at `ask-ceiling`; exact `session` approval resolves to `allow`; wildcard selector `*` never stored as wildcard identity and cross-pattern does not (exact selector `*` on an exact pending request may normalize to that exact canonical approval if retained) |
| c ceiling via saveAlwaysRules exact vs wildcard | `read secret.env` via `saveAlwaysRules` exact `secret.env` selector resolves only that target; `other.env` remains `ask-ceiling`; wildcard selector `*.env` never stored as wildcard identity and remains `ask-ceiling`; broad selector `*` never stored as wildcard `*` — for an exact pending protected request it may normalize to that request's exact canonical approval if retained, otherwise no wildcard stored |
| Once/session lifecycle and no durable mutation | `once` consumed after one op, `session` persists until `InstanceState.dispose`, file contents unchanged after both |
| Child isolation via real service session plumbing | Parent `session` approval for `kilo.json` not inherited by child session; session deny not leaked to sibling |
| Provenance read-model correctness through service | `Permission.provenance` shows `schemaVersion`, `permissionRequestId`/`operationId`, `contributingLayers` with correct `sourceKind`/`canonicalPath`/`decision`, `decisive`/`ceilingId`, `approval` metadata |

## Production-Path Test Matrix (new suite)

| Test | File:line | What it proves |
|---|---|---|
| absent global with project allow gives immediate allow | `packages/opencode/test/permission/r18-production-path.test.ts:64` | Absent global is non-applicable; project `bash *: allow` yields immediate `allow` with `project-file` provenance, no `global-file` |
| authored empty global is applicable ask versus absent allows | `packages/opencode/test/permission/r18-production-path.test.ts:92` | Empty `{"permission":{}}` global file is applicable `ask` that blocks project allow; provenance `global-file` `ask`; absent allows |
| global deny via real disk dominates project allow | `packages/opencode/test/permission/r18-production-path.test.ts:131` | Disk `global: bash *: deny` dominates `project: bash *: allow` → `deny` with `global-file` `deny` |
| project absent with global allow still allows | `packages/opencode/test/permission/r18-production-path.test.ts:168` | Single global allow with no project file yields `allow` |
| ceiling b ask-ceiling and exact approval positive/negative | `packages/opencode/test/permission/r18-production-path.test.ts:192` | `edit kilo.json` with `project: edit *: allow` caps at `ask-ceiling (b)`; exact `session` resolves; wildcard selector `*` never stored as wildcard identity (for exact pending request, `*` normalizes to exact canonical if retained), cross-session not inherited |
| ceiling c broad allow caps and exact approval resolves | `packages/opencode/test/permission/r18-production-path.test.ts:268` | `read secret.env` with `project: read *: allow` caps at `ask-ceiling (c)`; exact `session` for `secret.env` resolves, `other.env` not, `*.env.example` not capped |
| saveAlwaysRules c exact vs wildcard/broad | `packages/opencode/test/permission/r18-production-path.test.ts:341` | `saveAlwaysRules` exact selector `secret.env` resolves only that target; `other.env` remains `ask-ceiling`; wildcard selector `*.env` never stored as wildcard identity and remains `ask-ceiling`; broad selector `*` never stored as `*` — for exact pending request it may normalize to exact canonical if retained |
| once consumed after one op and no file mutation | `packages/opencode/test/permission/r18-production-path.test.ts:467` | `once` approval for `bash` allows one `operationId` then next same pattern pending; `kilo.jsonc` file unchanged |
| session persists until dispose and no durable mutation | `packages/opencode/test/permission/r18-production-path.test.ts:511` | `session` approval for `edit kilo.json` persists in same session, `InstanceState.dispose` drops it, file unchanged |
| child does not inherit parent session approval | `packages/opencode/test/permission/r18-production-path.test.ts:576` | Parent `sess_parent_approval` session approval for `kilo.json` not visible to `sess_child_approval` |
| child deny isolation | `packages/opencode/test/permission/r18-production-path.test.ts:631` | Session deny via `__testSetSessionRules` for `sess_parent_deny` does not leak to `sess_child_deny` |
| provenance correctness through service | `packages/opencode/test/permission/r18-production-path.test.ts:670` | `deny`/`ask`/`allow` provenance via service has `runtime-safety` first, correct `sourceKind`/`canonicalPath`/`decision`, `schemaVersion 1`, `request` ids, `approval` metadata |

## Defect Fix (LOCK-002 concrete)

| Location | Change | Reason |
|---|---|---|
| `packages/opencode/src/permission/index.ts:154` | Add `isCeilingCEnvFile` helper | Detect `*.env` / `*.env.*` (exempt `*.env.example`) for ceiling (c) |
| `packages/opencode/src/permission/index.ts:966` | `isProtForR18` now includes `read && isCeilingCEnvFile` | `reply always` for `read secret.env` was ordinary `global-approved` not `r18 session`; now creates `r18 session` so exact approval resolves `ask-ceiling (c)` |
| `packages/opencode/src/permission/index.ts:1076` | `isProt` now includes `read && isCeilingCEnvFile` | `saveAlwaysRules` for ceiling (c) likewise creates `r18 session` |
| `packages/opencode/src/permission/index.ts:1085` | Add `isProtExact` guard and reject glob fallback | `saveAlwaysRules` protected branch never stores fallback canonical containing glob; complete approval set must be exact; wildcard selector `*`/`*.env` never stored as wildcard identity — for an exact pending protected request, selector `*` may normalize to that request's exact canonical approval if retained, otherwise no wildcard stored |

Existing evaluator `evaluate` already implements (c) via `hasBroadAllowFor` and `exactApprovalCovers`; service path now aligns. No evaluator semantics changed; no transport/sandbox/path change.

## Verification

| Command | Result |
|---|---|
| `bun test ./test/permission/r18-production-path.test.ts` | PASS — 12 pass 77 expect |
| `bun test ./test/permission/r18-evaluator.test.ts ./test/permission/r18-service.test.ts ./test/permission/r18-blockers.test.ts ./test/permission/r18-production-path.test.ts` | PASS — 127 pass 440 expect |
| `bun run typecheck` (packages/opencode) | PASS |
| `bun run script/check-architecture-impact.ts --worktree` | PASS — `0 architecture signal(s) in changed files. none` / `RESULT: PASS` (observed 2026-08-28) |
| `bun run script/check-md-table-padding.ts` | PASS |
| `git diff --check` | PASS — no whitespace errors |

Architecture impact (observed 2026-08-28): `bun run script/check-architecture-impact.ts --worktree` → `check-architecture-impact: 0 architecture signal(s) in changed files. none` / `Local worktree mode — local semantic assessment is the primary standard; no PR declaration is required here.` / `RESULT: PASS`. The `isCeilingCEnvFile` / `isProtExact` changes touch `packages/opencode/src/permission/index.ts` only (permission service), no runtime lifecycle / config lifecycle docs; no architecture doc update required.

## What Is Not Claimed

- P4.4 row closure: none. Matrix at `specs/vscode-orchestrator/evidence/p4.4-source-removal-evidence-matrix.md` remains Active/residual.
- Transport narrowing / P4.5 deletion: not in scope.
- Durable `protected_files` writes via approvals: not claimed; approvals remain runtime-only.
- Child `fork` process isolation: covered via session-ID isolation in `InstanceState`, not OS process fork.

## Remaining Risks

| Risk | Mitigation |
|---|---|
| Global `Config` cache staleness if `Global.Path.config` overridden without stamp refresh | Tests use scoped `isolatedGlobal` helper (existing-style `Effect.addFinalizer` that restores `Global.Path.config` before `fs.rm` and propagates cleanup failure); verify via direct disk read in `resolveAuthoredGlobalLayers`; production uses `config.getGlobal` stamp refresh. |
| Ceiling (c) `*.env.example` exemption relies on `Wildcard.match` exact | Covered by `isCeilingCEnvFile` exempt check and evaluator `isEnvTarget` parity. |
| Session approval for protected `AGENTS.md` with `trustedContext` not exercised here (covered in existing blockers) | Existing `r18-blockers` covers `trustedContext` hijack and metadata-only protected. |

## Change Log

| Date | Change |
|---|---|
| 2026-08-28 | Bounded R18 production-path suite + ceiling (c) service fix + evidence artifact (this file) — no P4.4 closure. |
| 2026-08-28 | Audit repair: exact-only protected `saveAlwaysRules` (LOCK-004) — wildcard selector vs stored identity distinguished — deterministic readiness via `awaitWithTimeout` for immediate `allow` and `pollWithTimeout`-backed `waitForPending` polling `Permission.list` until expected pending count (project helper `test/lib/effect.ts` 20ms interval, 5s timeout), scoped `isolatedGlobal` helper (restores `Global.Path.config` before `fs.rm`, propagates cleanup failure, no mocks, no ad-hoc sleeps), new `saveAlwaysRules` c-exact test, corrected evidence file:line references (12 tests). |
| 2026-08-28 | Final bounded audit corrections: tracker R18 row now references bounded production implementation/test evidence and new evidence document with no contradiction (retains bounded-subgate wording and P4/P4.4 Active/residual), architecture impact recorded as observed `0 signals / PASS`, `waitForPending` replaced fixed `Effect.sleep` loop with `pollWithTimeout`-backed deterministic readiness polling `Permission.list`, evidence wording updated to truthfully describe synchronization mechanism, realistic `Permission.ask` async via `forkScoped` + poll readiness + `reply` preserved. |
