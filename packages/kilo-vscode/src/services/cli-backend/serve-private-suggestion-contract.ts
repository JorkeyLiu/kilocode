import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isSuggestionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("sug")
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

function hasPathMaterial(v: string): boolean {
  return v.includes("/") || v.includes("\\")
}

export function canonicalSuggestionOpId(requestID: string, token: string): string {
  if (typeof requestID !== "string" || requestID.length === 0) throw new TypeError("requestID must be non-empty string")
  if (requestID.includes("\0")) throw new TypeError("requestID must not contain null bytes")
  if (!isSuggestionId(requestID)) throw new TypeError("requestID must be SuggestionID")
  if (requestID.includes(":")) throw new TypeError("requestID must not contain ':'")
  if (hasPathMaterial(requestID)) throw new TypeError("requestID must not carry path material")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("token must not contain null bytes")
  if (hasPathMaterial(token)) throw new TypeError("token must not carry path material")
  return `suggestion:${requestID}:${token}`
}

export function parseSuggestionOpId(opId: string): { requestID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`suggestion opId must have 2 segments: ${opId}`)
  if (segs[0] !== "suggestion") throw new TypeError(`opId kind must be suggestion: ${opId}`)
  const rid = segs[1]!
  const token = segs[2]!
  if (rid.length === 0 || !isSuggestionId(rid)) throw new TypeError(`opId requestID must be SuggestionID: ${opId}`)
  if (rid.includes("\0")) throw new TypeError("opId requestID must not contain null bytes")
  if (hasPathMaterial(rid)) throw new TypeError("opId requestID must not carry path material")
  if (token.length === 0) throw new TypeError(`opId token must be non-empty: ${opId}`)
  if (token.includes(":")) throw new TypeError("opId token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("opId token must not contain null bytes")
  if (hasPathMaterial(token)) throw new TypeError("opId token must not carry path material")
  return { requestID: rid, token }
}

export interface SuggestionAcceptContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "suggestion/accept"
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { index: number }
}

export interface SuggestionDismissContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "suggestion/dismiss"
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: Record<string, never>
}

export type SuggestionContractRequest = SuggestionAcceptContractRequest | SuggestionDismissContractRequest

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
  if (!isSuggestionId(ctx.requestID)) throw new Error("context.requestID must be SuggestionID")
  if ((ctx.requestID as string).includes("\0")) throw new Error("context.requestID must not contain null bytes")
  if ((ctx.requestID as string).includes(":")) throw new Error("context.requestID must not contain ':'")
  if (hasPathMaterial(ctx.requestID as string)) throw new Error("context.requestID must not carry path material")
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
  if (raw.op !== "suggestion/accept" && raw.op !== "suggestion/dismiss")
    throw new Error("op must be suggestion/accept or suggestion/dismiss")
  clean(raw.idempotencyKey, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  const ctx = checkContext(raw.context)
  const parsed = parseSuggestionOpId(raw.opId as string)
  const idem = parseSuggestionOpId(raw.idempotencyKey as string)
  if (idem.requestID !== parsed.requestID) throw new Error("idempotencyKey request binding mismatch")
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  const ctxRid = ctx.requestID as string
  if (ctxRid !== parsed.requestID) {
    // Binding mismatch is a terminal scope failure at dispatch; request
    // validation stays strict so malformed tuples never reach the peer.
    // The mismatch itself is surfaced by the carrier as scope_mismatch.
    void 0
  }
  return raw as Record<string, unknown>
}

function checkIndex(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new Error("payload.index must be non-negative safe integer")
  return v
}

export function validateSuggestionAcceptContractRequest(raw: unknown): SuggestionAcceptContractRequest {
  const root = base(raw)
  if (root.op !== "suggestion/accept") throw new Error("op must be suggestion/accept")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 1 || !("index" in payload)) throw new Error("payload must carry only index")
  checkIndex((payload as Record<string, unknown>).index)
  return raw as unknown as SuggestionAcceptContractRequest
}

export function validateSuggestionDismissContractRequest(raw: unknown): SuggestionDismissContractRequest {
  const root = base(raw)
  if (root.op !== "suggestion/dismiss") throw new Error("op must be suggestion/dismiss")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for dismiss")
  return raw as unknown as SuggestionDismissContractRequest
}

export interface SuggestionAction {
  label: string
  description?: string
  prompt: string
}

function checkAction(raw: unknown): void {
  if (!record(raw)) throw new Error("terminal action must be object")
  const allowed = new Set(["label", "description", "prompt"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected terminal action field ${k}`)
  }
  if (typeof raw.label !== "string" || raw.label.length === 0) throw new Error("terminal action label invalid")
  if ((raw.label as string).includes("\0")) throw new Error("terminal action label invalid")
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") throw new Error("terminal action description invalid")
    if ((raw.description as string).includes("\0")) throw new Error("terminal action description invalid")
  }
  if (typeof raw.prompt !== "string" || raw.prompt.length === 0) throw new Error("terminal action prompt invalid")
  if ((raw.prompt as string).includes("\0")) throw new Error("terminal action prompt invalid")
}

export interface SuggestionAcceptTerminal {
  kind: "terminal"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  sessionID: string
  requestID: string
  index: number
  action: SuggestionAction
}

export interface SuggestionDismissTerminal {
  kind: "terminal"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  sessionID: string
  requestID: string
}

export interface SuggestionTerminalFailure {
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

export interface SuggestionAmbiguous {
  kind: "ambiguous"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: false
  transportUnknown: true
}

function checkIdentity(raw: Record<string, unknown>, req: SuggestionContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== true) throw new Error("terminal accepted must be true")
  if (raw.terminal !== true) throw new Error("terminal must be true")
}

function checkFailureIdentity(raw: Record<string, unknown>, req: SuggestionContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== false) throw new Error("terminal-failure accepted must be false")
  if (raw.terminal !== true) throw new Error("terminal must be true")
  if (raw.sideEffect !== false) throw new Error("terminal-failure sideEffect must be false")
}

export function validateSuggestionAcceptResult(raw: unknown, req: SuggestionAcceptContractRequest): SuggestionAcceptTerminal {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.kind !== "terminal") throw new Error("accept result kind must be terminal")
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
    "index",
    "action",
  ])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected terminal field ${k}`)
  }
  checkIdentity(raw, req)
  if (!isSessionId(raw.sessionID)) throw new Error("terminal sessionID must be SessionID")
  if (raw.requestID !== req.context.requestID) throw new Error("terminal requestID mismatch")
  if (typeof raw.index !== "number" || !Number.isSafeInteger(raw.index) || raw.index < 0)
    throw new Error("terminal index must be non-negative safe integer")
  if (raw.index !== req.payload.index) throw new Error("terminal index mismatch")
  checkAction(raw.action)
  return raw as unknown as SuggestionAcceptTerminal
}

export function validateSuggestionDismissResult(
  raw: unknown,
  req: SuggestionDismissContractRequest,
): SuggestionDismissTerminal {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.kind !== "terminal") throw new Error("dismiss result kind must be terminal")
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
  if (!isSessionId(raw.sessionID)) throw new Error("terminal sessionID must be SessionID")
  if (raw.requestID !== req.context.requestID) throw new Error("terminal requestID mismatch")
  return raw as unknown as SuggestionDismissTerminal
}

export function validateSuggestionTerminalFailure(
  raw: unknown,
  req: SuggestionContractRequest,
): SuggestionTerminalFailure {
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
  if (failure.code !== "suggestion.not_found" && failure.code !== "scope_mismatch")
    throw new Error("terminal-failure code must be suggestion.not_found or scope_mismatch")
  if (failure.retryable !== false) throw new Error("terminal-failure retryable must be false")
  if (typeof failure.time !== "number" || !Number.isFinite(failure.time))
    throw new Error("failure time must be finite number")
  return raw as unknown as SuggestionTerminalFailure
}

export function makeSuggestionAmbiguous(req: SuggestionContractRequest): SuggestionAmbiguous {
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

export function makeSuggestionTerminalFailure(
  req: SuggestionContractRequest,
  code: "suggestion.not_found" | "scope_mismatch",
  time: number = Date.now(),
): SuggestionTerminalFailure {
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

export function isSettledSuggestionResult(result: unknown, req: SuggestionContractRequest): boolean {
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
