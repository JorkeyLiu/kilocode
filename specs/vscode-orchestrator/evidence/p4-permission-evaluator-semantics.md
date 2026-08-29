# P4 Permission Evaluator Semantics — Implementation and Matrix Evidence

> **Status: R18 EVALUATOR MATRIX COMPLETE — No transport or phase closure claimed.**
> This artifact records the bounded R18 semantics and points to the direct and production-path evidence that proves them. It does not claim transport narrowing, P4.4, P4.5, or P5 completion. The P4.3 pre-cutover checklist remains byte-identical and pending.

## Artifact Metadata

| Field | Value |
|---|---|
| Title | P4 Permission Evaluator Semantics — Implementation and Matrix Evidence |
| Date prepared | 2026-08-24 |
| Baseline commit (HEAD at preparation) | `1ea09d215c106ed845a5f582293ff36bbf331111` |
| Reference baseline (pre-amendment) | `d112c37780c8d1d844ecd94e40d3fe6e83ec3e02` |
| Baseline tag | R18 bounded decision |
| Status | R18 bounded evaluator implementation/test matrix complete |
| Phase gate | P4 remains Active; P4.4 remains Active/residual; P4.5 and P5 remain outside this closure |
| Evidence kind | Direct evaluator tests plus production-path integration |

This artifact is the evidence record required by the locked decisions for R18. The evaluator and focused tests are implemented in `packages/opencode`; no dual-read, import, compatibility reader, transport bridge, or phase-gate change is created.

## Authoritative Sources Cited

| Document | Section | What it authorizes |
|---|---|---|
| `specs/vscode-orchestrator/runtime-and-configuration-direction.md` | §5.3 Permission composition | Restrictive policy stack, monotonic deny/ask/allow, child inheritance, approval records |
| `specs/vscode-orchestrator/runtime-and-configuration-direction.md` | §9 R18 | Bounded resolution of the eight permission-evaluator areas |
| `specs/vscode-orchestrator/migration-tracker.md` | §4 Active Gates (P4 permission-evaluator gate) and §7 Decisions (R18) | R18 implementation/test closure status and evidence pointers; transport and phase gates remain active |
| `specs/vscode-orchestrator/evidence/p4.3-pre-cutover-reconciliation-checklist.md` | Entire file | Must remain byte-identical; reconciliation NOT performed; cutover NOT occurred |
| `specs/vscode-orchestrator/p0-current-state-inventory.md` | §6.1 config sources; §5.2 agent manifests | Canonical file/asset provenance |
| `packages/core/src/v1/config/permission.ts` | InputObject | Built-in permission identifier contract (mirrored in R18) |
| `packages/opencode/src/permission/index.ts` | `Permission.ask` and shared evaluator input builder | Production path delegates decisive evaluation to `packages/opencode/src/permission/evaluator.ts` |

## Bound — What This Artifact Is and Is Not

- **Is:** A durable specification of the bounded permission-evaluator semantics (R18) and evidence of its focused implementation/test matrix.
- **Is not:** Transport evidence or a P4/P4.4/P4.5/P5 phase closure. P4 remains Active; P4.4 remains Active/residual.
- **P4.3:** The pre-cutover checklist at `specs/vscode-orchestrator/evidence/p4.3-pre-cutover-reconciliation-checklist.md` is byte-for-byte preserved; no manual value, operator, date, or signature has been filled.

## Locked Decisions Preserved

- **LOCK-001:** P4.3 remains untouched and manual; no reader cutover, dual-read, import, or checklist completion claim.
- **LOCK-002:** This bounded unit implements and tests only the specified evaluator behavior; it does not change transport, storage, config rebuild/convergence, or phase-gate ownership.
- **LOCK-003:** Permission enforcement is runtime-owned in the private CLI/runtime (`packages/opencode`); the extension owns authoring/projection only. Shared permission IDs/types may live in the core package.
- **LOCK-004:** Canonical identifiers are `question` for the free-form question flow and `question_tool` for the question tool; no `mcp` alias.
- **LOCK-005:** Approval state is ephemeral runtime memory scoped to a session and exact request patterns; no second persistent store, no parent-allow inheritance, no durable approval side effect.
- **LOCK-006:** Policy composition is runtime ceilings → global → project → selected agent manifest → session restrictions; deny dominates ask dominates allow, with intra-document specificity and declaration order only; cross-layer rules never override one another.

## R18 Bounded Decision Summary

R18 is recorded in `specs/vscode-orchestrator/runtime-and-configuration-direction.md` §9 (after R17) and mirrored in `specs/vscode-orchestrator/migration-tracker.md` §7 Decisions (R18) (Owner Hub, Required by P4, dated 2026-08-24). The implementation and focused evidence close the bounded evaluator matrix without closing transport or any unrelated phase gate. R18 resolves exactly the eight areas below and nothing else. Additions to the ceiling catalog require a new bounded decision.

## 1. Hard-Safety Ceiling Catalog and Override Behavior (complete v1)

The ceiling catalog is finite and closed at v1. Only these three ceilings exist.

| Ceiling | Effect | Override | Example |
|---|---|---|---|
| (a) Runtime hard deny | Absolute deny — cannot be overridden by policy, approval, or allow-everything | None; no exact approval, no wildcard, no allow-everything bypasses | Any request matching a runtime hard-deny rule is denied even if global/project/agent allow it |
| (b) Protected canonical control/config paths — mutating access caps at ask | Any mutating permission covering a protected path caps at ask unless an explicit exact agent/path safety approval exists | Only an explicit exact approval for the exact canonical agent identity and exact canonical protected path resolves the ask; broad/wildcard (`*`, `**`, prefix `*`), permission `*`, and allow-everything/session allow do not bypass | Protected paths: global config root `~/.config/kilo/kilo.jsonc`, project config root `<workspaceRoot>/.kilo/kilo.jsonc`, all typed/config assets under canonical `<workspaceRoot>/.kilo/` (legacy `.kilocode/` is a pre-cutover safety boundary only until the P4.3 reader cutover — not a canonical target and does not survive cutover; its safety protection remains relevant only before cutover) except `plans/` (agent, command, rules, skills, workflows, config assets), and root control files `kilo.json`, `kilo.jsonc`, `opencode.json`, `opencode.jsonc`, `AGENTS.md`; mutating IDs include `edit`, `write`, `bash`, `external_directory` when targeting those paths |
| (c) Broad/wildcard read grants for `*.env` and `*.env.*` cap at ask | A broad allow whose pattern is `*.env` or `*.env.*` (for example `*`, `**/*.env`, `*.env.*`, `config/*.env.*`) caps at ask when the resolved read target is an env file | Only an explicit exact approval for the exact env file/pattern resolves the ask; literal `*.env.example` is exempt — a broad allow may directly allow it without an ask; broad/wildcard and allow-everything do not bypass the ask for `*.env`/`*.env.*` | `read` with pattern `secrets.env` under a `read: { "*": "allow" }` broad grant still asks; `read` with pattern `config.env.example` under the same broad grant allows |

Distinction: (a) is an absolute deny; (b) and (c) are ask ceilings. Additions to this catalog require a new bounded decision; no implementation may silently widen ceilings or invent a new ceiling class. Broad/wildcard patterns are defined as any pattern containing `*` or `**` not as an exact literal; an exact approval must match the canonicalized request pattern exactly, character-for-character, after canonicalization.

## 2. Evaluator Ownership

| Owner | Location | Authority |
|---|---|---|
| Private runtime | `packages/opencode` (Effect service / permission evaluator) | Sole authoritative enforcement of every request decision |
| Extension | `packages/kilo-vscode` | Authors canonical policy (`permission` fields in global/project `kilo.jsonc` and typed agent manifests) and renders decisions/provenance; never enforces |
| Core | `packages/core` | May hold shared permission IDs/types/schemas as source of truth for type unions; carries no enforcement authority |

No extension-side authoritative enforcement exists. Provenance rendered by the extension is a read-model projection of the runtime decision.

## 3. Permission Identifiers

| Canonical ID | Meaning | Provenance |
|---|---|---|
| `question` | Free-form question flow — a runtime ask rendered to the user (free-form text question) | Separate registry entry; request permission = `question`; decision provenance records `question` |
| `question_tool` | Question tool invocation — a harness tool a session invokes to ask the user | Separate registry entry; request permission = `question_tool`; decision provenance records `question_tool` |
| `mcp` | Not an authorization alias. Availability/discovery of MCP servers is governed by the `mcp` keyed records (section 3.2/4); authorization still uses the tool's permission ID (for example `read`, `bash`) | No `mcp` permission rule governs auth; an `mcp` allow does not bypass a tool deny |

Built-in identifiers follow the config contract (`permission` field) and include at least: `read`, `edit`, `bash`, `glob`, `grep`, `list`, `task`, `external_directory`, `skill`, `agent_manager`, `webfetch`, `websearch`, `lsp`, `doom_loop`, `todowrite`, `todoread`, `notebook_read`, `notebook_edit`, `notebook_execute`, plus `question` and `question_tool`. No arbitrary plugin IDs are invented beyond those represented by the `permission` `Record<string, Rule>` contract — unknown plugin IDs are valid string keys but are not enumerated here; they compose under the same rules.

## 4. Per-Session Approval Scope and Lifetime

| Approval kind | Scope | Lifetime | Canonicalization |
|---|---|---|---|
| `once` | One `operationId` only — canonical operation identity `operationId = permission:<permissionRequestId>` (for example `permission:per_abc123`) for the exact pending request instance that was asked, correlated via `request.operationId == approval.operationId`; `permissionRequestId` is the request ID (`per_abc123`), `operationId` is the canonical identity (`permission:per_abc123`), distinct from `request.permission` (`edit`, `question_tool`) which is the permission ID | Consumed on next use of that `operationId`; not retained after the operation completes | Pattern set as canonicalized absolute/canonical path or exact literal; `operationId` correlation required |
| `session` | Same session, same agent identity, same permission ID (`request.permission`), and exact canonicalized request pattern set | Until session end, explicit revoke, or runtime disposal/crash | Exact match only — wildcards or prefixes do not count as exact for ceiling-protected paths; `operationId` not used (pattern/session scope only) |

Rules: No wildcard approvals for ceiling-protected paths (b) or `*.env` (c). Child sessions never receive parent approvals. There is no parent-allow inheritance — a parent `allow` does not propagate. Runtime crash or disposal drops all approvals atomically. Durable policy changes happen only through explicit canonical file editing (`kilo.jsonc`, agent manifest) and are validated/materialized; they never occur as a side effect of a permission ask/reply. `allow-everything` (`permission: "*": "allow"` or session allow-everything) resolves only ordinary policy `ask`; it never resolves `deny` or any `ask-ceiling` for protected paths (b) or env files (c). Only an exact agent/path or exact env-file `once`/`session` approval for that `operationId`/exact pattern set resolves those ceiling `ask`s; no wildcard or allow-everything bypass exists. A single exact approval for the same operation (same session, same agent identity, same permission ID, exact canonical pattern set — `once` correlated via `permission:<permissionRequestId>`) resolves every matching ordinary `ask` and every class (b)/(c) `ask-ceiling` for that exact request; this single-approval mixed coverage does not extend to class (a) absolute hard deny, any `deny`, wildcard/broad patterns, permission `*`, or `allow-everything`.

## 5. Provenance Structure (v1 machine-readable, in-memory)

Provenance is diagnostic/read-model data and is not a second authority/store.

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `"1"` | Provenance envelope version |
| `request.permissionRequestId` | string | Raw request ID (for example `per_abc123`) emitted by the permission request; this is the suffix of the canonical identity |
| `request.operationId` | string | Canonical operation identity for this permission request instance, defined as `operationId = permission:<permissionRequestId>` (for example `permission:per_abc123`); distinct from `request.permission` which is the permission ID (`edit`, `question_tool`); same `operationId` identity is used to correlate a `once` approval's consumption (`request.operationId == approval.operationId`) |
| `request.permission` | string | Request permission ID (for example `edit`, `question`, `question_tool`) |
| `request.patterns` | string[] | Canonicalized request pattern set (exact patterns the evaluator judged) |
| `contributingLayers` | Layer[] | All layers evaluated in order: `runtime-ceiling`, `global`, `project`, `agent`, `session-restriction`, plus `approval` when present |
| `layers[].sourceKind` | string | `runtime-safety`, `global-file`, `project-file`, `agent-manifest`, `session-restriction`, `approval` |
| `layers[].canonicalPath` | string | Canonical absolute file path or asset ID (for example `~/.config/kilo/kilo.jsonc`, `<workspaceRoot>/.kilo/kilo.jsonc`, `agent:<id>`, `session:<id>`) |
| `layers[].decision` | `"deny"\|"ask"\|"ask-ceiling"\|"allow"\|"no-ceiling"` | Layer-level decision for that layer after evaluating its rules/ceiling; `no-ceiling` is valid only for `runtime-ceiling` when no (a)/(b)/(c) matches (neutral, not `ask`); final `decisive.result` is never `no-ceiling` — only `deny`/`ask`/`ask-ceiling`/`allow` |
| `layers[].rules[]` | RuleRef[] | Rule identity/pattern/action/order evaluated within that layer |
| `rules[].pattern` | string | Matched pattern |
| `rules[].action` | `"deny"\|"ask"\|"allow"` | Rule action (per-rule action; layer `decision` may be `ask-ceiling` or `no-ceiling` for runtime-ceiling) |
| `rules[].order` | number | Declaration order index within its document |
| `decisive.result` | `"deny"\|"ask"\|"ask-ceiling"\|"allow"` | Final decisive request result; never `no-ceiling` — `no-ceiling` is a runtime-ceiling layer contribution only (layer `decision`), not a final result |
| `decisive.reason` | string | Which ceiling/rule decided (for example `ceiling-b`, `global-deny`, `agent-ask`, `approval-exact`) |
| `decisive.ceilingId` | `"(a)"\|"(b)"\|"(c)"\|null` | Ceiling category when `ask-ceiling` |
| `approval` | object? | Present only when an exact approval resolved an ask (ceiling or ordinary policy) |
| `approval.kind` | `"once"\|"session"` | Approval kind |
| `approval.operationId` | string? | For `once` approvals, the exact `operationId` (`permission:<permissionRequestId>`, for example `permission:per_abc123`) consumed (correlates to `request.operationId`); for `session` approvals, omitted — resolution is by session/agent/permission ID/exact patterns, not by `operationId` |
| `approval.patterns` | string[] | Exact canonicalized pattern set the approval covers |
| `approval.scope` | string | Session ID + agent identity |
| `approval.expiry` | string? | `session-end` or `once-consumed` |

The provenance layer-decision representation is `deny|ask|ask-ceiling|allow|no-ceiling`; `no-ceiling` is a valid `layers[].decision` only for the always-evaluated `runtime-ceiling` layer when no ceiling (a)/(b)/(c) matches — it is explicit neutral (not `ask`) with no blocking effect on `allow` and is never a final `decisive.result` (which is only `deny|ask|ask-ceiling|allow`). When a ceiling matches the runtime-ceiling layer contributes `layers[].decision = "deny"` (a) or `"ask-ceiling"` (b)/(c). An applicable authored document or selected manifest with no matching rule contributes `layers[].decision = "ask"` (no-rule `ask`) and marks `decisive.reason = "<layer>-no-rule-ask"` (or `default-ask` when every applicable policy layer has no matching rule); this `ask` prevents `allow` by omission. A layer with no authored document, no selected manifest, or no session restriction is non-applicable and contributes no layer entry and no decision; it does not prevent `allow` by omission. Runtime ceilings remain always evaluated; neutral `no-ceiling` is included as a `layers[].decision` entry but does not create `ask` and does not block `allow`.

## 6. Child Propagation

- Children inherit enclosing denies and session restrictions from the parent session.
- Children never inherit parent allows.
- Children never inherit parent approvals (`once` or `session`).
- Each child re-evaluates global, project, its own selected agent manifest, and its own session restrictions independently.
- Nested descendants repeat the same rule (grandchild inherits the child's enclosing denies/restrictions, not the root's allows/approvals).

No approval leakage across sibling or parent-child boundaries. A child denied by a parent deny cannot be allowed by its own manifest.

## 7. Single-Document Wildcard/Rule Ordering

| Rank | Criterion | Description |
|---|---|---|
| 1 | Exact literal match | Rule pattern equals the request pattern character-for-character with no wildcard tokens |
| 2 | Greater literal specificity | More literal characters and fewer wildcard tokens; `*` and `**` each count as one wildcard token; `.` and `/` are literal when not part of `*` |
| 3 | Later declaration order | For a tie on rank 1-2, the rule declared later in the same document wins (higher order index) |

This ordering never crosses policy layers. Cross-layer ordering is by the ceiling/layer composition stack only. Missing rules in a document are not ordered — they are absent.

## 8. Explicit Composition Algorithm

```
function decide(request):
  # Runtime ceiling is always evaluated but neutral when no ceiling matches.
  # - runtime-ceiling: always evaluated; yields "deny" (a), "ask-ceiling" (b/c), or explicit neutral "no-ceiling" when no (a)/(b)/(c) matches (not "ask")
  # - global: applicable iff a global authored document exists
  # - project: applicable iff a project authored document exists under <workspaceRoot>/.kilo/
  # - agent: applicable iff a manifest is selected for this session
  # - session-restriction: applicable iff session restrictions exist for this session
  # A non-applicable policy layer contributes no decision and does not prevent allow.
  # An applicable authored/selected policy layer with no matching rule contributes "ask" (no-rule ask).
  # Runtime "no-ceiling" is neutral and does not contribute ask/deny nor prevent allow.
  perLayer = {}
  perLayer["runtime-ceiling"] = evaluateRuntimeCeiling(request)  # "deny" | "ask-ceiling" | "no-ceiling"
  applicablePolicyLayers = layersWherePolicySourceExists(request) # subset of ["global","project","agent","session-restriction"]
  for layer in applicablePolicyLayers:
    perLayer[layer] = decisiveActionInLayer(request, layer)  # using §7 ordering; no matching rule => "ask" (no-rule ask)
  evaluatedLayers = ["runtime-ceiling"] + applicablePolicyLayers  # runtime always included, even when neutral
  # Examples:
  # - global allow + project document exists but no matching project rule => project "ask" => overall ask (A-27) (runtime no-ceiling neutral does not block)
  # - standalone question_tool allow where global/project/agent/session layers have no authored document/selected manifest => those layers non-applicable => runtime no-ceiling neutral => allow if every applicable policy layer allows
  denies = any layer in evaluatedLayers where perLayer[layer] == "deny"  # includes class (a) hard deny
  ceilingAskPresent = perLayer["runtime-ceiling"] == "ask-ceiling"  # class (b)/(c) only
  ordinaryAskPresent = any layer in applicablePolicyLayers where perLayer[layer] == "ask"
  anyAsk = ceilingAskPresent || ordinaryAskPresent
  # Rule 1: deny dominates (LOCK-006) — class (a) absolute hard deny is never resolved by any approval or allow-everything
  if denies: return deny with provenance reason = highest-priority deny layer (ceiling (a) first)
  # Rule 2: every ask must be resolved before allow; deny already handled
  # - Ceiling asks (b) protected paths or (c) *.env broad-grant: resolve ONLY via an exact once/session approval
  #   for the same operation (same session, same agent identity, same permission ID = request.permission, exact canonical pattern set,
  #    correlated via operationId for once as request.operationId == approval.operationId == permission:<permissionRequestId>);
  #   the approval pattern must be exact canonical character-for-character with no wildcard — broad/wildcard patterns and allow-everything never resolve a ceiling.
  # - Ordinary policy asks: resolve via either an exact approval for the same operation (same session/agent/permission/patterns, once via operationId) or allow-everything in the same session.
  # - Class (a) is absolute deny and is never resolved; any deny already returned above.
  # - When ordinary and ceiling asks co-occur, a single exact approval for the same operation resolves every matching ordinary ask and every class (b)/(c) ask-ceiling for that exact request (no separate class discriminator).
  if anyAsk:
    hasExactApproval = exactApprovalCoversRequest(request)  # same session, same agent, same permission, exact canonical pattern set, once via operationId correlation; no wildcard, no allow-everything; does not cover class (a), any deny, permission *, or broad patterns
    ceilingResolved = !ceilingAskPresent || hasExactApproval  # single exact approval suffices for (b)/(c) ceiling asks
    ordinaryResolved = !ordinaryAskPresent || (hasExactApproval || allowEverythingFor(request) in same session)  # same exact approval also resolves ordinary ask
    if ceilingResolved && ordinaryResolved:
      return allow  # every ask resolved by its permitted resolver; single exact approval suffices for mixed ordinary+ceiling on same operation
    if !ceilingResolved:
      return ask-ceiling  # allow-everything does not resolve ceiling asks; only exact approval does
    if !ordinaryResolved:
      return ask
  # Rule 3: allow only when every applicable policy layer permits and runtime is not denying/capping, and at least one allow exists
  # Neutral runtime "no-ceiling" does not count as allow but does not block; non-applicable layers are not considered
  if applicablePolicyLayers.length > 0 && every layer in applicablePolicyLayers has perLayer[layer] == "allow" && perLayer["runtime-ceiling"] == "no-ceiling":
    return allow
  if applicablePolicyLayers.length == 0 && perLayer["runtime-ceiling"] == "no-ceiling":
    # No policy layers applicable and no ceiling — defaults handled as ask elsewhere; here no applicable allow exists => fall through to ask
    return ask
  # Fallback already handled via anyAsk; remaining neutral+allowing stack already returned
  return ask
```

- Applicable-layer semantics: the provenance layer-decision representation is `deny|ask|ask-ceiling|allow|no-ceiling`; the runtime-ceiling layer is always evaluated but yields explicit neutral `no-ceiling` (`layers[].decision = "no-ceiling"`) when no ceiling (a)/(b)/(c) matches, which is not `ask` and does not prevent `allow`. An authored/selected policy layer is applicable; a layer with no authored document, no selected manifest, or no session restriction is non-applicable and contributes no decision and does not block `allow`. An applicable authored/selected document with no matching rule contributes `ask` (no-rule `ask`) and prevents `allow` by omission. Runtime ceilings remain always evaluated; neutral `no-ceiling` is the result when no (a)/(b)/(c) matches (for example standalone `question_tool` allow with no ceiling => runtime `no-ceiling` neutral, project allow => `allow`). Mixed asks: when a request triggers both an ordinary policy `ask` and a ceiling `ask-ceiling`, every ask must be resolved before `allow` — a single exact `once`/`session` approval for the same operation (same session, same agent identity, same permission ID, exact canonical pattern set — `once` via `operationId == permission:<permissionRequestId>`) resolves every matching ordinary `ask` and every class (b)/(c) `ask-ceiling` for that exact request (no separate class discriminator; no wildcard, no allow-everything, no class (a) bypass); an ordinary `ask` may also be resolved by `allow-everything`. If any ordinary `ask` remains unresolved, the result is ordinary `ask`; if any ceiling `ask-ceiling` remains unresolved, the result is `ask-ceiling` (deny still dominates both). A mixed ordinary+ceiling request with that single exact approval therefore yields `allow`. Thus global `allow` + an existing project document with no matching project rule ⇒ `ask` (project applicable no-rule); a standalone `question_tool` allow with other policy layers non-applicable and runtime `no-ceiling` ⇒ `allow` if every applicable policy layer allows.
- Toggles (`tool` on/off) only change availability or add a session restriction; they never add a grant.
- Cross-layer rules never override one another — an allow in `project` cannot override a `global` deny or ask.
- No-rule across all applicable layers defaults to `ask` (and any single applicable no-rule in an otherwise-allowing stack also yields `ask` per A-27 / D-10); a stack consisting only of runtime `no-ceiling` plus non-applicable policy layers with no applicable `allow` also defaults to `ask`.
- Allow-everything (`permission: "*": "allow"` or session allow-everything) resolves only ordinary policy `ask`; it never resolves `deny`, class (a) absolute hard deny, or any `ask-ceiling` for protected paths (b) or env files (c). Only an exact `once`/`session` approval for the same operation (same session, same agent identity, same permission ID, exact canonical pattern set — `once` via `permission:<permissionRequestId>`) resolves those ceiling `ask`s, and that same single exact approval also resolves every matching ordinary `ask` for that exact request (no wildcard, broad pattern, permission `*`, or `allow-everything` bypass; no separate approval class discriminator); thus a mixed ordinary+ceiling request with one matching exact approval yields `allow`. Exact bounded approvals may resolve only class (b)/(c) ask ceilings; no approval resolves class (a) absolute hard deny, any `deny`, wildcard/broad ceiling attempts, permission `*`, or `allow-everything`.

## Decision Matrix (normative)

| # | Scenario | Expected decision | Provenance reason |
|---|---|---|---|
| D-01 | Any layer hard deny (a) with global allow | deny | ceiling-a absolute |
| D-02 | Protected path mutating request (b) with global allow, no approval | ask-ceiling | ceiling-b |
| D-03 | Same as D-02 with exact agent/path approval in same session | allow | approval-exact |
| D-04 | Same as D-02 with broad `*` approval | ask-ceiling | ceiling-b (broad not exact) |
| D-05 | Same as D-02 with allow-everything | ask-ceiling | ceiling-b (allow-everything never bypasses) |
| D-06 | `*.env` read under broad `read: "*": allow`, no approval | ask-ceiling | ceiling-c |
| D-07 | `*.env` read with exact approval for that file | allow | approval-exact |
| D-08 | `*.env.example` read under broad allow | allow | broad allow (exempt) |
| D-09 | `*.env.example` read with global deny | deny | global deny dominates |
| D-10 | No applicable rule across all applicable policy layers (each applicable policy layer has no matching rule; non-applicable layers absent; runtime evaluates to neutral `no-ceiling` when no ceiling matches) | ask | default-ask (runtime `no-ceiling` neutral does not create allow) |
| D-20 | Standalone `question_tool` (or any permission) allow where only one authored layer (e.g. project `question_tool: "allow"`) is applicable and all other policy layers are non-applicable (no authored document/selected manifest) and runtime evaluates to neutral `no-ceiling` (no matching ceiling) | allow | all applicable policy allow + runtime `no-ceiling` neutral (non-applicable layers contribute no decision) |
| D-21 | Mixed ordinary `ask` plus ceiling `ask-ceiling` (e.g. protected-path ceiling (b) plus applicable project no-rule `ask`) with only `allow-everything` present | `ask-ceiling` | ceiling not resolved — `allow-everything` resolves ordinary `ask` but never a ceiling; every ceiling ask requires exact approval |
| D-22 | Same mixed `ask` + `ask-ceiling` with single exact approval for the same operation (same session, same agent, same permission, exact canonical pattern set — `once` via `permission:<permissionRequestId>`) | `allow` | single exact approval resolves both — every matching ordinary `ask` and every class (b)/(c) `ask-ceiling` for that exact request; no separate class discriminator; does not extend to class (a), any `deny`, wildcard/broad, permission `*`, or `allow-everything` |
| D-11 | Agent allow with global deny | deny | global deny dominates |
| D-12 | Global allow with agent deny | deny | agent deny dominates |
| D-13 | Session restriction deny with otherwise allow | deny | session-restriction deny |
| D-14 | Session allow-everything with global deny | deny | deny dominates ask |
| D-15 | Question flow `question` denied, `question_tool` allowed | `question` deny, `question_tool` allow | separate IDs |
| D-16 | `mcp` allow with `read` deny on same target | deny | tool ID governs, not mcp |
| D-17 | Child request allowed by own manifest but parent deny exists | deny | inherited parent deny |
| D-18 | Child request with parent exact approval present | ask (or ceiling) | no parent approval inheritance |
| D-19 | Later exact rule beats earlier wildcard in same document | allow/deny per later exact | intra-document ordering rank 1 |

## Acceptance-Test Matrix (implemented and evidenced)

The direct matrix is implemented in `packages/opencode/test/permission/r18-evaluator.test.ts`; the production-path subset is implemented in `packages/opencode/test/permission/r18-production-path.test.ts` and exercises real disk-authored canonical global/project policy through `Permission.ask`.

| ID | Category | Test description | Preconditions | Input | Expected | Negative check |
|---|---|---|---|---|---|---|
| A-01 | Ceiling absolute | Hard deny cannot be overridden by any allow/approval | Global allow for path, runtime hard deny on path | Mutating request to hard-denied path | deny | No allow-everything or exact approval flips to allow |
| A-02 | Ceiling b ask | Protected path caps at ask | Global allow for `kilo.json` edit | `edit` `kilo.json` | ask-ceiling | Not allow |
| A-03 | Ceiling b exact approval | Exact approval resolves ask | As A-02 plus exact agent/path session approval | Same request in same session | allow | Broad `*` in same session still asks |
| A-04 | Ceiling b wildcard bypass | Broad wildcard cannot bypass | Global `edit: { "*": "allow" }` | `edit` `AGENTS.md` | ask-ceiling | Wildcard does not resolve |
| A-05 | Ceiling b allow-everything | Allow-everything cannot bypass | Session allow-everything | `edit` `.kilo/kilo.jsonc` | ask-ceiling | Not allow |
| A-06 | Ceiling c broad grant | Broad read caps at ask for env | Global `read: { "*": "allow" }` | `read` `secret.env` | ask-ceiling | Not allow |
| A-07 | Ceiling c exact approval | Exact env approval resolves | As A-06 plus exact approval for `secret.env` | Same request same session | allow | Exact for `other.env` does not resolve `secret.env` |
| A-08 | Ceiling c exempt | `.env.example` not capped | Global `read: { "*": "allow" }` | `read` `example.env.example` | allow | No ask |
| A-09 | Ceiling c nested pattern | `*.env.*` capped | Global `read: { "*": "allow" }` | `read` `config.env.backup` | ask-ceiling | Not allow |
| A-10 | Identifier separation | `question` vs `question_tool` separate | Policy denies `question`, allows `question_tool` | Each ID separately | Deny/allow respectively | `question` deny does not deny `question_tool` |
| A-11 | No mcp alias | `mcp` does not authorize | Policy allows `mcp`, denies `read` | `read` request via MCP tool | deny | `mcp` allow does not flip |
| A-12 | Approval once | Once approval consumed after one op | Ask then once approval | Same request twice | First allow, second ask | Not retained |
| A-13 | Approval session exact | Session approval only exact pattern set | Session approval for `fileA` | Request for `fileB` in same session | ask | Not allow |
| A-14 | Parent allow leakage | Child does not inherit parent allow | Parent allow, child global deny | Child request | deny | No parent allow counted |
| A-15 | Parent approval leakage | Child does not receive parent approval | Parent exact approval for env | Child request same file | ask-ceiling | No inheritance |
| A-16 | Wildcard broad grant negative | Wildcard session approval not valid for ceiling paths | Session approval `*` for protected path | Protected mutating request | ask-ceiling | Wildcard ignored |
| A-17 | `.env.example` positive | Broad grant allows example | Global allow, ceiling c not triggered for example | `read` `*.env.example` | allow | No ask even without exact approval |
| A-18 | Protected exact vs broad | Exact protected approval allows, broad does not | Both exist, same session | Protected request | allow only for exact, ask for broad | Distinguish |
| A-19 | Provenance completeness | Provenance includes all layers and decisive reason | Global deny, project allow | Denied request | deny + layers listed | No missing layer |
| A-20 | Provenance ceiling | Ceiling reason present | Protected ask-ceiling | Provenance result | `ask-ceiling` + ceilingId (b) | Not plain ask |
| A-21 | Crash disposal | Approvals dropped on crash | Session approval present then crash | Same request after restart | ask | No persistence |
| A-22 | Session disposal | Approvals dropped on session end | Session approval present then close | New session same pattern | ask | No persistence |
| A-23 | No second store | Durable file not written by approval | Session approval granted | Inspect canonical files | No file change | Files unchanged; only memory |
| A-24 | Single-document ordering | Exact beats wildcard | Same doc: `*.env` allow then `secret.env` deny | `secret.env` | deny | Earlier wildcard not decisive |
| A-25 | Intra-doc tie later wins | Later rule wins on tie | Same doc: two equal-specificity rules | Target | Later action wins | Earlier not wins |
| A-26 | Cross-layer no override | Project cannot override global deny | Global deny, project allow | Request | deny | Project allow ignored |
| A-27 | Multi-layer allow requires all applicable (applicable no-rule blocks allow) | All applicable layers must allow; applicable document with no matching rule contributes ask | Global `allow` for permission, project authored document exists but contains no matching rule for the request (applicable no-rule) | Request covered by global allow but no project rule | ask | Not allow — applicable project no-rule is `ask` and prevents allow by omission |
| A-28 | Toggle does not grant | Tool toggle on does not create allow | Tool enabled via toggle, no policy allow | Tool request | ask or deny per policy | Toggle never flips to allow |
| A-29 | Standalone allow with other layers non-applicable | Single applicable policy layer allow suffices when other policy layers are non-applicable and runtime is neutral | Only one authored layer exists (e.g. project `question_tool: "allow"`), all other policy layers have no authored document/selected manifest and are non-applicable; runtime evaluates to explicit neutral `no-ceiling` (no matching ceiling) for the request | `question_tool` request where only project layer is applicable and allows and runtime is `no-ceiling` neutral | allow | Non-applicable layers contribute no decision; runtime `no-ceiling` is neutral not `ask`; `allow` requires all *applicable* policy layers allow, runtime neutral, and at least one allow |
| A-30 | Mixed ordinary plus ceiling asks — every ask must be resolved | Every ceiling ask and every ordinary ask must be covered before `allow` | Protected-path ceiling (b) `ask-ceiling` plus applicable project no-rule `ask` co-occur; session has `allow-everything` but no exact ceiling approval | Same request in same session | `ask-ceiling` | `allow-everything` resolves ordinary `ask` only; ceiling still needs exact approval |
| A-31 | Mixed asks with single exact approval covering both ordinary and ceiling | Single exact approval resolves both ordinary and ceiling asks for the same operation | Same mixed stack as A-30 but session has a single exact approval for the same operation (same session, same agent, same permission, exact canonical pattern set — `once` via `permission:<permissionRequestId>`) and no `allow-everything` | Same request in same session | `allow` | Single exact approval covers every matching ordinary `ask` and every class (b)/(c) `ask-ceiling` for that exact request (no separate class discriminator); exclusions preserved — does not resolve class (a) hard deny, any `deny`, wildcard/broad ceiling attempt, permission `*`, or `allow-everything` |

Total coverage: ceilings (A-01..A-09), identifiers (A-10..A-11), approvals (A-12..A-13), leakage (A-14..A-16), protected exact vs broad (A-17..A-18), provenances (A-19..A-20), crash/disposal/no-store (A-21..A-23), ordering (A-24..A-26), composition (A-27..A-31: applicable no-rule vs standalone neutral `no-ceiling` allow vs mixed every-ask resolution including single exact approval covering both ordinary and (b)/(c) ceiling asks as `allow` per A-31/D-22). 31-case matrix.

## Implementation and Evidence

The authoritative evaluator is `packages/opencode/src/permission/evaluator.ts:410`, called by `packages/opencode/src/permission/index.ts:711` from `Permission.ask`. The shared input builder preserves the production path from `Global.Path.config` and `<workspaceRoot>/.kilo/kilo.jsonc` through canonical layers, evaluator, and provenance. Direct matrix coverage is in `packages/opencode/test/permission/r18-evaluator.test.ts`; production-path coverage is in `packages/opencode/test/permission/r18-production-path.test.ts`.

## P4.3 Checklist Is Untouched and Still Pending

- The file `specs/vscode-orchestrator/evidence/p4.3-pre-cutover-reconciliation-checklist.md` is byte-for-byte preserved as prepared on 2026-08-24 at checklist creation commit `8d8e73e80ea1cdc5c5bc13f591d9f40b7b35e304` (the checklist was not present at `fdf5fbcb3dab06b73a6cca08b8a239db26df9fbf`, which introduced only the P4.3 readiness inventory test). No operator, date, value, or signature has been filled.
- Evidence baseline is `1ea09d215c106ed845a5f582293ff36bbf331111` (HEAD at preparation); `d112c37780c8d1d844ecd94e40d3fe6e83ec3e02` is retained as the pre-amendment/reference baseline — separate from the checklist's creation baseline `8d8e73e80ea1cdc5c5bc13f591d9f40b7b35e304` / `fdf5fbcb3dab06b73a6cca08b8a239db26df9fbf`.
- Manual reconciliation is required before the P4.3 reader deletion boundary. This artifact creates no automation and does not claim completeness.
- Proof of reader deletion and per-row inactive evidence belongs to P4.4 after the cutover, not here.

## Verification (this unit)

| Command | Result |
|---|---|
| `git diff --check` | PASS — no whitespace errors |
| `bun test --isolate ./test/permission/r18-evaluator.test.ts` | PASS — 64 tests, 166 expect assertions |
| `bun test --isolate ./test/permission/r18-production-path.test.ts` | PASS — 18 tests, 106 expect assertions |
| `bun run typecheck` from `packages/opencode` | PASS |
| `bun run typecheck` from `packages/core` | PASS |
| `bun run script/check-md-table-padding.ts specs/vscode-orchestrator/evidence/p4-permission-evaluator-semantics.md specs/vscode-orchestrator/migration-tracker.md specs/vscode-orchestrator/runtime-and-configuration-direction.md` | PASS — no padded tables in these three markdown files |
| `bun run script/check-architecture-impact.ts --worktree` | Report-only — see below; no runtime boundary claimed |

Architecture impact: this unit updates the R18 evidence record alongside bounded permission evaluator/schema/tests. The architecture checker reported no signal requiring a canonical architecture-doc update; transport, storage, config-rebuild, and lifecycle boundaries are unchanged.

## Remaining Risks — Outside R18 bounded closure

| Risk | Impact | Next evidence required |
|---|---|---|
| Transport and P4.4 residual work | R18 evidence does not narrow or delete the SDK/HTTP/SSE bridge | Complete the separately tracked P4.4/P4.5 transport and removal gates |
| Child process isolation | The production-path child proof uses session plumbing and inherited rules, not OS process isolation | Retain child process/lifecycle evidence in its owning phase; no R18 claim follows |
| Config/lifecycle convergence | This evaluator unit does not change configuration rebuild ownership or convergence | Preserve the existing lifecycle evidence and gates |
| P4.3 not executed | Desired config lost at cutover | Sole user must manually fill pre-cutover checklist before reader deletion |

## Change Log

| Date | Change | By |
|---|---|---|
| 2026-08-24 | Initial creation: specification-only evidence for R18 bounded permission-evaluator semantics — complete v1 ceiling catalog (a absolute deny, b protected control/config paths with exact-approval exception, c `*.env`/`*.env.*` with `*.env.example` exempt), ownership (`packages/opencode` sole enforcement), canonical IDs `question`/`question_tool` separate vs `mcp` not alias, per-session ephemeral approvals (`once`/`session` exact, no wildcard for ceilings, no parent inheritance, crash/disposal drops, no file side effect), v1 provenance in-memory shape (schema version, request ID/patterns, all layers, source kind/path/asset ID, rule identity/order, decisive result/reason, approval metadata, diagnostic not second store), child propagation (inherits denies/restrictions, never allows/approvals), single-document ordering (exact→specificity→declaration order, never cross-layer), layered composition (deny→ask→allow, any deny => deny, any ask => ask unless exact approval, allow only when every layer permits, toggles never grant, no-rule => ask); decision matrix and 28-case future acceptance matrix including negative cases for deny override, parent allow/approval leakage, wildcard broad grants, `.env.example`, protected exact vs broad approval, question ID separation, provenance, crash/session disposal, no second store; explicitly states P4.3 checklist untouched and still pending; cites R18 and §5.3/gate; no implementation/test gate closure. Baseline `d112c37780c8d1d844ecd94e40d3fe6e83ec3e02`. | Manifestor execution of p4-permission-evaluator semantics amendment |
| 2026-08-24 | Amendment to resolve re-audit blockers (documentation-only): (1) coherent missing-layer rule — authored/selected layer is applicable, layer with no authored document/selected manifest/session restriction is non-applicable and contributes no decision, applicable document with no matching rule contributes `ask`, runtime ceilings/defaults remain applicable; global allow + existing project document with no rule => `ask` (A-27), standalone `question_tool` with other layers absent => `allow` if all applicable allow (D-20/A-29); pseudocode and D/A matrices aligned; (2) allow-everything correction — resolves only ordinary `ask`, never `deny` or any `ask-ceiling` (b/c); only exact agent/path or exact env-file approval resolves ceiling asks; (3) R18 mirrors corrected so `.kilo/` is canonical project tree and `.kilocode/` is only legacy pre-cutover safety boundary not surviving P4.3; (4) identity normalization — `permissionRequestId` = raw request ID (`per_abc123`), `operationId = permission:<permissionRequestId>` (`permission:per_abc123`), distinct from `request.permission` (`edit`, `question_tool`), `once` correlation via `operationId`; (5) evidence baseline updated to `1ea09d215c106ed845a5f582293ff36bbf331111` (HEAD at preparation), `d112c37780c8d1d844ecd94e40d3fe6e83ec3e02` retained as pre-amendment/reference baseline; P4.3 checklist byte-identical. | Manifestor execution of re-audit correction amendment |
| 2026-08-29 | R18 bounded evaluator implementation/test closure: direct 64-test matrix plus 18 production-path tests prove ceilings, exact approvals, ordinary-only allow-everything, no-rule/default behavior, decisive rule provenance, child deny/approval boundaries, same-document ordering, and separate `question`/`question_tool` identities. P4.4/P4.5/P5 remain outside scope. | Manifestor execution of bounded R18 evaluator closure |
