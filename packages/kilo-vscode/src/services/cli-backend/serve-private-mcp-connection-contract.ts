// Private-only `mcp/connect` + `mcp/disconnect` mutation contracts (production).
// Each request is strictly `{v:1,requestId,opId,op,
// idempotencyKey,context:{directory},payload:{name}}` with
// `opId === mcp-connect:<token>` (resp. `mcp-disconnect:<token>`, token
// non-empty, no colon, no path material) and `idempotencyKey === opId`.
// The token is correlation/diagnostic identity only: there is no cross-request
// replay semantic and the CLI keeps no durable journal or result snapshot.
// Success data is `{connected:true}` (resp. `{disconnected:true}`); failures
// are redacted `{code,message,retryable}` results with echo-validated
// identities. No session_operation row is written.
//
// Source facts:
// - Owner: directory-keyed `MCP.Service` (`packages/opencode/src/mcp/index.ts`
//   `connect`/`disconnect`) is the sole connection/stdio child/defs/watch
//   lifecycle owner; the private ops only route the call through the existing
//   drain-control + `InstanceRef` lane.
// - Private entry: `packages/opencode/src/kilocode/mcp-connection-private.ts`
//   (`mcp/connect` + `mcp/disconnect` FD ops, strict validation,
//   drain-control lane, `InstanceRef` scope, typed `mcp.not_found` terminal
//   plus retryable rebuild fence).
// - Consumer: `packages/kilo-vscode/src/kilo-provider/mcp-connection-privatefirst.ts`
//   is private-only: at most one private call per user action with zero SDK
//   fallback and zero retry; every outcome re-observes `mcp/status`.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness.
// - `payload.name` names the configured server. No freshness, ordering, or
//   lifecycle claim is made.
// - Out of scope: `mcp/status` re-observation, OAuth authenticate, config or
//   canonical writes, transport behavior, and any other operation.

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

export function canonicalMcpConnectOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `mcp-connect:${token}`
}

export function parseMcpConnectOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "mcp-connect" || segs[1]!.length === 0)
    throw new TypeError("opId must be mcp-connect:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new TypeError("opId must be mcp-connect:<token> with nonempty colon-free token")
  return { token }
}

export function canonicalMcpDisconnectOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `mcp-disconnect:${token}`
}

export function parseMcpDisconnectOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "mcp-disconnect" || segs[1]!.length === 0)
    throw new TypeError("opId must be mcp-disconnect:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new TypeError("opId must be mcp-disconnect:<token> with nonempty colon-free token")
  return { token }
}

export interface McpConnectContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "mcp/connect"
  idempotencyKey: string
  context: { directory: string }
  payload: { name: string }
}

export interface McpDisconnectContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "mcp/disconnect"
  idempotencyKey: string
  context: { directory: string }
  payload: { name: string }
}

function validateIds(
  raw: Record<string, unknown>,
  op: "mcp/connect" | "mcp/disconnect",
  parse: (opId: string) => { token: string },
): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== op) throw new Error(`op must be ${op}`)
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (!pathless(raw.idempotencyKey as string)) throw new Error("idempotencyKey must not carry path material")
  const parsed = parse(raw.opId as string)
  const idem = parse(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
}

function validateContext(raw: unknown): void {
  if (!record(raw)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory"])
  for (const k of Object.keys(raw)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || !isAbsolute(raw.directory) || raw.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
}

function validateNamePayload(raw: unknown): void {
  if (!record(raw)) throw new Error("payload must be object")
  const allowedPayload = new Set(["name"])
  for (const k of Object.keys(raw)) if (!allowedPayload.has(k)) throw new Error("unexpected payload field")
  const name = (raw as Record<string, unknown>).name
  if (typeof name !== "string" || name.length === 0 || name.length > 256)
    throw new Error("payload.name must be non-empty string")
  if (name.includes("\0")) throw new Error("payload.name must not contain null bytes")
}

export function validateMcpConnectContractRequest(raw: unknown): McpConnectContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  validateIds(raw, "mcp/connect", parseMcpConnectOpId)
  validateContext(raw.context)
  validateNamePayload(raw.payload)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as McpConnectContractRequest
}

export function validateMcpDisconnectContractRequest(raw: unknown): McpDisconnectContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  validateIds(raw, "mcp/disconnect", parseMcpDisconnectOpId)
  validateContext(raw.context)
  validateNamePayload(raw.payload)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as McpDisconnectContractRequest
}

export interface McpConnectionFailure {
  code: string
  message: string
  retryable: boolean
}

export type McpConnectResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/connect"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { connected: true }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/connect"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: McpConnectionFailure }
      accepted: false
      failure: McpConnectionFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/connect"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export type McpDisconnectResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/disconnect"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { disconnected: true }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/disconnect"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: McpConnectionFailure }
      accepted: false
      failure: McpConnectionFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/disconnect"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeMcpConnectAmbiguous(req: McpConnectContractRequest, transportUnknown = true): McpConnectResult {
  const out: McpConnectResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/connect",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export function makeMcpDisconnectAmbiguous(
  req: McpDisconnectContractRequest,
  transportUnknown = true,
): McpDisconnectResult {
  const out: McpDisconnectResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/disconnect",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Only CLI-authoritative terminal codes are accepted; anything else is
// invalid wire and fails closed to ambiguous. Server names, paths, and
// transport echo keys are rejected so responses cannot carry payloads.
const FAILURE_FORBIDDEN = new Set([
  "name",
  "server",
  "mcp",
  "directory",
  "workspace",
  "status",
  "statuses",
  "path",
  "stack",
  "data",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

const FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "mcp.not_found",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
])

export function validateMcpConnectionFailure(raw: unknown): McpConnectionFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error("failure must not carry raw field")
  }
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!FAILURE_CODES.has(raw.code as string)) throw new Error("failure code is not CLI-authoritative")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as McpConnectionFailure
}

export type McpConnectWireOutcome = { kind: "valid"; result: McpConnectResult } | { kind: "invalid"; detail: string }
export type McpDisconnectWireOutcome =
  | { kind: "valid"; result: McpDisconnectResult }
  | { kind: "invalid"; detail: string }

export const MCP_CONNECTION_INVALID_DETAIL = "invalid private response shape"

const RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
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
export function validateMcpConnectResult(raw: unknown, req: McpConnectContractRequest): McpConnectResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "mcp/connect") throw new Error("op mismatch")
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
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "connected") throw new Error("unexpected data field")
    if (data.connected !== true) throw new Error("succeeded data.connected must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as McpConnectResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = validateMcpConnectionFailure(rec.failure)
    const outFailure = validateMcpConnectionFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as McpConnectResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as McpConnectResult
}

// eslint-disable-next-line complexity
export function validateMcpDisconnectResult(raw: unknown, req: McpDisconnectContractRequest): McpDisconnectResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "mcp/disconnect") throw new Error("op mismatch")
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
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "disconnected") throw new Error("unexpected data field")
    if (data.disconnected !== true) throw new Error("succeeded data.disconnected must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as McpDisconnectResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = validateMcpConnectionFailure(rec.failure)
    const outFailure = validateMcpConnectionFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as McpDisconnectResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as McpDisconnectResult
}

export function normalizePrivateMcpConnectWire(raw: unknown, req: McpConnectContractRequest): McpConnectWireOutcome {
  try {
    return { kind: "valid", result: validateMcpConnectResult(raw, req) }
  } catch {
    return { kind: "invalid", detail: MCP_CONNECTION_INVALID_DETAIL }
  }
}

export function normalizePrivateMcpDisconnectWire(
  raw: unknown,
  req: McpDisconnectContractRequest,
): McpDisconnectWireOutcome {
  try {
    return { kind: "valid", result: validateMcpDisconnectResult(raw, req) }
  } catch {
    return { kind: "invalid", detail: MCP_CONNECTION_INVALID_DETAIL }
  }
}

export function isSettledMcpConnectResult(result: unknown, req: McpConnectContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed" && kind !== "ambiguous") return false
  try {
    validateMcpConnectResult(result, req)
    return true
  } catch {
    return false
  }
}

export function isSettledMcpDisconnectResult(result: unknown, req: McpDisconnectContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed" && kind !== "ambiguous") return false
  try {
    validateMcpDisconnectResult(result, req)
    return true
  } catch {
    return false
  }
}
