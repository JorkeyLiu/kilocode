import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type { PathContractRequest, PathResult, PathWireOutcome } from "../services/cli-backend/serve-private-path-contract"
import { comparePathParity, isPathValidationError } from "../services/cli-backend/serve-private-path-contract"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only `path/get` parity observer. The connection service itself
 * satisfies this interface; tests supply fakes.
 */
export interface PathParityConnection {
  isPrivateAvailable(): boolean
  privatePathOutcomeWithHandle(req: PathContractRequest): {
    id: number
    promise: Promise<PathWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  /**
   * Authoritative routing directory shared by the SDK `path.get` read and
   * the private `path/get` read. Implemented by the existing connection
   * owner from the exact active backend spawn identity
   * (`ServerManager.getActiveSpawnCwd`). Absent/dead/disposed means the
   * observer must stay detached-fail-closed (no mutable-directory or
   * `process.cwd()` substitute).
   */
  getPathRoutingDirectory?(): string | undefined
  addDeferredPathObserver?(dir: string, workspace: string | undefined, listener: () => void): () => void
}

export const PATH_PARITY_TIMEOUT_MS = 3000

export function buildPathIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = `path:${token}`
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

function thrownErrorHasTerminal(rec: Record<string, unknown>): boolean {
  const nested = rec.error as Record<string, unknown> | undefined
  if (nested && typeof nested === "object") {
    const gated = errorHasTerminalClass(nested)
    if (gated !== null) return gated
  }
  for (const c of [rec.status, rec.statusCode, rec.code]) {
    if (typeof c === "number" && TERMINAL_HTTP.has(c)) return true
    if (typeof c === "string" && TERMINAL_HTTP.has(Number(c))) return true
  }
  return false
}

export function sdkPathHasTerminal(sdk: { data?: unknown; error?: unknown; response?: unknown } | Error | unknown): boolean {
  if (sdk instanceof Error) return thrownErrorHasTerminal(sdk as unknown as Record<string, unknown>)
  if (!sdk || typeof sdk !== "object") return false
  const typed = sdk as { data?: unknown; error?: unknown; response?: unknown }
  const resp = (typed as { response?: { status?: unknown } }).response
  if (resp && typeof resp.status === "number" && Number.isInteger(resp.status)) {
    if (TERMINAL_HTTP.has(resp.status)) return true
    if (typed.error) return false
    return typed.data !== undefined && typed.data !== null
  }
  if (!typed.error) return typed.data !== undefined && typed.data !== null
  const gated = errorHasTerminalClass(typed.error as Record<string, unknown>)
  if (gated !== null) return gated
  return false
}

/**
 * Fallback-only dedupe for connections without keyed registration: pending
 * deferred keys per connection instance. Bounded by distinct opaque
 * epoch+directory+workspace digest triples with `path/epoch`, `path/dir`,
 * `path/workspace` domains; no timers, no polling. The production owner
 * `DeferredPath` holds its own opaque key in the same digest style; this
 * fallback form lives only in this per-connection set and never the
 * production key. Exact `dir`/`workspace` closure values stay with the
 * caller for request construction; only the digest key is stored here.
 * Serialized keys never carry raw directory/workspace material and `:` inside
 * a raw value cannot collide across tuples.
 */
const deferredPathKeysByConnection = new WeakMap<object, Set<string>>()

export function deferredPathKey(epoch: number | null, dir: string, workspace: string | undefined): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const epochPart =
    epoch === null ? "none" : `e-${crypto.createHash("sha256").update(`path/epoch\x00${epoch}`, "utf8").digest("hex")}`
  const dirPart = `d-${crypto.createHash("sha256").update(`path/dir\x00${canonical}`, "utf8").digest("hex")}`
  const wsPart =
    workspace === undefined
      ? "none"
      : `w-${crypto.createHash("sha256").update(`path/workspace\x00${workspace}`, "utf8").digest("hex")}`
  return `path:${epochPart}:${dirPart}:${wsPart}`
}

function ambiguousPathResult(req: PathContractRequest): PathResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "path/get",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as PathResult
}

function cancelObserverTimeout(
  connection: PathParityConnection,
  handle: { cancel?: (msg?: string) => boolean | "stale" } | null,
  exactId: number | null,
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
      console.warn("[Kilo Path] handle.cancel failed:", { op: "path/get", cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      console.warn("[Kilo Path] tryCancelPrivatePending failed:", { op: "path/get", cancelFailed: true })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo Path] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "path/get",
      stale: true,
    })
    return
  }
  if (result === true) {
    console.warn(`[Kilo Path] private parity timeout after ${timeoutMs}ms:`, { op: "path/get", timeoutMs })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo Path] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "path/get",
      stale: true,
    })
    return
  }
  if (invalidate) {
    try {
      invalidate("path observer timeout")
    } catch {
      console.warn("[Kilo Path] invalidatePrivatePeerOnObserverTimeout failed:", {
        op: "path/get",
        invalidateFailed: true,
      })
    }
  }
  console.warn(`[Kilo Path] private parity timeout after ${timeoutMs}ms:`, { op: "path/get", timeoutMs })
}

function reportPathValid(result: PathResult, sdk: { data?: unknown; error?: unknown; response?: unknown }): void {
  const parity = comparePathParity(result, sdk)
  if (parity.divergence) console.warn("[Kilo Path] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown)
    console.warn("[Kilo Path] transport-unknown parity:", { op: "path/get", transportUnknown: true })
}

async function observeViaOutcome(
  connection: PathParityConnection,
  handle: { id: number; promise: Promise<PathWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: PathContractRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: PathWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isPathValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as PathWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, timeoutMs, epochAtStart)
      return { kind: "valid", result: ambiguousPathResult(req) } as PathWireOutcome
    })
  } catch (e) {
    if (isPathValidationError(e)) {
      console.warn("[Kilo Path] validation divergence:", { op: "path/get", invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousPathResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    console.warn("[Kilo Path] validation divergence:", { op: "path/get", invalid: true })
    return
  }
  reportPathValid(outcome.result, sdk)
}

async function observePathParity(
  connection: PathParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferPathParityAfterNegotiation(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const req: PathContractRequest = {
      v: 1,
      requestId,
      opId,
      op: "path/get",
      idempotencyKey,
      context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
      payload: {},
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privatePathOutcomeWithHandle.bind(connection)
      const handle = factory(req)
      await observeViaOutcome(connection, handle, req, sdk, timeoutMs, epochAtStart)
      return
    } catch (e) {
      if (isPathValidationError(e)) {
        console.warn("[Kilo Path] validation divergence:", { op: "path/get", invalid: true })
        return
      }
      throw e
    }
  } catch {
    console.warn("[Kilo Path] private parity observation failed (fail-closed):", {
      op: "path/get",
      observationFailed: true,
    })
  }
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches path state, config, or errors.
 */
function deferPathParityAfterNegotiation(
  connection: PathParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observePathParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs).catch(() =>
      console.warn("[Kilo Path] private parity observation failed (fail-closed):", {
        op: "path/get",
        observationFailed: true,
      }),
    )
  }
  const add = connection.addDeferredPathObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, workspace, observe)
    } catch {
      console.warn("[Kilo Path] deferred parity subscribe failed (fail-closed):", {
        op: "path/get",
        subscribeFailed: true,
      })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        console.warn("[Kilo Path] deferred parity unsubscribe failed (fail-closed):", {
          op: "path/get",
          unsubscribeFailed: true,
        })
      }
      observe()
    }
    return
  }
  deferPathFallback(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs, observe)
}

function deferPathFallback(
  connection: PathParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
  observe: () => void,
): void {
  const epochAtDefer = connection.getPrivateEpoch?.() ?? null
  const key = deferredPathKey(epochAtDefer, dir, workspace)
  let keys = deferredPathKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredPathKeysByConnection.set(connection, keys)
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
        console.warn("[Kilo Path] deferred parity unsubscribe failed (fail-closed):", {
          op: "path/get",
          unsubscribeFailed: true,
        })
      }
      fireDeferredPath(connection, epochAtDefer, observe)
    })
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo Path] deferred parity unsubscribe failed (fail-closed):", {
          op: "path/get",
          unsubscribeFailed: true,
        })
      }
      fireDeferredPath(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    console.warn("[Kilo Path] deferred parity subscribe failed (fail-closed):", {
      op: "path/get",
      subscribeFailed: true,
    })
  }
}

function fireDeferredPath(connection: PathParityConnection, epochAtDefer: number | null, observe: () => void): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (now !== epochAtDefer) {
    console.warn("[Kilo Path] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchPathParity(
  connection: PathParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observePathParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
    void pending.catch(() =>
      console.warn("[Kilo Path] private parity observation failed (fail-closed):", {
        op: "path/get",
        observationFailed: true,
      }),
    )
  } catch {
    console.warn("[Kilo Path] private parity observation failed (fail-closed):", {
      op: "path/get",
      observationFailed: true,
    })
  }
}

/**
 * Detached SDK-first `path/get` parity observer.
 *
 * Call only after the SDK `path.get` has settled with a terminal result
 * (five-field data, or a terminal HTTP-class failure). The SDK result stays
 * authoritative: this never mutates path state, config, errors, or UI, and
 * never retries/replays the SDK. It returns synchronously (non-blocking);
 * private work runs detached with the default bounded timeout. Invalid
 * private wire bypasses the comparator and only logs a diagnostic. Only
 * directory-derived `worktree`/`directory` are compared; globals
 * `home`/`state`/`config` are excluded, the request directory is never
 * compared, and worktree derivation/freshness/transport remain explicit
 * unknowns (never assert `worktree === directory`).
 */
export function observePathParityDetached(
  connection: PathParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace?: string,
  timeoutMs = PATH_PARITY_TIMEOUT_MS,
): void {
  if (!sdkPathHasTerminal(sdk)) return
  if (typeof dir !== "string" || dir.length === 0) return
  if (workspace !== undefined && (typeof workspace !== "string" || workspace.length === 0)) return
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildPathIdentity()
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch {
    console.warn("[Kilo Path] private parity observation failed (fail-closed):", {
      op: "path/get",
      observationFailed: true,
    })
    return
  }
  launchPathParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
}
