// Private-first `mcp/status` read-only contract (production).
// Request is strictly `{v:1,requestId,opId,op:"mcp/status",
// idempotencyKey,context:{directory},payload:{}}` with
// `opId === mcp-status:<token>` (token non-empty, no colon, no path
// material) and `idempotencyKey === opId`. Success data is
// `{status: Record<string, McpStatus>}` preserving the exact HTTP shape
// from `MCP.status()` (five-state discriminated union per server).
//
// Source facts:
// - Route: `GET /mcp` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`
//   (`identifier: "mcp.status"`, success `Record<string, MCP.Status>`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts`
//   `status` returns `mcp.status()`. The FD handler invokes the same
//   `MCP.status()` under the same directory lane.
// - Model: `packages/opencode/src/mcp/index.ts` `Status` union
//   (`connected`/`disabled`/`failed`+error/`needs_auth`/
//   `needs_client_registration`+error).
// - Consumers: `KiloProvider.fetchAndSendMcpStatus`, Agent Manager backend
//   snapshot, and agent-manager mcp warmup are private-first: accepted
//   success returns with zero SDK; validated terminal failure closes with
//   zero SDK; fallback-eligible outcomes take exactly one SDK
//   `client.mcp.status` call with the same directory.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness or completeness.
// - Payload entries are validated shape-only. No freshness, ordering,
//   lifecycle, or cross-directory claim is made.
// - Out of scope: connect/disconnect/authenticate/toggle, lifecycle
//   mutations, transport behavior, and any other operation.

import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

export function canonicalMcpStatusOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (token.includes("\0")) throw new TypeError("token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("token must not carry path material")
  return `mcp-status:${token}`
}

export function parseMcpStatusOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("\0")) throw new TypeError("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`mcp-status opId must be mcp-status:<token>: ${opId}`)
  if (segs[0] !== "mcp-status") throw new TypeError(`opId kind must be mcp-status: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId token must be non-empty: ${opId}`)
  if (token.includes("\0")) throw new TypeError("opId token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new TypeError("opId token must not carry path material")
  return { token }
}

export interface McpStatusContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "mcp/status"
  idempotencyKey: string
  context: { directory: string }
  payload: Record<string, never>
}

export function validateMcpStatusContractRequest(raw: unknown): McpStatusContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  clean(raw.opId, "opId")
  if (raw.op !== "mcp/status") throw new Error("op must be mcp/status")
  clean(raw.idempotencyKey, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for mcp-status")
  const parsed = parseMcpStatusOpId(raw.opId as string)
  const idem = parseMcpStatusOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as McpStatusContractRequest
}

export type McpServerStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

export type McpStatusMap = Record<string, McpServerStatus>

const CONNECTED_FIELDS = new Set(["status"])
const DISABLED_FIELDS = new Set(["status"])
const FAILED_FIELDS = new Set(["status", "error"])
const NEEDS_AUTH_FIELDS = new Set(["status"])
const NEEDS_REG_FIELDS = new Set(["status", "error"])

export function validateMcpServerStatus(raw: unknown): McpServerStatus {
  if (!record(raw)) throw new Error("mcp entry must be object")
  const kind = (raw as Record<string, unknown>).status
  if (kind === "connected") {
    for (const k of Object.keys(raw)) if (!CONNECTED_FIELDS.has(k)) throw new Error("unexpected connected field")
    return raw as unknown as McpServerStatus
  }
  if (kind === "disabled") {
    for (const k of Object.keys(raw)) if (!DISABLED_FIELDS.has(k)) throw new Error("unexpected disabled field")
    return raw as unknown as McpServerStatus
  }
  if (kind === "failed") {
    for (const k of Object.keys(raw)) if (!FAILED_FIELDS.has(k)) throw new Error("unexpected failed field")
    if (!present((raw as Record<string, unknown>).error)) throw new Error("failed error must be non-empty string")
    return raw as unknown as McpServerStatus
  }
  if (kind === "needs_auth") {
    for (const k of Object.keys(raw)) if (!NEEDS_AUTH_FIELDS.has(k)) throw new Error("unexpected needs_auth field")
    return raw as unknown as McpServerStatus
  }
  if (kind === "needs_client_registration") {
    for (const k of Object.keys(raw)) if (!NEEDS_REG_FIELDS.has(k)) throw new Error("unexpected registration field")
    if (!present((raw as Record<string, unknown>).error)) throw new Error("registration error must be non-empty string")
    return raw as unknown as McpServerStatus
  }
  throw new Error("mcp entry status must be five-state")
}

export function validateMcpStatusMap(raw: unknown): McpStatusMap {
  if (!record(raw)) throw new Error("status must be object")
  const out: McpStatusMap = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (name.length === 0) throw new Error("mcp name must be non-empty")
    if (name.includes("\0")) throw new Error("mcp name must not contain null bytes")
    out[name] = validateMcpServerStatus(entry)
  }
  return out
}

export interface McpStatusFailure {
  code: string
  message: string
  retryable: boolean
}

const FAILURE_FORBIDDEN = new Set([
  "status",
  "statuses",
  "mcp",
  "directory",
  "workspace",
  "server",
  "error",
  "raw",
  "output",
  "detail",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateMcpStatusFailure(raw: unknown): McpStatusFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as McpStatusFailure
}

export type McpStatusResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/status"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { status: McpStatusMap }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/status"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: McpStatusFailure }
      accepted: boolean
      failure: McpStatusFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/status"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeMcpStatusAmbiguous(req: McpStatusContractRequest, transportUnknown = true): McpStatusResult {
  const out: McpStatusResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/status",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type McpStatusWireOutcome = { kind: "valid"; result: McpStatusResult } | { kind: "invalid"; detail: string }

export class McpStatusValidationError extends Error {
  readonly kind = "private-mcp-status-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "McpStatusValidationError"
    this.detail = detail
  }
}

export function isMcpStatusValidationError(v: unknown): v is McpStatusValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-mcp-status-validation"
}

export function normalizePrivateMcpStatusWire(raw: unknown, req: McpStatusContractRequest): McpStatusWireOutcome {
  try {
    const result = validateMcpStatusResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const RESULT_SUCCEEDED = new Set([
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
const RESULT_FAILED = new Set([
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
const RESULT_AMBIGUOUS = new Set([
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
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateMcpStatusResult(raw: unknown, req: McpStatusContractRequest): McpStatusResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "mcp/status") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["status"])
    for (const k of Object.keys(data)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateMcpStatusMap((data as Record<string, unknown>).status)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as McpStatusResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateMcpStatusFailure(rec.failure)
    const outFailure = validateMcpStatusFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as McpStatusResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as McpStatusResult
}

export function isSettledMcpStatusResult(result: unknown, req: McpStatusContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateMcpStatusResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
