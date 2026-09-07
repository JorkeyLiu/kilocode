import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type {
  PrivateChildrenWireOutcome,
  ServePrivateChildrenRequest,
  ServePrivateChildrenResult,
} from "../services/cli-backend/serve-private-peer"
import { compareChildrenParity, isPrivateChildrenValidationError } from "../services/cli-backend/serve-private-peer"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only session/children parity observer. The connection service itself
 * satisfies this interface; tests supply fakes.
 */
export interface ChildrenParityConnection {
  isPrivateAvailable(): boolean
  privateChildrenOutcomeWithHandle(req: ServePrivateChildrenRequest): {
    id: number
    promise: Promise<PrivateChildrenWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredChildrenObserver?(dir: string, parentSessionId: string, listener: () => void): () => void
}

export const SESSION_CHILDREN_PARITY_TIMEOUT_MS = 3000

export function buildSessionChildrenIdentity(parentSessionId: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = `children:${parentSessionId}:${token}`
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
  if (typeof err.status === "undefined" && typeof err.code === "undefined" && typeof err._tag === "undefined")
    return false
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
    for (const c of [
      (nested as Record<string, unknown>).status,
      (nested as Record<string, unknown>).statusCode,
      (nested as Record<string, unknown>).code,
    ]) {
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

export function sdkChildrenHasTerminal(
  sdk: { data?: unknown; error?: unknown; response?: unknown } | Error | unknown,
): boolean {
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
 * epoch+directory+parent triples; no timers, no polling. The stored epoch
 * is the existing owner `getPrivateEpoch()` snapshot: when the lifecycle
 * resets, fails, or disposes, the next registration observes a different
 * epoch (including null) and purges stale keys so a prior epoch never
 * suppresses renewal. No new persistent subsystem, no replay.
 */
const deferredChildrenKeysByConnection = new WeakMap<
  object,
  { epoch: number | null; keys: Set<string>; unsubs: Map<string, () => void> }
>()

/**
 * Bounded per-connection counters for detached `session/children` parity.
 * Fixed categories only — no arrays, no timers, no cross-process state.
 * Keyed by connection instance so entries end with the instance lifecycle
 * via `WeakMap`; `resetSessionChildrenParityDiagnostics` clears one entry.
 * Counters are write-only: production paths only `tally` next to the
 * existing `warn` and never read diagnostics to change behavior.
 *
 * `comparedNoDivergence` is comparator-scoped only: the children comparator
 * returned `divergence: null` for the fields it compares
 * (`id`/`parentID`/canonical `directory`/`title` plus in-memory full-payload
 * equality). It is not a full-parity/health claim — concurrent
 * create/fork/list shifts stay warn-only observation divergence and
 * transport/validation/timeout/stale outcomes remain separately counted.
 */
export type SessionChildrenParityDiagnostics = {
  readonly comparedNoDivergence: number
  readonly divergence: number
  readonly transportUnknown: number
  readonly validationDivergence: number
  readonly timeout: number
  readonly staleSkipped: number
  readonly failClosed: number
}

type ParityTally = {
  comparedNoDivergence: number
  divergence: number
  transportUnknown: number
  validationDivergence: number
  timeout: number
  staleSkipped: number
  failClosed: number
}

const parityDiagnosticsByConnection = new WeakMap<object, ParityTally>()

function tally(connection: ChildrenParityConnection, key: keyof ParityTally): void {
  if ((typeof connection !== "object" && typeof connection !== "function") || connection === null) return
  let cur = parityDiagnosticsByConnection.get(connection)
  if (!cur) {
    cur = { comparedNoDivergence: 0, divergence: 0, transportUnknown: 0, validationDivergence: 0, timeout: 0, staleSkipped: 0, failClosed: 0 }
    parityDiagnosticsByConnection.set(connection, cur)
  }
  cur[key] += 1
}

/**
 * Snapshot copy of the fixed-category parity counters for one connection.
 * Returns zeros when nothing was observed. The copy is frozen so callers
 * cannot mutate stored state; reading never affects parity behavior.
 * `comparedNoDivergence` counts only comparator `divergence: null` outcomes
 * and does not claim full parity/health.
 */
export function getSessionChildrenParityDiagnostics(
  connection: ChildrenParityConnection,
): SessionChildrenParityDiagnostics {
  const cur = parityDiagnosticsByConnection.get(connection as object)
  return Object.freeze({
    comparedNoDivergence: cur?.comparedNoDivergence ?? 0,
    divergence: cur?.divergence ?? 0,
    transportUnknown: cur?.transportUnknown ?? 0,
    validationDivergence: cur?.validationDivergence ?? 0,
    timeout: cur?.timeout ?? 0,
    staleSkipped: cur?.staleSkipped ?? 0,
    failClosed: cur?.failClosed ?? 0,
  })
}

/** Clears the stored counters for one connection. Instance GC clears the rest. */
export function resetSessionChildrenParityDiagnostics(connection: ChildrenParityConnection): void {
  parityDiagnosticsByConnection.delete(connection as object)
}

function deferredChildrenKey(epoch: number | null, dir: string, parentSessionId: string): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const parentHash = crypto.createHash("sha256").update(parentSessionId, "utf8").digest("hex")
  return `children:${epoch ?? "none"}:${canonical}:h-${parentHash}`
}

function ambiguousChildrenResult(req: ServePrivateChildrenRequest): ServePrivateChildrenResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/children",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as ServePrivateChildrenResult
}

function cancelObserverTimeout(
  connection: ChildrenParityConnection,
  handle: { cancel?: (msg?: string) => boolean | "stale" } | null,
  exactId: number | null,
  epochAtStart: number | null,
): void {
  const tryCancel = connection.tryCancelPrivatePending?.bind(connection) ?? null
  const invalidate = connection.invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
  let result: boolean | "stale" = false
  if (handle?.cancel) {
    try {
      result = handle.cancel("private parity timeout")
    } catch {
      tally(connection, "failClosed")
      console.warn("[Kilo Children] handle.cancel failed:", { op: "session/children", cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      tally(connection, "failClosed")
      console.warn("[Kilo Children] tryCancelPrivatePending failed:", { op: "session/children", cancelFailed: true })
      result = false
    }
  }
  if (result === "stale") {
    tally(connection, "staleSkipped")
    console.warn(`[Kilo Children] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "session/children",
      stale: true,
    })
    return
  }
  if (result === true) {
    tally(connection, "timeout")
    console.warn(`[Kilo Children] private parity timeout:`, { op: "session/children", timeout: true })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    tally(connection, "staleSkipped")
    console.warn(`[Kilo Children] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "session/children",
      stale: true,
    })
    return
  }
  if (invalidate) {
    try {
      invalidate("children observer timeout")
    } catch {
      tally(connection, "failClosed")
      console.warn("[Kilo Children] invalidatePrivatePeerOnObserverTimeout failed:", {
        op: "session/children",
        invalidateFailed: true,
      })
    }
  }
  tally(connection, "timeout")
  console.warn(`[Kilo Children] private parity timeout:`, { op: "session/children", timeout: true })
}

function reportChildrenValid(
  connection: ChildrenParityConnection,
  result: ServePrivateChildrenResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  parentSessionId: string,
): void {
  const parity = compareChildrenParity(result, sdk, parentSessionId)
  if (parity.divergence) {
    if (parity.divergence === "transport-unknown") tally(connection, "transportUnknown")
    else tally(connection, "divergence")
    console.warn("[Kilo Children] parity divergence:", parity.divergence, parity.details)
    return
  }
  if ((result as Record<string, unknown>).transportUnknown) {
    tally(connection, "transportUnknown")
    console.warn("[Kilo Children] transport-unknown parity:", { op: "session/children", transportUnknown: true })
    return
  }
  tally(connection, "comparedNoDivergence")
}

function validationDivergence(connection: ChildrenParityConnection): void {
  tally(connection, "validationDivergence")
  console.warn("[Kilo Children] validation divergence:", { op: "session/children", invalid: true })
}

async function observeViaOutcome(
  connection: ChildrenParityConnection,
  handle: { id: number; promise: Promise<PrivateChildrenWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: ServePrivateChildrenRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  parentSessionId: string,
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: PrivateChildrenWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isPrivateChildrenValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as PrivateChildrenWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, epochAtStart)
      return { kind: "valid", result: ambiguousChildrenResult(req) } as PrivateChildrenWireOutcome
    })
  } catch (e) {
    if (isPrivateChildrenValidationError(e)) {
      tally(connection, "validationDivergence")
      console.warn("[Kilo Children] validation divergence:", { op: "session/children", invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousChildrenResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    validationDivergence(connection)
    return
  }
  reportChildrenValid(connection, outcome.result, sdk, parentSessionId)
}

async function observeChildrenParity(
  connection: ChildrenParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  parentSessionId: string,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferChildrenParityAfterNegotiation(
      connection,
      sdk,
      dir,
      parentSessionId,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const req: ServePrivateChildrenRequest = {
      v: 1,
      requestId,
      opId,
      op: "session/children",
      idempotencyKey,
      context: { directory: dir, parentSessionId },
      payload: {},
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    const handle = connection.privateChildrenOutcomeWithHandle(req)
    await observeViaOutcome(connection, handle, req, sdk, parentSessionId, timeoutMs, epochAtStart)
  } catch {
    tally(connection, "failClosed")
    console.warn("[Kilo Children] private parity observation failed (fail-closed):", {
      op: "session/children",
      observationFailed: true,
    })
  }
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches session state, events, or errors.
 */
function deferChildrenParityAfterNegotiation(
  connection: ChildrenParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  parentSessionId: string,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeChildrenParity(connection, sdk, dir, parentSessionId, opId, idempotencyKey, requestId, timeoutMs).catch(
      () => {
        tally(connection, "failClosed")
        console.warn("[Kilo Children] private parity observation failed (fail-closed):", {
          op: "session/children",
          observationFailed: true,
        })
      },
    )
  }
  // Owner-managed dedupe when available: the connection service owns the key
  // lifecycle and releases stale keys on failed/superseded negotiation,
  // reset, dispose, and invalidation, so a failed epoch never suppresses
  // current availability. No new peer lifecycle is created here.
  // Race closure: the availability check in observeChildrenParity and this
  // registration are not atomic, so recheck synchronously after registering;
  // when the peer became available in between, release the deferred entry
  // and observe immediately so the transition cannot drop the observer.
  const add = connection.addDeferredChildrenObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, parentSessionId, observe)
    } catch {
      tally(connection, "failClosed")
      console.warn("[Kilo Children] deferred parity subscribe failed (fail-closed):", {
        op: "session/children",
        subscribeFailed: true,
      })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        tally(connection, "failClosed")
        console.warn("[Kilo Children] deferred parity unsubscribe failed (fail-closed):", {
          op: "session/children",
          unsubscribeFailed: true,
        })
      }
      observe()
    }
    return
  }
  deferChildrenFallback(connection, dir, parentSessionId, observe)
}

function deferChildrenFallback(
  connection: ChildrenParityConnection,
  dir: string,
  parentSessionId: string,
  observe: () => void,
): void {
  const epochAtDefer = connection.getPrivateEpoch?.() ?? null
  const key = deferredChildrenKey(epochAtDefer, dir, parentSessionId)
  let entry = deferredChildrenKeysByConnection.get(connection)
  if (!entry) {
    entry = { epoch: epochAtDefer, keys: new Set<string>(), unsubs: new Map<string, () => void>() }
    deferredChildrenKeysByConnection.set(connection, entry)
  }
  // Lifecycle-safe purge: a reset/failure/dispose moves the owner epoch
  // (including to null), so stale keys from a prior epoch must not dedupe
  // renewal for the current epoch. Uses only the existing owner
  // `getPrivateEpoch()` snapshot; no new subsystem, no replay.
  if (entry.epoch !== epochAtDefer) {
    for (const [, oldUnsub] of [...entry.unsubs]) {
      try {
        oldUnsub()
      } catch {
        tally(connection, "failClosed")
        console.warn("[Kilo Children] deferred parity unsubscribe failed (fail-closed):", {
          op: "session/children",
          unsubscribeFailed: true,
        })
      }
    }
    entry.keys.clear()
    entry.unsubs.clear()
    entry.epoch = epochAtDefer
  }
  const seen: Set<string> = entry.keys
  // Same-epoch replacement: the owner may have cleared availability
  // listeners on failure/reset/dispose without notifying this fallback, so a
  // retained key must never permanently suppress re-registration. Replace the
  // stale subscription (at most one pending per key) instead of dropping the
  // later valid observation.
  if (seen.has(key)) {
    const oldUnsub = entry.unsubs.get(key)
    if (oldUnsub) {
      try {
        oldUnsub()
      } catch {
        tally(connection, "failClosed")
        console.warn("[Kilo Children] deferred parity unsubscribe failed (fail-closed):", {
          op: "session/children",
          unsubscribeFailed: true,
        })
      }
    }
    seen.delete(key)
    entry.unsubs.delete(key)
  }
  seen.add(key)
  const sub = connection.onPrivateAvailable?.bind(connection) ?? null
  if (!sub) {
    seen.delete(key)
    entry.unsubs.delete(key)
    return
  }
  try {
    const unsub = sub(() => {
      seen.delete(key)
      entry.unsubs.delete(key)
      try {
        unsub()
      } catch {
        tally(connection, "failClosed")
        console.warn("[Kilo Children] deferred parity unsubscribe failed (fail-closed):", {
          op: "session/children",
          unsubscribeFailed: true,
        })
      }
      fireDeferredChildren(connection, epochAtDefer, observe)
    })
    entry.unsubs.set(key, unsub)
    // Fallback race closure: availability may have completed between the
    // initial check and subscription; recheck synchronously and fire once.
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      entry.unsubs.delete(key)
      try {
        unsub()
      } catch {
        tally(connection, "failClosed")
        console.warn("[Kilo Children] deferred parity unsubscribe failed (fail-closed):", {
          op: "session/children",
          unsubscribeFailed: true,
        })
      }
      fireDeferredChildren(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    entry.unsubs.delete(key)
    tally(connection, "failClosed")
    console.warn("[Kilo Children] deferred parity subscribe failed (fail-closed):", {
      op: "session/children",
      subscribeFailed: true,
    })
  }
}

function fireDeferredChildren(
  connection: ChildrenParityConnection,
  epochAtDefer: number | null,
  observe: () => void,
): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (now !== epochAtDefer) {
    tally(connection, "staleSkipped")
    console.warn("[Kilo Children] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchChildrenParity(
  connection: ChildrenParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  parentSessionId: string,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeChildrenParity(
      connection,
      sdk,
      dir,
      parentSessionId,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
    void pending.catch(() => {
      tally(connection, "failClosed")
      console.warn("[Kilo Children] private parity observation failed (fail-closed):", {
        op: "session/children",
        observationFailed: true,
      })
    })
  } catch {
    tally(connection, "failClosed")
    console.warn("[Kilo Children] private parity observation failed (fail-closed):", {
      op: "session/children",
      observationFailed: true,
    })
  }
}

/**
 * Detached SDK-first `session/children` parity observer.
 *
 * Call only after the SDK `session.children` has settled with a terminal
 * result (data or terminal HTTP-class failure). The SDK result stays
 * authoritative: this never mutates child/session maps, fixtures,
 * sync/recovery/eviction/events/UI state, and never retries/replays the SDK.
 * It returns synchronously (non-blocking); private work runs detached with
 * the default bounded timeout. Invalid private wire bypasses the comparator
 * and only logs a diagnostic. Membership/content differences without a shared
 * revision are warn-only observation divergence, never parity failure.
 *
 * Each terminal outcome also increments one bounded per-connection counter
 * (`getSessionChildrenParityDiagnostics`); counters are warn-adjacent only and
 * never influence SDK authority, timing, or control flow. The no-divergence
 * counter is comparator-scoped (`comparedNoDivergence`): it records only
 * comparator `divergence: null` and never claims full parity/health.
 */
export function observeSessionChildrenParityDetached(
  connection: ChildrenParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  parentSessionId: string,
  dir: string,
  timeoutMs = SESSION_CHILDREN_PARITY_TIMEOUT_MS,
): void {
  if (!sdkChildrenHasTerminal(sdk)) return
  if (typeof parentSessionId !== "string" || parentSessionId.length === 0) return
  if (typeof dir !== "string" || dir.length === 0) return
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildSessionChildrenIdentity(parentSessionId)
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch {
    tally(connection, "failClosed")
    console.warn("[Kilo Children] private parity observation failed (fail-closed):", {
      op: "session/children",
      observationFailed: true,
    })
    return
  }
  launchChildrenParity(connection, sdk, dir, parentSessionId, opId, idempotencyKey, requestId, timeoutMs)
}
