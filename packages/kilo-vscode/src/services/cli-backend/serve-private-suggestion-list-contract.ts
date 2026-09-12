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

export function canonicalSuggestionListOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("token must not carry path material")
  return `suggestion-list:${token}`
}

export function parseSuggestionListOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`suggestion-list opId must be suggestion-list:<token>: ${opId}`)
  if (segs[0] !== "suggestion-list") throw new TypeError(`opId kind must be suggestion-list: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId token must be non-empty: ${opId}`)
  if (token.includes("\0")) throw new TypeError("opId token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("opId token must not carry path material")
  return { token }
}

export interface SuggestionListContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "suggestion/list"
  idempotencyKey: string
  context: { directory: string }
  payload: Record<string, never>
}

export function validateSuggestionListContractRequest(raw: unknown): SuggestionListContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  clean(raw.opId, "opId")
  if (raw.op !== "suggestion/list") throw new Error("op must be suggestion/list")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for suggestion-list")
  const parsed = parseSuggestionListOpId(raw.opId as string)
  const idem = parseSuggestionListOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as SuggestionListContractRequest
}

function isSuggestionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("sug")
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

export interface SuggestionListAction {
  label: string
  description?: string
  prompt: string
}

export interface SuggestionListEntry {
  id: string
  sessionID: string
  text: string
  actions: SuggestionListAction[]
  blocking?: boolean
  tool?: { messageID: string; callID: string }
}

const ENTRY_FIELDS = new Set(["id", "sessionID", "text", "actions", "blocking", "tool"])
const ACTION_FIELDS = new Set(["label", "description", "prompt"])
const TOOL_FIELDS = new Set(["messageID", "callID"])

function checkText(v: unknown, label: string, allowEmpty: boolean): void {
  if (typeof v !== "string") throw new Error(`${label} must be string`)
  if (!allowEmpty && v.length === 0) throw new Error(`${label} must be non-empty string`)
  if (v.includes("\0")) throw new Error(`${label} must not contain null bytes`)
}

function checkAction(raw: unknown): void {
  if (!record(raw)) throw new Error("suggestion action must be object")
  for (const k of Object.keys(raw)) {
    if (!ACTION_FIELDS.has(k)) throw new Error(`unexpected suggestion action field ${k}`)
  }
  checkText(raw.label, "suggestion action label", false)
  if (raw.description !== undefined) checkText(raw.description, "suggestion action description", true)
  checkText(raw.prompt, "suggestion action prompt", false)
}

function checkTool(v: unknown): void {
  if (v === undefined) return
  if (!record(v)) throw new Error("suggestion entry tool must be object")
  for (const k of Object.keys(v)) {
    if (!TOOL_FIELDS.has(k)) throw new Error(`unexpected suggestion tool field ${k}`)
  }
  const tool = v as Record<string, unknown>
  if (typeof tool.messageID !== "string" || tool.messageID.length === 0)
    throw new Error("suggestion entry tool.messageID must be non-empty string")
  if (typeof tool.callID !== "string" || tool.callID.length === 0)
    throw new Error("suggestion entry tool.callID must be non-empty string")
  if ((tool.messageID as string).includes("\0") || (tool.callID as string).includes("\0"))
    throw new Error("suggestion entry tool must not contain null bytes")
}

export function validateSuggestionListEntry(raw: unknown): SuggestionListEntry {
  if (!record(raw)) throw new Error("suggestion entry must be object")
  for (const k of Object.keys(raw)) {
    if (!ENTRY_FIELDS.has(k)) throw new Error(`unexpected suggestion entry field ${k}`)
  }
  if (!isSuggestionId(raw.id)) throw new Error("suggestion entry id must be SuggestionID")
  if ((raw.id as string).includes("\0")) throw new Error("suggestion entry id must not contain null bytes")
  if (!isSessionId(raw.sessionID)) throw new Error("suggestion entry sessionID must be SessionID")
  if ((raw.sessionID as string).includes("\0"))
    throw new Error("suggestion entry sessionID must not contain null bytes")
  checkText(raw.text, "suggestion entry text", false)
  if (!Array.isArray(raw.actions)) throw new Error("suggestion entry actions must be array")
  const actions = raw.actions as unknown[]
  if (actions.length < 1 || actions.length > 2) throw new Error("suggestion entry actions must carry 1-2 actions")
  for (const item of actions) checkAction(item)
  if (raw.blocking !== undefined && typeof raw.blocking !== "boolean")
    throw new Error("suggestion entry blocking must be boolean")
  checkTool(raw.tool)
  return raw as unknown as SuggestionListEntry
}

export function validateSuggestionListEntries(raw: unknown): SuggestionListEntry[] {
  if (!Array.isArray(raw)) throw new Error("suggestions must be array")
  return (raw as unknown[]).map((item) => validateSuggestionListEntry(item))
}

export interface SuggestionListFailure {
  code: string
  message: string
  retryable: boolean
}

const FAILURE_FORBIDDEN = new Set([
  "suggestion",
  "suggestions",
  "directory",
  "workspace",
  "session",
  "sessionID",
  "requestID",
  "prompt",
  "tool",
  "action",
  "actions",
  "text",
  "error",
  "raw",
  "output",
  "detail",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateSuggestionListFailure(raw: unknown): SuggestionListFailure {
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
  return raw as unknown as SuggestionListFailure
}

export type SuggestionListResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "suggestion/list"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { suggestions: SuggestionListEntry[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "suggestion/list"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: SuggestionListFailure }
      accepted: boolean
      failure: SuggestionListFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "suggestion/list"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSuggestionListAmbiguous(
  req: SuggestionListContractRequest,
  transportUnknown = true,
): SuggestionListResult {
  const out: SuggestionListResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "suggestion/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type SuggestionListWireOutcome =
  | { kind: "valid"; result: SuggestionListResult }
  | { kind: "invalid"; detail: string }

export class SuggestionListValidationError extends Error {
  readonly kind = "private-suggestion-list-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "SuggestionListValidationError"
    this.detail = detail
  }
}

export function isSuggestionListValidationError(v: unknown): v is SuggestionListValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-suggestion-list-validation"
}

export function normalizePrivateSuggestionListWire(
  raw: unknown,
  req: SuggestionListContractRequest,
): SuggestionListWireOutcome {
  try {
    const result = validateSuggestionListResult(raw, req)
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
export function validateSuggestionListResult(raw: unknown, req: SuggestionListContractRequest): SuggestionListResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "suggestion/list") throw new Error("op mismatch")
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
    const allowedData = new Set(["suggestions"])
    for (const k of Object.keys(data)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateSuggestionListEntries((data as Record<string, unknown>).suggestions)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SuggestionListResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateSuggestionListFailure(rec.failure)
    const outFailure = validateSuggestionListFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SuggestionListResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SuggestionListResult
}

export function isSettledSuggestionListResult(result: unknown, req: SuggestionListContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateSuggestionListResult(result, req)
    if (out.status === "succeeded") return true
    return false
  } catch {
    return false
  }
}
