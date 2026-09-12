// Private-first `skill/list` instance-inventory contract (production).
// Strict request/result validation plus the safe consumer projection
// (`{name, description?, location}`). The FD carrier invokes the same
// `Skill.Service.all()` used by `GET /skill`; the extension
// `loadSkills` is private-first with exactly one SDK `client.app.skills`
// fallback. SKILL.md `content` and file bytes never cross the boundary.
//
// Source facts (read-only, not imported):
// - Route: `GET /skill` with `WorkspaceRoutingQuery` (`directory?`,
//   `workspace?`) in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`
//   (`identifier: "skill.list"`, success `Array(Skill.Info)`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts`
//   `getSkill` returns `skill.all()` with no filter arguments.
// - Service: `packages/opencode/src/skill/index.ts` `Skill.all()`
//   (`Info[]`); `Info` = `{name, description?, location, content}`.
//   `all()` is `Object.values` insertion order; no sorting claim.
// - SDK: `client.app.skills({directory})` issues `GET /skill` and remains
//   the exactly-one fallback for failed/unavailable/invalid/ambiguous/
//   transport/closed/timeout outcomes. There is no domain terminal: every
//   failed result is fallback-eligible.
// - Consumer: `packages/kilo-vscode/src/kilo-provider/skills.ts`
//   `loadSkills` maps each entry to `{name, description, location}`
//   only, preserving the carrier's `Skill.Service.all()` order;
//   `content` never crosses that boundary.
// - Distinct from `skill/remove` (private-only mutation), `app.agents`,
//   and `command/list`. This contract never matches those operations.

import { isAbsolute, normalize, resolve } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

export function canonicalSkillListOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `skill-list:${token}`
}

export function parseSkillListOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`skill-list opId must be skill-list:<token>: ${opId}`)
  if (segs[0] !== "skill-list") throw new TypeError(`opId kind must be skill-list: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { token }
}

export interface SkillListContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "skill/list"
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

// eslint-disable-next-line complexity
export function validateSkillListContractRequest(raw: unknown): SkillListContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "skill/list") throw new Error("op must be skill/list")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for skill-list contract")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx as Record<string, unknown>)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0")) throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!isNonEmpty(ctx.workspace) || (ctx.workspace as string).includes("\0")) throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0) throw new Error("payload must be empty object for skill-list contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  parseSkillListOpId(raw.opId as string)
  const idem = parseSkillListOpId(raw.idempotencyKey as string)
  if (idem.token !== parseSkillListOpId(raw.opId as string).token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as SkillListContractRequest
}

export type SkillListScopeWhich = "directory" | "workspace" | "request"

export type SkillListScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: SkillListScopeWhich }

export function checkSkillListScope(
  req: SkillListContractRequest,
  expected: { directory: string; workspace?: string; token: string },
): SkillListScopeCheck {
  let want = expected.directory
  try {
    want = canonicalDir(expected.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  let got = req.context.directory
  try {
    got = canonicalDir(req.context.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  if (got !== want) return { ok: false, code: "scope_mismatch", which: "directory" }
  const wantWs = expected.workspace
  const gotWs = req.context.workspace
  if ((wantWs === undefined) !== (gotWs === undefined)) return { ok: false, code: "scope_mismatch", which: "workspace" }
  if (wantWs !== undefined && gotWs !== wantWs) return { ok: false, code: "scope_mismatch", which: "workspace" }
  const parsed = parseSkillListOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalSkillListOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound) return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Safe skill summary projection: the consumer subset
// (`kilo-provider/skills.ts` maps `{name, description, location}`).
// SKILL.md `content` and file bytes are excluded by design so fixtures
// cannot carry skill body content and no file meaning is inferred.
// Insertion order is preserved; no name-uniqueness is enforced.
export interface SkillListEntry {
  name: string
  description?: string
  location: string
}

const SKILL_LIST_ENTRY_FIELDS = new Set(["name", "description", "location"])

export function validateSkillListEntry(raw: unknown): SkillListEntry {
  if (!isRecord(raw)) throw new Error("skill entry must be object")
  assertAllowedKeys(raw as Record<string, unknown>, SKILL_LIST_ENTRY_FIELDS, "skill-entry")
  if (!isNonEmpty(raw.name)) throw new Error("skill-entry.name must be non-empty string")
  if (raw.description !== undefined && typeof raw.description !== "string") throw new Error("skill-entry.description must be string when present")
  if (!isNonEmpty(raw.location)) throw new Error("skill-entry.location must be non-empty string")
  return raw as unknown as SkillListEntry
}

export function validateSkillListEntries(raw: unknown): SkillListEntry[] {
  if (!Array.isArray(raw)) throw new Error("skills must be array")
  return (raw as unknown[]).map((item) => validateSkillListEntry(item))
}

export interface SkillListFailure {
  code: string
  message: string
  retryable: boolean
}

const SKILL_LIST_FAILURE_FORBIDDEN = new Set([
  "skill",
  "skills",
  "content",
  "location",
  "path",
  "file",
  "template",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "directory",
  "workspace",
])

const SKILL_LIST_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateSkillListFailure(raw: unknown): SkillListFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (SKILL_LIST_FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  assertAllowedKeys(raw as Record<string, unknown>, SKILL_LIST_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SkillListFailure
}

export type SkillListResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "skill/list"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { skills: SkillListEntry[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "skill/list"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: SkillListFailure }
      accepted: boolean
      failure: SkillListFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "skill/list"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSkillListAmbiguous(req: SkillListContractRequest, transportUnknown = true): SkillListResult {
  const out: SkillListResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "skill/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type SkillListWireOutcome =
  | { kind: "valid"; result: SkillListResult }
  | { kind: "invalid"; detail: string }

export class SkillListValidationError extends Error {
  readonly kind = "private-skill-list-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "SkillListValidationError"
    this.detail = detail
  }
}

export function isSkillListValidationError(v: unknown): v is SkillListValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-skill-list-validation"
}

export function normalizePrivateSkillListWire(raw: unknown, req: SkillListContractRequest): SkillListWireOutcome {
  try {
    const result = validateSkillListResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const SKILL_LIST_RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const SKILL_LIST_RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const SKILL_LIST_RESULT_AMBIGUOUS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "transportUnknown"])
const SKILL_LIST_OUTCOME_PLAIN = new Set(["type", "time"])
const SKILL_LIST_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateSkillListResult(raw: unknown, req: SkillListContractRequest): SkillListResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "skill/list") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous") throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number") throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    assertAllowedKeys(rec, SKILL_LIST_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, SKILL_LIST_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["skills"])
    for (const k of Object.keys(data as Record<string, unknown>)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateSkillListEntries((data as Record<string, unknown>).skills)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SkillListResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, SKILL_LIST_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, SKILL_LIST_OUTCOME_FAILED, "outcome")
    const failure = validateSkillListFailure(rec.failure)
    const outFailure = validateSkillListFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SkillListResult
  }
  assertAllowedKeys(rec, SKILL_LIST_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, SKILL_LIST_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean") throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SkillListResult
}
