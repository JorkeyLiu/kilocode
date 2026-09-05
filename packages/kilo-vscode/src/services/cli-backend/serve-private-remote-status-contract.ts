// Gate B deferred `remote.status` read-only candidate contract evidence only.
// Pure contract helpers with no transport, no private capability, no dispatch,
// no runtime observation, no durable state, no enable/disable, no event stream,
// and no production parity claim.
// `op:"remote/status"` below is a contract-evidence label only; it is never
// registered as a private capability and never sent over any peer. Production
// `remote.status` stays SDK-only (`GET /remote/status` via `@kilocode/sdk`
// `client.remote.status`).
//
// Source facts (read-only evidence, not imported):
// - Route: `GET /remote/status` with `WorkspaceRoutingQuery`
//   (`directory?`, `workspace?`) in
//   `packages/opencode/src/kilocode/server/httpapi/groups/remote.ts`
//   (`identifier: "remote.status"`, success `RemoteStatus`
//   `{enabled,connected}`, both booleans).
// - Handler: `packages/opencode/src/kilocode/server/httpapi/handlers/remote.ts`
//   `status` returns `KiloSessions.remoteStatus()` synchronously and ignores
//   the routed directory/workspace.
// - Service: `packages/opencode/src/kilo-sessions/kilo-sessions.ts`
//   `remoteStatus()` returns `{enabled: !!remote || !!enabling,
//   connected: remote?.conn.connected ?? false}` from module-closure process
//   state, not directory-keyed `InstanceState`.
// - SDK: v2 `client.remote.status({directory?, workspace?})` issues
//   `GET /remote/status` with optional query.
// - Consumer: `packages/kilo-vscode/src/services/RemoteStatusService.ts`
//   `refresh()`/`toggle()` call `client.remote.status()` with no arguments and
//   read `data.enabled`/`data.connected`.
//
// PROCESS-GLOBAL vs DIRECTORY-ROUTED SEMANTICS (explicit, honest v1):
// - `enabled` and `connected` are PROCESS-GLOBAL (KiloSessions closure). They
//   MUST NOT be treated as directory-isolated. This contract never binds them
//   to the request directory, never asserts payload directory equality, and
//   never compares them for directory isolation.
// - `directory`/`workspace` in the request context are ROUTING-ONLY labels
//   (accepted by the route query). Scope checks guard request-routing identity
//   only; a scope match says nothing about payload ownership.
// - Cross-directory equality of `enabled`/`connected` is EXPECTED and is not a
//   divergence; see `isRemoteStatusProcessGlobalField` and the parity test.
// - Out of scope: `remote.enable`, `remote.disable`, and `RemoteStatusChanged`
//   event parity.

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

export const REMOTE_STATUS_GLOBAL_FIELDS = ["enabled", "connected"] as const
export type RemoteStatusGlobalField = (typeof REMOTE_STATUS_GLOBAL_FIELDS)[number]

export function isRemoteStatusProcessGlobalField(v: unknown): v is RemoteStatusGlobalField {
  return v === "enabled" || v === "connected"
}

export function canonicalRemoteStatusOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `remote-status:${token}`
}

export function parseRemoteStatusOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`remote-status opId must have 1 segment: ${opId}`)
  if (segs[0] !== "remote-status") throw new TypeError(`opId kind must be remote-status: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { token }
}

export interface RemoteStatusContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "remote/status"
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

// eslint-disable-next-line complexity
export function validateRemoteStatusContractRequest(raw: unknown): RemoteStatusContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "remote/status") throw new Error("op must be remote/status")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId)
    throw new Error("idempotencyKey must equal opId for remote-status contract")
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
    throw new Error("payload must be empty object for remote-status contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  parseRemoteStatusOpId(raw.opId as string)
  const idem = parseRemoteStatusOpId(raw.idempotencyKey as string)
  if (idem.token !== parseRemoteStatusOpId(raw.opId as string).token)
    throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as RemoteStatusContractRequest
}

export type RemoteStatusScopeWhich = "directory" | "workspace" | "request"

export type RemoteStatusScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: RemoteStatusScopeWhich }

export function checkRemoteStatusScope(
  req: RemoteStatusContractRequest,
  expected: { directory: string; workspace?: string; token: string },
): RemoteStatusScopeCheck {
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
  if (wantWs !== undefined && gotWs !== wantWs)
    return { ok: false, code: "scope_mismatch", which: "workspace" }
  const parsed = parseRemoteStatusOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalRemoteStatusOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound)
    return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Smallest honest v1 payload projection: exactly the two production booleans.
// Both fields are process-global; validation checks shape only and asserts no
// directory binding.
export interface RemoteStatusPayload {
  enabled: boolean
  connected: boolean
}

const REMOTE_STATUS_PAYLOAD_FIELDS = new Set(["enabled", "connected"])

export function validateRemoteStatusPayload(raw: unknown): RemoteStatusPayload {
  if (!isRecord(raw)) throw new Error("remote-status payload must be object")
  assertAllowedKeys(raw as Record<string, unknown>, REMOTE_STATUS_PAYLOAD_FIELDS, "remote-status")
  if (typeof (raw as Record<string, unknown>).enabled !== "boolean")
    throw new Error("remote-status.enabled must be boolean")
  if (typeof (raw as Record<string, unknown>).connected !== "boolean")
    throw new Error("remote-status.connected must be boolean")
  return raw as unknown as RemoteStatusPayload
}

export type RemoteStatusResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "remote/status"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { status: RemoteStatusPayload }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "remote/status"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: RemoteStatusFailure }
      accepted: boolean
      failure: RemoteStatusFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "remote/status"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeRemoteStatusAmbiguous(
  req: RemoteStatusContractRequest,
  transportUnknown = true,
): RemoteStatusResult {
  const out: RemoteStatusResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "remote/status",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape following B6 `session/get` and path-get conventions
// ({code,message,retryable} only). Raw status/session/directory echo keys are
// rejected so fixtures cannot carry secret material.
export interface RemoteStatusFailure {
  code: string
  message: string
  retryable: boolean
}

const REMOTE_STATUS_FAILURE_FORBIDDEN = new Set([
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
])

const REMOTE_STATUS_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateRemoteStatusFailure(raw: unknown): RemoteStatusFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (REMOTE_STATUS_FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  assertAllowedKeys(raw as Record<string, unknown>, REMOTE_STATUS_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as RemoteStatusFailure
}

export type RemoteStatusWireOutcome =
  | { kind: "valid"; result: RemoteStatusResult }
  | { kind: "invalid"; detail: string }

export class RemoteStatusValidationError extends Error {
  readonly kind = "private-remote-status-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "RemoteStatusValidationError"
    this.detail = detail
  }
}

export function isRemoteStatusValidationError(v: unknown): v is RemoteStatusValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-remote-status-validation"
}

export function normalizePrivateRemoteStatusWire(
  raw: unknown,
  req: RemoteStatusContractRequest,
): RemoteStatusWireOutcome {
  try {
    const result = validateRemoteStatusResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const REMOTE_STATUS_RESULT_SUCCEEDED = new Set([
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
const REMOTE_STATUS_RESULT_FAILED = new Set([
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
const REMOTE_STATUS_RESULT_AMBIGUOUS = new Set([
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
const REMOTE_STATUS_OUTCOME_PLAIN = new Set(["type", "time"])
const REMOTE_STATUS_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateRemoteStatusResult(
  raw: unknown,
  req: RemoteStatusContractRequest,
): RemoteStatusResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "remote/status") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, REMOTE_STATUS_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, REMOTE_STATUS_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["status"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    // Process-global payload: shape-only validation. No directory binding is
    // asserted here by design; the request directory is routing-only.
    validateRemoteStatusPayload((data as Record<string, unknown>).status)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as RemoteStatusResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, REMOTE_STATUS_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, REMOTE_STATUS_OUTCOME_FAILED, "outcome")
    const failure = validateRemoteStatusFailure(rec.failure)
    const outFailure = validateRemoteStatusFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as RemoteStatusResult
  }
  assertAllowedKeys(rec, REMOTE_STATUS_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, REMOTE_STATUS_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as RemoteStatusResult
}

// Detached parity only (contract evidence, never production parity):
// compares ONLY the two process-global booleans (`enabled`, `connected`)
// exactly. The request directory is never compared; `processGlobal: true` plus
// `globalExcluded: true` in the details mark that explicit exclusion so no
// reader can mistake parity for directory isolation of globals.
export function compareRemoteStatusParity(
  priv: RemoteStatusResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const privStatus: string = priv.status
  if (!!(priv as Record<string, unknown>).transportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (sdkStatus !== privStatus) {
    return {
      divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`,
      details: { sdkStatus, privStatus, processGlobal: true },
    }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkPayload = (sdk.data ?? {}) as Record<string, unknown>
    const pdata = (priv as Extract<RemoteStatusResult, { status: "succeeded" }>).data as Record<string, unknown>
    const privPayload = (pdata.status ?? {}) as Record<string, unknown>
    const base = { processGlobal: true, globalExcluded: true }
    if (typeof sdkPayload.enabled !== "boolean" || typeof sdkPayload.connected !== "boolean") {
      return { divergence: "remote-status-shape-mismatch", details: { ...base, mismatch: true } }
    }
    if (sdkPayload.enabled !== privPayload.enabled) {
      return { divergence: "remote-status-enabled-mismatch", details: { ...base, mismatch: true, field: "enabled" } }
    }
    if (sdkPayload.connected !== privPayload.connected) {
      return {
        divergence: "remote-status-connected-mismatch",
        details: { ...base, mismatch: true, field: "connected" },
      }
    }
    return { divergence: null, details: { ...base } }
  }
  return { divergence: null, details: { processGlobal: true, globalExcluded: true } }
}
