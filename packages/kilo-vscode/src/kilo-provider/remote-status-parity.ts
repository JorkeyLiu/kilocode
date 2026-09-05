import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type {
  PrivateRemoteStatusWireOutcome,
  ServePrivateRemoteStatusRequest,
  ServePrivateRemoteStatusResult,
} from "../services/cli-backend/serve-private-peer"
import {
  compareRemoteStatusParity,
  isPrivateRemoteStatusValidationError,
} from "../services/cli-backend/serve-private-peer"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only remote/status parity observer. The connection service itself
 * satisfies this interface; tests supply fakes.
 */
export interface RemoteStatusParityConnection {
  isPrivateAvailable(): boolean
  privateRemoteStatusOutcomeWithHandle(req: ServePrivateRemoteStatusRequest): {
    id: number
    promise: Promise<PrivateRemoteStatusWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredRemoteStatusObserver?(dir: string, workspace: string | undefined, listener: () => void): () => void
}

export const REMOTE_STATUS_PARITY_TIMEOUT_MS = 3000

export function buildRemoteStatusIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = `remote-status:${token}`
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

const TERMINAL_HTTP = new Set([400, 404, 409, 500])

function responseStatusOf(sdk: { response?: unknown }): number | null {
  const resp = (sdk as { response?: { status?: unknown } })?.response
  if (resp && typeof resp.status === "number" && Number.isInteger(resp.status)) return resp.status as number
  if (resp && typeof resp.status === "string") {
    const v = Number(resp.status)
    if (Number.isInteger(v)) return v
  }
  return null
}

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

export function sdkRemoteStatusHasTerminal(sdk: { data?: unknown; error?: unknown; response?: unknown }): boolean {
  const n = responseStatusOf(sdk)
  if (n !== null && Number.isInteger(n) && n >= 100 && n < 600) {
    if (TERMINAL_HTTP.has(n)) return true
    if ((sdk as { error?: unknown }).error) return false
    return true
  }
  if (!sdk.error) {
    const data = sdk.data as Record<string, unknown> | undefined
    return !!data && typeof data.enabled === "boolean" && typeof data.connected === "boolean"
  }
  const gated = errorHasTerminalClass(sdk.error as Record<string, unknown>)
  if (gated !== null) return gated
  return false
}

/**
 * Fallback dedupe for connections without keyed registration: pending
 * deferred keys per connection instance. Bounded by distinct
 * epoch+directory+workspace triples; no timers, no polling. The stored epoch
 * is the existing owner `getPrivateEpoch()` snapshot: when the lifecycle
 * resets, fails, or disposes, the next registration observes a different
 * epoch (including null) and purges stale keys so a prior epoch never
 * suppresses renewal. No new persistent subsystem, no replay.
 */
const deferredRemoteKeysByConnection = new WeakMap<
  object,
  { epoch: number | null; keys: Set<string>; unsubs: Map<string, () => void> }
>()

function deferredRemoteKey(epoch: number | null, dir: string, workspace: string | undefined): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const ws =
    workspace === undefined ? "none" : `h-${crypto.createHash("sha256").update(workspace, "utf8").digest("hex")}`
  return `remote-status:${epoch ?? "none"}:${canonical}:${ws}`
}

function ambiguousRemoteResult(req: ServePrivateRemoteStatusRequest): ServePrivateRemoteStatusResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "remote/status",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as ServePrivateRemoteStatusResult
}

function cancelObserverTimeout(
  connection: RemoteStatusParityConnection,
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
      console.warn("[Kilo Remote] handle.cancel failed:", { op: "remote/status", cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      console.warn("[Kilo Remote] tryCancelPrivatePending failed:", { op: "remote/status", cancelFailed: true })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo Remote] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "remote/status",
      stale: true,
    })
    return
  }
  if (result === true) {
    console.warn(`[Kilo Remote] private parity timeout:`, { op: "remote/status", timeout: true })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo Remote] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "remote/status",
      stale: true,
    })
    return
  }
  if (invalidate) {
    try {
      invalidate("remote-status observer timeout")
    } catch {
      console.warn("[Kilo Remote] invalidatePrivatePeerOnObserverTimeout failed:", {
        op: "remote/status",
        invalidateFailed: true,
      })
    }
  }
  console.warn(`[Kilo Remote] private parity timeout:`, { op: "remote/status", timeout: true })
}

function reportRemoteValid(
  result: ServePrivateRemoteStatusResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): void {
  const parity = compareRemoteStatusParity(result, sdk)
  if (parity.divergence) console.warn("[Kilo Remote] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown)
    console.warn("[Kilo Remote] transport-unknown parity:", { op: "remote/status", transportUnknown: true })
}

function validationDivergence(): void {
  console.warn("[Kilo Remote] validation divergence:", { op: "remote/status", invalid: true })
}

async function observeViaOutcome(
  connection: RemoteStatusParityConnection,
  handle: {
    id: number
    promise: Promise<PrivateRemoteStatusWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  },
  req: ServePrivateRemoteStatusRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: PrivateRemoteStatusWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isPrivateRemoteStatusValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as PrivateRemoteStatusWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, epochAtStart)
      return { kind: "valid", result: ambiguousRemoteResult(req) } as PrivateRemoteStatusWireOutcome
    })
  } catch (e) {
    if (isPrivateRemoteStatusValidationError(e)) {
      console.warn("[Kilo Remote] validation divergence:", { op: "remote/status", invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousRemoteResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    validationDivergence()
    return
  }
  reportRemoteValid(outcome.result, sdk)
}

async function observeRemoteParity(
  connection: RemoteStatusParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferRemoteParityAfterNegotiation(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const req: ServePrivateRemoteStatusRequest = {
      v: 1,
      requestId,
      opId,
      op: "remote/status",
      idempotencyKey,
      context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
      payload: {},
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    const handle = connection.privateRemoteStatusOutcomeWithHandle(req)
    await observeViaOutcome(connection, handle, req, sdk, timeoutMs, epochAtStart)
  } catch {
    console.warn("[Kilo Remote] private parity observation failed (fail-closed):", {
      op: "remote/status",
      observationFailed: true,
    })
  }
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches remote state, events, or errors.
 */
function deferRemoteParityAfterNegotiation(
  connection: RemoteStatusParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeRemoteParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs).catch(() =>
      console.warn("[Kilo Remote] private parity observation failed (fail-closed):", {
        op: "remote/status",
        observationFailed: true,
      }),
    )
  }
  const add = connection.addDeferredRemoteStatusObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, workspace, observe)
    } catch {
      console.warn("[Kilo Remote] deferred parity subscribe failed (fail-closed):", {
        op: "remote/status",
        subscribeFailed: true,
      })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        console.warn("[Kilo Remote] deferred parity unsubscribe failed (fail-closed):", {
          op: "remote/status",
          unsubscribeFailed: true,
        })
      }
      observe()
    }
    return
  }
  deferRemoteFallback(connection, dir, workspace, observe)
}

function deferRemoteFallback(
  connection: RemoteStatusParityConnection,
  dir: string,
  workspace: string | undefined,
  observe: () => void,
): void {
  const epochAtDefer = connection.getPrivateEpoch?.() ?? null
  const key = deferredRemoteKey(epochAtDefer, dir, workspace)
  let entry = deferredRemoteKeysByConnection.get(connection)
  if (!entry) {
    entry = { epoch: epochAtDefer, keys: new Set<string>(), unsubs: new Map<string, () => void>() }
    deferredRemoteKeysByConnection.set(connection, entry)
  }
  if (entry.epoch !== epochAtDefer) {
    for (const [, oldUnsub] of [...entry.unsubs]) {
      try {
        oldUnsub()
      } catch {
        console.warn("[Kilo Remote] deferred parity unsubscribe failed (fail-closed):", {
          op: "remote/status",
          unsubscribeFailed: true,
        })
      }
    }
    entry.keys.clear()
    entry.unsubs.clear()
    entry.epoch = epochAtDefer
  }
  const seen: Set<string> = entry.keys
  if (seen.has(key)) {
    const oldUnsub = entry.unsubs.get(key)
    if (oldUnsub) {
      try {
        oldUnsub()
      } catch {
        console.warn("[Kilo Remote] deferred parity unsubscribe failed (fail-closed):", {
          op: "remote/status",
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
        console.warn("[Kilo Remote] deferred parity unsubscribe failed (fail-closed):", {
          op: "remote/status",
          unsubscribeFailed: true,
        })
      }
      fireDeferredRemote(connection, epochAtDefer, observe)
    })
    entry.unsubs.set(key, unsub)
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      entry.unsubs.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo Remote] deferred parity unsubscribe failed (fail-closed):", {
          op: "remote/status",
          unsubscribeFailed: true,
        })
      }
      fireDeferredRemote(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    entry.unsubs.delete(key)
    console.warn("[Kilo Remote] deferred parity subscribe failed (fail-closed):", {
      op: "remote/status",
      subscribeFailed: true,
    })
  }
}

function fireDeferredRemote(
  connection: RemoteStatusParityConnection,
  epochAtDefer: number | null,
  observe: () => void,
): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (now !== epochAtDefer) {
    console.warn("[Kilo Remote] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchRemoteParity(
  connection: RemoteStatusParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeRemoteParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
    void pending.catch(() =>
      console.warn("[Kilo Remote] private parity observation failed (fail-closed):", {
        op: "remote/status",
        observationFailed: true,
      }),
    )
  } catch {
    console.warn("[Kilo Remote] private parity observation failed (fail-closed):", {
      op: "remote/status",
      observationFailed: true,
    })
  }
}

/**
 * Detached SDK-first `remote/status` parity observer.
 *
 * Call only after the SDK `remote.status` has settled with a terminal
 * result (data with both booleans or terminal HTTP-class failure). The SDK
 * result stays authoritative: this never mutates remote state,
 * enable/disable, events, or UI, and never retries/replays the SDK. It
 * returns synchronously (non-blocking); private work runs detached with the
 * default bounded timeout. Invalid private wire bypasses the comparator and
 * only logs a diagnostic. Boolean differences are warn-only observation
 * divergence (cross-directory equality expected), never parity failure.
 */
export function observeRemoteStatusParityDetached(
  connection: RemoteStatusParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace?: string,
  timeoutMs = REMOTE_STATUS_PARITY_TIMEOUT_MS,
): void {
  if (!sdkRemoteStatusHasTerminal(sdk)) return
  if (typeof dir !== "string" || dir.length === 0) return
  if (workspace !== undefined && (typeof workspace !== "string" || workspace.length === 0)) return
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildRemoteStatusIdentity()
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch {
    console.warn("[Kilo Remote] private parity observation failed (fail-closed):", {
      op: "remote/status",
      observationFailed: true,
    })
    return
  }
  launchRemoteParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
}
