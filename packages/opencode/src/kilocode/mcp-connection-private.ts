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
