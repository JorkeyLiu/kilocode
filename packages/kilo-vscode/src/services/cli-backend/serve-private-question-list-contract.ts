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

export function canonicalQuestionListOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("token must not carry path material")
  return `question-list:${token}`
}

export function parseQuestionListOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`question-list opId must be question-list:<token>: ${opId}`)
  if (segs[0] !== "question-list") throw new TypeError(`opId kind must be question-list: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId token must be non-empty: ${opId}`)
  if (token.includes("\0")) throw new TypeError("opId token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("opId token must not carry path material")
  return { token }
}

export interface QuestionListContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "question/list"
  idempotencyKey: string
  context: { directory: string }
  payload: Record<string, never>
}

export function validateQuestionListContractRequest(raw: unknown): QuestionListContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  clean(raw.opId, "opId")
  if (raw.op !== "question/list") throw new Error("op must be question/list")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for question-list")
  const parsed = parseQuestionListOpId(raw.opId as string)
  const idem = parseQuestionListOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as QuestionListContractRequest
}

function isQuestionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("que")
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

export interface QuestionListOption {
  label: string
  description: string
  labelKey?: string
  descriptionKey?: string
  mode?: string
}

export interface QuestionListInfo {
  question: string
  header: string
  options: QuestionListOption[]
  multiple?: boolean
  questionKey?: string
  headerKey?: string
  custom?: boolean
}

export interface QuestionListEntry {
  id: string
  sessionID: string
  questions: QuestionListInfo[]
  blocking?: boolean
  tool?: { messageID: string; callID: string }
}

const ENTRY_FIELDS = new Set(["id", "sessionID", "questions", "blocking", "tool"])
const INFO_FIELDS = new Set(["question", "header", "options", "multiple", "questionKey", "headerKey", "custom"])
const OPTION_FIELDS = new Set(["label", "description", "labelKey", "descriptionKey", "mode"])
const TOOL_FIELDS = new Set(["messageID", "callID"])

function checkText(v: unknown, label: string, allowEmpty: boolean): void {
  if (typeof v !== "string") throw new Error(`${label} must be string`)
  if (!allowEmpty && v.length === 0) throw new Error(`${label} must be non-empty string`)
  if (v.includes("\0")) throw new Error(`${label} must not contain null bytes`)
}

function checkOptText(v: unknown, label: string): void {
  if (v === undefined) return
  checkText(v, label, false)
}

function checkOption(raw: unknown): void {
  if (!record(raw)) throw new Error("question option must be object")
  for (const k of Object.keys(raw)) {
    if (!OPTION_FIELDS.has(k)) throw new Error(`unexpected question option field ${k}`)
  }
  checkText(raw.label, "question option label", false)
  checkText(raw.description, "question option description", false)
  checkOptText(raw.labelKey, "question option labelKey")
  checkOptText(raw.descriptionKey, "question option descriptionKey")
  checkOptText(raw.mode, "question option mode")
}

function checkInfo(raw: unknown): void {
  if (!record(raw)) throw new Error("question info must be object")
  for (const k of Object.keys(raw)) {
    if (!INFO_FIELDS.has(k)) throw new Error(`unexpected question info field ${k}`)
  }
  checkText(raw.question, "question info question", false)
  checkText(raw.header, "question info header", false)
  if (!Array.isArray(raw.options)) throw new Error("question info options must be array")
  for (const item of raw.options as unknown[]) checkOption(item)
  if (raw.multiple !== undefined && typeof raw.multiple !== "boolean")
    throw new Error("question info multiple must be boolean")
  checkOptText(raw.questionKey, "question info questionKey")
  checkOptText(raw.headerKey, "question info headerKey")
  if (raw.custom !== undefined && typeof raw.custom !== "boolean")
    throw new Error("question info custom must be boolean")
}

function checkTool(v: unknown): void {
  if (v === undefined) return
  if (!record(v)) throw new Error("question entry tool must be object")
  for (const k of Object.keys(v)) {
    if (!TOOL_FIELDS.has(k)) throw new Error(`unexpected question tool field ${k}`)
  }
  const tool = v as Record<string, unknown>
  if (typeof tool.messageID !== "string" || tool.messageID.length === 0)
    throw new Error("question entry tool.messageID must be non-empty string")
  if (typeof tool.callID !== "string" || tool.callID.length === 0)
    throw new Error("question entry tool.callID must be non-empty string")
}

export function validateQuestionListEntry(raw: unknown): QuestionListEntry {
  if (!record(raw)) throw new Error("question entry must be object")
  for (const k of Object.keys(raw)) {
    if (!ENTRY_FIELDS.has(k)) throw new Error(`unexpected question entry field ${k}`)
  }
  if (!isQuestionId(raw.id)) throw new Error("question entry id must be QuestionID")
  if ((raw.id as string).includes("\0")) throw new Error("question entry id must not contain null bytes")
  if (!isSessionId(raw.sessionID)) throw new Error("question entry sessionID must be SessionID")
  if (!Array.isArray(raw.questions)) throw new Error("question entry questions must be array")
  for (const item of raw.questions as unknown[]) checkInfo(item)
  if (raw.blocking !== undefined && typeof raw.blocking !== "boolean")
    throw new Error("question entry blocking must be boolean")
  checkTool(raw.tool)
  return raw as unknown as QuestionListEntry
}

export function validateQuestionListEntries(raw: unknown): QuestionListEntry[] {
  if (!Array.isArray(raw)) throw new Error("questions must be array")
  return (raw as unknown[]).map((item) => validateQuestionListEntry(item))
}

export interface QuestionListFailure {
  code: string
  message: string
  retryable: boolean
}

const FAILURE_FORBIDDEN = new Set([
  "question",
  "questions",
  "directory",
  "workspace",
  "session",
  "sessionID",
  "requestID",
  "prompt",
  "tool",
  "answers",
  "error",
  "raw",
  "output",
  "detail",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateQuestionListFailure(raw: unknown): QuestionListFailure {
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
  return raw as unknown as QuestionListFailure
}

export type QuestionListResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "question/list"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { questions: QuestionListEntry[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "question/list"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: QuestionListFailure }
      accepted: boolean
      failure: QuestionListFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "question/list"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeQuestionListAmbiguous(
  req: QuestionListContractRequest,
  transportUnknown = true,
): QuestionListResult {
  const out: QuestionListResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "question/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type QuestionListWireOutcome =
  | { kind: "valid"; result: QuestionListResult }
  | { kind: "invalid"; detail: string }

export class QuestionListValidationError extends Error {
  readonly kind = "private-question-list-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "QuestionListValidationError"
    this.detail = detail
  }
}

export function isQuestionListValidationError(v: unknown): v is QuestionListValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-question-list-validation"
}

export function normalizePrivateQuestionListWire(
  raw: unknown,
  req: QuestionListContractRequest,
): QuestionListWireOutcome {
  try {
    const result = validateQuestionListResult(raw, req)
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
export function validateQuestionListResult(raw: unknown, req: QuestionListContractRequest): QuestionListResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "question/list") throw new Error("op mismatch")
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
    const allowedData = new Set(["questions"])
    for (const k of Object.keys(data)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateQuestionListEntries((data as Record<string, unknown>).questions)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as QuestionListResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateQuestionListFailure(rec.failure)
    const outFailure = validateQuestionListFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as QuestionListResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as QuestionListResult
}

export function isSettledQuestionListResult(result: unknown, req: QuestionListContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateQuestionListResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
