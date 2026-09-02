import { isAbsolute } from "path"
import { JsonRpcPeer } from "../../private-worker/peer"
import type { ChildProcess } from "child_process"

export interface ServePrivateCancelQueuedRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/cancelQueued"
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
  }
}

export type ServePrivateCancelQueuedResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/cancelQueued"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { cancelled: boolean }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/cancelQueued"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/cancelQueued"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      revision?: { session: number; config: number }
      transportUnknown?: boolean
    }

export function canonicalCancelQueuedOpId(sessionId: string, messageId: string): string {
  return `cancelQueued:${sessionId}:${messageId}`
}

export function canonicalSessionUpdateOpId(sessionId: string, token?: string): string {
  if (token !== undefined) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
    if (token.includes(":")) throw new TypeError("token must not contain ':'")
    return `sessionUpdate:${sessionId}:${token}`
  }
  return `sessionUpdate:${sessionId}`
}

export function canonicalForkOpId(sessionId: string, token?: string): string {
  if (token !== undefined) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
    if (token.includes(":")) throw new TypeError("token must not contain ':'")
    return `fork:${sessionId}:${token}`
  }
  return `fork:${sessionId}`
}

const SESSION_TITLE_LIMIT = 200
const unsafeTitle = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
function validateTitleStrict(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("payload.title must be non-empty string")
  const value = raw.trim()
  if (!value) throw new Error("payload.title must be non-empty string")
  if (value.length > SESSION_TITLE_LIMIT) throw new Error("payload.title too long")
  if (unsafeTitle.test(value)) throw new Error("payload.title contains control characters")
  return value
}
function isSessionId(v: unknown): boolean {
  return typeof v === "string" && /^ses[^\s:]*$/.test(v) && !v.includes(":") && v.length > 0
}
function parseSessionUpdateOpId(opId: string): { kind: string; parts: string[] } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length < 2) throw new TypeError(`opId must contain ':'`)
  const kind = segs[0]!
  if (kind !== "sessionUpdate") throw new TypeError(`opId kind must be sessionUpdate: ${opId}`)
  const rest = segs.slice(1)
  for (const p of rest) if (p.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (rest.length !== 1 && rest.length !== 2)
    throw new TypeError(`sessionUpdate opId must have 1 or 2 segments: ${opId}`)
  return { kind, parts: rest }
}

export interface ServePrivateSessionUpdateRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/update"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: {
    title: string
  }
}

export type ServePrivateSessionUpdateResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/update"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { session: Record<string, unknown>; title?: string } | { title: string; session?: Record<string, unknown> }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/update"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/update"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      revision?: { session: number; config: number }
      transportUnknown?: boolean
    }

export interface ServePrivateForkRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/fork"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: {
    messageId?: string | null
  }
}

export type ServePrivateForkResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/fork"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { session: Record<string, unknown> }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/fork"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/fork"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      revision?: { session: number; config: number }
      transportUnknown?: boolean
    }

function makeAmbiguous(req: ServePrivateCancelQueuedRequest, transportUnknown = true): ServePrivateCancelQueuedResult {
  const out: ServePrivateCancelQueuedResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/cancelQueued",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function makeFailedInternal(
  req: ServePrivateCancelQueuedRequest,
  message: string,
  code = "internal",
): ServePrivateCancelQueuedResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/cancelQueued",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message, retryable: false } },
    accepted: false,
    failure: { code, message, retryable: false },
  }
}

function makeUpdateAmbiguous(
  req: ServePrivateSessionUpdateRequest,
  transportUnknown = true,
): ServePrivateSessionUpdateResult {
  const out: ServePrivateSessionUpdateResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/update",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function makeUpdateFailedInternal(
  req: ServePrivateSessionUpdateRequest,
  message: string,
  code = "internal",
): ServePrivateSessionUpdateResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/update",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message, retryable: false } },
    accepted: false,
    failure: { code, message, retryable: false },
  }
}

function makeForkAmbiguous(req: ServePrivateForkRequest, transportUnknown = true): ServePrivateForkResult {
  const out: ServePrivateForkResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/fork",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function makeForkFailedInternal(req: ServePrivateForkRequest, message: string, code = "internal"): ServePrivateForkResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/fork",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message, retryable: false } },
    accepted: false,
    failure: { code, message, retryable: false },
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}

function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}

function bestEffortDispose(peer: JsonRpcPeer | null, label: string): void {
  if (!peer) return
  try {
    peer.dispose()
  } catch (err) {
    console.warn(`[Kilo PrivatePeer] best-effort ${label} dispose failed:`, String(err))
  }
}

const PRIVATE_PROTOCOL_NAME = "kilo-private"
const PRIVATE_PROTOCOL_MAJOR = 1

// eslint-disable-next-line complexity
export function validateCancelQueuedRequest(raw: unknown): ServePrivateCancelQueuedRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/cancelQueued") throw new Error("op must be session/cancelQueued")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  if (typeof ctx.sessionId !== "string" || ctx.sessionId.length === 0)
    throw new Error("context.sessionId must be non-empty string")
  if (
    "parentSessionId" in ctx &&
    ctx.parentSessionId !== null &&
    ctx.parentSessionId !== undefined &&
    typeof ctx.parentSessionId !== "string"
  )
    throw new Error("context.parentSessionId must be string or null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (typeof payload.messageId !== "string" || payload.messageId.length === 0)
    throw new Error("payload.messageId must be non-empty string")
  const expected = canonicalCancelQueuedOpId(ctx.sessionId as string, payload.messageId as string)
  if (raw.opId !== expected) throw new Error(`opId must be canonical ${expected}`)
  return raw as unknown as ServePrivateCancelQueuedRequest
}

// eslint-disable-next-line complexity
export function validateCancelQueuedResult(
  raw: unknown,
  req: ServePrivateCancelQueuedRequest,
): ServePrivateCancelQueuedResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/cancelQueued") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  if ("revision" in raw && raw.revision !== undefined) {
    const rev = raw.revision as unknown
    if (
      !isRecord(rev) ||
      typeof rev.session !== "number" ||
      typeof rev.config !== "number" ||
      !isSafeInt(rev.session) ||
      !isSafeInt(rev.config)
    )
      throw new Error("revision must be {session,config} integers")
  }
  if ("transportUnknown" in raw && raw.transportUnknown !== undefined && typeof raw.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data) || typeof data.cancelled !== "boolean")
      throw new Error("succeeded data.cancelled must be boolean")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if ((outcome as Record<string, unknown>).failure !== undefined)
      throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ServePrivateCancelQueuedResult
  }
  if (status === "failed") {
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = (outcome as Record<string, unknown>).failure
    if (
      !isRecord(failure) ||
      typeof failure.code !== "string" ||
      typeof failure.message !== "string" ||
      typeof failure.retryable !== "boolean"
    )
      throw new Error("failed failure invalid")
    if (
      !isRecord(outFailure) ||
      typeof outFailure.code !== "string" ||
      typeof outFailure.message !== "string" ||
      typeof outFailure.retryable !== "boolean"
    )
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable)
      throw new Error("failure retryable mismatch")
    const failureDetail = (failure as Record<string, unknown>).detail
    const outDetail = (outFailure as Record<string, unknown>).detail
    if (failureDetail !== undefined && typeof failureDetail !== "string")
      throw new Error("failed failure.detail must be string if present")
    if (outDetail !== undefined && typeof outDetail !== "string")
      throw new Error("failed outcome.failure.detail must be string if present")
    if (String(failureDetail ?? "") !== String(outDetail ?? "")) throw new Error("failure detail mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateCancelQueuedResult
  }
  // ambiguous
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if ((outcome as Record<string, unknown>).failure !== undefined)
    throw new Error("ambiguous outcome must not have failure")
  if ((outcome as Record<string, unknown>).data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateCancelQueuedResult
}

// eslint-disable-next-line complexity
export function validateSessionUpdateRequest(raw: unknown): ServePrivateSessionUpdateRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/update") throw new Error("op must be session/update")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (
    typeof ctx.directory !== "string" ||
    !isAbsolute(ctx.directory as string) ||
    (ctx.directory as string).includes("\0")
  )
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  // Private requires explicit parentSessionId === null (must be present and null, not omitted or non-null)
  if (!("parentSessionId" in ctx) || ctx.parentSessionId !== null)
    throw new Error("context.parentSessionId must be null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (typeof payload.title !== "string" || payload.title.length === 0)
    throw new Error("payload.title must be non-empty string")
  validateTitleStrict(payload.title)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["title"])
  for (const k of Object.keys(payload as Record<string, unknown>))
    if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  if (ctx.parentSessionId !== null && ctx.parentSessionId !== undefined)
    throw new Error("parentSessionId must be null for sessionUpdate")
  const parsed = parseSessionUpdateOpId(raw.opId as string)
  if (parsed.parts[0] !== ctx.sessionId)
    throw new Error(`opId session binding mismatch: ${raw.opId} vs ${ctx.sessionId}`)
  return raw as unknown as ServePrivateSessionUpdateRequest
}

// eslint-disable-next-line complexity
export function validateSessionUpdateResult(
  raw: unknown,
  req: ServePrivateSessionUpdateRequest,
): ServePrivateSessionUpdateResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/update") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  if ("revision" in raw && raw.revision !== undefined) {
    const rev = raw.revision as unknown
    if (
      !isRecord(rev) ||
      typeof rev.session !== "number" ||
      typeof rev.config !== "number" ||
      !isSafeInt(rev.session) ||
      !isSafeInt(rev.config)
    )
      throw new Error("revision must be {session,config} integers")
  }
  if ("transportUnknown" in raw && raw.transportUnknown !== undefined && typeof raw.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const hasTitle =
      typeof (data as Record<string, unknown>).title === "string" &&
      ((data as Record<string, unknown>).title as string).length > 0
    const sess = (data as Record<string, unknown>).session
    const hasSessionTitle =
      isRecord(sess) &&
      typeof (sess as Record<string, unknown>).title === "string" &&
      ((sess as Record<string, unknown>).title as string).length > 0
    if (!hasTitle && !hasSessionTitle) throw new Error("succeeded data must contain title or session.title")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if ((outcome as Record<string, unknown>).failure !== undefined)
      throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ServePrivateSessionUpdateResult
  }
  if (status === "failed") {
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = (outcome as Record<string, unknown>).failure
    if (
      !isRecord(failure) ||
      typeof failure.code !== "string" ||
      typeof failure.message !== "string" ||
      typeof failure.retryable !== "boolean"
    )
      throw new Error("failed failure invalid")
    if (
      !isRecord(outFailure) ||
      typeof outFailure.code !== "string" ||
      typeof outFailure.message !== "string" ||
      typeof outFailure.retryable !== "boolean"
    )
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable)
      throw new Error("failure retryable mismatch")
    const failureDetail = (failure as Record<string, unknown>).detail
    const outDetail = (outFailure as Record<string, unknown>).detail
    if (failureDetail !== undefined && typeof failureDetail !== "string")
      throw new Error("failed failure.detail must be string if present")
    if (outDetail !== undefined && typeof outDetail !== "string")
      throw new Error("failed outcome.failure.detail must be string if present")
    if (String(failureDetail ?? "") !== String(outDetail ?? "")) throw new Error("failure detail mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateSessionUpdateResult
  }
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if ((outcome as Record<string, unknown>).failure !== undefined)
    throw new Error("ambiguous outcome must not have failure")
  if ((outcome as Record<string, unknown>).data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateSessionUpdateResult
}

function parseForkOpId(opId: string): { kind: string; parts: string[] } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length < 2) throw new TypeError(`opId must contain ':'`)
  const kind = segs[0]!
  if (kind !== "fork") throw new TypeError(`opId kind must be fork: ${opId}`)
  const rest = segs.slice(1)
  for (const p of rest) if (p.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (rest.length !== 1 && rest.length !== 2) throw new TypeError(`fork opId must have 1 or 2 segments: ${opId}`)
  return { kind, parts: rest }
}

// eslint-disable-next-line complexity
export function validateForkRequest(raw: unknown): ServePrivateForkRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/fork") throw new Error("op must be session/fork")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory as string) || (ctx.directory as string).includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  if ("parentSessionId" in ctx && ctx.parentSessionId !== null && ctx.parentSessionId !== undefined)
    throw new Error("context.parentSessionId must be null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if ("messageId" in payload && payload.messageId !== null && payload.messageId !== undefined) {
    if (typeof payload.messageId !== "string" || payload.messageId.length === 0) throw new Error("payload.messageId must be non-empty string")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(ctx as Record<string, unknown>)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["messageId"])
  for (const k of Object.keys(payload as Record<string, unknown>)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  const parsed = parseForkOpId(raw.opId as string)
  if (parsed.parts[0] !== ctx.sessionId) throw new Error(`opId session binding mismatch: ${raw.opId} vs ${ctx.sessionId}`)
  return raw as unknown as ServePrivateForkRequest
}

// eslint-disable-next-line complexity
export function validateForkResult(raw: unknown, req: ServePrivateForkRequest): ServePrivateForkResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/fork") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous") throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number") throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  if ("revision" in raw && raw.revision !== undefined) {
    const rev = raw.revision as unknown
    if (!isRecord(rev) || typeof rev.session !== "number" || typeof rev.config !== "number" || !isSafeInt(rev.session) || !isSafeInt(rev.config))
      throw new Error("revision must be {session,config} integers")
  }
  if ("transportUnknown" in raw && raw.transportUnknown !== undefined && typeof raw.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data) || !isRecord((data as Record<string, unknown>).session)) throw new Error("succeeded data.session must be object")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if ((outcome as Record<string, unknown>).failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ServePrivateForkResult
  }
  if (status === "failed") {
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = (outcome as Record<string, unknown>).failure
    if (!isRecord(failure) || typeof failure.code !== "string" || typeof failure.message !== "string" || typeof failure.retryable !== "boolean")
      throw new Error("failed failure invalid")
    if (!isRecord(outFailure) || typeof outFailure.code !== "string" || typeof outFailure.message !== "string" || typeof outFailure.retryable !== "boolean")
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable) throw new Error("failure retryable mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateForkResult
  }
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if ((outcome as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  if ((outcome as Record<string, unknown>).data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateForkResult
}

export interface ServePrivatePeerOptions {
  reader: NodeJS.ReadableStream | null
  writer: NodeJS.WritableStream | null
  pid?: number
  epoch: number
  process?: ChildProcess | null
  initializeTimeoutMs?: number
}

export class ServePrivatePeer {
  private peer: JsonRpcPeer | null = null
  private available = false
  private disposed = false
  private capabilities: Record<string, unknown> | unknown[] | null = null
  private initRaw: unknown | null = null
  private initEpoch: number | null = null

  constructor(private readonly opts: ServePrivatePeerOptions) {}

  getEpoch(): number {
    return this.opts.epoch
  }

  getPid(): number | undefined {
    return this.opts.pid
  }

  isAvailable(): boolean {
    return this.available && !this.disposed && this.peer?.getState() === "open"
  }

  isDisposed(): boolean {
    return this.disposed
  }

  getCapabilities(): unknown {
    return this.capabilities
  }

  getInitResult(): unknown {
    return this.initRaw
  }

  // eslint-disable-next-line complexity
  async initialize(timeoutMs = 5000): Promise<boolean> {
    if (this.disposed) return false
    if (this.available) return true
    const actualTimeout = this.opts.initializeTimeoutMs ?? timeoutMs
    if (!this.opts.reader || !this.opts.writer) {
      this.available = false
      return false
    }
    const epochAtStart = this.opts.epoch
    this.initEpoch = epochAtStart
    const peerAtStart = new JsonRpcPeer({
      reader: this.opts.reader,
      writer: this.opts.writer,
      child: this.opts.process ?? undefined,
      onClosed: () => {
        if (this.initEpoch !== epochAtStart) return
        if (this.opts.epoch !== epochAtStart) return
        this.available = false
      },
    })
    this.peer = peerAtStart

    const initPromise = peerAtStart.request("initialize", {
      protocol: { name: "kilo-private", major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["session/cancelQueued", "session/update", "session/fork"],
    })
    void initPromise.catch((err) => console.warn("[Kilo PrivatePeer] initialize request error:", String(err)))

    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`initialize timed out after ${actualTimeout}ms`)), actualTimeout)
      ;(timer as unknown as { unref?: () => void })?.unref?.()
    })

    try {
      const res = (await Promise.race([initPromise, timeout])) as Record<string, unknown>
      if (timer) clearTimeout(timer)
      if (this.disposed) return false
      if (this.initEpoch !== epochAtStart) return false
      if (this.opts.epoch !== epochAtStart) return false
      if (peerAtStart.getState() !== "open") {
        this.available = false
        bestEffortDispose(peerAtStart, "post-initialize-closed")
        if (this.peer === peerAtStart) this.peer = null
        return false
      }

      const proto = res?.protocol as Record<string, unknown> | undefined
      let protoName: string | undefined
      let protoMajor: number | undefined
      if (proto && typeof proto.name === "string") protoName = proto.name as string
      if (proto && typeof proto.major === "number") protoMajor = proto.major as number
      else if (typeof res?.protocolVersion === "string") {
        const parts = (res.protocolVersion as string).split(".")
        const n = Number(parts[0])
        if (!Number.isNaN(n)) protoMajor = n
      } else if (res?.protocolVersion && typeof res.protocolVersion === "object") {
        const pv = res.protocolVersion as Record<string, unknown>
        if (typeof pv.major === "number") protoMajor = pv.major as number
      }

      // Strict identity: require kilo-private name and major 1; missing/wrong => fail-closed unavailable.
      // Known old CLI shapes (capabilities {} or protocolVersion "1.0" with serverInfo kilo-private-worker)
      // have no protocol.name and are treated as unavailable rather than crashing the SDK connection.
      if (protoName !== PRIVATE_PROTOCOL_NAME || protoMajor !== PRIVATE_PROTOCOL_MAJOR) {
        this.available = false
        bestEffortDispose(peerAtStart, "protocol-mismatch")
        if (this.peer === peerAtStart) this.peer = null
        console.warn("[Kilo PrivatePeer] protocol mismatch fail-closed:", { protoName, protoMajor })
        return false
      }

      const caps = (res as Record<string, unknown>)?.capabilities as unknown
      let hasCancelQueued = false
      let hasSessionUpdate = false
      let hasFork = false
      if (Array.isArray(caps)) {
        hasCancelQueued = caps.includes("session/cancelQueued")
        hasSessionUpdate = caps.includes("session/update")
        hasFork = caps.includes("session/fork")
      } else if (caps && typeof caps === "object") {
        const c = caps as Record<string, unknown>
        if ((c as Record<string, unknown>)["session/cancelQueued"]) hasCancelQueued = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("cancelQueued")
        )
          hasCancelQueued = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if (sess.cancelQueued) hasCancelQueued = true
        } else if (c["session/cancelQueued"] === true) hasCancelQueued = true
        if ((c as Record<string, unknown>)["session/update"]) hasSessionUpdate = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("update")
        )
          hasSessionUpdate = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if ((sess as Record<string, unknown>).update) hasSessionUpdate = true
        } else if (c["session/update"] === true) hasSessionUpdate = true
        if ((c as Record<string, unknown>)["session/fork"]) hasFork = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("fork")
        )
          hasFork = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if ((sess as Record<string, unknown>).fork) hasFork = true
        } else if (c["session/fork"] === true) hasFork = true
        if (Object.keys(c).length === 0) {
          hasCancelQueued = false
          hasSessionUpdate = false
          hasFork = false
        }
      }

      if (!hasCancelQueued && !hasSessionUpdate && !hasFork) {
        this.available = false
        bestEffortDispose(peerAtStart, "missing-capability")
        if (this.peer === peerAtStart) this.peer = null
        return false
      }

      if (this.disposed || this.initEpoch !== epochAtStart || this.opts.epoch !== epochAtStart) {
        bestEffortDispose(peerAtStart, "stale-epoch")
        if (this.peer === peerAtStart) this.peer = null
        return false
      }

      this.capabilities = caps as Record<string, unknown>
      this.initRaw = res
      this.available = true
      return true
    } catch (err) {
      if (timer) clearTimeout(timer)
      console.warn("[Kilo PrivatePeer] initialize failed:", String(err))
      if (this.disposed || this.initEpoch !== epochAtStart) {
        bestEffortDispose(peerAtStart, "initialize-disposed")
        if (this.peer === peerAtStart) this.peer = null
        return false
      }
      this.available = false
      bestEffortDispose(peerAtStart, "initialize-error")
      if (this.peer === peerAtStart) this.peer = null
      return false
    }
  }

  // eslint-disable-next-line complexity
  async privateCancelQueued(req: ServePrivateCancelQueuedRequest): Promise<ServePrivateCancelQueuedResult> {
    validateCancelQueuedRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    try {
      const raw = (await peerAtCall.request("session/cancelQueued", req)) as unknown
      if (
        this.opts.epoch !== currentEpoch ||
        this.disposed ||
        this.peer !== peerAtCall ||
        peerAtCall.getState() === "closed"
      ) {
        return makeAmbiguous(req, true)
      }
      try {
        const validated = validateCancelQueuedResult(raw, req)
        return validated
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return makeFailedInternal(req, `invalid private response shape: ${msg}`)
      }
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string; stale?: boolean; data?: unknown }
      const isPeerClosed =
        peerAtCall.getState() === "closed" ||
        this.peer?.getState() === "closed" ||
        this.disposed ||
        this.opts.epoch !== currentEpoch ||
        this.peer !== peerAtCall ||
        err?.message?.includes("Peer closed") ||
        err?.message?.includes("Peer disposed") ||
        err?.message?.includes("Peer is closed") ||
        err?.code === -32603 ||
        err?.stale === true

      if (isPeerClosed) {
        return makeAmbiguous(req, true)
      }
      const code = typeof err?.code === "number" ? String(err.code) : "internal"
      const msg = err?.message ?? String(e)
      const failed: ServePrivateCancelQueuedResult = {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/cancelQueued",
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
        accepted: false,
        failure: { code, message: msg, retryable: false },
      }
      return failed
    }
  }

  // eslint-disable-next-line complexity
  hasCapability(cap: string): boolean {
    const caps = this.capabilities
    if (!caps) return false
    if (Array.isArray(caps)) return caps.includes(cap)
    if (typeof caps === "object") {
      const c = caps as Record<string, unknown>
      if (c[cap]) return true
      if (cap === "session/update" && c["session/update"] === true) return true
      if (cap === "session/update" && Array.isArray(c.session) && (c.session as unknown[]).includes("update"))
        return true
      if (cap === "session/update" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.update) return true
      }
      if (cap === "session/cancelQueued" && c["session/cancelQueued"]) return true
      if (cap === "session/fork" && c["session/fork"] === true) return true
      if (cap === "session/fork" && Array.isArray(c.session) && (c.session as unknown[]).includes("fork")) return true
      if (cap === "session/fork" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.fork) return true
      }
    }
    return false
  }

  // eslint-disable-next-line complexity
  async privateSessionUpdate(req: ServePrivateSessionUpdateRequest): Promise<ServePrivateSessionUpdateResult> {
    validateSessionUpdateRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/update")) {
      throw new Error("Private peer missing session/update capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    try {
      const raw = (await peerAtCall.request("session/update", req)) as unknown
      if (
        this.opts.epoch !== currentEpoch ||
        this.disposed ||
        this.peer !== peerAtCall ||
        peerAtCall.getState() === "closed"
      ) {
        return makeUpdateAmbiguous(req, true)
      }
      try {
        const validated = validateSessionUpdateResult(raw, req)
        return validated
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return makeUpdateFailedInternal(req, `invalid private response shape: ${msg}`)
      }
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string; stale?: boolean; data?: unknown }
      const isPeerClosed =
        peerAtCall.getState() === "closed" ||
        this.peer?.getState() === "closed" ||
        this.disposed ||
        this.opts.epoch !== currentEpoch ||
        this.peer !== peerAtCall ||
        err?.message?.includes("Peer closed") ||
        err?.message?.includes("Peer disposed") ||
        err?.message?.includes("Peer is closed") ||
        err?.code === -32603 ||
        err?.stale === true

      if (isPeerClosed) {
        return makeUpdateAmbiguous(req, true)
      }
      const code = typeof err?.code === "number" ? String(err.code) : "internal"
      const msg = err?.message ?? String(e)
      const failed: ServePrivateSessionUpdateResult = {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/update",
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
        accepted: false,
        failure: { code, message: msg, retryable: false },
      }
      return failed
    }
  }

  // eslint-disable-next-line complexity
  async privateFork(req: ServePrivateForkRequest): Promise<ServePrivateForkResult> {
    validateForkRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/fork")) {
      throw new Error("Private peer missing session/fork capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    try {
      const raw = (await peerAtCall.request("session/fork", req)) as unknown
      if (
        this.opts.epoch !== currentEpoch ||
        this.disposed ||
        this.peer !== peerAtCall ||
        peerAtCall.getState() === "closed"
      ) {
        return makeForkAmbiguous(req, true)
      }
      try {
        const validated = validateForkResult(raw, req)
        return validated
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return makeForkFailedInternal(req, `invalid private response shape: ${msg}`)
      }
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string; stale?: boolean; data?: unknown }
      const isPeerClosed =
        peerAtCall.getState() === "closed" ||
        this.peer?.getState() === "closed" ||
        this.disposed ||
        this.opts.epoch !== currentEpoch ||
        this.peer !== peerAtCall ||
        err?.message?.includes("Peer closed") ||
        err?.message?.includes("Peer disposed") ||
        err?.message?.includes("Peer is closed") ||
        err?.code === -32603 ||
        err?.stale === true

      if (isPeerClosed) {
        return makeForkAmbiguous(req, true)
      }
      const code = typeof err?.code === "number" ? String(err.code) : "internal"
      const msg = err?.message ?? String(e)
      const failed: ServePrivateForkResult = {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/fork",
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
        accepted: false,
        failure: { code, message: msg, retryable: false },
      }
      return failed
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.available = false
    bestEffortDispose(this.peer, "dispose")
    this.peer = null
  }

  getProtocolForFixture(): { name: string; major: number; minor?: number } | null {
    const raw = this.initRaw as Record<string, unknown> | null
    if (!raw) return null
    const proto = raw.protocol as Record<string, unknown> | undefined
    if (proto && typeof proto.name === "string" && typeof proto.major === "number") {
      const out: { name: string; major: number; minor?: number } = {
        name: proto.name as string,
        major: proto.major as number,
      }
      if (typeof proto.minor === "number") out.minor = proto.minor as number
      return out
    }
    // fallback shapes
    if (typeof raw.protocolVersion === "string") {
      const parts = (raw.protocolVersion as string).split(".")
      const maj = Number(parts[0])
      const min = parts[1] !== undefined ? Number(parts[1]) : undefined
      if (!Number.isNaN(maj))
        return { name: "kilo-private", major: maj, ...(min !== undefined && !Number.isNaN(min) ? { minor: min } : {}) }
    }
    return null
  }

  getPeerStateForFixture(): string {
    if (this.disposed) return "disposed"
    if (!this.peer) return "absent"
    try {
      return this.peer.getState()
    } catch {
      return "unknown"
    }
  }

  getCapabilitiesListForFixture(): string[] {
    const caps = this.capabilities
    if (!caps) return []
    if (Array.isArray(caps)) return [...(caps as string[])]
    if (typeof caps === "object") {
      const c = caps as Record<string, unknown>
      const out: string[] = []
      for (const k of Object.keys(c)) {
        if ((k === "session/cancelQueued" || k === "session/update" || k === "session/fork") && c[k]) out.push(k)
      }
      if (Array.isArray(c.session)) {
        for (const v of c.session as unknown[])
          if (v === "cancelQueued") out.push("session/cancelQueued")
          else if (v === "update") out.push("session/update")
          else if (v === "fork") out.push("session/fork")
      }
      if (typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.cancelQueued) out.push("session/cancelQueued")
        if (sess.update) out.push("session/update")
        if (sess.fork) out.push("session/fork")
      }
      return [...new Set(out)]
    }
    return []
  }
}

export function getSdkHttpStatus(sdk: { response?: unknown; error?: unknown; data?: unknown }): number | null {
  const resp = (sdk as { response?: unknown }).response as { status?: unknown } | undefined
  if (
    resp &&
    typeof resp.status === "number" &&
    Number.isInteger(resp.status) &&
    resp.status >= 100 &&
    resp.status < 600
  )
    return resp.status
  if (resp && typeof resp.status === "string") {
    const n = Number(resp.status)
    if (Number.isInteger(n) && n >= 100 && n < 600) return n
  }
  return null
}

function sdkHttpStatus(sdk: { data?: unknown; error?: unknown; response?: unknown }): number | null {
  const fromResponse = getSdkHttpStatus(sdk as { response?: unknown })
  if (fromResponse !== null) return fromResponse
  if (!sdk.error) return null
  const err = sdk.error as Record<string, unknown>
  const candidates: unknown[] = [
    err.status,
    err.statusCode,
    err.code,
    err.httpStatus,
    (err as Record<string, unknown>).status_code,
    (err as Record<string, unknown>).httpStatusCode,
  ]
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c) && c >= 100 && c < 600) return c
    if (typeof c === "string") {
      const n = Number(c)
      if (Number.isInteger(n) && n >= 100 && n < 600) return n
    }
  }
  if (typeof err.message === "string") {
    const m = err.message.match(/\b(400|404|409|500)\b/)
    if (m) return Number(m[1])
  }
  const tag = typeof err._tag === "string" ? String(err._tag).toLowerCase() : ""
  if (tag.includes("notfound")) return 404
  if (tag.includes("conflict")) return 409
  if (tag.includes("badrequest")) return 400
  if (tag.includes("internal")) return 500
  return null
}

function sdkStatusClass(status: number | null): string | null {
  if (status === null) return null
  if (status === 400) return "400"
  if (status === 404) return "404"
  if (status === 409) return "409"
  if (status === 500) return "500"
  return String(status)
}

// eslint-disable-next-line complexity
export function compareParity(
  priv: ServePrivateCancelQueuedResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const privStatus: string = priv.status
  const isTransportUnknown = !!(priv as Record<string, unknown>).transportUnknown
  if (isTransportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  // ambiguous without transportUnknown maps to SDK 409 class
  if (privStatus === "ambiguous" && sdkStatus === "failed") {
    const http = sdkHttpStatus(sdk)
    if (http === 409) {
      return { divergence: null, details: { sdkStatus, privStatus, http } }
    }
    return {
      divergence: `status-mismatch:sdk=failed(${String(http ?? "unknown")}) priv=ambiguous`,
      details: { sdkStatus, privStatus, http },
    }
  }
  if (privStatus === "ambiguous" && sdkStatus === "succeeded") {
    return { divergence: `status-mismatch:sdk=succeeded priv=ambiguous`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus !== privStatus) {
    return { divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkCancelled: unknown = sdk.data
    const privCancelled: unknown = (priv as Extract<ServePrivateCancelQueuedResult, { status: "succeeded" }>).data
      ?.cancelled
    if (sdkCancelled !== privCancelled) {
      return {
        divergence: `cancelled-mismatch:sdk=${String(sdkCancelled)} priv=${String(privCancelled)}`,
        details: { sdkCancelled, privCancelled },
      }
    }
    return { divergence: null, details: {} }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateCancelQueuedResult, { status: "failed" }>).failure?.code ??
      "unknown") as string
    const http = sdkHttpStatus(sdk)
    const cls = sdkStatusClass(http)
    const allowed = (() => {
      if (cls === "400") return new Set(["validation.failed", "scope_mismatch"])
      if (cls === "404") return new Set(["session.not_found"])
      if (cls === "409") return new Set(["stale", "conflict", "InstanceUnavailableDuringConfigRebuild"])
      if (cls === "500") return new Set(["internal"])
      return null
    })()
    if (allowed) {
      if (!allowed.has(privCode)) {
        return {
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    // fallback when SDK class unknown: require exact code equality only if SDK provides string code that looks like typed code
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}

// eslint-disable-next-line complexity
export function compareUpdateParity(
  priv: ServePrivateSessionUpdateResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const privStatus: string = priv.status
  const isTransportUnknown = !!(priv as Record<string, unknown>).transportUnknown
  if (isTransportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (privStatus === "ambiguous" && sdkStatus === "failed") {
    const http = sdkHttpStatus(sdk)
    if (http === 409) {
      return { divergence: null, details: { sdkStatus, privStatus, http } }
    }
    return {
      divergence: `status-mismatch:sdk=failed(${String(http ?? "unknown")}) priv=ambiguous`,
      details: { sdkStatus, privStatus, http },
    }
  }
  if (privStatus === "ambiguous" && sdkStatus === "succeeded") {
    return { divergence: `status-mismatch:sdk=succeeded priv=ambiguous`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus !== privStatus) {
    return { divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkData = sdk.data as Record<string, unknown> | undefined
    const sdkTitle: unknown =
      sdkData?.title ?? (sdkData?.session as Record<string, unknown> | undefined)?.title ?? sdk.data
    const pdata = (priv as Extract<ServePrivateSessionUpdateResult, { status: "succeeded" }>).data as Record<
      string,
      unknown
    >
    const privTitle: unknown =
      (pdata as Record<string, unknown>).title ??
      ((pdata as Record<string, unknown>).session as Record<string, unknown> | undefined)?.title
    // If both are plain strings, compare directly; otherwise compare title fields
    const sdkStr =
      typeof sdkTitle === "string" ? sdkTitle : typeof sdkData?.title === "string" ? sdkData?.title : sdkTitle
    const privStr = typeof privTitle === "string" ? privTitle : undefined
    if (typeof sdkStr === "string" && typeof privStr === "string") {
      if (sdkStr !== privStr) {
        return { divergence: `title-mismatch`, details: { mismatch: true } }
      }
      return { divergence: null, details: {} }
    }
    // fallback: compare stringified data when title not extractable — treat as divergence if not equal (redacted)
    if (String(sdkTitle) !== String(privTitle)) {
      return { divergence: `title-mismatch`, details: { mismatch: true } }
    }
    return { divergence: null, details: {} }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateSessionUpdateResult, { status: "failed" }>).failure?.code ??
      "unknown") as string
    const http = sdkHttpStatus(sdk)
    const cls = sdkStatusClass(http)
    const allowed = (() => {
      if (cls === "400") return new Set(["validation.failed", "scope_mismatch", "invalid.title"])
      if (cls === "404") return new Set(["session.not_found"])
      if (cls === "409") return new Set(["stale", "conflict", "InstanceUnavailableDuringConfigRebuild"])
      if (cls === "500") return new Set(["internal"])
      return null
    })()
    if (allowed) {
      if (!allowed.has(privCode)) {
        return {
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}

// eslint-disable-next-line complexity
export function compareForkParity(
  priv: ServePrivateForkResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const privStatus: string = priv.status
  const isTransportUnknown = !!(priv as Record<string, unknown>).transportUnknown
  if (isTransportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (privStatus === "ambiguous" && sdkStatus === "failed") {
    const http = sdkHttpStatus(sdk)
    if (http === 409) {
      return { divergence: null, details: { sdkStatus, privStatus, http } }
    }
    return {
      divergence: `status-mismatch:sdk=failed(${String(http ?? "unknown")}) priv=ambiguous`,
      details: { sdkStatus, privStatus, http },
    }
  }
  if (privStatus === "ambiguous" && sdkStatus === "succeeded") {
    return { divergence: `status-mismatch:sdk=succeeded priv=ambiguous`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus !== privStatus) {
    return { divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkData = sdk.data as Record<string, unknown> | undefined
    const sdkId: unknown = (sdkData as Record<string, unknown> | undefined)?.id ?? sdk.data
    const pdata = (priv as Extract<ServePrivateForkResult, { status: "succeeded" }>).data as Record<string, unknown>
    const privId: unknown = (pdata.session as Record<string, unknown> | undefined)?.id ?? pdata.id
    if (typeof sdkId === "string" && typeof privId === "string") {
      if (sdkId !== privId) {
        return { divergence: `fork-id-mismatch`, details: { mismatch: true } }
      }
      return { divergence: null, details: {} }
    }
    if (String(sdkId) !== String(privId)) {
      return { divergence: `fork-id-mismatch`, details: { mismatch: true } }
    }
    return { divergence: null, details: {} }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateForkResult, { status: "failed" }>).failure?.code ?? "unknown") as string
    const http = sdkHttpStatus(sdk)
    const cls = sdkStatusClass(http)
    const allowed = (() => {
      if (cls === "400") return new Set(["validation.failed", "scope_mismatch"])
      if (cls === "404") return new Set(["session.not_found"])
      if (cls === "409") return new Set(["stale", "conflict", "InstanceUnavailableDuringConfigRebuild"])
      if (cls === "500") return new Set(["internal"])
      return null
    })()
    if (allowed) {
      if (!allowed.has(privCode)) {
        return {
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}
