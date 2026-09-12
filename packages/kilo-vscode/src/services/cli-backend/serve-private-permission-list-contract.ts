import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

export function canonicalPermissionListOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("token must not carry path material")
  return `permission-list:${token}`
}

export function parsePermissionListOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`permission-list opId must be permission-list:<token>: ${opId}`)
  if (segs[0] !== "permission-list") throw new TypeError(`opId kind must be permission-list: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId token must be non-empty: ${opId}`)
  if (token.includes("\0")) throw new TypeError("opId token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("opId token must not carry path material")
  return { token }
}

export interface PermissionListContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "permission/list"
  idempotencyKey: string
  context: { directory: string }
  payload: Record<string, never>
}

export function validatePermissionListContractRequest(raw: unknown): PermissionListContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  clean(raw.opId, "opId")
  if (raw.op !== "permission/list") throw new Error("op must be permission/list")
  clean(raw.idempotencyKey, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for permission-list")
  const parsed = parsePermissionListOpId(raw.opId as string)
  const idem = parsePermissionListOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as PermissionListContractRequest
}

function isPermissionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("per")
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

export interface PermissionListEntry {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

const ENTRY_FIELDS = new Set(["id", "sessionID", "permission", "patterns", "metadata", "always", "tool"])
const TOOL_FIELDS = new Set(["messageID", "callID"])

function checkListStrings(v: unknown, label: string): void {
  if (!Array.isArray(v)) throw new Error(`${label} must be array`)
  for (const e of v as unknown[]) {
    if (typeof e !== "string") throw new Error(`${label} must be strings`)
    if ((e as string).includes("\0")) throw new Error(`${label} must not contain null bytes`)
  }
}

function checkListTool(v: unknown): void {
  if (v === undefined) return
  if (!record(v)) throw new Error("permission entry tool must be object")
  for (const k of Object.keys(v)) {
    if (!TOOL_FIELDS.has(k)) throw new Error(`unexpected permission tool field ${k}`)
  }
  const tool = v as Record<string, unknown>
  if (typeof tool.messageID !== "string" || tool.messageID.length === 0)
    throw new Error("permission entry tool.messageID must be non-empty string")
  if (typeof tool.callID !== "string" || tool.callID.length === 0)
    throw new Error("permission entry tool.callID must be non-empty string")
}

export function validatePermissionListEntry(raw: unknown): PermissionListEntry {
  if (!record(raw)) throw new Error("permission entry must be object")
  for (const k of Object.keys(raw)) {
    if (!ENTRY_FIELDS.has(k)) throw new Error(`unexpected permission entry field ${k}`)
  }
  if (!isPermissionId(raw.id)) throw new Error("permission entry id must be PermissionID")
  if ((raw.id as string).includes("\0")) throw new Error("permission entry id must not contain null bytes")
  if (!isSessionId(raw.sessionID)) throw new Error("permission entry sessionID must be SessionID")
  if (typeof raw.permission !== "string" || raw.permission.length === 0)
    throw new Error("permission entry permission must be non-empty string")
  if ((raw.permission as string).includes("\0"))
    throw new Error("permission entry permission must not contain null bytes")
  checkListStrings(raw.patterns, "permission entry patterns")
  if (!record(raw.metadata)) throw new Error("permission entry metadata must be object")
  checkListStrings(raw.always, "permission entry always")
  checkListTool(raw.tool)
  return raw as unknown as PermissionListEntry
}

export function validatePermissionListEntries(raw: unknown): PermissionListEntry[] {
  if (!Array.isArray(raw)) throw new Error("permissions must be array")
  return (raw as unknown[]).map((item) => validatePermissionListEntry(item))
}

export interface PermissionListFailure {
  code: string
  message: string
  retryable: boolean
}

const FAILURE_FORBIDDEN = new Set([
  "permission",
  "permissions",
  "directory",
  "workspace",
  "session",
  "sessionID",
  "requestID",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validatePermissionListFailure(raw: unknown): PermissionListFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as PermissionListFailure
}

export type PermissionListResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "permission/list"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { permissions: PermissionListEntry[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "permission/list"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: PermissionListFailure }
      accepted: boolean
      failure: PermissionListFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "permission/list"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makePermissionListAmbiguous(
  req: PermissionListContractRequest,
  transportUnknown = true,
): PermissionListResult {
  const out: PermissionListResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "permission/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type PermissionListWireOutcome =
  | { kind: "valid"; result: PermissionListResult }
  | { kind: "invalid"; detail: string }

export class PermissionListValidationError extends Error {
  readonly kind = "private-permission-list-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PermissionListValidationError"
    this.detail = detail
  }
}

export function isPermissionListValidationError(v: unknown): v is PermissionListValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-permission-list-validation"
}

export function normalizePrivatePermissionListWire(
  raw: unknown,
  req: PermissionListContractRequest,
): PermissionListWireOutcome {
  try {
    const result = validatePermissionListResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validatePermissionListResult(raw: unknown, req: PermissionListContractRequest): PermissionListResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "permission/list") throw new Error("op mismatch")
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
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["permissions"])
    for (const k of Object.keys(data)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validatePermissionListEntries((data as Record<string, unknown>).permissions)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PermissionListResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validatePermissionListFailure(rec.failure)
    const outFailure = validatePermissionListFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as PermissionListResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as PermissionListResult
}

export function isSettledPermissionListResult(result: unknown, req: PermissionListContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validatePermissionListResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
