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

export const REMOTE_ENABLE_OP = "remote/enable" as const
export const REMOTE_DISABLE_OP = "remote/disable" as const

export function canonicalRemoteEnableOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `remote-enable:${token}`
}

export function canonicalRemoteDisableOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `remote-disable:${token}`
}

export function parseRemoteEnableOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`remote-enable opId must have 1 segment: ${opId}`)
  if (segs[0] !== "remote-enable") throw new TypeError(`opId kind must be remote-enable: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { token }
}

export function parseRemoteDisableOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`remote-disable opId must have 1 segment: ${opId}`)
  if (segs[0] !== "remote-disable") throw new TypeError(`opId kind must be remote-disable: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { token }
}

export interface RemoteToggleContractRequest {
  v: 1
  requestId: string
  opId: string
  op: typeof REMOTE_ENABLE_OP | typeof REMOTE_DISABLE_OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export type RemoteToggleAction = "enable" | "disable"

// eslint-disable-next-line complexity
export function validateRemoteToggleContractRequest(raw: unknown): RemoteToggleContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== REMOTE_ENABLE_OP && raw.op !== REMOTE_DISABLE_OP) throw new Error("op must be remote/enable or remote/disable")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for remote-toggle contract")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!isNonEmpty(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for remote-toggle contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  if (raw.op === REMOTE_ENABLE_OP) {
    parseRemoteEnableOpId(raw.opId as string)
    const idem = parseRemoteEnableOpId(raw.idempotencyKey as string)
    if (idem.token !== parseRemoteEnableOpId(raw.opId as string).token)
      throw new Error("idempotencyKey token must equal opId token")
  } else {
    parseRemoteDisableOpId(raw.opId as string)
    const idem = parseRemoteDisableOpId(raw.idempotencyKey as string)
    if (idem.token !== parseRemoteDisableOpId(raw.opId as string).token)
      throw new Error("idempotencyKey token must equal opId token")
  }
  return raw as unknown as RemoteToggleContractRequest
}

export type RemoteToggleScopeWhich = "directory" | "workspace" | "request"

export type RemoteToggleScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: RemoteToggleScopeWhich }

export function checkRemoteToggleScope(
  req: RemoteToggleContractRequest,
  expected: { directory: string; workspace?: string; token: string; action: RemoteToggleAction },
): RemoteToggleScopeCheck {
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
  if ((wantWs === undefined) !== (gotWs === undefined))
    return { ok: false, code: "scope_mismatch", which: "workspace" }
  if (wantWs !== undefined && gotWs !== wantWs) return { ok: false, code: "scope_mismatch", which: "workspace" }
  const wantOp = expected.action === "enable" ? REMOTE_ENABLE_OP : REMOTE_DISABLE_OP
  if (req.op !== wantOp) return { ok: false, code: "scope_mismatch", which: "request" }
  const parsed = expected.action === "enable" ? parseRemoteEnableOpId(req.opId) : parseRemoteDisableOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound =
    expected.action === "enable"
      ? canonicalRemoteEnableOpId(expected.token)
      : canonicalRemoteDisableOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound)
    return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

export interface RemoteTogglePayload {
  enabled: boolean
  connected: boolean
}

const REMOTE_TOGGLE_PAYLOAD_FIELDS = new Set(["enabled", "connected"])

export function validateRemoteTogglePayload(raw: unknown): RemoteTogglePayload {
  if (!isRecord(raw)) throw new Error("remote-toggle payload must be object")
  assertAllowedKeys(raw as Record<string, unknown>, REMOTE_TOGGLE_PAYLOAD_FIELDS, "remote-toggle")
  if (typeof (raw as Record<string, unknown>).enabled !== "boolean")
    throw new Error("remote-toggle.enabled must be boolean")
  if (typeof (raw as Record<string, unknown>).connected !== "boolean")
    throw new Error("remote-toggle.connected must be boolean")
  return raw as unknown as RemoteTogglePayload
}

export interface RemoteToggleFailure {
  code: string
  message: string
  retryable: boolean
}

const REMOTE_TOGGLE_FAILURE_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "enabled",
  "connected",
  "status",
  "directory",
  "workspace",
  "token",
  "url",
  "credential",
])

const REMOTE_TOGGLE_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateRemoteToggleFailure(raw: unknown): RemoteToggleFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (REMOTE_TOGGLE_FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  assertAllowedKeys(raw as Record<string, unknown>, REMOTE_TOGGLE_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as RemoteToggleFailure
}

export type RemoteToggleResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof REMOTE_ENABLE_OP | typeof REMOTE_DISABLE_OP
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { status: RemoteTogglePayload }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof REMOTE_ENABLE_OP | typeof REMOTE_DISABLE_OP
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: RemoteToggleFailure }
      accepted: boolean
      failure: RemoteToggleFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof REMOTE_ENABLE_OP | typeof REMOTE_DISABLE_OP
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeRemoteToggleAmbiguous(
  req: RemoteToggleContractRequest,
  transportUnknown = true,
): RemoteToggleResult {
  const out: RemoteToggleResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type RemoteToggleWireOutcome =
  | { kind: "valid"; result: RemoteToggleResult }
  | { kind: "invalid"; detail: string }

const REMOTE_TOGGLE_RESULT_SUCCEEDED = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "data",
])
const REMOTE_TOGGLE_RESULT_FAILED = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "failure",
])
const REMOTE_TOGGLE_RESULT_AMBIGUOUS = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "transportUnknown",
])
const REMOTE_TOGGLE_OUTCOME_PLAIN = new Set(["type", "time"])
const REMOTE_TOGGLE_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateRemoteToggleResult(raw: unknown, req: RemoteToggleContractRequest): RemoteToggleResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== req.op) throw new Error("op mismatch")
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
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    assertAllowedKeys(rec, REMOTE_TOGGLE_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, REMOTE_TOGGLE_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["status"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateRemoteTogglePayload((data as Record<string, unknown>).status)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as RemoteToggleResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, REMOTE_TOGGLE_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, REMOTE_TOGGLE_OUTCOME_FAILED, "outcome")
    const failure = validateRemoteToggleFailure(rec.failure)
    const outFailure = validateRemoteToggleFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as RemoteToggleResult
  }
  assertAllowedKeys(rec, REMOTE_TOGGLE_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, REMOTE_TOGGLE_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as RemoteToggleResult
}

export function isSettledRemoteToggleResult(result: unknown, req: RemoteToggleContractRequest): boolean {
  if (!isRecord(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateRemoteToggleResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
