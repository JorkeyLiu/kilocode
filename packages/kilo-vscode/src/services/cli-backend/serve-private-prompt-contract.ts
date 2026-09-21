function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}

function isMessageId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("msg")
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}

export function canonicalPromptOpId(messageId: string): string {
  if (typeof messageId !== "string" || messageId.length === 0) throw new TypeError("messageId must be non-empty string")
  if (messageId.includes(":")) throw new TypeError("messageId must not contain ':'")
  return `prompt:${messageId}`
}

export interface PromptContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/prompt"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: {
    messageId: string
    parts: unknown[]
    model?: { providerID: string; modelID: string } | null
    agent?: string | null
    variant?: string | null
    noReply?: boolean | null
    tools?: Record<string, boolean> | null
    format?: unknown | null
    system?: string | null
    snapshotInitialization?: "wait" | null
    editorContext?: unknown | null
  }
}

export type PromptResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/prompt"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { accepted: true; messageId: string; sessionId: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/prompt"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean; detail?: string } }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/prompt"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
      revision?: { session: number; config: number }
    }

export function makePromptAmbiguous(req: PromptContractRequest, transportUnknown = true): PromptResult {
  const out: PromptResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/prompt",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

function validateFailureShape(v: unknown, label: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${label} invalid`)
  assertAllowedKeys(v as Record<string, unknown>, new Set(["code", "message", "retryable", "detail"]), label)
  const rec = v as Record<string, unknown>
  if (typeof rec.code !== "string" || typeof rec.message !== "string" || typeof rec.retryable !== "boolean")
    throw new Error(`${label} invalid`)
  if (rec.detail !== undefined && typeof rec.detail !== "string") throw new Error(`${label}.detail must be string if present`)
  return rec
}

function assertFailureDetailMirror(top: Record<string, unknown>, out: Record<string, unknown>): void {
  const hasTop = top.detail !== undefined
  const hasOut = out.detail !== undefined
  if (!hasTop && !hasOut) return
  if (hasTop !== hasOut) throw new Error("failure detail presence mismatch")
  if (top.detail !== out.detail) throw new Error("failure detail mismatch")
}

// eslint-disable-next-line complexity
export function validatePromptContractRequest(raw: unknown): PromptContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/prompt") throw new Error("op must be session/prompt")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for prompt")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(ctx as Record<string, unknown>)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0) throw new Error("context.directory must be non-empty string")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  if ("parentSessionId" in ctx && ctx.parentSessionId !== null && ctx.parentSessionId !== undefined)
    throw new Error("context.parentSessionId must be null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set([
    "messageId",
    "parts",
    "model",
    "agent",
    "variant",
    "noReply",
    "tools",
    "format",
    "system",
    "snapshotInitialization",
    "editorContext",
  ])
  for (const k of Object.keys(payload as Record<string, unknown>)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  if (!isMessageId((payload as Record<string, unknown>).messageId)) throw new Error("payload.messageId must be MessageID")
  if (!Array.isArray((payload as Record<string, unknown>).parts)) throw new Error("payload.parts must be array")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const expected = canonicalPromptOpId((payload as Record<string, unknown>).messageId as string)
  if (raw.opId !== expected) throw new Error(`opId must be canonical ${expected}`)
  return raw as unknown as PromptContractRequest
}

const RESULT_ROOT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data", "revision"])
const RESULT_ROOT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure", "revision"])
const RESULT_ROOT_AMBIGUOUS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "transportUnknown", "revision"])
const OUTCOME_SUCCEEDED_FIELDS = new Set(["type", "time"])
const OUTCOME_FAILED_FIELDS = new Set(["type", "time", "failure"])
const OUTCOME_AMBIGUOUS_FIELDS = new Set(["type", "time"])
const REVISION_FIELDS = new Set(["session", "config"])

function validateRevision(v: unknown): void {
  if (v === undefined) return
  if (!isRecord(v)) throw new Error("revision must be {session,config} integers")
  assertAllowedKeys(v as Record<string, unknown>, REVISION_FIELDS, "revision")
  const rec = v as Record<string, unknown>
  if (!isSafeInt(rec.session) || !isSafeInt(rec.config)) throw new Error("revision must be {session,config} integers")
}

// eslint-disable-next-line complexity
export function validatePromptResult(raw: unknown, req: PromptContractRequest): PromptResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/prompt") throw new Error("op mismatch")
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
  validateRevision(rec.revision)
  if (status === "succeeded") {
    assertAllowedKeys(rec, RESULT_ROOT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, OUTCOME_SUCCEEDED_FIELDS, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    assertAllowedKeys(data as Record<string, unknown>, new Set(["accepted", "messageId", "sessionId"]), "data")
    const d = data as Record<string, unknown>
    if (d.accepted !== true) throw new Error("succeeded data.accepted must be true")
    if (d.messageId !== req.payload.messageId) throw new Error("succeeded data.messageId mismatch")
    if (d.sessionId !== req.context.sessionId) throw new Error("succeeded data.sessionId mismatch")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PromptResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, RESULT_ROOT_FAILED, "result")
    assertAllowedKeys(outRec, OUTCOME_FAILED_FIELDS, "outcome")
    const failure = validateFailureShape(rec.failure, "failed failure")
    const outFailure = validateFailureShape(outRec.failure, "failed outcome.failure")
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    assertFailureDetailMirror(failure, outFailure)
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as PromptResult
  }
  assertAllowedKeys(rec, RESULT_ROOT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, OUTCOME_AMBIGUOUS_FIELDS, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean") throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  return raw as unknown as PromptResult
}

export type PrivatePromptWireOutcome = { kind: "valid"; result: PromptResult } | { kind: "invalid"; detail: string }

export class PrivatePromptValidationError extends Error {
  readonly kind = "private-prompt-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivatePromptValidationError"
    this.detail = detail
  }
}

export function isPrivatePromptValidationError(v: unknown): v is PrivatePromptValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-prompt-validation"
}

export function normalizePrivatePromptWire(raw: unknown, req: PromptContractRequest): PrivatePromptWireOutcome {
  try {
    const result = validatePromptResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}
