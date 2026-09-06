import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type {
  ConfigWarningsContractRequest,
  ConfigWarningsResult,
  ConfigWarningsWireOutcome,
} from "../services/cli-backend/serve-private-config-warnings-contract"
import {
  canonicalConfigWarningsOpId,
  compareConfigWarningsParity,
  isConfigWarningsValidationError,
} from "../services/cli-backend/serve-private-config-warnings-contract"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only `config/warnings` parity observer. The connection service itself
 * satisfies this interface; tests supply fakes.
 */
export interface ConfigWarningsParityConnection {
  isPrivateAvailable(): boolean
  privateConfigWarningsOutcomeWithHandle(req: ConfigWarningsContractRequest): {
    id: number
    promise: Promise<ConfigWarningsWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredConfigWarningsObserver?(dir: string, workspace: string | undefined, listener: () => void): () => void
}

export const CONFIG_WARNINGS_PARITY_TIMEOUT_MS = 3000

export function buildConfigWarningsIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalConfigWarningsOpId(token)
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

export function sdkConfigWarningsHasTerminal(
  sdk: { data?: unknown; error?: unknown; response?: unknown } | Error | unknown,
): boolean {
  if (sdk instanceof Error) return thrownErrorHasTerminal(sdk as unknown as Record<string, unknown>)
  if (!sdk || typeof sdk !== "object") return false
  const typed = sdk as { data?: unknown; error?: unknown; response?: unknown }
  const resp = (typed as { response?: { status?: unknown } }).response
  if (resp && typeof resp.status === "number" && Number.isInteger(resp.status)) {
    if (TERMINAL_HTTP.has(resp.status)) return true
    if (typed.error) return false
    return Array.isArray(typed.data)
  }
  if (!typed.error) return Array.isArray(typed.data)
  const gated = errorHasTerminalClass(typed.error as Record<string, unknown>)
  if (gated !== null) return gated
  return false
}

/**
 * Fallback-only dedupe for connections without keyed registration: pending
 * deferred keys per connection instance. Bounded by distinct opaque
 * epoch+directory+workspace digest triples with `config-warnings/epoch`,
 * `config-warnings/dir`, `config-warnings/workspace` domains; no timers, no
 * polling. The production owner `DeferredConfigWarnings` holds its own
 * opaque key in the same digest style; this fallback form lives only in this
 * per-connection set and never the production key. Exact `dir`/`workspace`
 * closure values stay with the caller for request construction; only the
 * digest key is stored here. Serialized keys never carry raw
 * directory/workspace material and `:` inside a raw value cannot collide
 * across tuples.
 */
const deferredConfigWarningsKeysByConnection = new WeakMap<object, Set<string>>()

export function deferredConfigWarningsKey(epoch: number | null, dir: string, workspace: string | undefined): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const epochPart =
    epoch === null
      ? "none"
      : `e-${crypto.createHash("sha256").update(`config-warnings/epoch\x00${epoch}`, "utf8").digest("hex")}`
  const dirPart = `d-${crypto.createHash("sha256").update(`config-warnings/dir\x00${canonical}`, "utf8").digest("hex")}`
  const wsPart =
    workspace === undefined
      ? "none"
      : `w-${crypto.createHash("sha256").update(`config-warnings/workspace\x00${workspace}`, "utf8").digest("hex")}`
  return `config-warnings:${epochPart}:${dirPart}:${wsPart}`
}

function ambiguousConfigWarningsResult(req: ConfigWarningsContractRequest): ConfigWarningsResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "config/warnings",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as ConfigWarningsResult
}

function cancelObserverTimeout(
  connection: ConfigWarningsParityConnection,
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
      console.warn("[Kilo ConfigWarnings] handle.cancel failed:", { op: "config/warnings", cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      console.warn("[Kilo ConfigWarnings] tryCancelPrivatePending failed:", {
        op: "config/warnings",
        cancelFailed: true,
      })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo ConfigWarnings] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "config/warnings",
      stale: true,
    })
    return
  }
  if (result === true) {
    console.warn(`[Kilo ConfigWarnings] private parity timeout after ${timeoutMs}ms:`, {
      op: "config/warnings",
      timeoutMs,
    })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo ConfigWarnings] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "config/warnings",
      stale: true,
    })
    return
  }
  if (invalidate) {
    try {
      invalidate("config-warnings observer timeout")
    } catch {
      console.warn("[Kilo ConfigWarnings] invalidatePrivatePeerOnObserverTimeout failed:", {
        op: "config/warnings",
        invalidateFailed: true,
      })
    }
  }
  console.warn(`[Kilo ConfigWarnings] private parity timeout after ${timeoutMs}ms:`, {
    op: "config/warnings",
    timeoutMs,
  })
}

function reportConfigWarningsValid(
  result: ConfigWarningsResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): void {
  const parity = compareConfigWarningsParity(result, sdk)
  if (parity.divergence) console.warn("[Kilo ConfigWarnings] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown)
    console.warn("[Kilo ConfigWarnings] transport-unknown parity:", { op: "config/warnings", transportUnknown: true })
}

async function observeViaOutcome(
  connection: ConfigWarningsParityConnection,
  handle: { id: number; promise: Promise<ConfigWarningsWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: ConfigWarningsContractRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: ConfigWarningsWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isConfigWarningsValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as ConfigWarningsWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, timeoutMs, epochAtStart)
      return { kind: "valid", result: ambiguousConfigWarningsResult(req) } as ConfigWarningsWireOutcome
    })
  } catch (e) {
    if (isConfigWarningsValidationError(e)) {
      console.warn("[Kilo ConfigWarnings] validation divergence:", { op: "config/warnings", invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousConfigWarningsResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    console.warn("[Kilo ConfigWarnings] validation divergence:", { op: "config/warnings", invalid: true })
    return
  }
  reportConfigWarningsValid(outcome.result, sdk)
}

async function observeConfigWarningsParity(
  connection: ConfigWarningsParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferConfigWarningsParityAfterNegotiation(
      connection,
      sdk,
      dir,
      workspace,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const req: ConfigWarningsContractRequest = {
      v: 1,
      requestId,
      opId,
      op: "config/warnings",
      idempotencyKey,
      context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
      payload: {},
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privateConfigWarningsOutcomeWithHandle.bind(connection)
      const handle = factory(req)
      await observeViaOutcome(connection, handle, req, sdk, timeoutMs, epochAtStart)
      return
    } catch (e) {
      if (isConfigWarningsValidationError(e)) {
        console.warn("[Kilo ConfigWarnings] validation divergence:", { op: "config/warnings", invalid: true })
        return
      }
      throw e
    }
  } catch {
    console.warn("[Kilo ConfigWarnings] private parity observation failed (fail-closed):", {
      op: "config/warnings",
      observationFailed: true,
    })
  }
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches config state, warnings UI, or errors.
 */
function deferConfigWarningsParityAfterNegotiation(
  connection: ConfigWarningsParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeConfigWarningsParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs).catch(
      () =>
        console.warn("[Kilo ConfigWarnings] private parity observation failed (fail-closed):", {
          op: "config/warnings",
          observationFailed: true,
        }),
    )
  }
  const add = connection.addDeferredConfigWarningsObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, workspace, observe)
    } catch {
      console.warn("[Kilo ConfigWarnings] deferred parity subscribe failed (fail-closed):", {
        op: "config/warnings",
        subscribeFailed: true,
      })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        console.warn("[Kilo ConfigWarnings] deferred parity unsubscribe failed (fail-closed):", {
          op: "config/warnings",
          unsubscribeFailed: true,
        })
      }
      observe()
    }
    return
  }
  deferConfigWarningsFallback(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs, observe)
}

function deferConfigWarningsFallback(
  connection: ConfigWarningsParityConnection,
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
  const key = deferredConfigWarningsKey(epochAtDefer, dir, workspace)
  let keys = deferredConfigWarningsKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredConfigWarningsKeysByConnection.set(connection, keys)
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
        console.warn("[Kilo ConfigWarnings] deferred parity unsubscribe failed (fail-closed):", {
          op: "config/warnings",
          unsubscribeFailed: true,
        })
      }
      fireDeferredConfigWarnings(connection, epochAtDefer, observe)
    })
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo ConfigWarnings] deferred parity unsubscribe failed (fail-closed):", {
          op: "config/warnings",
          unsubscribeFailed: true,
        })
      }
      fireDeferredConfigWarnings(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    console.warn("[Kilo ConfigWarnings] deferred parity subscribe failed (fail-closed):", {
      op: "config/warnings",
      subscribeFailed: true,
    })
  }
}

function fireDeferredConfigWarnings(
  connection: ConfigWarningsParityConnection,
  epochAtDefer: number | null,
  observe: () => void,
): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (now !== epochAtDefer) {
    console.warn("[Kilo ConfigWarnings] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchConfigWarningsParity(
  connection: ConfigWarningsParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeConfigWarningsParity(
      connection,
      sdk,
      dir,
      workspace,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
    void pending.catch(() =>
      console.warn("[Kilo ConfigWarnings] private parity observation failed (fail-closed):", {
        op: "config/warnings",
        observationFailed: true,
      }),
    )
  } catch {
    console.warn("[Kilo ConfigWarnings] private parity observation failed (fail-closed):", {
      op: "config/warnings",
      observationFailed: true,
    })
  }
}

/**
 * Detached SDK-first `config/warnings` parity observer.
 *
 * Call only after the SDK `config.warnings` has settled with a terminal
 * result (warning array data, or a terminal HTTP-class failure). The SDK
 * result stays authoritative: this never mutates config state, warning UI,
 * errors, or caches, and never retries/replays the SDK. It returns
 * synchronously (non-blocking); private work runs detached with the default
 * bounded timeout. Invalid private wire bypasses the comparator and only
 * logs a diagnostic. Both sides compare as the same safe
 * `{pathCategory,messageCategory}` multiset; membership/duplicate gaps are
 * `config-warnings-membership-unknown` unknowns, never failures. Ordering,
 * directory, and freshness remain explicitly unknown and are never compared.
 */
export function observeConfigWarningsParityDetached(
  connection: ConfigWarningsParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace?: string,
  timeoutMs = CONFIG_WARNINGS_PARITY_TIMEOUT_MS,
): void {
  if (!sdkConfigWarningsHasTerminal(sdk)) return
  if (typeof dir !== "string" || dir.length === 0) return
  if (workspace !== undefined && (typeof workspace !== "string" || workspace.length === 0)) return
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildConfigWarningsIdentity()
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch {
    console.warn("[Kilo ConfigWarnings] private parity observation failed (fail-closed):", {
      op: "config/warnings",
      observationFailed: true,
    })
    return
  }
  launchConfigWarningsParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
}
