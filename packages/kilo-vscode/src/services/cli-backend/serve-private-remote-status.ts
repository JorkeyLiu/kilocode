import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"

// `remote/status` diagnostics-only process-global snapshot (detached parity only).
// Request is strictly `{v:1,requestId,opId,op:"remote/status",
// idempotencyKey,context:{directory,workspace?},payload:{}}`
// with `opId === remote-status:<token>` (token non-empty, no colon) and
// `idempotencyKey === opId`. Directory/workspace are routing identity only;
// the `{enabled,connected}` payload is process-global (KiloSessions closure)
// and is never bound to the request directory. Cross-directory equality of
// the two booleans is expected, not a divergence. No enable/disable, no
// event-stream parity, no mutation/pagination/config ownership.
// Diagnostics never expose booleans, directories, workspaces, op/request ids,
// backend codes, or raw error strings: only fixed categories, booleans about
// shape, HTTP classes, and the constant op.

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

export function canonicalRemoteStatusOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `remote-status:${token}`
}

export interface ServePrivateRemoteStatusRequest {
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

export type ServePrivateRemoteStatusResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "remote/status"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { status: { enabled: boolean; connected: boolean } }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "remote/status"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean }
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
  req: ServePrivateRemoteStatusRequest,
  transportUnknown = true,
): ServePrivateRemoteStatusResult {
  const out: ServePrivateRemoteStatusResult = {
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

export function failedRemoteStatusResult(
  req: ServePrivateRemoteStatusRequest,
  code: string,
  msg: string,
): ServePrivateRemoteStatusResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "remote/status",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
    accepted: false,
    failure: { code, message: msg, retryable: false },
  }
}

// eslint-disable-next-line complexity
export function validateRemoteStatusRequest(raw: unknown): ServePrivateRemoteStatusRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "remote/status") throw new Error("op must be remote/status")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for remote-status")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (
    typeof ctx.directory !== "string" ||
    !isAbsolute(ctx.directory as string) ||
    (ctx.directory as string).includes("\0")
  )
    throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!isNonEmptyString(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for remote-status")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const opId = raw.opId as string
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "remote-status" || segs[1]!.length === 0)
    throw new Error("opId must be remote-status:<token> with nonempty colon-free token")
  return raw as unknown as ServePrivateRemoteStatusRequest
}

const REMOTE_STATUS_RESULT_ROOT_SUCCEEDED = new Set([
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
const REMOTE_STATUS_RESULT_ROOT_FAILED = new Set([
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
const REMOTE_STATUS_RESULT_ROOT_AMBIGUOUS = new Set([
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
const REMOTE_STATUS_FAILURE_FIELDS = new Set(["code", "message", "retryable"])
const REMOTE_STATUS_OUTCOME_PLAIN = new Set(["type", "time"])
const REMOTE_STATUS_OUTCOME_FAILED = new Set(["type", "time", "failure"])

/**
 * Type-honest wire normalization for `remote/status`.
 * A raw wire payload is either a strictly valid private remote-status result
 * or an invalid-wire diagnostic. Invalid wire is never a normal `failed`
 * result and never reaches `compareRemoteStatusParity` or SDK state.
 */
export type PrivateRemoteStatusWireOutcome =
  | { kind: "valid"; result: ServePrivateRemoteStatusResult }
  | { kind: "invalid"; detail: string }

export class PrivateRemoteStatusValidationError extends Error {
  readonly kind = "private-remote-status-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateRemoteStatusValidationError"
    this.detail = detail
  }
}

export function isPrivateRemoteStatusValidationError(v: unknown): v is PrivateRemoteStatusValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-remote-status-validation"
}

export function normalizePrivateRemoteStatusWire(
  raw: unknown,
  req: ServePrivateRemoteStatusRequest,
): PrivateRemoteStatusWireOutcome {
  try {
    const result = validateRemoteStatusResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

function validateRemoteStatusFailureShape(v: unknown, label: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${label} invalid`)
  assertAllowedKeys(v as Record<string, unknown>, REMOTE_STATUS_FAILURE_FIELDS, label)
  const rec = v as Record<string, unknown>
  if (typeof rec.code !== "string" || typeof rec.message !== "string" || typeof rec.retryable !== "boolean")
    throw new Error(`${label} invalid`)
  return rec
}

function validateRemoteStatusPayloadShape(v: unknown): void {
  if (!isRecord(v)) throw new Error("succeeded data.status must be object")
  const rec = v as Record<string, unknown>
  const allowed = new Set(["enabled", "connected"])
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected data.status field ${k}`)
  if (typeof rec.enabled !== "boolean") throw new Error("succeeded data.status.enabled must be boolean")
  if (typeof rec.connected !== "boolean") throw new Error("succeeded data.status.connected must be boolean")
}

// eslint-disable-next-line complexity
export function validateRemoteStatusResult(
  raw: unknown,
  req: ServePrivateRemoteStatusRequest,
): ServePrivateRemoteStatusResult {
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
    assertAllowedKeys(rec, REMOTE_STATUS_RESULT_ROOT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, REMOTE_STATUS_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    if (rec.transportUnknown !== undefined) throw new Error("succeeded must not have transportUnknown")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["status"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    // Process-global payload: shape-only validation. No directory binding is
    // asserted here by design; the request directory is routing-only.
    validateRemoteStatusPayloadShape((data as Record<string, unknown>).status)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ServePrivateRemoteStatusResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, REMOTE_STATUS_RESULT_ROOT_FAILED, "result")
    assertAllowedKeys(outRec, REMOTE_STATUS_OUTCOME_FAILED, "outcome")
    if (rec.transportUnknown !== undefined) throw new Error("failed must not have transportUnknown")
    const failure = validateRemoteStatusFailureShape(rec.failure, "failed failure")
    const outFailure = validateRemoteStatusFailureShape(outRec.failure, "failed outcome.failure")
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateRemoteStatusResult
  }
  assertAllowedKeys(rec, REMOTE_STATUS_RESULT_ROOT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, REMOTE_STATUS_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ServePrivateRemoteStatusResult
}

// Detached parity only: compares ONLY the two process-global booleans
// (`enabled`, `connected`) exactly. The request directory/workspace is never
// compared; `processGlobal: true` plus `globalExcluded: true` mark that
// explicit exclusion so no reader can mistake parity for directory isolation.
// Diagnostics never carry boolean values, directories, workspaces, or ids:
// only fixed categories and presence booleans.
export function compareRemoteStatusParity(
  priv: ServePrivateRemoteStatusResult,
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
    const pdata = (priv as Extract<ServePrivateRemoteStatusResult, { status: "succeeded" }>).data as Record<
      string,
      unknown
    >
    const privPayload = (pdata.status ?? {}) as Record<string, unknown>
    const base = { processGlobal: true, globalExcluded: true }
    if (typeof sdkPayload.enabled !== "boolean" || typeof sdkPayload.connected !== "boolean") {
      return { divergence: "remote-status-shape-mismatch", details: { ...base, mismatch: true } }
    }
    if (typeof privPayload.enabled !== "boolean" || typeof privPayload.connected !== "boolean") {
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

/** Minimal raw transport surface a peer owner needs for the remote-status outcome handle. */
export interface RemoteStatusRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape. */
interface RemoteStatusRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the read-only remote-status
 * parity observer. The caller validates the request and checks availability
 * and capability first. Transport/closed maps to ambiguous transportUnknown,
 * thrown errors map to failed results, and malformed wire resolves as
 * `{ kind: "invalid" }` before any comparator. No retries, no replays.
 */
export function requestRemoteStatusOutcome(
  raw: RemoteStatusRawTransport,
  host: RemoteStatusRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: ServePrivateRemoteStatusRequest,
): { id: number; promise: Promise<PrivateRemoteStatusWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId("remote/status", req)
  const promise = (async (): Promise<PrivateRemoteStatusWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeRemoteStatusAmbiguous(req, true) }
      const { code, msg } = host.failInfo(e)
      return { kind: "valid", result: failedRemoteStatusResult(req, code, msg) }
    }
    if (host.isStale()) return { kind: "valid", result: makeRemoteStatusAmbiguous(req, true) }
    return normalizePrivateRemoteStatusWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

/**
 * Exact-id timeout cancel ownership for a remote-status observer handle. Only
 * fixed categories reach diagnostics: the constant op plus booleans. Stale
 * handles clean only their captured peer; current-epoch miss/throw reports
 * through `invalidate` so the owner can fail-closed.
 */
export function makeRemoteStatusCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
): (msg?: string) => boolean {
  return (msg = "private parity timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate("remote-status stale observer timeout")
      } catch {
        console.warn("[Kilo Remote] stale observer cleanup failed:", {
          op: "remote/status",
          stale: true,
          cleanupFailed: true,
        })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo Remote] observer timeout cancel failed:", { op: "remote/status", cancelFailed: true })
      try {
        host.invalidate("remote-status observer timeout cancel throw")
      } catch {
        console.warn("[Kilo Remote] observer timeout invalidate failed:", {
          op: "remote/status",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate("remote-status observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo Remote] observer timeout invalidate failed:", {
          op: "remote/status",
          invalidateFailed: true,
        })
      }
      return false
    }
    return true
  }
}

/** Owner-level epoch mapping for the connection pass-through. */
interface RemoteStatusOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

/**
 * Connection-side epoch-aware wrapper around a peer remote-status outcome
 * handle. Epoch drift or peer replacement maps to ambiguous transportUnknown;
 * exact cancel preserves the peer while current-epoch cancel miss/throw
 * fail-closed via owner invalidation. A stale captured handle cleans only its
 * captured peer and returns `"stale"` so the observer never invalidates the
 * replacement peer.
 */
export function wrapRemoteStatusOutcomeForOwner(
  owner: RemoteStatusOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<PrivateRemoteStatusWireOutcome> },
  req: ServePrivateRemoteStatusRequest,
): { id: number; promise: Promise<PrivateRemoteStatusWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      return { kind: "valid", result: makeRemoteStatusAmbiguous(req, true) } as PrivateRemoteStatusWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Remote] stale observer cleanup failed:", {
          op: "remote/status",
          stale: true,
          cleanupFailed: true,
        })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Remote] observer timeout cancel failed:", {
        op: "remote/status",
        cancelFailed: true,
      })
      try {
        owner.invalidate("remote-status observer timeout cancel throw")
      } catch {
        console.warn("[Kilo Remote] observer timeout invalidate failed:", {
          op: "remote/status",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("remote-status observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo Remote] observer timeout invalidate failed:", {
          op: "remote/status",
          invalidateFailed: true,
        })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

/**
 * Owner-managed deferred remote-status observers: at most one deferred
 * private remote-status observation per backend epoch + canonical routing
 * directory + workspace. Wrappers live in the owner's availability-listener
 * set too; this map only provides the dedupe key. No timers, no polling, no
 * detached work, no new peer lifecycle. The workspace value is represented
 * only by its SHA-256 digest so keys never expose workspace material.
 */
export class DeferredRemoteStatus {
  private readonly map = new Map<string, () => void>()
  constructor(private readonly listeners: Set<() => void>) {}

  key(epoch: number | null, dir: string, workspace?: string): string {
    let canonical = dir
    try {
      canonical = normalize(resolve(dir))
    } catch {
      canonical = dir
    }
    const wsPart =
      workspace === undefined ? "none" : `h-${crypto.createHash("sha256").update(workspace, "utf8").digest("hex")}`
    return `remote-status:${epoch ?? "none"}:${canonical}:${wsPart}`
  }

  add(
    epoch: number | null,
    failedEpoch: number | null,
    available: boolean,
    dir: string,
    workspace: string | undefined,
    listener: () => void,
  ): () => void {
    if (epoch === null) return () => {}
    if (failedEpoch !== null && epoch === failedEpoch) return () => {}
    if (available) return () => {}
    const key = this.key(epoch, dir, workspace)
    if (this.map.has(key)) return () => {}
    let wrapper: () => void = () => {
      this.remove(key, wrapper)
      listener()
    }
    this.map.set(key, wrapper)
    this.listeners.add(wrapper)
    return () => {
      this.remove(key, wrapper)
    }
  }

  remove(key: string, wrapper: () => void): void {
    if (this.map.get(key) === wrapper) this.map.delete(key)
    this.listeners.delete(wrapper)
  }

  clearForEpoch(epoch: number | null): void {
    const prefix = `remote-status:${epoch ?? "none"}:`
    for (const [key, wrapper] of [...this.map]) {
      if (!key.startsWith(prefix)) continue
      this.map.delete(key)
      this.listeners.delete(wrapper)
    }
  }

  clearAll(): void {
    for (const [, wrapper] of [...this.map]) this.listeners.delete(wrapper)
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
