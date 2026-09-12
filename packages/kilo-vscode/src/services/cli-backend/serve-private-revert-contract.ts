import { isAbsolute } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}
function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}
function isSessionId(v: unknown): boolean {
  return typeof v === "string" && v.startsWith("ses") && v.length > 0 && !v.includes("\0")
}
function isMessageId(v: unknown): boolean {
  return typeof v === "string" && v.startsWith("msg") && v.length > 0 && !v.includes("\0")
}
function isPartId(v: unknown): boolean {
  return typeof v === "string" && v.startsWith("prt") && v.length > 0 && !v.includes("\0")
}

export interface ServePrivateRevertRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/revert"
  idempotencyKey: string
  context: { directory: string; sessionId: string; parentSessionId: string | null; configVersion?: number; sessionRevision?: number }
  payload: { messageId?: string; partId?: string }
}

export interface ServePrivateUnrevertRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/unrevert"
  idempotencyKey: string
  context: { directory: string; sessionId: string; parentSessionId: string | null; configVersion?: number; sessionRevision?: number }
  payload: Record<string, never>
}

export type ServePrivateRevertResult =
  | { v: 1; requestId: string; opId: string; op: "session/revert"; idempotencyKey: string; status: "succeeded"; outcome: { type: "succeeded"; time: number }; accepted: true; data: { session: Record<string, unknown> }; revision?: { session: number; config: number } }
  | { v: 1; requestId: string; opId: string; op: "session/revert"; idempotencyKey: string; status: "failed"; outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean; detail?: string } }; accepted: boolean; failure: { code: string; message: string; retryable: boolean; detail?: string }; revision?: { session: number; config: number } }
  | { v: 1; requestId: string; opId: string; op: "session/revert"; idempotencyKey: string; status: "ambiguous"; outcome: { type: "ambiguous"; time: number }; accepted: false; revision?: { session: number; config: number }; transportUnknown?: boolean }

export type ServePrivateUnrevertResult =
  | { v: 1; requestId: string; opId: string; op: "session/unrevert"; idempotencyKey: string; status: "succeeded"; outcome: { type: "succeeded"; time: number }; accepted: true; data: { session: Record<string, unknown> }; revision?: { session: number; config: number } }
  | { v: 1; requestId: string; opId: string; op: "session/unrevert"; idempotencyKey: string; status: "failed"; outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean; detail?: string } }; accepted: boolean; failure: { code: string; message: string; retryable: boolean; detail?: string }; revision?: { session: number; config: number } }
  | { v: 1; requestId: string; opId: string; op: "session/unrevert"; idempotencyKey: string; status: "ambiguous"; outcome: { type: "ambiguous"; time: number }; accepted: false; revision?: { session: number; config: number }; transportUnknown?: boolean }

function checkOpId(opId: string, sessionId: string, kind: "revert" | "unrevert"): void {
  const prefix = `${kind}:${sessionId}:`
  if (!opId.startsWith(prefix)) throw new Error(`opId session binding mismatch: ${opId} vs ${sessionId}`)
  const token = opId.slice(prefix.length)
  if (!token) throw new Error(`opId segment must be non-empty: ${opId}`)
  if (token.includes(":")) throw new Error(`token must not contain ':'`)
}

function checkContext(ctx: unknown): asserts ctx is ServePrivateRevertRequest["context"] {
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || (ctx.directory as string).includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  if (!("parentSessionId" in ctx) || ctx.parentSessionId !== null) throw new Error("context.parentSessionId must be null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
}

// eslint-disable-next-line complexity
export function validateRevertRequest(raw: unknown): ServePrivateRevertRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/revert") throw new Error("op must be session/revert")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for revert")
  checkContext(raw.context)
  const ctx = raw.context as Record<string, unknown>
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if ("messageId" in payload && payload.messageId !== undefined && !isMessageId(payload.messageId))
    throw new Error("payload.messageId must be MessageID")
  if ("partId" in payload && payload.partId !== undefined && !isPartId(payload.partId))
    throw new Error("payload.partId must be PartID")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["messageId", "partId"])
  for (const k of Object.keys(payload)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  checkOpId(raw.opId as string, ctx.sessionId as string, "revert")
  checkOpId(raw.idempotencyKey as string, ctx.sessionId as string, "revert")
  return raw as unknown as ServePrivateRevertRequest
}

export function validateUnrevertRequest(raw: unknown): ServePrivateUnrevertRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/unrevert") throw new Error("op must be session/unrevert")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for unrevert")
  checkContext(raw.context)
  const ctx = raw.context as Record<string, unknown>
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for unrevert")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  checkOpId(raw.opId as string, ctx.sessionId as string, "unrevert")
  checkOpId(raw.idempotencyKey as string, ctx.sessionId as string, "unrevert")
  return raw as unknown as ServePrivateUnrevertRequest
}

function checkEnvelope(raw: Record<string, unknown>, req: { requestId: string; opId: string; op: string; idempotencyKey: string }, kind: string): void {
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== kind) throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
}

function checkOutcome(raw: Record<string, unknown>): string {
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous") throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number") throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  return status
}

function checkOptional(raw: Record<string, unknown>): void {
  if ("revision" in raw && raw.revision !== undefined) {
    const rev = raw.revision as unknown
    if (!isRecord(rev) || typeof rev.session !== "number" || typeof rev.config !== "number" || !isSafeInt(rev.session) || !isSafeInt(rev.config))
      throw new Error("revision must be {session,config} integers")
  }
  if ("transportUnknown" in raw && raw.transportUnknown !== undefined && typeof raw.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
}

function checkResultShape(raw: unknown, req: { requestId: string; opId: string; op: string; idempotencyKey: string }, kind: string): void {
  if (!isRecord(raw)) throw new Error("result must be object")
  checkEnvelope(raw, req, kind)
  checkOutcome(raw)
  checkOptional(raw)
}

// eslint-disable-next-line complexity
export function validateRevertResult(raw: unknown, req: ServePrivateRevertRequest): ServePrivateRevertResult {
  checkResultShape(raw, req, "session/revert")
  const status = (raw as Record<string, unknown>).status
  const outcome = (raw as Record<string, unknown>).outcome as Record<string, unknown>
  if (status === "succeeded") {
    if ((raw as Record<string, unknown>).accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data) || !isRecord((data as Record<string, unknown>).session)) throw new Error("succeeded data.session must be object")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if (outcome.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ServePrivateRevertResult
  }
  if (status === "failed") {
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = outcome.failure
    if (!isRecord(failure) || typeof failure.code !== "string" || typeof failure.message !== "string" || typeof failure.retryable !== "boolean")
      throw new Error("failed failure invalid")
    if (!isRecord(outFailure) || typeof outFailure.code !== "string" || typeof outFailure.message !== "string" || typeof outFailure.retryable !== "boolean")
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable) throw new Error("failure retryable mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateRevertResult
  }
  if ((raw as Record<string, unknown>).accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outcome.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ServePrivateRevertResult
}

// eslint-disable-next-line complexity
export function validateUnrevertResult(raw: unknown, req: ServePrivateUnrevertRequest): ServePrivateUnrevertResult {
  checkResultShape(raw, req, "session/unrevert")
  const status = (raw as Record<string, unknown>).status
  const outcome = (raw as Record<string, unknown>).outcome as Record<string, unknown>
  if (status === "succeeded") {
    if ((raw as Record<string, unknown>).accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data) || !isRecord((data as Record<string, unknown>).session)) throw new Error("succeeded data.session must be object")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if (outcome.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ServePrivateUnrevertResult
  }
  if (status === "failed") {
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = outcome.failure
    if (!isRecord(failure) || typeof failure.code !== "string" || typeof failure.message !== "string" || typeof failure.retryable !== "boolean")
      throw new Error("failed failure invalid")
    if (!isRecord(outFailure) || typeof outFailure.code !== "string" || typeof outFailure.message !== "string" || typeof outFailure.retryable !== "boolean")
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable) throw new Error("failure retryable mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateUnrevertResult
  }
  if ((raw as Record<string, unknown>).accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outcome.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ServePrivateUnrevertResult
}

export function makeRevertAmbiguous(req: ServePrivateRevertRequest, transportUnknown = true): ServePrivateRevertResult {
  return {
    v: 1, requestId: req.requestId, opId: req.opId, op: "session/revert", idempotencyKey: req.idempotencyKey,
    status: "ambiguous", outcome: { type: "ambiguous", time: Date.now() }, accepted: false, transportUnknown,
  }
}

export function makeUnrevertAmbiguous(req: ServePrivateUnrevertRequest, transportUnknown = true): ServePrivateUnrevertResult {
  return {
    v: 1, requestId: req.requestId, opId: req.opId, op: "session/unrevert", idempotencyKey: req.idempotencyKey,
    status: "ambiguous", outcome: { type: "ambiguous", time: Date.now() }, accepted: false, transportUnknown,
  }
}
