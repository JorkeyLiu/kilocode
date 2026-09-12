import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isPermissionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("per")
}

function isReply(v: unknown): v is "once" | "always" | "reject" {
  return v === "once" || v === "always" || v === "reject"
}

export function canonicalPermissionOpId(requestID: string, token: string): string {
  if (typeof requestID !== "string" || requestID.length === 0) throw new TypeError("requestID must be non-empty string")
  if (requestID.includes("\0")) throw new TypeError("requestID must not contain null bytes")
  if (!isPermissionId(requestID)) throw new TypeError("requestID must be PermissionID")
  if (requestID.includes(":")) throw new TypeError("requestID must not contain ':'")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("token must not contain null bytes")
  return `permission:${requestID}:${token}`
}

export function parsePermissionOpId(opId: string): { requestID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`permission opId must have 2 segments: ${opId}`)
  if (segs[0] !== "permission") throw new TypeError(`opId kind must be permission: ${opId}`)
  const rid = segs[1]!
  const token = segs[2]!
  if (rid.length === 0 || !isPermissionId(rid)) throw new TypeError(`opId requestID must be PermissionID: ${opId}`)
  if (rid.includes("\0")) throw new TypeError("opId requestID must not contain null bytes")
  if (token.length === 0) throw new TypeError(`opId token must be non-empty: ${opId}`)
  if (token.includes(":")) throw new TypeError("opId token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("opId token must not contain null bytes")
  return { requestID: rid, token }
}

export interface PermissionSaveContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "permission/save-always-rules"
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { approvedAlways?: string[]; deniedAlways?: string[] }
}

export interface PermissionReplyContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "permission/reply"
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { reply: "once" | "always" | "reject"; message?: string }
}

export type PermissionContractRequest = PermissionSaveContractRequest | PermissionReplyContractRequest

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

function checkContext(ctx: unknown): Record<string, unknown> {
  if (!record(ctx)) throw new Error("context must be object")
  const allowed = new Set(["directory", "requestID"])
  for (const k of Object.keys(ctx)) {
    if (!allowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isPermissionId(ctx.requestID)) throw new Error("context.requestID must be PermissionID")
  if ((ctx.requestID as string).includes("\0")) throw new Error("context.requestID must not contain null bytes")
  return ctx
}

function strings(v: unknown, label: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${label} must be array`)
  for (const e of v) {
    if (typeof e !== "string") throw new Error(`${label} entries must be strings`)
    if ((e as string).includes("\0")) throw new Error(`${label} entries must not contain null bytes`)
  }
  return [...(v as string[])]
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
  if (raw.op !== "permission/save-always-rules" && raw.op !== "permission/reply")
    throw new Error("op must be permission/save-always-rules or permission/reply")
  clean(raw.idempotencyKey, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  const ctx = checkContext(raw.context)
  const parsed = parsePermissionOpId(raw.opId as string)
  const idem = parsePermissionOpId(raw.idempotencyKey as string)
  if (idem.requestID !== parsed.requestID) throw new Error("idempotencyKey request binding mismatch")
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  if (parsed.requestID !== ctx.requestID) throw new Error("opId request binding mismatch")
  return raw as Record<string, unknown>
}

export function validatePermissionSaveContractRequest(raw: unknown): PermissionSaveContractRequest {
  const root = base(raw)
  if (root.op !== "permission/save-always-rules") throw new Error("op must be permission/save-always-rules")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  const allowed = new Set(["approvedAlways", "deniedAlways"])
  for (const k of Object.keys(payload)) {
    if (!allowed.has(k)) throw new Error(`unexpected payload field ${k}`)
  }
  const rec = payload as Record<string, unknown>
  if (rec.approvedAlways !== undefined) strings(rec.approvedAlways, "payload.approvedAlways")
  if (rec.deniedAlways !== undefined) strings(rec.deniedAlways, "payload.deniedAlways")
  return raw as unknown as PermissionSaveContractRequest
}

export function validatePermissionReplyContractRequest(raw: unknown): PermissionReplyContractRequest {
  const root = base(raw)
  if (root.op !== "permission/reply") throw new Error("op must be permission/reply")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  const allowed = new Set(["reply", "message"])
  for (const k of Object.keys(payload)) {
    if (!allowed.has(k)) throw new Error(`unexpected payload field ${k}`)
  }
  const rec = payload as Record<string, unknown>
  if (!isReply(rec.reply)) throw new Error("payload.reply must be once/always/reject")
  if (rec.message !== undefined) {
    if (typeof rec.message !== "string") throw new Error("payload.message must be string")
    if ((rec.message as string).includes("\0")) throw new Error("payload.message must not contain null bytes")
  }
  return raw as unknown as PermissionReplyContractRequest
}

export interface PermissionTerminal {
  kind: "terminal"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  sessionID?: string
  requestID: string
  reply?: "once" | "always" | "reject"
}

export type PermissionFailureCode = "permission.not_found" | "scope_mismatch" | "validation.failed" | "internal"

export interface PermissionTerminalFailure {
  kind: "terminal-failure"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: true
  failure: { code: PermissionFailureCode; retryable: false; time: number }
  sideEffect: false
}

export interface PermissionAmbiguous {
  kind: "ambiguous"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: false
  transportUnknown: true
}

function checkIdentity(raw: Record<string, unknown>, req: PermissionContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== true) throw new Error("terminal accepted must be true")
  if (raw.terminal !== true) throw new Error("terminal must be true")
}

function checkFailureIdentity(raw: Record<string, unknown>, req: PermissionContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== false) throw new Error("terminal-failure accepted must be false")
  if (raw.terminal !== true) throw new Error("terminal must be true")
  if (raw.sideEffect !== false) throw new Error("terminal-failure sideEffect must be false")
}

export function validatePermissionSaveResult(raw: unknown, req: PermissionSaveContractRequest): PermissionTerminal {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.kind !== "terminal") throw new Error("save result kind must be terminal")
  const allowed = new Set(["kind", "v", "requestId", "opId", "idempotencyKey", "accepted", "terminal", "requestID"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected terminal field ${k}`)
  }
  checkIdentity(raw, req)
  if (raw.requestID !== req.context.requestID) throw new Error("terminal requestID mismatch")
  return raw as unknown as PermissionTerminal
}

export function validatePermissionReplyResult(raw: unknown, req: PermissionReplyContractRequest): PermissionTerminal {
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
    "reply",
  ])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected terminal field ${k}`)
  }
  checkIdentity(raw, req)
  if (typeof raw.sessionID !== "string" || !(raw.sessionID as string).startsWith("ses"))
    throw new Error("terminal sessionID must be SessionID")
  if (raw.requestID !== req.context.requestID) throw new Error("terminal requestID mismatch")
  if (!isReply(raw.reply)) throw new Error("terminal reply must be once/always/reject")
  if (raw.reply !== req.payload.reply) throw new Error("terminal reply mismatch")
  return raw as unknown as PermissionTerminal
}

export function validatePermissionTerminalFailure(raw: unknown, req: PermissionContractRequest): PermissionTerminalFailure {
  if (!record(raw)) throw new Error("terminal-failure must be object")
  if (raw.kind !== "terminal-failure") throw new Error("terminal-failure kind must be terminal-failure")
  const allowed = new Set(["kind", "v", "requestId", "opId", "idempotencyKey", "accepted", "terminal", "failure", "sideEffect"])
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
  const code = (failure as Record<string, unknown>).code
  if (
    code !== "permission.not_found" &&
    code !== "scope_mismatch" &&
    code !== "validation.failed" &&
    code !== "internal"
  )
    throw new Error("terminal-failure code must be permission.not_found, scope_mismatch, validation.failed, or internal")
  if ((failure as Record<string, unknown>).retryable !== false)
    throw new Error("terminal-failure retryable must be false")
  if (typeof (failure as Record<string, unknown>).time !== "number" || !Number.isFinite((failure as Record<string, unknown>).time))
    throw new Error("failure time must be finite number")
  return raw as unknown as PermissionTerminalFailure
}

export function makePermissionAmbiguous(req: PermissionContractRequest): PermissionAmbiguous {
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

export function isSettledPermissionResult(result: unknown, req: PermissionContractRequest): boolean {
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
