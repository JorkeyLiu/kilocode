import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isQuestionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("que")
}

function isAnswers(v: unknown): v is string[][] {
  if (!Array.isArray(v)) return false
  for (const row of v as unknown[]) {
    if (!Array.isArray(row)) return false
    for (const cell of row as unknown[]) {
      if (typeof cell !== "string") return false
    }
  }
  return true
}

export function canonicalQuestionOpId(requestID: string, token: string): string {
  if (typeof requestID !== "string" || requestID.length === 0) throw new TypeError("requestID must be non-empty string")
  if (requestID.includes("\0")) throw new TypeError("requestID must not contain null bytes")
  if (!isQuestionId(requestID)) throw new TypeError("requestID must be QuestionID")
  if (requestID.includes(":")) throw new TypeError("requestID must not contain ':'")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("token must not contain null bytes")
  return `question:${requestID}:${token}`
}

export function parseQuestionOpId(opId: string): { requestID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`question opId must have 2 segments: ${opId}`)
  if (segs[0] !== "question") throw new TypeError(`opId kind must be question: ${opId}`)
  const rid = segs[1]!
  const token = segs[2]!
  if (rid.length === 0 || !isQuestionId(rid)) throw new TypeError(`opId requestID must be QuestionID: ${opId}`)
  if (rid.includes("\0")) throw new TypeError("opId requestID must not contain null bytes")
  if (token.length === 0) throw new TypeError(`opId token must be non-empty: ${opId}`)
  if (token.includes(":")) throw new TypeError("opId token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("opId token must not contain null bytes")
  return { requestID: rid, token }
}

export interface QuestionReplyContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "question/reply"
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { answers: string[][] }
}

export interface QuestionRejectContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "question/reject"
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: Record<string, never>
}

export type QuestionContractRequest = QuestionReplyContractRequest | QuestionRejectContractRequest

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

function checkContext(ctx: unknown): Record<string, unknown> {
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory", "requestID"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isQuestionId(ctx.requestID)) throw new Error("context.requestID must be QuestionID")
  if ((ctx.requestID as string).includes("\0")) throw new Error("context.requestID must not contain null bytes")
  return ctx
}

function base(raw: unknown): Record<string, unknown> {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  clean(raw.opId, "opId")
  if (raw.op !== "question/reply" && raw.op !== "question/reject")
    throw new Error("op must be question/reply or question/reject")
  clean(raw.idempotencyKey, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  const ctx = checkContext(raw.context)
  const parsed = parseQuestionOpId(raw.opId as string)
  const idem = parseQuestionOpId(raw.idempotencyKey as string)
  if (idem.requestID !== parsed.requestID) throw new Error("idempotencyKey request binding mismatch")
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as Record<string, unknown>
}

export function validateQuestionReplyContractRequest(raw: unknown): QuestionReplyContractRequest {
  const root = base(raw)
  if (root.op !== "question/reply") throw new Error("op must be question/reply")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 1 || !("answers" in payload)) throw new Error("payload must carry only answers")
  if (!isAnswers((payload as Record<string, unknown>).answers)) throw new Error("payload.answers must be string[][]")
  return raw as unknown as QuestionReplyContractRequest
}

export function validateQuestionRejectContractRequest(raw: unknown): QuestionRejectContractRequest {
  const root = base(raw)
  if (root.op !== "question/reject") throw new Error("op must be question/reject")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for reject")
  return raw as unknown as QuestionRejectContractRequest
}

export interface QuestionTerminal {
  kind: "terminal"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  sessionID: string
  requestID: string
  answers?: string[][]
}

export interface QuestionTerminalFailure {
  kind: "terminal-failure"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: true
  failure: { code: string; retryable: boolean; time: number }
  sideEffect: false
}

export interface QuestionAmbiguous {
  kind: "ambiguous"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: false
  transportUnknown: true
}

function checkIdentity(raw: Record<string, unknown>, req: QuestionContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== true) throw new Error("terminal accepted must be true")
  if (raw.terminal !== true) throw new Error("terminal must be true")
}

function checkFailureIdentity(raw: Record<string, unknown>, req: QuestionContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== false) throw new Error("terminal-failure accepted must be false")
  if (raw.terminal !== true) throw new Error("terminal must be true")
  if (raw.sideEffect !== false) throw new Error("terminal-failure sideEffect must be false")
}

export function validateQuestionReplyResult(raw: unknown, req: QuestionReplyContractRequest): QuestionTerminal {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.kind !== "terminal") throw new Error("reply result kind must be terminal")
  const allowed = new Set([
    "kind",
    "v",
    "requestId",
    "opId",
    "idempotencyKey",
    "accepted",
    "terminal",
    "sessionID",
    "requestID",
    "answers",
  ])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected terminal field ${k}`)
  }
  checkIdentity(raw, req)
  if (typeof raw.sessionID !== "string" || !(raw.sessionID as string).startsWith("ses"))
    throw new Error("terminal sessionID must be SessionID")
  if (raw.requestID !== req.context.requestID) throw new Error("terminal requestID mismatch")
  if (!isAnswers(raw.answers)) throw new Error("terminal answers must be string[][]")
  const want = req.payload.answers
  const got = raw.answers as string[][]
  if (got.length !== want.length) throw new Error("terminal answers length mismatch")
  for (let i = 0; i < got.length; i++) {
    const a = got[i]!
    const b = want[i]!
    if (a.length !== b.length) throw new Error("terminal answers row mismatch")
    for (let j = 0; j < a.length; j++) {
      if (a[j] !== b[j]) throw new Error("terminal answers mismatch")
    }
  }
  return raw as unknown as QuestionTerminal
}

export function validateQuestionRejectResult(raw: unknown, req: QuestionRejectContractRequest): QuestionTerminal {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.kind !== "terminal") throw new Error("reject result kind must be terminal")
  const allowed = new Set([
    "kind",
    "v",
    "requestId",
    "opId",
    "idempotencyKey",
    "accepted",
    "terminal",
    "sessionID",
    "requestID",
  ])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected terminal field ${k}`)
  }
  checkIdentity(raw, req)
  if (typeof raw.sessionID !== "string" || !(raw.sessionID as string).startsWith("ses"))
    throw new Error("terminal sessionID must be SessionID")
  if (raw.requestID !== req.context.requestID) throw new Error("terminal requestID mismatch")
  return raw as unknown as QuestionTerminal
}

export function validateQuestionTerminalFailure(raw: unknown, req: QuestionContractRequest): QuestionTerminalFailure {
  if (!record(raw)) throw new Error("terminal-failure must be object")
  if (raw.kind !== "terminal-failure") throw new Error("terminal-failure kind must be terminal-failure")
  const allowed = new Set([
    "kind",
    "v",
    "requestId",
    "opId",
    "idempotencyKey",
    "accepted",
    "terminal",
    "failure",
    "sideEffect",
  ])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected terminal-failure field ${k}`)
  }
  checkFailureIdentity(raw, req)
  const failure = raw.failure
  if (!record(failure)) throw new Error("failure must be object")
  const fAllowed = new Set(["code", "retryable", "time"])
  for (const k of Object.keys(failure)) {
    if (!fAllowed.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (failure.code !== "question.not_found" && failure.code !== "scope_mismatch")
    throw new Error("terminal-failure code must be question.not_found or scope_mismatch")
  if (failure.retryable !== false) throw new Error("terminal-failure retryable must be false")
  if (typeof failure.time !== "number" || !Number.isFinite(failure.time))
    throw new Error("failure time must be finite number")
  return raw as unknown as QuestionTerminalFailure
}

export function makeQuestionAmbiguous(req: QuestionContractRequest): QuestionAmbiguous {
  return {
    kind: "ambiguous",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: false,
    transportUnknown: true,
  }
}

export function makeQuestionTerminalFailure(
  req: QuestionContractRequest,
  code: "question.not_found" | "scope_mismatch",
  time: number = Date.now(),
): QuestionTerminalFailure {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code, retryable: false, time },
    sideEffect: false,
  }
}

export function isSettledQuestionResult(result: unknown, req: QuestionContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { kind?: unknown }).kind
  if (kind !== "terminal" && kind !== "terminal-failure") return false
  const raw = result as Record<string, unknown>
  if (raw.v !== 1) return false
  if (raw.requestId !== req.requestId || raw.opId !== req.opId || raw.idempotencyKey !== req.idempotencyKey)
    return false
  if (raw.terminal !== true) return false
  if (kind === "terminal") return raw.accepted === true
  return raw.accepted === false && raw.sideEffect === false
}
