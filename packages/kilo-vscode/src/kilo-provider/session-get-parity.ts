import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type {
  PrivateGetWireOutcome,
  ServePrivateGetRequest,
  ServePrivateGetResult,
} from "../services/cli-backend/serve-private-peer"
import { compareGetParity, isPrivateGetValidationError } from "../services/cli-backend/serve-private-peer"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only session/get parity observer. The connection service itself
 * satisfies this interface; tests supply fakes.
 */
export interface GetParityConnection {
  isPrivateAvailable(): boolean
  privateGetWithHandle(req: ServePrivateGetRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean
  }
  privateGet(req: ServePrivateGetRequest): Promise<unknown>
  privateGetOutcomeWithHandle?(req: ServePrivateGetRequest): {
    id: number
    promise: Promise<PrivateGetWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredGetObserver?(dir: string, sessionId: string, listener: () => void): () => void
}

export const SESSION_GET_PARITY_TIMEOUT_MS = 3000

export function buildSessionGetIdentity(sessionId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = `get:${sessionId}:${token}`
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

export function sdkGetHasTerminal(sdk: { data?: unknown; error?: unknown; response?: unknown }): boolean {
  const n = responseStatusOf(sdk)
  if (n !== null && Number.isInteger(n) && n >= 100 && n < 600) {
    if (TERMINAL_HTTP.has(n)) return true
    if (sdk.error) return false
    return true
  }
  if (!sdk.error) return true
  const gated = errorHasTerminalClass(sdk.error as Record<string, unknown>)
  if (gated !== null) return gated
  return false
}

/**
 * Fallback dedupe for connections without keyed registration: pending
 * deferred keys per connection instance. Bounded by distinct
 * epoch+directory+session triples; no timers, no polling.
 */
const deferredGetKeysByConnection = new WeakMap<object, Set<string>>()

function deferredGetKey(epoch: number | null, dir: string, sessionId: string): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  return `get:${epoch ?? "none"}:${canonical}:${sessionId}`
}

function ambiguousGetResult(req: ServePrivateGetRequest): ServePrivateGetResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/get",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as ServePrivateGetResult
}

function cancelObserverTimeout(
  connection: GetParityConnection,
  handle: { cancel?: (msg?: string) => boolean | "stale" } | null,
  exactId: number | null,
  opId: string,
  requestId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): void {
  const tryCancel = connection.tryCancelPrivatePending?.bind(connection) ?? null
  const invalidate = connection.invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
  let result: boolean | "stale" = false
  if (handle?.cancel) {
    try {
      result = handle.cancel(`private parity timeout opId=${opId}`)
    } catch (err) {
      console.warn("[Kilo Get] handle.cancel failed:", String(err).slice(0, 200), { opId })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, `private parity timeout opId=${opId}`)
    } catch (err) {
      console.warn("[Kilo Get] tryCancelPrivatePending failed:", String(err).slice(0, 200), { opId })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo Get] stale observer timeout skipped invalidation (epoch changed):`, { opId, requestId })
    return
  }
  if (result === true) {
    console.warn(`[Kilo Get] private parity timeout after ${timeoutMs}ms:`, { opId, requestId })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo Get] stale observer timeout skipped invalidation (epoch changed):`, { opId, requestId })
    return
  }
  if (invalidate) {
    try {
      invalidate(`get observer timeout opId=${opId}`)
    } catch (err) {
      console.warn("[Kilo Get] invalidatePrivatePeerOnObserverTimeout failed:", String(err).slice(0, 200), { opId })
    }
  }
  console.warn(`[Kilo Get] private parity timeout after ${timeoutMs}ms:`, { opId, requestId })
}

function reportGetValid(
  result: ServePrivateGetResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  opId: string,
): void {
  const parity = compareGetParity(result, sdk)
  if (parity.divergence) console.warn("[Kilo Get] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown) console.warn("[Kilo Get] transport-unknown parity:", opId)
}

function validationDivergence(detail: string, opId: string, diag?: string): void {
  console.warn("[Kilo Get] validation divergence:", `invalid private response shape: ${detail}`.slice(0, 200), {
    opId,
    ...(diag ? { _error: diag.slice(0, 200) } : {}),
  })
}

async function observeViaOutcome(
  connection: GetParityConnection,
  handle: { id: number; promise: Promise<PrivateGetWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: ServePrivateGetRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  opId: string,
  requestId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: PrivateGetWireOutcome | null = null
  let diag: string | undefined
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isPrivateGetValidationError(e)) {
        diag = String(e)
        return { kind: "invalid", detail: (e as { detail: string }).detail } as PrivateGetWireOutcome
      }
      const msg = String(e)
      if (msg.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, opId, requestId, timeoutMs, epochAtStart)
      else diag = msg
      return { kind: "valid", result: ambiguousGetResult(req) } as PrivateGetWireOutcome
    })
  } catch (e) {
    if (isPrivateGetValidationError(e)) {
      console.warn("[Kilo Get] validation divergence:", String(e).slice(0, 200), { opId })
      return
    }
    diag = String(e)
    outcome = { kind: "valid", result: ambiguousGetResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    validationDivergence(outcome.detail, opId, diag)
    return
  }
  reportGetValid(outcome.result, sdk, opId)
}

async function observeStatusParity(
  connection: GetParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  sessionId: string,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferGetParityAfterNegotiation(connection, sdk, dir, sessionId, opId, idempotencyKey, requestId, timeoutMs)
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const req: ServePrivateGetRequest = {
      v: 1,
      requestId,
      opId,
      op: "session/get",
      idempotencyKey,
      context: { directory: dir, sessionId },
      payload: {},
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privateGetOutcomeWithHandle?.bind(connection) ?? null
      if (factory) {
        const handle = factory(req)
        await observeViaOutcome(connection, handle, req, sdk, opId, requestId, timeoutMs, epochAtStart)
        return
      }
    } catch (e) {
      if (isPrivateGetValidationError(e)) {
        console.warn("[Kilo Get] validation divergence:", String(e).slice(0, 200), { opId })
        return
      }
      throw e
    }
    await observeViaLegacy(connection, req, sdk, opId, requestId, timeoutMs, epochAtStart)
  } catch (e) {
    console.warn("[Kilo Get] private parity observation failed (fail-closed):", String(e).slice(0, 200))
  }
}

async function observeViaLegacy(
  connection: GetParityConnection,
  req: ServePrivateGetRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  opId: string,
  requestId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  let privPromise: Promise<unknown>
  try {
    const h = connection.privateGetWithHandle(req)
    handle = h
    privPromise = h.promise
  } catch (e) {
    if (isPrivateGetValidationError(e)) {
      console.warn("[Kilo Get] validation divergence:", String(e).slice(0, 200), { opId })
      return
    }
    privPromise = Promise.reject(e)
  }
  const settled = await withTimeout(privPromise, timeoutMs)
    .catch((e: unknown) => {
      if (isPrivateGetValidationError(e)) return { __validationError: String(e) }
      const msg = String(e)
      if (msg.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle?.id ?? null, opId, requestId, timeoutMs, epochAtStart)
      return {
        v: 1,
        requestId,
        opId,
        op: "session/get",
        idempotencyKey: opId,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
        _error: msg,
      }
    })
    .catch((e: unknown) => {
      if (isPrivateGetValidationError(e)) return { __validationError: String(e) }
      return {
        v: 1,
        requestId,
        opId,
        op: "session/get",
        idempotencyKey: opId,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
        _error: String(e),
      }
    })
  const rec = (settled ?? {}) as Record<string, unknown>
  if (typeof rec.__validationError === "string") {
    console.warn("[Kilo Get] validation divergence:", String(rec.__validationError).slice(0, 200), { opId })
    return
  }
  reportGetValid(rec as unknown as ServePrivateGetResult, sdk, opId)
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches session state, events, or errors.
 */
function deferGetParityAfterNegotiation(
  connection: GetParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  sessionId: string,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeStatusParity(connection, sdk, dir, sessionId, opId, idempotencyKey, requestId, timeoutMs).catch((e) =>
      console.warn("[Kilo Get] private parity observation failed (fail-closed):", String(e).slice(0, 200)),
    )
  }
  // Owner-managed dedupe when available: the connection service owns the key
  // lifecycle and releases stale keys on failed/superseded negotiation,
  // reset, dispose, and invalidation, so a failed epoch never suppresses
  // current availability. No new peer lifecycle is created here.
  const add = connection.addDeferredGetObserver?.bind(connection) ?? null
  if (add) {
    try {
      add(dir, sessionId, observe)
    } catch (e) {
      console.warn("[Kilo Get] deferred parity subscribe failed (fail-closed):", String(e).slice(0, 200))
    }
    return
  }
  const epochAtDefer = connection.getPrivateEpoch?.() ?? null
  const key = deferredGetKey(epochAtDefer, dir, sessionId)
  let keys = deferredGetKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredGetKeysByConnection.set(connection, keys)
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
      } catch (err) {
        console.warn("[Kilo Get] deferred parity unsubscribe failed (fail-closed):", String(err).slice(0, 200), {
          epoch: epochAtDefer,
        })
      }
      const now = connection.getPrivateEpoch?.() ?? null
      if (now !== epochAtDefer) {
        console.warn("[Kilo Get] stale deferred parity skipped (epoch changed)")
        return
      }
      observe()
    })
  } catch (e) {
    seen.delete(key)
    console.warn("[Kilo Get] deferred parity subscribe failed (fail-closed):", String(e).slice(0, 200))
  }
}

function launchGetParity(
  connection: GetParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  sessionId: string,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeStatusParity(connection, sdk, dir, sessionId, opId, idempotencyKey, requestId, timeoutMs)
    void pending.catch((e) =>
      console.warn("[Kilo Get] private parity observation failed (fail-closed):", String(e).slice(0, 200)),
    )
  } catch (e) {
    console.warn("[Kilo Get] private parity observation failed (fail-closed):", String(e).slice(0, 200))
  }
}

/**
 * Detached SDK-first `session/get` parity observer.
 *
 * Call only after the SDK `session.get` has settled with a terminal result
 * (data or terminal HTTP-class failure). The SDK result stays authoritative:
 * this never mutates session state, events, reconcile, refresh revisions, or
 * SDK errors. It returns synchronously (non-blocking); private work runs
 * detached with the default bounded timeout. Invalid private wire bypasses
 * the comparator and only logs a diagnostic.
 */
export function observeSessionGetParityDetached(
  connection: GetParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  sessionId: string,
  dir: string,
  timeoutMs = SESSION_GET_PARITY_TIMEOUT_MS,
): void {
  if (!sdkGetHasTerminal(sdk)) return
  if (typeof sessionId !== "string" || sessionId.length === 0) return
  if (typeof dir !== "string" || dir.length === 0) return
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildSessionGetIdentity(sessionId)
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch (e) {
    console.warn("[Kilo Get] private parity observation failed (fail-closed):", String(e).slice(0, 200))
    return
  }
  launchGetParity(connection, sdk, dir, sessionId, opId, idempotencyKey, requestId, timeoutMs)
}
