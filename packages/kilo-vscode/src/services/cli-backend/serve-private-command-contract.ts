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

// Canonical tuple reuses the durable prompt identity: the same user message
// is the authority for prompt and command, so no new operation kind.
export function canonicalCommandOpId(messageId: string): string {
  if (typeof messageId !== "string" || messageId.length === 0) throw new TypeError("messageId must be non-empty string")
  if (messageId.includes(":")) throw new TypeError("messageId must not contain ':'")
  return `prompt:${messageId}`
}

export interface CommandContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/command"
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
    command: string
    arguments: string
    model?: string | null
    agent?: string | null
    variant?: string | null
    parts?: unknown[] | null
    snapshotInitialization?: "wait" | null
  }
}

export type CommandResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/command"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { accepted: true; messageId: string; sessionId: string }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/command"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean; detail?: string } }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/command"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeCommandAmbiguous(req: CommandContractRequest, transportUnknown = true): CommandResult {
  const out: CommandResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/command",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function isSourceText(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (typeof v.value !== "string") return false
  if (!isFiniteNumber(v.start) || !isFiniteNumber(v.end)) return false
  return true
}

function isRange(v: unknown): boolean {
  if (!isRecord(v)) return false
  const s = v.start as unknown
  const e = v.end as unknown
  if (!isRecord(s) || !isRecord(e)) return false
  if (!isSafeInt(s.line) || !isSafeInt(s.character)) return false
  if (!isSafeInt(e.line) || !isSafeInt(e.character)) return false
  return true
}

// Mirrors core FilePartSource (file/symbol/resource). Keep in sync with
// SessionV1.FilePartSource; UI legal shape stays accepted.
function isFilePartSource(v: unknown): boolean {
  if (!isRecord(v)) return false
  const t = v.type
  if (t === "file") {
    if (typeof v.path !== "string") return false
    return isSourceText(v.text)
  }
  if (t === "symbol") {
    if (typeof v.path !== "string" || typeof v.name !== "string") return false
    if (!isSafeInt(v.kind)) return false
    if (!isRange(v.range)) return false
    return isSourceText(v.text)
  }
  if (t === "resource") {
    if (typeof v.clientName !== "string" || typeof v.uri !== "string") return false
    return isSourceText(v.text)
  }
  return false
}

const FILE_PART_FIELDS = new Set(["id", "type", "mime", "filename", "url", "source"])

function assertFileKeys(p: Record<string, unknown>): void {
  for (const k of Object.keys(p)) if (!FILE_PART_FIELDS.has(k)) throw new Error(`unexpected payload.parts file field ${k}`)
}

function assertOptionalString(p: Record<string, unknown>, field: string, label: string): void {
  const v = p[field]
  if (v !== undefined && v !== null && typeof v !== "string") throw new Error(`${label} must be string if present`)
}

function validateFilePart(p: unknown): void {
  if (!isRecord(p)) throw new Error("payload.parts entry must be object")
  assertFileKeys(p)
  if (p.type !== "file") throw new Error("payload.parts entry type must be file")
  if (typeof p.mime !== "string" || typeof p.url !== "string") throw new Error("payload.parts file entry requires mime/url")
  assertOptionalString(p, "id", "payload.parts file entry id")
  assertOptionalString(p, "filename", "payload.parts file entry filename")
  const source = (p as Record<string, unknown>).source
  if (source !== undefined && source !== null && !isFilePartSource(source))
    throw new Error("payload.parts file entry source invalid")
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
export function validateCommandContractRequest(raw: unknown): CommandContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/command") throw new Error("op must be session/command")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for command")
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
    "command",
    "arguments",
    "model",
    "agent",
    "variant",
    "parts",
    "snapshotInitialization",
  ])
  for (const k of Object.keys(payload as Record<string, unknown>)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  if (!isMessageId((payload as Record<string, unknown>).messageId)) throw new Error("payload.messageId must be MessageID")
  if (typeof (payload as Record<string, unknown>).command !== "string" || ((payload as Record<string, unknown>).command as string).length === 0)
    throw new Error("payload.command must be non-empty string")
  if (typeof (payload as Record<string, unknown>).arguments !== "string") throw new Error("payload.arguments must be string")
  const model = (payload as Record<string, unknown>).model
  if (model !== undefined && model !== null) {
    if (typeof model !== "string" || model.length === 0) throw new Error("payload.model must be provider/model string")
    const segs = (model as string).split("/")
    if (segs.length !== 2 || !segs[0] || !segs[1] || (model as string).includes(":"))
      throw new Error("payload.model must be provider/model string")
  }
  const agent = (payload as Record<string, unknown>).agent
  if (agent !== undefined && agent !== null && typeof agent !== "string")
    throw new Error("payload.agent must be string or null")
  const variant = (payload as Record<string, unknown>).variant
  if (variant !== undefined && variant !== null && typeof variant !== "string")
    throw new Error("payload.variant must be string or null")
  const parts = (payload as Record<string, unknown>).parts
  if (parts !== undefined && parts !== null) {
    if (!Array.isArray(parts)) throw new Error("payload.parts must be array")
    for (const entry of parts as unknown[]) validateFilePart(entry)
  }
  const snap = (payload as Record<string, unknown>).snapshotInitialization
  if (snap !== undefined && snap !== null && snap !== "wait") throw new Error("payload.snapshotInitialization must be wait or null")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const expected = canonicalCommandOpId((payload as Record<string, unknown>).messageId as string)
  if (raw.opId !== expected) throw new Error(`opId must be canonical ${expected}`)
  return raw as unknown as CommandContractRequest
}

const RESULT_ROOT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const RESULT_ROOT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const RESULT_ROOT_AMBIGUOUS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_SUCCEEDED_FIELDS = new Set(["type", "time"])
const OUTCOME_FAILED_FIELDS = new Set(["type", "time", "failure"])
const OUTCOME_AMBIGUOUS_FIELDS = new Set(["type", "time"])

// eslint-disable-next-line complexity
export function validateCommandResult(raw: unknown, req: CommandContractRequest): CommandResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/command") throw new Error("op mismatch")
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
    return raw as unknown as CommandResult
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
    return raw as unknown as CommandResult
  }
  assertAllowedKeys(rec, RESULT_ROOT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, OUTCOME_AMBIGUOUS_FIELDS, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean") throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  return raw as unknown as CommandResult
}

export type PrivateCommandWireOutcome = { kind: "valid"; result: CommandResult } | { kind: "invalid"; detail: string }

export class PrivateCommandValidationError extends Error {
  readonly kind = "private-command-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateCommandValidationError"
    this.detail = detail
  }
}

export function normalizePrivateCommandWire(raw: unknown, req: CommandContractRequest): PrivateCommandWireOutcome {
  try {
    const result = validateCommandResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}
