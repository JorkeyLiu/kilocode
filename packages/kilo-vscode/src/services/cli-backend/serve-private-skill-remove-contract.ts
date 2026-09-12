// Private-only `skill/remove` mutation contract (production).
// Request is strictly `{v:1,requestId,opId,op:"skill/remove",
// idempotencyKey,context:{directory,workspace?},payload:{location}}` with
// `opId === skill-remove:<token>` (token non-empty, no colon, no path
// material) and `idempotencyKey === opId`. The location is a descriptor-only
// observed registry value: the CLI resolves the exact registered Skill
// location, unlinks only SKILL.md via the shared cold-convergence mutation,
// and preserves sibling files. No file bytes cross the boundary; failures
// are redacted `{code,message,retryable}` results with echo-validated
// identities. No session_operation row is written.
//
// Source facts:
// - Route: `POST /kilocode/skill/remove` with `RemoveSkillPayload`
//   in `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts`
//   (`identifier: "kilocode.removeSkill"`).
// - Shared mutation: `packages/opencode/src/kilocode/skill-remove-execute.ts`
//   (`Skill.all` → `skill-remove.target` guards → `containsPath` scope →
//   `withColdMutation` → manifest-only `unlink`).
// - Private entry: `packages/opencode/src/kilocode/skill-remove-private.ts`
//   (`skill/remove` FD op, strict validation, drain-control lane,
//   `InstanceRef` scope, redacted terminal failures).
// - Consumer: `packages/kilo-vscode/src/kilo-provider/skill-remove-privatefirst.ts`
//   is private-only: no SDK fallback on any outcome; every outcome refreshes
//   authoritative skills/commands.

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

export function canonicalSkillRemoveOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `skill-remove:${token}`
}

export function parseSkillRemoveOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "skill-remove" || segs[1]!.length === 0)
    throw new TypeError("opId must be skill-remove:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new TypeError("opId must be skill-remove:<token> with nonempty colon-free token")
  return { token }
}

export interface SkillRemoveContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "skill/remove"
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: {
    location: string
  }
}

function validateIds(raw: Record<string, unknown>): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "skill/remove") throw new Error("op must be skill/remove")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for skill-remove contract")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (!pathless(raw.idempotencyKey as string)) throw new Error("idempotencyKey must not carry path material")
  const parsed = parseSkillRemoveOpId(raw.opId as string)
  const idem = parseSkillRemoveOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
}

function validateContext(raw: unknown): void {
  if (!record(raw)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(raw)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || raw.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  if (raw.workspace !== undefined) {
    if (typeof raw.workspace !== "string" || raw.workspace.length === 0 || (raw.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
}

function validatePayload(raw: unknown): void {
  if (!record(raw)) throw new Error("payload must be object")
  const allowedPayload = new Set(["location"])
  for (const k of Object.keys(raw)) if (!allowedPayload.has(k)) throw new Error("unexpected payload field")
  const location = (raw as Record<string, unknown>).location
  if (typeof location !== "string" || location.length === 0)
    throw new Error("payload.location must be non-empty string")
  if (location.includes("\0")) throw new Error("payload.location must not contain null bytes")
}

export function validateSkillRemoveContractRequest(raw: unknown): SkillRemoveContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  validateIds(raw)
  validateContext(raw.context)
  validatePayload(raw.payload)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as SkillRemoveContractRequest
}

export interface SkillRemoveFailure {
  code: string
  message: string
  retryable: boolean
}

export type SkillRemoveResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "skill/remove"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { removed: true }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "skill/remove"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: SkillRemoveFailure }
      accepted: boolean
      failure: SkillRemoveFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "skill/remove"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSkillRemoveAmbiguous(req: SkillRemoveContractRequest, transportUnknown = true): SkillRemoveResult {
  const out: SkillRemoveResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "skill/remove",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape ({code,message,retryable} only). Location, path,
// directory, and transport echo keys are rejected so responses cannot carry
// file bytes.
const FAILURE_FORBIDDEN = new Set([
  "location",
  "path",
  "file",
  "directory",
  "workspace",
  "stack",
  "stdout",
  "stderr",
  "data",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

// Only CLI-authoritative terminal codes are accepted; anything else is
// invalid wire and fails closed to ambiguous.
const FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "skill.builtin",
  "skill.url",
  "skill.not_found",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
])

export function validateSkillRemoveFailure(raw: unknown): SkillRemoveFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error("failure must not carry raw field")
  }
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!FAILURE_CODES.has(raw.code as string)) throw new Error("failure code is not CLI-authoritative")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SkillRemoveFailure
}

export type SkillRemoveWireOutcome = { kind: "valid"; result: SkillRemoveResult } | { kind: "invalid"; detail: string }

export const SKILL_REMOVE_INVALID_DETAIL = "invalid private response shape"

export class SkillRemoveValidationError extends Error {
  readonly kind = "private-skill-remove-validation" as const
  readonly detail: string
  constructor(_detail: string) {
    super(SKILL_REMOVE_INVALID_DETAIL)
    this.name = "SkillRemoveValidationError"
    this.detail = SKILL_REMOVE_INVALID_DETAIL
  }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateSkillRemoveResult(raw: unknown, req: SkillRemoveContractRequest): SkillRemoveResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "skill/remove") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "removed") throw new Error("unexpected data field")
    if (data.removed !== true) throw new Error("succeeded data.removed must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SkillRemoveResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = validateSkillRemoveFailure(rec.failure)
    const outFailure = validateSkillRemoveFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SkillRemoveResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SkillRemoveResult
}

export function normalizePrivateSkillRemoveWire(raw: unknown, req: SkillRemoveContractRequest): SkillRemoveWireOutcome {
  try {
    return { kind: "valid", result: validateSkillRemoveResult(raw, req) }
  } catch {
    return { kind: "invalid", detail: SKILL_REMOVE_INVALID_DETAIL }
  }
}
