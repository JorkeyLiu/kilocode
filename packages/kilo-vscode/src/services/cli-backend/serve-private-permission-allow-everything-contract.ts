// Private `permission/allow-everything` mutation contract (production).
// Request is strictly `{v:1,requestId,opId,op:"permission/allow-everything",
// idempotencyKey,context:{directory,sessionID?,requestID?},payload:{enable}}`
// with `opId === permission-allow-everything:<token>` (token non-empty, no
// colon, no path material, no null bytes) and `idempotencyKey === opId`.
// `context.directory` binds routing and scope; optional `sessionID`
// (SessionID) and `requestID` (PermissionID) scope the allow-all rule exactly
// like the HTTP `POST /permission/allow-everything` body. Success echoes the
// enable/session/request binding; failures are redacted terminal-failures
// (`scope_mismatch`/`validation.failed`/`internal`, retryable false,
// sideEffect false). No durable operation row is written.

import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

function isPermissionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("per")
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

export function canonicalPermissionAllowEverythingOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `permission-allow-everything:${token}`
}

export function parsePermissionAllowEverythingOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "permission-allow-everything" || segs[1]!.length === 0)
    throw new TypeError("opId must be permission-allow-everything:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new TypeError("opId must be permission-allow-everything:<token> with nonempty colon-free token")
  return { token }
}

export interface PermissionAllowEverythingContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "permission/allow-everything"
  idempotencyKey: string
  context: { directory: string; sessionID?: string; requestID?: string }
  payload: { enable: boolean }
}

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  if (!pathless(text) && label !== "context.directory") throw new Error(`${label} must not carry path material`)
  return text
}

function checkContext(ctx: unknown): Record<string, unknown> {
  if (!record(ctx)) throw new Error("context must be object")
  const allowed = new Set(["directory", "sessionID", "requestID"])
  for (const k of Object.keys(ctx)) {
    if (!allowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (ctx.sessionID !== undefined) {
    if (!isSessionId(ctx.sessionID)) throw new Error("context.sessionID must be SessionID")
    if ((ctx.sessionID as string).includes("\0")) throw new Error("context.sessionID must not contain null bytes")
  }
  if (ctx.requestID !== undefined) {
    if (!isPermissionId(ctx.requestID)) throw new Error("context.requestID must be PermissionID")
    if ((ctx.requestID as string).includes("\0")) throw new Error("context.requestID must not contain null bytes")
  }
  return ctx
}

export function validatePermissionAllowEverythingContractRequest(raw: unknown): PermissionAllowEverythingContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  clean(raw.opId, "opId")
  if (raw.op !== "permission/allow-everything") throw new Error("op must be permission/allow-everything")
  clean(raw.idempotencyKey, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  const parsed = parsePermissionAllowEverythingOpId(raw.opId as string)
  const idem = parsePermissionAllowEverythingOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  checkContext(raw.context)
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  const payloadAllowed = new Set(["enable"])
  for (const k of Object.keys(payload)) {
    if (!payloadAllowed.has(k)) throw new Error(`unexpected payload field ${k}`)
  }
  if (typeof (payload as Record<string, unknown>).enable !== "boolean")
    throw new Error("payload.enable must be boolean")
  return raw as unknown as PermissionAllowEverythingContractRequest
}

export interface PermissionAllowEverythingTerminal {
  kind: "terminal"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  enable: boolean
  sessionID?: string
  requestID?: string
}

export type PermissionAllowEverythingFailureCode = "scope_mismatch" | "validation.failed" | "internal"

export interface PermissionAllowEverythingTerminalFailure {
  kind: "terminal-failure"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: true
  failure: { code: PermissionAllowEverythingFailureCode; retryable: false; time: number }
  sideEffect: false
}

export interface PermissionAllowEverythingAmbiguous {
  kind: "ambiguous"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: false
  transportUnknown: true
}

function checkIdentity(raw: Record<string, unknown>, req: PermissionAllowEverythingContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== true) throw new Error("terminal accepted must be true")
  if (raw.terminal !== true) throw new Error("terminal must be true")
}

function checkFailureIdentity(raw: Record<string, unknown>, req: PermissionAllowEverythingContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== false) throw new Error("terminal-failure accepted must be false")
  if (raw.terminal !== true) throw new Error("terminal must be true")
  if (raw.sideEffect !== false) throw new Error("terminal-failure sideEffect must be false")
}

export function validatePermissionAllowEverythingResult(
  raw: unknown,
  req: PermissionAllowEverythingContractRequest,
): PermissionAllowEverythingTerminal {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.kind !== "terminal") throw new Error("allow-everything result kind must be terminal")
  const allowed = new Set([
    "kind",
    "v",
    "requestId",
    "opId",
    "idempotencyKey",
    "accepted",
    "terminal",
    "enable",
    "sessionID",
    "requestID",
  ])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected terminal field ${k}`)
  }
  checkIdentity(raw, req)
  if (typeof raw.enable !== "boolean") throw new Error("terminal enable must be boolean")
  if (raw.enable !== req.payload.enable) throw new Error("terminal enable mismatch")
  if (req.context.sessionID !== undefined && raw.sessionID !== req.context.sessionID)
    throw new Error("terminal sessionID mismatch")
  if (req.context.sessionID === undefined && raw.sessionID !== undefined)
    throw new Error("terminal sessionID mismatch")
  if (req.context.requestID !== undefined && raw.requestID !== req.context.requestID)
    throw new Error("terminal requestID mismatch")
  if (req.context.requestID === undefined && raw.requestID !== undefined)
    throw new Error("terminal requestID mismatch")
  return raw as unknown as PermissionAllowEverythingTerminal
}

export function validatePermissionAllowEverythingTerminalFailure(
  raw: unknown,
  req: PermissionAllowEverythingContractRequest,
): PermissionAllowEverythingTerminalFailure {
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
  if (code !== "scope_mismatch" && code !== "validation.failed" && code !== "internal")
    throw new Error("terminal-failure code must be scope_mismatch, validation.failed, or internal")
  if ((failure as Record<string, unknown>).retryable !== false)
    throw new Error("terminal-failure retryable must be false")
  if (typeof (failure as Record<string, unknown>).time !== "number" || !Number.isFinite((failure as Record<string, unknown>).time))
    throw new Error("failure time must be finite number")
  return raw as unknown as PermissionAllowEverythingTerminalFailure
}

export function makePermissionAllowEverythingAmbiguous(
  req: PermissionAllowEverythingContractRequest,
): PermissionAllowEverythingAmbiguous {
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

export function isSettledPermissionAllowEverythingResult(
  result: unknown,
  req: PermissionAllowEverythingContractRequest,
): boolean {
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
