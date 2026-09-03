import { isAbsolute, normalize, resolve } from "path"

// B7 `session/messages` read-only same-directory page snapshot (detached parity only).
// Request is strictly `{v:1,requestId,opId,op:"session/messages",
// idempotencyKey,context:{directory,sessionId},payload:{limit?,before?}}`
// with `opId === messages:<sessionId>:<token>` (token non-empty, no colon)
// and `idempotencyKey === opId`. `before` requires `limit` (zero is a valid
// supplied limit); `limit:0` preserves full-read semantics. Success data is
// `{messages: WithParts[], nextCursor?}`; the comparator may use the full
// payload in memory but only logs safe truncated metadata (never content,
// part content, ids, cursor values, or serialized payload).

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

export function canonicalMessagesOpId(sessionId: string, token: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  if (sessionId.includes(":")) throw new TypeError("sessionId must not contain ':'")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `messages:${sessionId}:${token}`
}

export interface ServePrivateMessagesRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/messages"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: {
    limit?: number
    before?: string
  }
}

export type ServePrivateMessagesResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/messages"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { messages: Record<string, unknown>[]; nextCursor?: string }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/messages"
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
      op: "session/messages"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeMessagesAmbiguous(req: ServePrivateMessagesRequest, transportUnknown = true): ServePrivateMessagesResult {
  const out: ServePrivateMessagesResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/messages",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function parseMessagesOpId(opId: string): { sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`messages opId must have 2 segments: ${opId}`)
  const kind = segs[0]!
  if (kind !== "messages") throw new TypeError(`opId kind must be messages: ${opId}`)
  const sid = segs[1]!
  const token = segs[2]!
  if (sid.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (sid.includes(":") || token.includes(":")) throw new TypeError(`token must not contain ':'`)
  return { sessionId: sid, token }
}

// eslint-disable-next-line complexity
export function validateMessagesRequest(raw: unknown): ServePrivateMessagesRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/messages") throw new Error("op must be session/messages")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for messages")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx as Record<string, unknown>)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory as string) || (ctx.directory as string).includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set(["limit", "before"])
  for (const k of Object.keys(payload as Record<string, unknown>)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  const prec = payload as Record<string, unknown>
  if (prec.limit !== undefined) {
    if (typeof prec.limit !== "number" || !Number.isInteger(prec.limit) || (prec.limit as number) < 0 || !Number.isSafeInteger(prec.limit))
      throw new Error("payload.limit must be non-negative integer")
  }
  if (prec.before !== undefined) {
    if (typeof prec.before !== "string" || (prec.before as string).length === 0)
      throw new Error("payload.before must be non-empty string")
    if (prec.limit === undefined)
      throw new Error("payload.before requires payload.limit")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const parsed = parseMessagesOpId(raw.opId as string)
  if (parsed.sessionId !== ctx.sessionId) throw new Error(`opId session binding mismatch: ${raw.opId} vs ${ctx.sessionId}`)
  const idem = raw.idempotencyKey as string
  const parsedIdem = parseMessagesOpId(idem)
  if (parsedIdem.sessionId !== ctx.sessionId) throw new Error(`idempotencyKey session binding mismatch: ${idem} vs ${ctx.sessionId}`)
  return raw as unknown as ServePrivateMessagesRequest
}

const MESSAGES_RESULT_ROOT_SUCCEEDED = new Set([
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
const MESSAGES_RESULT_ROOT_FAILED = new Set([
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
const MESSAGES_RESULT_ROOT_AMBIGUOUS = new Set([
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
const MESSAGES_FAILURE_FIELDS = new Set(["code", "message", "retryable", "detail"])
const MESSAGES_OUTCOME_SUCCEEDED_FIELDS = new Set(["type", "time"])
const MESSAGES_OUTCOME_FAILED_FIELDS = new Set(["type", "time", "failure"])
const MESSAGES_OUTCOME_AMBIGUOUS_FIELDS = new Set(["type", "time"])

/**
 * Type-honest wire normalization for `session/messages`.
 * A raw wire payload is either a strictly valid private messages result or
 * an invalid-wire diagnostic. Invalid wire is never a normal `failed` result
 * and never reaches `compareMessagesParity` or SDK state.
 */
export type PrivateMessagesWireOutcome =
  | { kind: "valid"; result: ServePrivateMessagesResult }
  | { kind: "invalid"; detail: string }

export class PrivateMessagesValidationError extends Error {
  readonly kind = "private-messages-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateMessagesValidationError"
    this.detail = detail
  }
}

export function isPrivateMessagesValidationError(v: unknown): v is PrivateMessagesValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-messages-validation"
}

export function normalizePrivateMessagesWire(raw: unknown, req: ServePrivateMessagesRequest): PrivateMessagesWireOutcome {
  try {
    const result = validateMessagesResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

function validateMessagesFailureShape(v: unknown, label: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${label} invalid`)
  assertAllowedKeys(v as Record<string, unknown>, MESSAGES_FAILURE_FIELDS, label)
  const rec = v as Record<string, unknown>
  if (typeof rec.code !== "string" || typeof rec.message !== "string" || typeof rec.retryable !== "boolean")
    throw new Error(`${label} invalid`)
  if (rec.detail !== undefined && typeof rec.detail !== "string") throw new Error(`${label}.detail must be string if present`)
  return rec
}

// eslint-disable-next-line complexity
export function validateMessagesResult(raw: unknown, req: ServePrivateMessagesRequest): ServePrivateMessagesResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/messages") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, MESSAGES_RESULT_ROOT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, MESSAGES_OUTCOME_SUCCEEDED_FIELDS, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    if (rec.transportUnknown !== undefined) throw new Error("succeeded must not have transportUnknown")
    if (rec.revision !== undefined) throw new Error("revision not accepted for messages result")
    if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for messages result")
    if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for messages result")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["messages", "nextCursor"])
    for (const k of Object.keys(data as Record<string, unknown>)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    const drec = data as Record<string, unknown>
    if (!Array.isArray(drec.messages)) throw new Error("succeeded data.messages must be array")
    for (const item of drec.messages as unknown[]) if (!isRecord(item)) throw new Error("succeeded data.messages entry must be object")
    if (drec.nextCursor !== undefined && typeof drec.nextCursor !== "string") throw new Error("succeeded data.nextCursor must be string if present")
    if (typeof drec.nextCursor === "string" && (drec.nextCursor as string).length === 0) throw new Error("succeeded data.nextCursor must be non-empty string if present")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    if (outRec.data !== undefined) throw new Error("succeeded outcome must not have data")
    return raw as unknown as ServePrivateMessagesResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, MESSAGES_RESULT_ROOT_FAILED, "result")
    assertAllowedKeys(outRec, MESSAGES_OUTCOME_FAILED_FIELDS, "outcome")
    if (rec.transportUnknown !== undefined) throw new Error("failed must not have transportUnknown")
    if (rec.revision !== undefined) throw new Error("revision not accepted for messages result")
    if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for messages result")
    if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for messages result")
    const failure = validateMessagesFailureShape(rec.failure, "failed failure")
    const outFailure = validateMessagesFailureShape(outRec.failure, "failed outcome.failure")
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    assertFailureDetailMirror(failure, outFailure)
    if (rec.data !== undefined) throw new Error("failed must not have data")
    if (outRec.data !== undefined) throw new Error("failed outcome must not have data")
    return raw as unknown as ServePrivateMessagesResult
  }
  assertAllowedKeys(rec, MESSAGES_RESULT_ROOT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, MESSAGES_OUTCOME_AMBIGUOUS_FIELDS, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.revision !== undefined) throw new Error("revision not accepted for messages result")
  if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for messages result")
  if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for messages result")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  if (outRec.data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateMessagesResult
}

function sdkMessagesOf(sdk: { data?: unknown }): unknown[] | null {
  if (!Array.isArray(sdk.data)) return null
  return sdk.data as unknown[]
}

function sdkCursorValue(sdk: { response?: unknown }): string | null {
  const resp = (sdk as { response?: { headers?: unknown } }).response
  if (!resp || typeof resp !== "object") return null
  const headers = (resp as { headers?: unknown }).headers as { get?: unknown } | undefined
  if (headers && typeof headers.get === "function") {
    try {
      const v = (headers.get as (k: string) => unknown).call(headers, "X-Next-Cursor")
      if (typeof v === "string" && v.length > 0) return v
      return null
    } catch {
      return null
    }
  }
  return null
}

function sdkCursorPresent(sdk: { response?: unknown }): boolean {
  return sdkCursorValue(sdk) !== null
}

function privCursorValue(pdata: { nextCursor?: unknown }): string | null {
  const v = (pdata as { nextCursor?: unknown }).nextCursor
  if (typeof v === "string" && v.length > 0) return v
  return null
}

function messageKeyOf(item: unknown): string | null {
  if (!isRecord(item)) return null
  const info = (item as Record<string, unknown>).info
  if (!isRecord(info)) return null
  const id = (info as Record<string, unknown>).id
  if (typeof id !== "string" || id.length === 0) return null
  const time = (info as Record<string, unknown>).time
  let created = ""
  if (isRecord(time) && typeof (time as Record<string, unknown>).created === "number")
    created = String((time as Record<string, unknown>).created)
  return `${id}:${created}`
}

function deepMessagesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepMessagesEqual(a[i], b[i])) return false
    return true
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false
      if (!deepMessagesEqual(a[k], (b as Record<string, unknown>)[k])) return false
    }
    return true
  }
  return false
}

// eslint-disable-next-line complexity
export function compareMessagesParity(
  priv: ServePrivateMessagesResult,
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
    const sdkItems = sdkMessagesOf(sdk)
    const pdata = (priv as Extract<ServePrivateMessagesResult, { status: "succeeded" }>).data
    const privItems = (pdata as { messages: unknown[] }).messages ?? []
    // Safe metadata only: counts and cursor presence. Full payloads were
    // compared in memory (keys below) but ids, cursors, and content never
    // leave this function.
    const sdkCount = sdkItems ? sdkItems.length : -1
    const privCount = Array.isArray(privItems) ? privItems.length : -1
    if (sdkItems === null) {
      return { divergence: `observation-divergence:sdk-shape`, details: { sdkCount, privCount } }
    }
    if (sdkCount !== privCount) {
      const sdkCursor = sdkCursorPresent(sdk)
      const privCursor = typeof (pdata as { nextCursor?: unknown }).nextCursor === "string"
      return { divergence: `observation-divergence:count-mismatch`, details: { sdkCount, privCount, sdkCursor, privCursor } }
    }
    // Exact-query identity: same query must yield the same ordered timeline.
    // Missing shared revision means concurrent streaming can shift
    // content/order/page/cursor; any such shift is warn-only observation
    // divergence, never a parity failure that alters behavior.
    const sdkKeys = sdkItems.map(messageKeyOf)
    const privKeys = (privItems as unknown[]).map(messageKeyOf)
    let orderMatch = sdkKeys.length === privKeys.length
    if (orderMatch) {
      for (let i = 0; i < sdkKeys.length; i++) {
        if (sdkKeys[i] === null || privKeys[i] === null || sdkKeys[i] !== privKeys[i]) {
          orderMatch = false
          break
        }
      }
    }
    if (!orderMatch) {
      const sdkCursor = sdkCursorPresent(sdk)
      const privCursor = typeof (pdata as { nextCursor?: unknown }).nextCursor === "string"
      return { divergence: `observation-divergence:order-mismatch`, details: { sdkCount, privCount, sdkCursor, privCursor } }
    }
    // Complete-payload comparison in memory: same ids/times/order can still
    // hide material content/parts divergence. Compared fully here; only a
    // fixed summary category leaves this function.
    if (!deepMessagesEqual(sdkItems, privItems)) {
      const sdkCursor = sdkCursorPresent(sdk)
      const privCursor = typeof (pdata as { nextCursor?: unknown }).nextCursor === "string"
      return { divergence: `observation-divergence:content-mismatch`, details: { sdkCount, privCount, sdkCursor, privCursor } }
    }
    const sdkVal = sdkCursorValue(sdk)
    const privVal = privCursorValue(pdata as { nextCursor?: unknown })
    const sdkCursor = sdkVal !== null
    const privCursor = privVal !== null
    if (sdkCursor !== privCursor) {
      return { divergence: `observation-divergence:cursor-mismatch`, details: { sdkCount, privCount, sdkCursor, privCursor } }
    }
    if (sdkCursor && privCursor && sdkVal !== privVal) {
      return { divergence: `observation-divergence:cursor-mismatch`, details: { sdkCount, privCount, sdkCursor, privCursor } }
    }
    return { divergence: null, details: { sdkCount, privCount, sdkCursor, privCursor } }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateMessagesResult, { status: "failed" }>).failure?.code ?? "unknown") as string
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
          divergence: `failure-class-mismatch`,
          details: { sdkClass: cls, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch`,
        details: { sdkCodePresent: true },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}
