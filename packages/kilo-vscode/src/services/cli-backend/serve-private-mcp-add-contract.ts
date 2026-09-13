// Private-only `mcp/add` registration contract (production).
// Request is strictly `{v:1,requestId,opId,op:"mcp/add",
// idempotencyKey,context:{directory},payload:{name,config}}` with
// `opId === mcp-add:<token>` (token non-empty, no colon, no path material)
// and `idempotencyKey === opId`.
// The token is correlation/diagnostic identity only: there is no cross-request
// replay semantic and the CLI keeps no durable journal or result snapshot.
// Success data is `{status: Record<string, McpServerStatus>}` preserving the
// exact HTTP add-route shape (five-state per server, same as `mcp/status`);
// failures are redacted `{code,message,retryable}` results with
// echo-validated identities. No session_operation row is written.
//
// Source facts:
// - Owner: directory-keyed `MCP.Service` (`packages/opencode/src/mcp/index.ts`
//   `add`) is the sole connection/stdio child/defs/watch lifecycle owner;
//   the private op only routes the call through the existing drain-control +
//   `InstanceRef` lane.
// - Private entry: `packages/opencode/src/kilocode/mcp-connection-private.ts`
//   (`mcp/add` FD op, strict validation, drain-control lane, `InstanceRef`
//   scope, typed terminals plus retryable rebuild fence).
// - Consumer: `packages/kilo-vscode/src/kilo-provider/mcp-add-privatefirst.ts`
//   is private-only: at most one private call per registration with zero SDK
//   fallback and zero retry; the returned status map converges the
//   BrowserAutomation state directly.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness.
// - `payload.name` names the server to register; `payload.config` carries the
//   exact `local` (`type,command,environment?,enabled?,timeout?`) or `remote`
//   (`type,url,enabled?,headers?,oauth?,timeout?`) registration. No freshness,
//   ordering, or lifecycle claim is made.
// - Out of scope: `mcp/status` re-observation, config or canonical writes,
//   transport behavior, and any other operation.

import { isAbsolute } from "path"
import { validateMcpStatusMap } from "./serve-private-mcp-status-contract"
import type { McpStatusMap } from "./serve-private-mcp-status-contract"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

export function canonicalMcpAddOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `mcp-add:${token}`
}

export function parseMcpAddOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "mcp-add" || segs[1]!.length === 0)
    throw new TypeError("opId must be mcp-add:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new TypeError("opId must be mcp-add:<token> with nonempty colon-free token")
  return { token }
}

export interface McpAddLocalConfig {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export interface McpAddRemoteConfig {
  type: "remote"
  url: string
  enabled?: boolean
  headers?: Record<string, string>
  oauth?: false | Record<string, unknown>
  timeout?: number
}

export type McpAddConfig = McpAddLocalConfig | McpAddRemoteConfig

export interface McpAddContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "mcp/add"
  idempotencyKey: string
  context: { directory: string }
  payload: { name: string; config: McpAddConfig }
}

function validateIds(raw: Record<string, unknown>): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "mcp/add") throw new Error("op must be mcp/add")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (!pathless(raw.idempotencyKey as string)) throw new Error("idempotencyKey must not carry path material")
  const parsed = parseMcpAddOpId(raw.opId as string)
  const idem = parseMcpAddOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
}

function validateContext(raw: unknown): void {
  if (!record(raw)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory"])
  for (const k of Object.keys(raw)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || !isAbsolute(raw.directory) || raw.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
}

function checkTimeout(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > 600000)
    throw new Error("config.timeout must be positive int")
  return v
}

function checkStringMap(v: unknown, label: string): Record<string, string> {
  if (!record(v)) throw new Error(`${label} must be object`)
  const keys = Object.keys(v)
  if (keys.length > 64) throw new Error(`${label} too many entries`)
  const out: Record<string, string> = {}
  for (const k of keys) {
    if (k.length === 0 || k.length > 256 || k.includes("\0")) throw new Error(`${label} key invalid`)
    const val = (v as Record<string, unknown>)[k]
    if (typeof val !== "string" || val.length > 8192 || val.includes("\0")) throw new Error(`${label} value invalid`)
    out[k] = val
  }
  return out
}

const LOCAL_FIELDS = new Set(["type", "command", "environment", "env", "enabled", "timeout"])
const REMOTE_FIELDS = new Set(["type", "url", "enabled", "headers", "oauth", "timeout"])
const OAUTH_FIELDS = new Set(["clientId", "clientSecret", "scope", "callbackPort", "redirectUri"])

// eslint-disable-next-line complexity
function validateConfig(raw: unknown): McpAddConfig {
  if (!record(raw)) throw new Error("payload.config must be object")
  const kind = (raw as Record<string, unknown>).type
  if (kind === "local") {
    for (const k of Object.keys(raw)) if (!LOCAL_FIELDS.has(k)) throw new Error("unexpected config field")
    const rec = raw as Record<string, unknown>
    const command = rec.command
    if (!Array.isArray(command) || command.length === 0 || command.length > 64)
      throw new Error("config.command must be non-empty array")
    for (const entry of command) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 1024 || entry.includes("\0"))
        throw new Error("config.command entry invalid")
    }
    const out: McpAddLocalConfig = { type: "local", command: [...(command as string[])] }
    if (rec.environment !== undefined) out.environment = checkStringMap(rec.environment, "config.environment")
    if (rec.env !== undefined) {
      const env = checkStringMap(rec.env, "config.env")
      if (out.environment !== undefined && JSON.stringify(out.environment) !== JSON.stringify(env))
        throw new Error("config.environment/env mismatch")
      if (out.environment === undefined) out.environment = env
    }
    if (rec.enabled !== undefined) {
      if (typeof rec.enabled !== "boolean") throw new Error("config.enabled must be boolean")
      out.enabled = rec.enabled
    }
    if (rec.timeout !== undefined) out.timeout = checkTimeout(rec.timeout)
    return out
  }
  if (kind === "remote") {
    for (const k of Object.keys(raw)) if (!REMOTE_FIELDS.has(k)) throw new Error("unexpected config field")
    const rec = raw as Record<string, unknown>
    if (typeof rec.url !== "string" || rec.url.length === 0 || rec.url.length > 2048 || rec.url.includes("\0"))
      throw new Error("config.url must be non-empty string")
    const out: McpAddRemoteConfig = { type: "remote", url: rec.url }
    if (rec.enabled !== undefined) {
      if (typeof rec.enabled !== "boolean") throw new Error("config.enabled must be boolean")
      out.enabled = rec.enabled
    }
    if (rec.headers !== undefined) out.headers = checkStringMap(rec.headers, "config.headers")
    if (rec.oauth !== undefined) {
      if (rec.oauth === false) {
        out.oauth = false
      } else {
        if (!record(rec.oauth)) throw new Error("config.oauth invalid")
        for (const k of Object.keys(rec.oauth)) if (!OAUTH_FIELDS.has(k)) throw new Error("unexpected oauth field")
        out.oauth = { ...(rec.oauth as Record<string, unknown>) }
      }
    }
    if (rec.timeout !== undefined) out.timeout = checkTimeout(rec.timeout)
    return out
  }
  throw new Error("config.type must be local or remote")
}

function validateNamePayload(raw: unknown): { name: string; config: McpAddConfig } {
  if (!record(raw)) throw new Error("payload must be object")
  const allowedPayload = new Set(["name", "config"])
  for (const k of Object.keys(raw)) if (!allowedPayload.has(k)) throw new Error("unexpected payload field")
  const rec = raw as Record<string, unknown>
  if (typeof rec.name !== "string" || rec.name.length === 0 || rec.name.length > 256)
    throw new Error("payload.name must be non-empty string")
  if ((rec.name as string).includes("\0")) throw new Error("payload.name must not contain null bytes")
  return { name: rec.name as string, config: validateConfig(rec.config) }
}

export function validateMcpAddContractRequest(raw: unknown): McpAddContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  validateIds(raw)
  validateContext(raw.context)
  validateNamePayload(raw.payload)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as McpAddContractRequest
}

export interface McpAddFailure {
  code: string
  message: string
  retryable: boolean
}

export type McpAddResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/add"
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
      op: "mcp/add"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: McpAddFailure }
      accepted: false
      failure: McpAddFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "mcp/add"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeMcpAddAmbiguous(req: McpAddContractRequest, transportUnknown = true): McpAddResult {
  const out: McpAddResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/add",
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
  "config",
  "command",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

const FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
])

export function validateMcpAddFailure(raw: unknown): McpAddFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error("failure must not carry raw field")
  }
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!FAILURE_CODES.has(raw.code as string)) throw new Error("failure code is not CLI-authoritative")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as McpAddFailure
}

export type McpAddWireOutcome = { kind: "valid"; result: McpAddResult } | { kind: "invalid"; detail: string }

export const MCP_ADD_INVALID_DETAIL = "invalid private response shape"

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
export function validateMcpAddResult(raw: unknown, req: McpAddContractRequest): McpAddResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "mcp/add") throw new Error("op mismatch")
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
    for (const k of Object.keys(data)) if (k !== "status") throw new Error("unexpected data field")
    validateMcpStatusMap((data as Record<string, unknown>).status)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as McpAddResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = validateMcpAddFailure(rec.failure)
    const outFailure = validateMcpAddFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as McpAddResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as McpAddResult
}

export function normalizePrivateMcpAddWire(raw: unknown, req: McpAddContractRequest): McpAddWireOutcome {
  try {
    return { kind: "valid", result: validateMcpAddResult(raw, req) }
  } catch {
    return { kind: "invalid", detail: MCP_ADD_INVALID_DETAIL }
  }
}

export function isSettledMcpAddResult(result: unknown, req: McpAddContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed" && kind !== "ambiguous") return false
  try {
    validateMcpAddResult(result, req)
    return true
  } catch {
    return false
  }
}
