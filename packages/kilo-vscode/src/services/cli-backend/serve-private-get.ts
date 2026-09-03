import { isAbsolute, normalize, resolve } from "path"

// B6 `session/get` read-only same-directory snapshot (detached parity only).
// Request is strictly `{v:1,requestId,opId,op:"session/get",
// idempotencyKey,context:{directory,sessionId},payload:{}}` with
// `opId === get:<sessionId>:<token>` (token non-empty, no colon) and
// `idempotencyKey === opId`. Success data is `{session: Session.Info}`;
// only `id`, canonicalized `directory`, and `title` are ever compared.

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

function assertFailureDetailMirror(top: Record<string, unknown>, out: Record<string, unknown>): void {
  const hasTop = top.detail !== undefined
  const hasOut = out.detail !== undefined
  if (!hasTop && !hasOut) return
  if (hasTop !== hasOut) throw new Error("failure detail presence mismatch")
  if (top.detail !== out.detail) throw new Error("failure detail mismatch")
}

function statusInRange(n: unknown): number | null {
  if (typeof n === "number" && Number.isInteger(n) && n >= 100 && n < 600) return n
  if (typeof n === "string") {
    const v = Number(n)
    if (Number.isInteger(v) && v >= 100 && v < 600) return v
  }
  return null
}

function errorStatusFromFields(err: Record<string, unknown>): number | null {
  const cands: unknown[] = [err.status, err.statusCode, err.code, err.httpStatus, err.status_code, err.httpStatusCode]
  for (const c of cands) {
    const v = statusInRange(c)
    if (v !== null) return v
  }
  return null
}

function errorStatusFromMessage(err: Record<string, unknown>): number | null {
  if (typeof err.message === "string") {
    const m = err.message.match(/\b(400|404|409|500)\b/)
    if (m) return Number(m[1])
  }
  const tag = typeof err._tag === "string" ? String(err._tag).toLowerCase() : ""
  if (tag.includes("notfound")) return 404
  if (tag.includes("conflict")) return 409
  if (tag.includes("badrequest")) return 400
  if (tag.includes("internal")) return 500
  return null
}

function sdkHttpStatus(sdk: { data?: unknown; error?: unknown; response?: unknown }): number | null {
  const resp = (sdk as { response?: unknown }).response as { status?: unknown } | undefined
  if (resp) {
    const v = statusInRange(resp.status)
    if (v !== null) return v
  }
  if (!sdk.error) return null
  const err = sdk.error as Record<string, unknown>
  return errorStatusFromFields(err) ?? errorStatusFromMessage(err)
}

function sdkStatusClass(status: number | null): string | null {
  if (status === null) return null
  if (status === 400) return "400"
  if (status === 404) return "404"
  if (status === 409) return "409"
  if (status === 500) return "500"
  return String(status)
}

export function canonicalGetOpId(sessionId: string, token: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  if (sessionId.includes(":")) throw new TypeError("sessionId must not contain ':'")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `get:${sessionId}:${token}`
}

export interface ServePrivateGetRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/get"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: Record<string, never>
}

export type ServePrivateGetResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/get"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { session: Record<string, unknown> }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/get"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/get"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeGetAmbiguous(req: ServePrivateGetRequest, transportUnknown = true): ServePrivateGetResult {
  const out: ServePrivateGetResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/get",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function parseGetOpId(opId: string): { sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`get opId must have 2 segments: ${opId}`)
  const kind = segs[0]!
  if (kind !== "get") throw new TypeError(`opId kind must be get: ${opId}`)
  const sid = segs[1]!
  const token = segs[2]!
  if (sid.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (sid.includes(":") || token.includes(":")) throw new TypeError(`token must not contain ':'`)
  return { sessionId: sid, token }
}

// eslint-disable-next-line complexity
export function validateGetRequest(raw: unknown): ServePrivateGetRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/get") throw new Error("op must be session/get")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for get")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx as Record<string, unknown>)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory as string) || (ctx.directory as string).includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0) throw new Error("payload must be empty object for get")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const parsed = parseGetOpId(raw.opId as string)
  if (parsed.sessionId !== ctx.sessionId) throw new Error(`opId session binding mismatch: ${raw.opId} vs ${ctx.sessionId}`)
  const idem = raw.idempotencyKey as string
  const parsedIdem = parseGetOpId(idem)
  if (parsedIdem.sessionId !== ctx.sessionId) throw new Error(`idempotencyKey session binding mismatch: ${idem} vs ${ctx.sessionId}`)
  return raw as unknown as ServePrivateGetRequest
}

const GET_RESULT_ROOT_SUCCEEDED = new Set([
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
const GET_RESULT_ROOT_FAILED = new Set([
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
const GET_RESULT_ROOT_AMBIGUOUS = new Set([
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
const GET_FAILURE_FIELDS = new Set(["code", "message", "retryable", "detail"])
const GET_OUTCOME_SUCCEEDED_FIELDS = new Set(["type", "time"])
const GET_OUTCOME_FAILED_FIELDS = new Set(["type", "time", "failure"])
const GET_OUTCOME_AMBIGUOUS_FIELDS = new Set(["type", "time"])

/**
 * Type-honest wire normalization for `session/get`.
 * A raw wire payload is either a strictly valid private get result or an
 * invalid-wire diagnostic. Invalid wire is never a normal `failed` result and
 * never reaches `compareGetParity` or SDK state.
 */
export type PrivateGetWireOutcome =
  | { kind: "valid"; result: ServePrivateGetResult }
  | { kind: "invalid"; detail: string }

export class PrivateGetValidationError extends Error {
  readonly kind = "private-get-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateGetValidationError"
    this.detail = detail
  }
}

export function isPrivateGetValidationError(v: unknown): v is PrivateGetValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-get-validation"
}

export function normalizePrivateGetWire(raw: unknown, req: ServePrivateGetRequest): PrivateGetWireOutcome {
  try {
    const result = validateGetResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

function validateGetFailureShape(v: unknown, label: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${label} invalid`)
  assertAllowedKeys(v as Record<string, unknown>, GET_FAILURE_FIELDS, label)
  const rec = v as Record<string, unknown>
  if (typeof rec.code !== "string" || typeof rec.message !== "string" || typeof rec.retryable !== "boolean")
    throw new Error(`${label} invalid`)
  if (rec.detail !== undefined && typeof rec.detail !== "string") throw new Error(`${label}.detail must be string if present`)
  return rec
}

// eslint-disable-next-line complexity
export function validateGetResult(raw: unknown, req: ServePrivateGetRequest): ServePrivateGetResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/get") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous") throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number") throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    assertAllowedKeys(rec, GET_RESULT_ROOT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, GET_OUTCOME_SUCCEEDED_FIELDS, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    if (rec.transportUnknown !== undefined) throw new Error("succeeded must not have transportUnknown")
    if (rec.revision !== undefined) throw new Error("revision not accepted for get result")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["session"])
    for (const k of Object.keys(data as Record<string, unknown>)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    const sess = (data as Record<string, unknown>).session
    if (!isRecord(sess)) throw new Error("succeeded data.session must be object")
    const srec = sess as Record<string, unknown>
    if (!isNonEmptyString(srec.id)) throw new Error("succeeded data.session.id must be non-empty string")
    if (typeof srec.directory !== "string" || (srec.directory as string).length === 0)
      throw new Error("succeeded data.session.directory must be non-empty string")
    if (typeof srec.title !== "string") throw new Error("succeeded data.session.title must be string")
    // LOCK-003 strict payload identity: succeeded wire must carry the exact
    // requested session id and the canonical request directory. Violating wire
    // is invalid and bypasses the comparator (never a normal failed result).
    if (srec.id !== req.context.sessionId) throw new Error("payload session id mismatch")
    let want: string
    try {
      want = canonicalDir(req.context.directory)
    } catch {
      throw new Error("payload directory mismatch")
    }
    let got: string
    try {
      got = canonicalDir(srec.directory as string)
    } catch {
      throw new Error("succeeded data.session.directory invalid")
    }
    if (want !== got) throw new Error("payload directory mismatch")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    if (outRec.data !== undefined) throw new Error("succeeded outcome must not have data")
    return raw as unknown as ServePrivateGetResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, GET_RESULT_ROOT_FAILED, "result")
    assertAllowedKeys(outRec, GET_OUTCOME_FAILED_FIELDS, "outcome")
    if (rec.transportUnknown !== undefined) throw new Error("failed must not have transportUnknown")
    if (rec.revision !== undefined) throw new Error("revision not accepted for get result")
    if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for get result")
    if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for get result")
    const failure = validateGetFailureShape(rec.failure, "failed failure")
    const outFailure = validateGetFailureShape(outRec.failure, "failed outcome.failure")
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    assertFailureDetailMirror(failure, outFailure)
    if (rec.data !== undefined) throw new Error("failed must not have data")
    if (outRec.data !== undefined) throw new Error("failed outcome must not have data")
    return raw as unknown as ServePrivateGetResult
  }
  assertAllowedKeys(rec, GET_RESULT_ROOT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, GET_OUTCOME_AMBIGUOUS_FIELDS, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.revision !== undefined) throw new Error("revision not accepted for get result")
  if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for get result")
  if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for get result")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  if (outRec.data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateGetResult
}

// eslint-disable-next-line complexity
export function compareGetParity(
  priv: ServePrivateGetResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const privStatus: string = priv.status
  const isTransportUnknown = !!(priv as Record<string, unknown>).transportUnknown
  if (isTransportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (privStatus === "ambiguous" && sdkStatus === "failed") {
    const http = sdkHttpStatus(sdk)
    if (http === 409) {
      return { divergence: null, details: { sdkStatus, privStatus, http } }
    }
    return {
      divergence: `status-mismatch:sdk=failed(${String(http ?? "unknown")}) priv=ambiguous`,
      details: { sdkStatus, privStatus, http },
    }
  }
  if (privStatus === "ambiguous" && sdkStatus === "succeeded") {
    return { divergence: `status-mismatch:sdk=succeeded priv=ambiguous`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus !== privStatus) {
    return { divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkSess = (sdk.data ?? {}) as Record<string, unknown>
    const pdata = (priv as Extract<ServePrivateGetResult, { status: "succeeded" }>).data as Record<string, unknown>
    const privSess = (pdata.session ?? {}) as Record<string, unknown>
    const sdkId = sdkSess.id
    const privId = privSess.id
    if (typeof sdkId !== "string" || typeof privId !== "string" || sdkId !== privId) {
      return { divergence: `get-id-mismatch`, details: { mismatch: true, field: "id" } }
    }
    const sdkDirRaw = sdkSess.directory
    const privDirRaw = privSess.directory
    if (typeof sdkDirRaw === "string" && typeof privDirRaw === "string") {
      let sdkDir = sdkDirRaw
      let privDir = privDirRaw
      try {
        sdkDir = canonicalDir(sdkDirRaw)
      } catch {}
      try {
        privDir = canonicalDir(privDirRaw)
      } catch {}
      if (sdkDir !== privDir) {
        return { divergence: `get-directory-mismatch`, details: { mismatch: true, field: "directory" } }
      }
    } else if (String(sdkDirRaw ?? "") !== String(privDirRaw ?? "")) {
      return { divergence: `get-directory-mismatch`, details: { mismatch: true, field: "directory" } }
    }
    const sdkTitle = sdkSess.title
    const privTitle = privSess.title
    if (String(sdkTitle ?? "") !== String(privTitle ?? "")) {
      return { divergence: `get-title-mismatch`, details: { mismatch: true, field: "title" } }
    }
    return { divergence: null, details: {} }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateGetResult, { status: "failed" }>).failure?.code ?? "unknown") as string
    const http = sdkHttpStatus(sdk)
    const cls = sdkStatusClass(http)
    const allowed = (() => {
      if (cls === "400") return new Set(["validation.failed", "scope_mismatch"])
      if (cls === "404") return new Set(["session.not_found"])
      if (cls === "409") return new Set(["stale", "conflict", "InstanceUnavailableDuringConfigRebuild"])
      if (cls === "500") return new Set(["internal"])
      return null
    })()
    if (allowed) {
      if (!allowed.has(privCode)) {
        return {
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}
