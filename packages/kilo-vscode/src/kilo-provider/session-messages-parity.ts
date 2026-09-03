import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type {
  PrivateMessagesWireOutcome,
  ServePrivateMessagesRequest,
  ServePrivateMessagesResult,
} from "../services/cli-backend/serve-private-peer"
import { compareMessagesParity, isPrivateMessagesValidationError } from "../services/cli-backend/serve-private-peer"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only session/messages parity observer. The connection service itself
 * satisfies this interface; tests supply fakes.
 */
export interface MessagesParityConnection {
  isPrivateAvailable(): boolean
  privateMessagesWithHandle(req: ServePrivateMessagesRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean
  }
  privateMessages(req: ServePrivateMessagesRequest): Promise<unknown>
  privateMessagesOutcomeWithHandle?(req: ServePrivateMessagesRequest): {
    id: number
    promise: Promise<PrivateMessagesWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredMessagesObserver?(dir: string, sessionId: string, limit: number | undefined, before: string | undefined, listener: () => void): () => void
}

export interface MessagesParityQuery {
  limit?: number
  before?: string
}

export const SESSION_MESSAGES_PARITY_TIMEOUT_MS = 3000

function isValidMessagesQuery(query: MessagesParityQuery): boolean {
  const limit = query.limit
  const before = query.before
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0)) return false
  if (before !== undefined && (typeof before !== "string" || before.length === 0)) return false
  if (before !== undefined && limit === undefined) return false
  return true
}

export function buildSessionMessagesIdentity(sessionId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = `messages:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return { opId, idempotencyKey: opId, requestId }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function responseStatusOf(sdk: { response?: unknown }): number | null {
  const resp = (sdk as { response?: { status?: unknown } })?.response
  if (resp && typeof resp.status === "number" && Number.isInteger(resp.status)) return resp.status as number
  if (resp && typeof resp.status === "string") {
    const v = Number(resp.status)
    if (Number.isInteger(v)) return v
  }
  return null
}

const TERMINAL_HTTP = new Set([400, 404, 409, 500])

function errorHasTerminalClass(err: Record<string, unknown>): boolean | null {
  for (const c of [err.status, err.statusCode, err.code, err.httpStatus]) {
    if (typeof c === "number" && TERMINAL_HTTP.has(c)) return true
    if (typeof c === "string" && TERMINAL_HTTP.has(Number(c))) return true
  }
  if (typeof err.message === "string" && /\b(400|404|409|500)\b/.test(err.message)) return true
  const tag = typeof err._tag === "string" ? String(err._tag).toLowerCase() : ""
  if (tag.includes("badrequest") || tag.includes("notfound") || tag.includes("conflict") || tag.includes("internal"))
    return true
  if (typeof err.status === "undefined" && typeof err.code === "undefined" && typeof err._tag === "undefined") return false
  return null
}

function numericHttpStatus(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v < 600) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    if (Number.isInteger(n) && n >= 100 && n < 600) return n
  }
  return null
}

function thrownStatusFromRecord(rec: Record<string, unknown>): number | null {
  const cause = rec.cause as Record<string, unknown> | undefined
  if (cause && typeof cause === "object") {
    const s = numericHttpStatus((cause as Record<string, unknown>).status)
    if (s !== null) return s
  }
  const resp = rec.response as Record<string, unknown> | undefined
  if (resp && typeof resp === "object") {
    const s = numericHttpStatus((resp as Record<string, unknown>).status)
    if (s !== null) return s
  }
  const nested = rec.error as Record<string, unknown> | undefined
  if (nested && typeof nested === "object") {
    for (const c of [(nested as Record<string, unknown>).status, (nested as Record<string, unknown>).statusCode, (nested as Record<string, unknown>).code]) {
      const s = numericHttpStatus(c)
      if (s !== null) return s
    }
  }
  for (const c of [rec.status, rec.statusCode, rec.code, rec.httpStatus]) {
    const s = numericHttpStatus(c)
    if (s !== null) return s
  }
  return null
}

function thrownErrorHasTerminal(rec: Record<string, unknown>): boolean {
  const s = thrownStatusFromRecord(rec)
  return s !== null && TERMINAL_HTTP.has(s)
}

export function sdkMessagesHasTerminal(sdk: { data?: unknown; error?: unknown; response?: unknown } | Error | unknown): boolean {
  if (sdk instanceof Error) return thrownErrorHasTerminal(sdk as unknown as Record<string, unknown>)
  if (!sdk || typeof sdk !== "object") return false
  const rec = sdk as Record<string, unknown>
  const hasData = rec.data !== undefined
  const hasError = (rec as { error?: unknown }).error !== undefined
  const hasResponse = (rec as { response?: unknown }).response !== undefined
  if (!hasData && !hasError && !hasResponse) return thrownErrorHasTerminal(rec)
  const n = responseStatusOf(sdk as { response?: unknown })
  if (n !== null && Number.isInteger(n) && n >= 100 && n < 600) {
    if (TERMINAL_HTTP.has(n)) return true
    if ((sdk as { error?: unknown }).error) return false
    return hasData
  }
  if (!hasError) return hasData
  const gated = errorHasTerminalClass((sdk as { error?: unknown }).error as Record<string, unknown>)
  if (gated !== null) return gated
  return false
}

/**
 * Fallback dedupe for connections without keyed registration: pending
 * deferred keys per connection instance. Bounded by distinct
 * epoch+directory+session+query triples; no timers, no polling.
 */
const deferredMessagesKeysByConnection = new WeakMap<object, Set<string>>()

function deferredMessagesKey(epoch: number | null, dir: string, sessionId: string, limit: number | undefined, before: string | undefined): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const limitPart = limit === undefined ? "none" : String(limit)
  const beforePart = before === undefined ? "none" : `h-${crypto.createHash("sha256").update(before, "utf8").digest("hex")}`
  return `messages:${epoch ?? "none"}:${canonical}:${sessionId}:${limitPart}:${beforePart}`
}

function ambiguousMessagesResult(req: ServePrivateMessagesRequest): ServePrivateMessagesResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/messages",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as ServePrivateMessagesResult
}

function cancelObserverTimeout(
  connection: MessagesParityConnection,
  handle: { cancel?: (msg?: string) => boolean | "stale" } | null,
  exactId: number | null,
  _opId: string,
  _requestId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): void {
  const tryCancel = connection.tryCancelPrivatePending?.bind(connection) ?? null
  const invalidate = connection.invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
  let result: boolean | "stale" = false
  if (handle?.cancel) {
    try {
      result = handle.cancel("private parity timeout")
    } catch {
      console.warn("[Kilo Messages] handle.cancel failed:", { op: "session/messages", cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      console.warn("[Kilo Messages] tryCancelPrivatePending failed:", { op: "session/messages", cancelFailed: true })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo Messages] stale observer timeout skipped invalidation (epoch changed):`, { op: "session/messages", stale: true })
    return
  }
  if (result === true) {
    console.warn(`[Kilo Messages] private parity timeout after ${timeoutMs}ms:`, { op: "session/messages", timeoutMs })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo Messages] stale observer timeout skipped invalidation (epoch changed):`, { op: "session/messages", stale: true })
    return
  }
  if (invalidate) {
    try {
      invalidate("messages observer timeout")
    } catch {
      console.warn("[Kilo Messages] invalidatePrivatePeerOnObserverTimeout failed:", { op: "session/messages", invalidateFailed: true })
    }
  }
  console.warn(`[Kilo Messages] private parity timeout after ${timeoutMs}ms:`, { op: "session/messages", timeoutMs })
}

function reportMessagesValid(
  result: ServePrivateMessagesResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  _opId: string,
): void {
  const parity = compareMessagesParity(result, sdk)
  if (parity.divergence) console.warn("[Kilo Messages] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown)
    console.warn("[Kilo Messages] transport-unknown parity:", { op: "session/messages", transportUnknown: true })
}

function validationDivergence(_detail: string, _opId: string): void {
  console.warn("[Kilo Messages] validation divergence:", { op: "session/messages", invalid: true })
}

async function observeViaOutcome(
  connection: MessagesParityConnection,
  handle: { id: number; promise: Promise<PrivateMessagesWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: ServePrivateMessagesRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  opId: string,
  requestId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: PrivateMessagesWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isPrivateMessagesValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as PrivateMessagesWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, opId, requestId, timeoutMs, epochAtStart)
      return { kind: "valid", result: ambiguousMessagesResult(req) } as PrivateMessagesWireOutcome
    })
  } catch (e) {
    if (isPrivateMessagesValidationError(e)) {
      console.warn("[Kilo Messages] validation divergence:", { op: "session/messages", invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousMessagesResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    validationDivergence(outcome.detail, opId)
    return
  }
  reportMessagesValid(outcome.result, sdk, opId)
}

async function observeMessagesParity(
  connection: MessagesParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  sessionId: string,
  query: MessagesParityQuery,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferMessagesParityAfterNegotiation(connection, sdk, dir, sessionId, query, opId, idempotencyKey, requestId, timeoutMs)
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const payload: ServePrivateMessagesRequest["payload"] =
      query.limit === undefined && query.before === undefined
        ? {}
        : { ...(query.limit !== undefined ? { limit: query.limit } : {}), ...(query.before !== undefined ? { before: query.before } : {}) }
    const req: ServePrivateMessagesRequest = {
      v: 1,
      requestId,
      opId,
      op: "session/messages",
      idempotencyKey,
      context: { directory: dir, sessionId },
      payload,
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privateMessagesOutcomeWithHandle?.bind(connection) ?? null
      if (factory) {
        const handle = factory(req)
        await observeViaOutcome(connection, handle, req, sdk, opId, requestId, timeoutMs, epochAtStart)
        return
      }
    } catch (e) {
      if (isPrivateMessagesValidationError(e)) {
        console.warn("[Kilo Messages] validation divergence:", { op: "session/messages", invalid: true })
        return
      }
      throw e
    }
    await observeViaLegacy(connection, req, sdk, opId, requestId, timeoutMs, epochAtStart)
  } catch {
    console.warn("[Kilo Messages] private parity observation failed (fail-closed):", { op: "session/messages", observationFailed: true })
  }
}

async function observeViaLegacy(
  connection: MessagesParityConnection,
  req: ServePrivateMessagesRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  opId: string,
  requestId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  let privPromise: Promise<unknown>
  try {
    const h = connection.privateMessagesWithHandle(req)
    handle = h
    privPromise = h.promise
  } catch (e) {
    if (isPrivateMessagesValidationError(e)) {
      console.warn("[Kilo Messages] validation divergence:", { op: "session/messages", invalid: true })
      return
    }
    privPromise = Promise.reject(e)
  }
  const settled = await withTimeout(privPromise, timeoutMs)
    .catch((e: unknown) => {
      if (isPrivateMessagesValidationError(e)) return { __validationError: true }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle?.id ?? null, opId, requestId, timeoutMs, epochAtStart)
      return {
        v: 1,
        requestId,
        opId,
        op: "session/messages",
        idempotencyKey: opId,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      }
    })
    .catch((e: unknown) => {
      if (isPrivateMessagesValidationError(e)) return { __validationError: true }
      return {
        v: 1,
        requestId,
        opId,
        op: "session/messages",
        idempotencyKey: opId,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      }
    })
  const rec = (settled ?? {}) as Record<string, unknown>
  if (rec.__validationError === true) {
    console.warn("[Kilo Messages] validation divergence:", { op: "session/messages", invalid: true })
    return
  }
  reportMessagesValid(rec as unknown as ServePrivateMessagesResult, sdk, opId)
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches message state, events, or errors.
 * Different query combinations are different observations; the deferred key
 * binds the exact query so observations never compare across queries.
 */
function deferMessagesParityAfterNegotiation(
  connection: MessagesParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  sessionId: string,
  query: MessagesParityQuery,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeMessagesParity(connection, sdk, dir, sessionId, query, opId, idempotencyKey, requestId, timeoutMs).catch(() =>
      console.warn("[Kilo Messages] private parity observation failed (fail-closed):", { op: "session/messages", observationFailed: true }),
    )
  }
  // Owner-managed dedupe when available: the connection service owns the key
  // lifecycle and releases stale keys on failed/superseded negotiation,
  // reset, dispose, and invalidation, so a failed epoch never suppresses
  // current availability. No new peer lifecycle is created here.
  // Race closure: the availability check in observeMessagesParity and this
  // registration are not atomic, so recheck synchronously after registering;
  // when the peer became available in between, release the deferred entry
  // and observe immediately so the transition cannot drop the observer.
  const add = connection.addDeferredMessagesObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, sessionId, query.limit, query.before, observe)
    } catch {
      console.warn("[Kilo Messages] deferred parity subscribe failed (fail-closed):", { op: "session/messages", subscribeFailed: true })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        console.warn("[Kilo Messages] deferred parity unsubscribe failed (fail-closed):", { op: "session/messages", unsubscribeFailed: true })
      }
      observe()
    }
    return
  }
  deferMessagesFallback(connection, sdk, dir, sessionId, query, opId, idempotencyKey, requestId, timeoutMs, observe)
}

function deferMessagesFallback(
  connection: MessagesParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  sessionId: string,
  query: MessagesParityQuery,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
  observe: () => void,
): void {
  const epochAtDefer = connection.getPrivateEpoch?.() ?? null
  const key = deferredMessagesKey(epochAtDefer, dir, sessionId, query.limit, query.before)
  let keys = deferredMessagesKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredMessagesKeysByConnection.set(connection, keys)
  }
  const seen: Set<string> = keys
  if (seen.has(key)) return
  seen.add(key)
  const sub = connection.onPrivateAvailable?.bind(connection) ?? null
  if (!sub) {
    seen.delete(key)
    return
  }
  try {
    const unsub = sub(() => {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo Messages] deferred parity unsubscribe failed (fail-closed):", {
          op: "session/messages",
          unsubscribeFailed: true,
        })
      }
      fireDeferredMessages(connection, epochAtDefer, observe)
    })
    // Fallback race closure: availability may have completed between the
    // initial check and subscription; recheck synchronously and fire once.
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo Messages] deferred parity unsubscribe failed (fail-closed):", {
          op: "session/messages",
          unsubscribeFailed: true,
        })
      }
      fireDeferredMessages(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    console.warn("[Kilo Messages] deferred parity subscribe failed (fail-closed):", { op: "session/messages", subscribeFailed: true })
  }
}

function fireDeferredMessages(
  connection: MessagesParityConnection,
  epochAtDefer: number | null,
  observe: () => void,
): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (now !== epochAtDefer) {
    console.warn("[Kilo Messages] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchMessagesParity(
  connection: MessagesParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  sessionId: string,
  query: MessagesParityQuery,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeMessagesParity(connection, sdk, dir, sessionId, query, opId, idempotencyKey, requestId, timeoutMs)
    void pending.catch(() =>
      console.warn("[Kilo Messages] private parity observation failed (fail-closed):", { op: "session/messages", observationFailed: true }),
    )
  } catch {
    console.warn("[Kilo Messages] private parity observation failed (fail-closed):", { op: "session/messages", observationFailed: true })
  }
}

/**
 * Detached SDK-first `session/messages` parity observer.
 *
 * Call only after the SDK `session.messages` has settled with a terminal
 * result (data or terminal HTTP-class failure). The SDK result stays
 * authoritative: this never mutates message state, events, reconciliation,
 * recovery, stream ownership, retry/replay, cursor state, or UI state. It
 * returns synchronously (non-blocking); private work runs detached with the
 * default bounded timeout. Invalid private wire bypasses the comparator and
 * only logs a diagnostic. Content/order/page/cursor differences without a
 * shared revision are warn-only observation divergence, never parity failure.
 */
export function observeSessionMessagesParityDetached(
  connection: MessagesParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  sessionId: string,
  dir: string,
  query: MessagesParityQuery = {},
  timeoutMs = SESSION_MESSAGES_PARITY_TIMEOUT_MS,
): void {
  if (!sdkMessagesHasTerminal(sdk)) return
  if (typeof sessionId !== "string" || sessionId.length === 0) return
  if (typeof dir !== "string" || dir.length === 0) return
  if (!isValidMessagesQuery(query)) return
  const limit = query.limit
  const before = query.before
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildSessionMessagesIdentity(sessionId)
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch {
    console.warn("[Kilo Messages] private parity observation failed (fail-closed):", { op: "session/messages", observationFailed: true })
    return
  }
  launchMessagesParity(connection, sdk, dir, sessionId, { ...(limit !== undefined ? { limit } : {}), ...(before !== undefined ? { before } : {}) }, opId, idempotencyKey, requestId, timeoutMs)
}
