import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isNotebookId(v: unknown): boolean {
  return (
    typeof v === "string" &&
    (v as string).startsWith("nbr_") &&
    (v as string).length > 4 &&
    !(v as string).includes("\0") &&
    !(v as string).includes(":") &&
    !(v as string).includes("/") &&
    !(v as string).includes("\\")
  )
}

function cleanToken(token: string): string {
  if (token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("token must not carry path material")
  return token
}

export function canonicalNotebookOpId(requestID: string, token: string): string {
  if (!isNotebookId(requestID)) throw new TypeError("requestID must be NotebookRequestID")
  return `notebook:${requestID}:${cleanToken(token)}`
}

export function parseNotebookOpId(opId: string): { requestID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`notebook opId must have 2 segments: ${opId}`)
  if (segs[0] !== "notebook") throw new TypeError(`opId kind must be notebook: ${opId}`)
  const rid = segs[1]!
  if (!isNotebookId(rid)) throw new TypeError(`opId requestID must be NotebookRequestID: ${opId}`)
  const token = cleanToken(segs[2]!)
  return { requestID: rid, token }
}

export function canonicalNotebookListOpId(token: string): string {
  return `notebook-list:${cleanToken(token)}`
}

export function parseNotebookListOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`notebook-list opId must be notebook-list:<token>: ${opId}`)
  if (segs[0] !== "notebook-list") throw new TypeError(`opId kind must be notebook-list: ${opId}`)
  const token = cleanToken(segs[1]!)
  return { token }
}

export interface NotebookReplyContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "notebook/reply"
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { result: unknown }
}

export interface NotebookRejectContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "notebook/reject"
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { error: unknown }
}

export interface NotebookListContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "notebook/list"
  idempotencyKey: string
  context: { directory: string }
  payload: Record<string, never>
}

export type NotebookContractRequest = NotebookReplyContractRequest | NotebookRejectContractRequest

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

function checkDirContext(ctx: unknown, withRequest: boolean): void {
  if (!record(ctx)) throw new Error("context must be object")
  const allowed = withRequest ? new Set(["directory", "requestID"]) : new Set(["directory"])
  for (const k of Object.keys(ctx)) {
    if (!allowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (withRequest && !isNotebookId(ctx.requestID)) throw new Error("context.requestID must be NotebookRequestID")
}

function checkBinding(opId: string, key: string, withRequest: boolean): void {
  if (withRequest) {
    const parsed = parseNotebookOpId(opId)
    const idem = parseNotebookOpId(key)
    if (idem.requestID !== parsed.requestID) throw new Error("idempotencyKey request binding mismatch")
    if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
    return
  }
  const parsed = parseNotebookListOpId(opId)
  const idem = parseNotebookListOpId(key)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
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
  if (raw.op !== "notebook/reply" && raw.op !== "notebook/reject" && raw.op !== "notebook/list")
    throw new Error("op must be notebook/reply, notebook/reject, or notebook/list")
  clean(raw.idempotencyKey, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  return raw as Record<string, unknown>
}

const RESULT_OPS = new Set(["read", "edit", "execute"])

function checkResultShape(result: unknown): void {
  if (!record(result)) throw new Error("payload.result must be object")
  if (typeof result.operation !== "string" || !RESULT_OPS.has(result.operation))
    throw new Error("payload.result.operation must be read, edit, or execute")
  if (typeof result.requestPath !== "string" || result.requestPath.length === 0)
    throw new Error("payload.result.requestPath must be non-empty string")
  if ((result.requestPath as string).includes("\0"))
    throw new Error("payload.result.requestPath must not contain null bytes")
}

function checkErrorShape(error: unknown): void {
  if (!record(error)) throw new Error("payload.error must be object")
  if (typeof error.code !== "string" || error.code.length === 0)
    throw new Error("payload.error.code must be non-empty string")
  if (typeof error.message !== "string" || error.message.length === 0)
    throw new Error("payload.error.message must be non-empty string")
}

export function validateNotebookReplyContractRequest(raw: unknown): NotebookReplyContractRequest {
  const root = base(raw)
  if (root.op !== "notebook/reply") throw new Error("op must be notebook/reply")
  checkDirContext(root.context, true)
  checkBinding(root.opId as string, root.idempotencyKey as string, true)
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 1 || !("result" in payload)) throw new Error("payload must carry only result")
  checkResultShape(payload.result)
  return raw as unknown as NotebookReplyContractRequest
}

export function validateNotebookRejectContractRequest(raw: unknown): NotebookRejectContractRequest {
  const root = base(raw)
  if (root.op !== "notebook/reject") throw new Error("op must be notebook/reject")
  checkDirContext(root.context, true)
  checkBinding(root.opId as string, root.idempotencyKey as string, true)
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 1 || !("error" in payload)) throw new Error("payload must carry only error")
  checkErrorShape(payload.error)
  return raw as unknown as NotebookRejectContractRequest
}

export function validateNotebookListContractRequest(raw: unknown): NotebookListContractRequest {
  const root = base(raw)
  if (root.op !== "notebook/list") throw new Error("op must be notebook/list")
  checkDirContext(root.context, false)
  checkBinding(root.opId as string, root.idempotencyKey as string, false)
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for notebook-list")
  return raw as unknown as NotebookListContractRequest
}

export interface NotebookTerminal {
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

export interface NotebookTerminalFailure {
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

export interface NotebookAmbiguous {
  kind: "ambiguous"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: false
  transportUnknown: true
}

function checkIdentity(raw: Record<string, unknown>, req: NotebookContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== true) throw new Error("terminal accepted must be true")
  if (raw.terminal !== true) throw new Error("terminal must be true")
}

function checkFailureIdentity(raw: Record<string, unknown>, req: NotebookContractRequest): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  if (raw.accepted !== false) throw new Error("terminal-failure accepted must be false")
  if (raw.terminal !== true) throw new Error("terminal must be true")
  if (raw.sideEffect !== false) throw new Error("terminal-failure sideEffect must be false")
}

function checkTerminalBinding(raw: Record<string, unknown>, req: NotebookContractRequest): void {
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
}

export function validateNotebookReplyResult(raw: unknown, req: NotebookReplyContractRequest): NotebookTerminal {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.kind !== "terminal") throw new Error("reply result kind must be terminal")
  checkTerminalBinding(raw, req)
  return raw as unknown as NotebookTerminal
}

export function validateNotebookRejectResult(raw: unknown, req: NotebookRejectContractRequest): NotebookTerminal {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.kind !== "terminal") throw new Error("reject result kind must be terminal")
  checkTerminalBinding(raw, req)
  return raw as unknown as NotebookTerminal
}

export function validateNotebookTerminalFailure(raw: unknown, req: NotebookContractRequest): NotebookTerminalFailure {
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
  if (
    failure.code !== "notebook.not_found" &&
    failure.code !== "notebook.invalid_reply" &&
    failure.code !== "scope_mismatch"
  )
    throw new Error("terminal-failure code must be notebook.not_found, notebook.invalid_reply, or scope_mismatch")
  if (failure.retryable !== false) throw new Error("terminal-failure retryable must be false")
  if (typeof failure.time !== "number" || !Number.isFinite(failure.time))
    throw new Error("failure time must be finite number")
  return raw as unknown as NotebookTerminalFailure
}

export function makeNotebookAmbiguous(req: NotebookContractRequest): NotebookAmbiguous {
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

export function makeNotebookTerminalFailure(
  req: NotebookContractRequest,
  code: "notebook.not_found" | "notebook.invalid_reply" | "scope_mismatch",
  time: number = Date.now(),
): NotebookTerminalFailure {
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

export function isSettledNotebookResult(result: unknown, req: NotebookContractRequest): boolean {
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
