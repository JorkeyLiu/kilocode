import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type { KiloClient, SessionStatus } from "@kilocode/sdk/v2/client"
import type {
  PrivateStatusWireOutcome,
  ServePrivateStatusRequest,
  ServePrivateStatusResult,
} from "./services/cli-backend/serve-private-peer"
import {
  compareStatusParity,
  isPrivateStatusValidationError,
  normalizePrivateStatusWire,
} from "./services/cli-backend/serve-private-peer"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only status parity observer. The connection service itself satisfies
 * this interface; tests supply fakes.
 */
export interface StatusParityConnection {
  isPrivateAvailable(): boolean
  privateStatusWithHandle(req: ServePrivateStatusRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean
  }
  privateStatus(req: ServePrivateStatusRequest): Promise<unknown>
  privateStatusOutcomeWithHandle?(req: ServePrivateStatusRequest): {
    id: number
    promise: Promise<PrivateStatusWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredStatusObserver?(dir: string, listener: () => void): () => void
}

export interface StatusParityObserver {
  connection: StatusParityConnection
  timeoutMs?: number
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

/**
 * Fallback dedupe for connections without keyed registration: pending
 * deferred keys per connection instance. Entries are released when the
 * deferred observation fires (or subscribe fails); keyed connections release
 * theirs on notify/failure/reset instead. Bounded by distinct epoch+directory
 * pairs; no timers, no polling.
 */
const deferredStatusKeysByConnection = new WeakMap<object, Set<string>>()

function deferredStatusKey(epoch: number | null, dir: string): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  return `status:${epoch ?? "none"}:${canonical}`
}

/**
 * One-shot late observation: the first seed ran while the private peer was still
 * negotiating, so the observer skipped. Re-run exactly one read-only parity
 * observation when the current backend's negotiation completes. The SDK data
 * snapshot is already applied and stays authoritative — this never touches
 * the map, posts, or reconcile. No timers or polling: strictly the
 * connection-service private-availability lifecycle hook. If the hook is
 * absent (fakes, negotiation failure) the seed simply stays SDK-only.
 *
 * Dedupe: duplicate seeds for the same backend epoch + effective directory
 * share at most one deferred observation. Keyed connections own the dedupe;
 * other connections fall back to per-instance key tracking here.
 */
function launchStatusParity(
  connection: StatusParityConnection,
  sdkData: Record<string, SessionStatus>,
  dir: string,
  timeoutMs: number,
  deferred = false,
): void {
  try {
    const pending = observeStatusParity(connection, sdkData, dir, timeoutMs, deferred)
    void pending.catch((e) =>
      console.warn("[Kilo Status] private parity observation failed (fail-closed):", String(e).slice(0, 200)),
    )
  } catch (e) {
    console.warn("[Kilo Status] private parity observation failed (fail-closed):", String(e).slice(0, 200))
  }
}

function deferStatusParityAfterNegotiation(
  connection: StatusParityConnection,
  sdkData: Record<string, SessionStatus>,
  dir: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    launchStatusParity(connection, sdkData, dir, timeoutMs, true)
  }
  const add = connection.addDeferredStatusObserver?.bind(connection) ?? null
  if (add) {
    try {
      add(dir, observe)
    } catch (e) {
      console.warn("[Kilo Status] deferred parity subscribe failed (fail-closed):", String(e).slice(0, 200))
    }
    return
  }
  const epochAtDefer = connection.getPrivateEpoch?.() ?? null
  const key = deferredStatusKey(epochAtDefer, dir)
  let keys = deferredStatusKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredStatusKeysByConnection.set(connection, keys)
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
        console.warn("[Kilo Status] deferred parity unsubscribe failed (fail-closed):", String(err).slice(0, 200), {
          epoch: epochAtDefer,
        })
      }
      const now = connection.getPrivateEpoch?.() ?? null
      if (now !== epochAtDefer) {
        console.warn("[Kilo Status] stale deferred parity skipped (epoch changed)")
        return
      }
      observe()
    })
  } catch (e) {
    seen.delete(key)
    console.warn("[Kilo Status] deferred parity subscribe failed (fail-closed):", String(e).slice(0, 200))
  }
}

function ambiguousStatusResult(req: ServePrivateStatusRequest): ServePrivateStatusResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/status",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as ServePrivateStatusResult
}

function cancelObserverTimeout(
  connection: StatusParityConnection,
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
      console.warn("[Kilo Status] handle.cancel failed:", String(err).slice(0, 200), { opId })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, `private parity timeout opId=${opId}`)
    } catch (err) {
      console.warn("[Kilo Status] tryCancelPrivatePending failed:", String(err).slice(0, 200), { opId })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo Status] stale observer timeout skipped invalidation (epoch changed):`, { opId, requestId })
    return
  }
  if (result === true) {
    console.warn(`[Kilo Status] private parity timeout after ${timeoutMs}ms:`, { opId, requestId })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo Status] stale observer timeout skipped invalidation (epoch changed):`, { opId, requestId })
    return
  }
  if (invalidate) {
    try {
      invalidate(`status observer timeout opId=${opId}`)
    } catch (err) {
      console.warn("[Kilo Status] invalidatePrivatePeerOnObserverTimeout failed:", String(err).slice(0, 200), { opId })
    }
  }
  console.warn(`[Kilo Status] private parity timeout after ${timeoutMs}ms:`, { opId, requestId })
}

function reportStatusValid(
  result: ServePrivateStatusResult,
  sdkData: Record<string, SessionStatus>,
  opId: string,
): void {
  const parity = compareStatusParity(result, { data: sdkData } as unknown as never)
  if (parity.divergence) console.warn("[Kilo Status] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown)
    console.warn("[Kilo Status] transport-unknown parity:", opId)
}

function validationDivergence(detail: string, opId: string, diag?: string): void {
  console.warn("[Kilo Status] validation divergence:", `invalid private response shape: ${detail}`.slice(0, 200), {
    opId,
    ...(diag ? { _error: diag.slice(0, 200) } : {}),
  })
}

async function observeViaOutcome(
  connection: StatusParityConnection,
  handle: { id: number; promise: Promise<PrivateStatusWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: ServePrivateStatusRequest,
  sdkData: Record<string, SessionStatus>,
  opId: string,
  requestId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: PrivateStatusWireOutcome | null = null
  let diag: string | undefined
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isPrivateStatusValidationError(e)) {
        diag = String(e)
        return { kind: "invalid", detail: (e as { detail: string }).detail } as PrivateStatusWireOutcome
      }
      const msg = String(e)
      if (msg.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, opId, requestId, timeoutMs, epochAtStart)
      else diag = msg
      return { kind: "valid", result: ambiguousStatusResult(req) } as PrivateStatusWireOutcome
    })
  } catch (e) {
    if (isPrivateStatusValidationError(e)) {
      console.warn("[Kilo Status] validation divergence:", String(e).slice(0, 200), { opId })
      return
    }
    diag = String(e)
    outcome = { kind: "valid", result: ambiguousStatusResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    validationDivergence(outcome.detail, opId, diag)
    return
  }
  reportStatusValid(outcome.result, sdkData, opId)
}

async function observeViaLegacy(
  connection: StatusParityConnection,
  req: ServePrivateStatusRequest,
  sdkData: Record<string, SessionStatus>,
  opId: string,
  requestId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  let privPromise: Promise<unknown>
  try {
    const h = connection.privateStatusWithHandle(req)
    handle = h
    privPromise = h.promise
  } catch (e) {
    if (isPrivateStatusValidationError(e)) {
      console.warn("[Kilo Status] validation divergence:", String(e).slice(0, 200), { opId })
      return
    }
    privPromise = Promise.reject(e)
  }
  const settled = await withTimeout(privPromise, timeoutMs)
    .catch((e: unknown) => {
      if (isPrivateStatusValidationError(e)) return { __validationError: String(e) }
      const msg = String(e)
      if (msg.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle?.id ?? null, opId, requestId, timeoutMs, epochAtStart)
      return {
        v: 1,
        requestId,
        opId,
        op: "session/status",
        idempotencyKey: opId,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
        _error: msg,
      }
    })
    .catch((e: unknown) => {
      if (isPrivateStatusValidationError(e)) return { __validationError: String(e) }
      return {
        v: 1,
        requestId,
        opId,
        op: "session/status",
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
    console.warn("[Kilo Status] validation divergence:", String(rec.__validationError).slice(0, 200), { opId })
    return
  }
  if (rec.kind === "invalid" && typeof rec.detail === "string") {
    validationDivergence(String(rec.detail).slice(0, 200), opId)
    return
  }
  if (rec.kind === "valid" && rec.result !== undefined) {
    const inner = normalizePrivateStatusWire(rec.result, req)
    if (inner.kind === "invalid") {
      validationDivergence(inner.detail, opId)
      return
    }
    reportStatusValid(inner.result, sdkData, opId)
    return
  }
  const diag = typeof rec._error === "string" ? (rec._error as string) : undefined
  const clean: Record<string, unknown> = { ...rec }
  delete clean._error
  const normalized = normalizePrivateStatusWire(clean, req)
  if (normalized.kind === "invalid") {
    validationDivergence(normalized.detail, opId, diag)
    return
  }
  reportStatusValid(normalized.result, sdkData, opId)
}

async function observeStatusParity(
  connection: StatusParityConnection,
  sdkData: Record<string, SessionStatus>,
  dir: string,
  timeoutMs: number,
  deferred = false,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    if (!deferred) deferStatusParityAfterNegotiation(connection, sdkData, dir, timeoutMs)
    return
  }
  if (!isAbsolute(dir)) return
  try {
    // Synchronous handle allocation first: exact timeout-cancel ownership and
    // the non-blocking seed guarantee depend on requestWithId running before
    // the first await.
    const token = crypto.randomUUID()
    const opId = `status:${token}`
    const requestId = crypto.randomUUID()
    const req: ServePrivateStatusRequest = {
      v: 1,
      requestId,
      opId,
      op: "session/status",
      idempotencyKey: opId,
      context: { directory: dir },
      payload: {},
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privateStatusOutcomeWithHandle?.bind(connection) ?? null
      if (factory) {
        const handle = factory(req)
        await observeViaOutcome(connection, handle, req, sdkData, opId, requestId, timeoutMs, epochAtStart)
        return
      }
    } catch (e) {
      if (isPrivateStatusValidationError(e)) {
        console.warn("[Kilo Status] validation divergence:", String(e).slice(0, 200), { opId })
        return
      }
      throw e
    }
    await observeViaLegacy(connection, req, sdkData, opId, requestId, timeoutMs, epochAtStart)
  } catch (e) {
    console.warn("[Kilo Status] private parity observation failed (fail-closed):", String(e).slice(0, 200))
  }
}

/**
 * Fetch all current session statuses and seed the provided map + webview.
 * Called on connect so the Settings panel knows about already-running sessions
 * without waiting for the next session.status SSE event.
 *
 * When `reconcile` is true (default: first seed), locally-busy sessions absent
 * from the server response are reset to idle — covering server crash/restart.
 * On SSE reconnects set `reconcile: false` to avoid a race where the HTTP
 * fetch briefly returns stale data and the spinner disappears mid-stream.
 *
 * When `observer` is provided and the private carrier is available, a
 * read-only private `session/status` call runs after the SDK result is fully
 * applied and is compared via `compareStatusParity` for observation only.
 * The SDK result is always authoritative: the private result never modifies
 * the map, never posts messages, and never changes reconcile semantics.
 */
export async function seedSessionStatuses(
  client: KiloClient,
  dir: string,
  map: Map<string, SessionStatus["type"]>,
  post: (msg: unknown) => void,
  reconcile = true,
  observer?: StatusParityObserver,
): Promise<void> {
  let sdkData: Record<string, SessionStatus> | null = null
  try {
    const result = await client.session.status({ directory: dir })
    if (!result.data) return
    const active = result.data
    sdkData = active as unknown as Record<string, SessionStatus>

    // Seed/update entries the server knows about
    for (const [sid, info] of Object.entries(active) as [string, SessionStatus][]) {
      map.set(sid, info.type)
      post({
        type: "sessionStatus",
        sessionID: sid,
        status: info.type,
        ...(info.type === "retry" ? { attempt: info.attempt, message: info.message, next: info.next } : {}),
      })
    }

    // Reconcile: any locally non-idle session absent from the server response
    // means the server lost its in-memory state (crash/restart). Reset to idle.
    // Skipped on SSE reconnects — the real-time SSE events are authoritative
    // for status transitions and the brief HTTP fetch can race with them.
    if (reconcile) {
      for (const [sid, status] of map) {
        if (status !== "idle" && !active[sid]) {
          map.set(sid, "idle")
          post({ type: "sessionStatus", sessionID: sid, status: "idle" })
        }
      }
    }
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to seed session statuses:", error)
  }
  if (sdkData && observer) {
    const timeoutMs = observer.timeoutMs ?? 3000
    launchStatusParity(observer.connection, sdkData, dir, timeoutMs)
  }
}
