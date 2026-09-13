import { Effect } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { InstanceRef } from "@/effect/instance-ref"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { MCP } from "@/mcp"

export const CONNECT_VERSION = 1 as const
export const CONNECT_OP = "mcp/connect" as const
export const CONNECT_CAPABILITY = "mcp/connect" as const
export const DISCONNECT_VERSION = 1 as const
export const DISCONNECT_OP = "mcp/disconnect" as const
export const DISCONNECT_CAPABILITY = "mcp/disconnect" as const
export const AUTHENTICATE_VERSION = 1 as const
export const AUTHENTICATE_OP = "mcp/authenticate" as const
export const AUTHENTICATE_CAPABILITY = "mcp/authenticate" as const
export const ADD_VERSION = 1 as const
export const ADD_OP = "mcp/add" as const
export const ADD_CAPABILITY = "mcp/add" as const

export interface McpConnectRequest {
  v: typeof CONNECT_VERSION
  requestId: string
  opId: string
  op: typeof CONNECT_OP
  idempotencyKey: string
  context: {
    directory: string
  }
  payload: {
    name: string
  }
}

export interface McpDisconnectRequest {
  v: typeof DISCONNECT_VERSION
  requestId: string
  opId: string
  op: typeof DISCONNECT_OP
  idempotencyKey: string
  context: {
    directory: string
  }
  payload: {
    name: string
  }
}

export interface McpConnectionFailure {
  code: string
  message: string
  retryable: boolean
}

export interface McpConnectSucceeded {
  v: typeof CONNECT_VERSION
  requestId: string
  opId: string
  op: typeof CONNECT_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { connected: true }
}

export interface McpConnectFailed {
  v: typeof CONNECT_VERSION
  requestId: string
  opId: string
  op: typeof CONNECT_OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: McpConnectionFailure }
  accepted: false
  failure: McpConnectionFailure
}

export interface McpDisconnectSucceeded {
  v: typeof DISCONNECT_VERSION
  requestId: string
  opId: string
  op: typeof DISCONNECT_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { disconnected: true }
}

export interface McpDisconnectFailed {
  v: typeof DISCONNECT_VERSION
  requestId: string
  opId: string
  op: typeof DISCONNECT_OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: McpConnectionFailure }
  accepted: false
  failure: McpConnectionFailure
}

export interface McpAuthenticateRequest {
  v: typeof AUTHENTICATE_VERSION
  requestId: string
  opId: string
  op: typeof AUTHENTICATE_OP
  idempotencyKey: string
  context: {
    directory: string
  }
  payload: {
    name: string
  }
}

export interface McpAuthenticateSucceeded {
  v: typeof AUTHENTICATE_VERSION
  requestId: string
  opId: string
  op: typeof AUTHENTICATE_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { authenticated: true }
}

export interface McpAuthenticateFailed {
  v: typeof AUTHENTICATE_VERSION
  requestId: string
  opId: string
  op: typeof AUTHENTICATE_OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: McpConnectionFailure }
  accepted: false
  failure: McpConnectionFailure
}

export type McpConnectResult = McpConnectSucceeded | McpConnectFailed
export type McpDisconnectResult = McpDisconnectSucceeded | McpDisconnectFailed
export type McpAuthenticateResult = McpAuthenticateSucceeded | McpAuthenticateFailed

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

export interface McpAddRequest {
  v: typeof ADD_VERSION
  requestId: string
  opId: string
  op: typeof ADD_OP
  idempotencyKey: string
  context: {
    directory: string
  }
  payload: {
    name: string
    config: McpAddConfig
  }
}

export interface McpAddSucceeded {
  v: typeof ADD_VERSION
  requestId: string
  opId: string
  op: typeof ADD_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { status: Record<string, unknown> }
}

export interface McpAddFailed {
  v: typeof ADD_VERSION
  requestId: string
  opId: string
  op: typeof ADD_OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: McpConnectionFailure }
  accepted: false
  failure: McpConnectionFailure
}

export type McpAddResult = McpAddSucceeded | McpAddFailed

export const VALIDATION_MESSAGE = "invalid mcp connection request"
export const SCOPE_MESSAGE = "directory mismatch"
export const FENCE_MESSAGE = "Instance is unavailable during config rebuild; no active runtime for this request"
export const INTERNAL_MESSAGE = "internal error"
export const NOT_FOUND_MESSAGE = "mcp server not found"

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
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `mcp-connect:${token}`
}

export function parseMcpConnectOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "mcp-connect" || segs[1]!.length === 0)
    throw new Error("opId must be mcp-connect:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new Error("opId must be mcp-connect:<token> with nonempty colon-free token")
  return { token }
}

export function canonicalMcpDisconnectOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `mcp-disconnect:${token}`
}

export function parseMcpDisconnectOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "mcp-disconnect" || segs[1]!.length === 0)
    throw new Error("opId must be mcp-disconnect:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new Error("opId must be mcp-disconnect:<token> with nonempty colon-free token")
  return { token }
}

export function canonicalMcpAuthenticateOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `mcp-authenticate:${token}`
}
export function parseMcpAuthenticateOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "mcp-authenticate" || segs[1]!.length === 0)
    throw new Error("opId must be mcp-authenticate:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new Error("opId must be mcp-authenticate:<token> with nonempty colon-free token")
  return { token }
}

export function canonicalMcpAddOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `mcp-add:${token}`
}

export function parseMcpAddOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "mcp-add" || segs[1]!.length === 0)
    throw new Error("opId must be mcp-add:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new Error("opId must be mcp-add:<token> with nonempty colon-free token")
  return { token }
}

const ROOT_FIELDS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
const CONTEXT_FIELDS = new Set(["directory"])
const PAYLOAD_FIELDS = new Set(["name"])

function checkIds(raw: Record<string, unknown>, op: string, parse: (opId: string) => { token: string }): void {
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

function checkContext(raw: unknown): void {
  if (!record(raw)) throw new Error("context must be object")
  for (const k of Object.keys(raw)) if (!CONTEXT_FIELDS.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || raw.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(raw.directory)
}

function checkPayload(raw: unknown): string {
  if (!record(raw)) throw new Error("payload must be object")
  for (const k of Object.keys(raw)) if (!PAYLOAD_FIELDS.has(k)) throw new Error("unexpected payload field")
  const name = (raw as Record<string, unknown>).name
  if (typeof name !== "string" || name.length === 0 || name.length > 256)
    throw new Error("payload.name must be non-empty string")
  if (name.includes("\0")) throw new Error("payload.name must not contain null bytes")
  return name
}

function checkRoot(raw: unknown): Record<string, unknown> {
  if (!record(raw)) throw new Error("params must be object")
  for (const k of Object.keys(raw)) if (!ROOT_FIELDS.has(k)) throw new Error("unexpected field")
  return raw
}

export function validateMcpConnectRequest(raw: unknown): McpConnectRequest {
  const rec = checkRoot(raw)
  if (rec.v !== CONNECT_VERSION) throw new Error("v must be 1")
  checkIds(rec, CONNECT_OP, parseMcpConnectOpId)
  checkContext(rec.context)
  checkPayload(rec.payload)
  return raw as unknown as McpConnectRequest
}

export function validateMcpDisconnectRequest(raw: unknown): McpDisconnectRequest {
  const rec = checkRoot(raw)
  if (rec.v !== DISCONNECT_VERSION) throw new Error("v must be 1")
  checkIds(rec, DISCONNECT_OP, parseMcpDisconnectOpId)
  checkContext(rec.context)
  checkPayload(rec.payload)
  return raw as unknown as McpDisconnectRequest
}

export function validateMcpAuthenticateRequest(raw: unknown): McpAuthenticateRequest {
  const rec = checkRoot(raw)
  if (rec.v !== AUTHENTICATE_VERSION) throw new Error("v must be 1")
  checkIds(rec, AUTHENTICATE_OP, parseMcpAuthenticateOpId)
  checkContext(rec.context)
  checkPayload(rec.payload)
  return raw as unknown as McpAuthenticateRequest
}

const ADD_ROOT_FIELDS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
const ADD_PAYLOAD_FIELDS = new Set(["name", "config"])
const ADD_LOCAL_FIELDS = new Set(["type", "command", "environment", "env", "enabled", "timeout"])
const ADD_REMOTE_FIELDS = new Set(["type", "url", "enabled", "headers", "oauth", "timeout"])
const ADD_OAUTH_FIELDS = new Set(["clientId", "clientSecret", "scope", "callbackPort", "redirectUri"])

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

function checkAddConfig(raw: unknown): McpAddConfig {
  if (!record(raw)) throw new Error("payload.config must be object")
  const kind = (raw as Record<string, unknown>).type
  if (kind === "local") {
    for (const k of Object.keys(raw)) if (!ADD_LOCAL_FIELDS.has(k)) throw new Error("unexpected config field")
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
    for (const k of Object.keys(raw)) if (!ADD_REMOTE_FIELDS.has(k)) throw new Error("unexpected config field")
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
        for (const k of Object.keys(rec.oauth)) if (!ADD_OAUTH_FIELDS.has(k)) throw new Error("unexpected oauth field")
        const oauth = rec.oauth as Record<string, unknown>
        if (oauth.clientId !== undefined && typeof oauth.clientId !== "string")
          throw new Error("config.oauth.clientId invalid")
        if (oauth.clientSecret !== undefined && typeof oauth.clientSecret !== "string")
          throw new Error("config.oauth.clientSecret invalid")
        if (oauth.scope !== undefined && typeof oauth.scope !== "string") throw new Error("config.oauth.scope invalid")
        if (oauth.callbackPort !== undefined) {
          if (typeof oauth.callbackPort !== "number" || !Number.isInteger(oauth.callbackPort) || oauth.callbackPort < 1 || oauth.callbackPort > 65535)
            throw new Error("config.oauth.callbackPort invalid")
        }
        if (oauth.redirectUri !== undefined && typeof oauth.redirectUri !== "string")
          throw new Error("config.oauth.redirectUri invalid")
        out.oauth = { ...(oauth as Record<string, unknown>) }
      }
    }
    if (rec.timeout !== undefined) out.timeout = checkTimeout(rec.timeout)
    return out
  }
  throw new Error("config.type must be local or remote")
}

function checkAddPayload(raw: unknown): { name: string; config: McpAddConfig } {
  if (!record(raw)) throw new Error("payload must be object")
  for (const k of Object.keys(raw)) if (!ADD_PAYLOAD_FIELDS.has(k)) throw new Error("unexpected payload field")
  const rec = raw as Record<string, unknown>
  const name = rec.name
  if (typeof name !== "string" || name.length === 0 || name.length > 256)
    throw new Error("payload.name must be non-empty string")
  if (name.includes("\0")) throw new Error("payload.name must not contain null bytes")
  return { name, config: checkAddConfig(rec.config) }
}

export function validateMcpAddRequest(raw: unknown): McpAddRequest {
  if (!record(raw)) throw new Error("params must be object")
  for (const k of Object.keys(raw)) if (!ADD_ROOT_FIELDS.has(k)) throw new Error("unexpected field")
  const rec = raw as Record<string, unknown>
  if (rec.v !== ADD_VERSION) throw new Error("v must be 1")
  checkIds(rec, ADD_OP, parseMcpAddOpId)
  checkContext(rec.context)
  const payload = checkAddPayload(rec.payload)
  return {
    v: ADD_VERSION,
    requestId: rec.requestId as string,
    opId: rec.opId as string,
    op: ADD_OP,
    idempotencyKey: rec.idempotencyKey as string,
    context: { directory: (rec.context as Record<string, unknown>).directory as string },
    payload,
  }
}

type Ids = { requestId: string; opId: string; idempotencyKey: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackMcpConnectIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function fallbackMcpDisconnectIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function fallbackMcpAuthenticateIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function safeMcpConnectIds(req: Ids): Ids {
  return { requestId: sanitized(req.requestId), opId: sanitized(req.opId), idempotencyKey: sanitized(req.idempotencyKey) }
}

export function safeMcpDisconnectIds(req: Ids): Ids {
  return { requestId: sanitized(req.requestId), opId: sanitized(req.opId), idempotencyKey: sanitized(req.idempotencyKey) }
}

export function safeMcpAuthenticateIds(req: Ids): Ids {
  return { requestId: sanitized(req.requestId), opId: sanitized(req.opId), idempotencyKey: sanitized(req.idempotencyKey) }
}

export function fallbackMcpAddIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function safeMcpAddIds(req: Ids): Ids {
  return { requestId: sanitized(req.requestId), opId: sanitized(req.opId), idempotencyKey: sanitized(req.idempotencyKey) }
}

export function failedConnect(ids: Ids, code: string, message: string, retryable: boolean): McpConnectFailed {
  const failure = { code, message, retryable }
  return {
    v: CONNECT_VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: CONNECT_OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeededConnect(req: McpConnectRequest): McpConnectSucceeded {
  return {
    v: CONNECT_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: CONNECT_OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { connected: true },
  }
}

export function failedDisconnect(ids: Ids, code: string, message: string, retryable: boolean): McpDisconnectFailed {
  const failure = { code, message, retryable }
  return {
    v: DISCONNECT_VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: DISCONNECT_OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeededDisconnect(req: McpDisconnectRequest): McpDisconnectSucceeded {
  return {
    v: DISCONNECT_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: DISCONNECT_OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { disconnected: true },
  }
}

export function failedAuthenticate(ids: Ids, code: string, message: string, retryable: boolean): McpAuthenticateFailed {
  const failure = { code, message, retryable }
  return {
    v: AUTHENTICATE_VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: AUTHENTICATE_OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeededAuthenticate(req: McpAuthenticateRequest): McpAuthenticateSucceeded {
  return {
    v: AUTHENTICATE_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: AUTHENTICATE_OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { authenticated: true },
  }
}

export function failedAdd(ids: Ids, code: string, message: string, retryable: boolean): McpAddFailed {
  const failure = { code, message, retryable }
  return {
    v: ADD_VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: ADD_OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeededAdd(req: McpAddRequest, status: Record<string, unknown>): McpAddSucceeded {
  return {
    v: ADD_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: ADD_OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { status },
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { _tag?: string })?._tag === "MCP.NotFoundError"
}

function isFence(err: unknown): boolean {
  return (
    err instanceof InstanceUnavailableDuringConfigRebuildError ||
    (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
  )
}

export const connectMcpPrivate = Effect.fn("McpConnectionPrivate.connect")(function* (raw: unknown) {
  let req: McpConnectRequest
  try {
    req = validateMcpConnectRequest(raw)
  } catch {
    return failedConnect(fallbackMcpConnectIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeMcpConnectIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failedConnect(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence = isFence(err)
      const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
      const message = fence ? FENCE_MESSAGE : INTERNAL_MESSAGE
      return Effect.succeed({ tag: "fail" as const, result: failedConnect(safe, code, message, fence) })
    }),
    Effect.catchDefect(() =>
      Effect.succeed({ tag: "fail" as const, result: failedConnect(safe, "internal", INTERNAL_MESSAGE, false) }),
    ),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failedConnect(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failedConnect(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const svc = yield* MCP.Service
    const done = yield* svc.connect(req.payload.name).pipe(
      Effect.map(() => ({ tag: "ok" as const })),
      Effect.catch((err: unknown) => Effect.succeed({ tag: "fail" as const, err })),
      Effect.catchDefect((defect: unknown) => Effect.succeed({ tag: "fail" as const, err: defect })),
    )
    if (done.tag === "ok") return succeededConnect(req)
    if (isNotFound(done.err)) return failedConnect(safe, "mcp.not_found", NOT_FOUND_MESSAGE, false)
    return failedConnect(safe, "internal", INTERNAL_MESSAGE, false)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failedConnect(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failedConnect(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})

export const disconnectMcpPrivate = Effect.fn("McpConnectionPrivate.disconnect")(function* (raw: unknown) {
  let req: McpDisconnectRequest
  try {
    req = validateMcpDisconnectRequest(raw)
  } catch {
    return failedDisconnect(fallbackMcpDisconnectIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeMcpDisconnectIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failedDisconnect(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence = isFence(err)
      const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
      const message = fence ? FENCE_MESSAGE : INTERNAL_MESSAGE
      return Effect.succeed({ tag: "fail" as const, result: failedDisconnect(safe, code, message, fence) })
    }),
    Effect.catchDefect(() =>
      Effect.succeed({ tag: "fail" as const, result: failedDisconnect(safe, "internal", INTERNAL_MESSAGE, false) }),
    ),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failedDisconnect(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failedDisconnect(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const svc = yield* MCP.Service
    const done = yield* svc.disconnect(req.payload.name).pipe(
      Effect.map(() => ({ tag: "ok" as const })),
      Effect.catch((err: unknown) => Effect.succeed({ tag: "fail" as const, err })),
      Effect.catchDefect((defect: unknown) => Effect.succeed({ tag: "fail" as const, err: defect })),
    )
    if (done.tag === "ok") return succeededDisconnect(req)
    if (isNotFound(done.err)) return failedDisconnect(safe, "mcp.not_found", NOT_FOUND_MESSAGE, false)
    return failedDisconnect(safe, "internal", INTERNAL_MESSAGE, false)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failedDisconnect(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failedDisconnect(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})

export const authenticateMcpPrivate = Effect.fn("McpConnectionPrivate.authenticate")(function* (raw: unknown) {
  let req: McpAuthenticateRequest
  try {
    req = validateMcpAuthenticateRequest(raw)
  } catch {
    return failedAuthenticate(fallbackMcpAuthenticateIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeMcpAuthenticateIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failedAuthenticate(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence = isFence(err)
      const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
      const message = fence ? FENCE_MESSAGE : INTERNAL_MESSAGE
      return Effect.succeed({ tag: "fail" as const, result: failedAuthenticate(safe, code, message, fence) })
    }),
    Effect.catchDefect(() =>
      Effect.succeed({ tag: "fail" as const, result: failedAuthenticate(safe, "internal", INTERNAL_MESSAGE, false) }),
    ),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failedAuthenticate(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failedAuthenticate(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const svc = yield* MCP.Service
    const done = yield* svc.authenticate(req.payload.name).pipe(
      Effect.map((status) => ({ tag: "ok" as const, status })),
      Effect.catch((err: unknown) => Effect.succeed({ tag: "fail" as const, err })),
      Effect.catchDefect((defect: unknown) => Effect.succeed({ tag: "fail" as const, err: defect })),
    )
    if (done.tag === "ok") {
      const status = done.status as { status?: unknown }
      if (status && status.status === "connected") return succeededAuthenticate(req)
      return failedAuthenticate(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (isNotFound(done.err)) return failedAuthenticate(safe, "mcp.not_found", NOT_FOUND_MESSAGE, false)
    return failedAuthenticate(safe, "internal", INTERNAL_MESSAGE, false)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failedAuthenticate(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failedAuthenticate(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})

export const addMcpPrivate = Effect.fn("McpConnectionPrivate.add")(function* (raw: unknown) {
  let req: McpAddRequest
  try {
    req = validateMcpAddRequest(raw)
  } catch {
    return failedAdd(fallbackMcpAddIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeMcpAddIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failedAdd(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence = isFence(err)
      const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
      const message = fence ? FENCE_MESSAGE : INTERNAL_MESSAGE
      return Effect.succeed({ tag: "fail" as const, result: failedAdd(safe, code, message, fence) })
    }),
    Effect.catchDefect(() =>
      Effect.succeed({ tag: "fail" as const, result: failedAdd(safe, "internal", INTERNAL_MESSAGE, false) }),
    ),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failedAdd(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failedAdd(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const svc = yield* MCP.Service
    const done = yield* svc.add(req.payload.name, req.payload.config as never).pipe(
      Effect.map((value) => ({ tag: "ok" as const, value })),
      Effect.catch((err: unknown) => Effect.succeed({ tag: "fail" as const, err })),
      Effect.catchDefect((defect: unknown) => Effect.succeed({ tag: "fail" as const, err: defect })),
    )
    if (done.tag === "ok") {
      const returned = (done.value as { status?: unknown }).status
      const map: Record<string, unknown> =
        !!returned && typeof returned === "object" && !Array.isArray(returned) && "status" in (returned as Record<string, unknown>)
          ? { [req.payload.name]: returned }
          : (returned as Record<string, unknown>)
      if (!map || typeof map !== "object" || Array.isArray(map)) return failedAdd(safe, "internal", INTERNAL_MESSAGE, false)
      return succeededAdd(req, map)
    }
    return failedAdd(safe, "internal", INTERNAL_MESSAGE, false)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failedAdd(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failedAdd(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
