import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type { CommandListContractRequest, CommandListResult, CommandListWireOutcome } from "../services/cli-backend/serve-private-command-list-contract"
import {
  canonicalCommandListOpId,
  compareCommandListParity,
  isCommandListValidationError,
} from "../services/cli-backend/serve-private-command-list-contract"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only `command/list` parity observer. The connection service itself
 * satisfies this interface; tests supply fakes.
 */
export interface CommandListParityConnection {
  isPrivateAvailable(): boolean
  privateCommandListOutcomeWithHandle(req: CommandListContractRequest): {
    id: number
    promise: Promise<CommandListWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredCommandListObserver?(dir: string, workspace: string | undefined, listener: () => void): () => void
}

export const COMMAND_LIST_PARITY_TIMEOUT_MS = 3000

export function buildCommandListIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalCommandListOpId(token)
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

export function sdkCommandListHasTerminal(sdk: { data?: unknown; error?: unknown; response?: unknown } | Error | unknown): boolean {
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
 * epoch+directory+workspace digest triples with `command-list/epoch`,
 * `command-list/dir`, `command-list/workspace` domains; no timers, no
 * polling. The production owner `DeferredCommandList` holds its own opaque
 * key in the same digest style; this fallback form lives only in this
 * per-connection set and never the production key. Exact `dir`/`workspace`
 * closure values stay with the caller for request construction; only the
 * digest key is stored here. Serialized keys never carry raw
 * directory/workspace material and `:` inside a raw value cannot collide
 * across tuples.
 */
const deferredCommandListKeysByConnection = new WeakMap<object, Set<string>>()

export function deferredCommandListKey(epoch: number | null, dir: string, workspace: string | undefined): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const epochPart =
    epoch === null ? "none" : `e-${crypto.createHash("sha256").update(`command-list/epoch\x00${epoch}`, "utf8").digest("hex")}`
  const dirPart = `d-${crypto.createHash("sha256").update(`command-list/dir\x00${canonical}`, "utf8").digest("hex")}`
  const wsPart =
    workspace === undefined
      ? "none"
      : `w-${crypto.createHash("sha256").update(`command-list/workspace\x00${workspace}`, "utf8").digest("hex")}`
  return `command-list:${epochPart}:${dirPart}:${wsPart}`
}

function ambiguousCommandListResult(req: CommandListContractRequest): CommandListResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "command/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as CommandListResult
}

function cancelObserverTimeout(
  connection: CommandListParityConnection,
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
      console.warn("[Kilo CommandList] handle.cancel failed:", { op: "command/list", cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      console.warn("[Kilo CommandList] tryCancelPrivatePending failed:", { op: "command/list", cancelFailed: true })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo CommandList] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "command/list",
      stale: true,
    })
    return
  }
  if (result === true) {
    console.warn(`[Kilo CommandList] private parity timeout after ${timeoutMs}ms:`, { op: "command/list", timeoutMs })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo CommandList] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "command/list",
      stale: true,
    })
    return
  }
  if (invalidate) {
    try {
      invalidate("command-list observer timeout")
    } catch {
      console.warn("[Kilo CommandList] invalidatePrivatePeerOnObserverTimeout failed:", {
        op: "command/list",
        invalidateFailed: true,
      })
    }
  }
  console.warn(`[Kilo CommandList] private parity timeout after ${timeoutMs}ms:`, { op: "command/list", timeoutMs })
}

function reportCommandListValid(result: CommandListResult, sdk: { data?: unknown; error?: unknown; response?: unknown }): void {
  const parity = compareCommandListParity(result, sdk)
  if (parity.divergence) console.warn("[Kilo CommandList] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown)
    console.warn("[Kilo CommandList] transport-unknown parity:", { op: "command/list", transportUnknown: true })
}

async function observeViaOutcome(
  connection: CommandListParityConnection,
  handle: { id: number; promise: Promise<CommandListWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: CommandListContractRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: CommandListWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isCommandListValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as CommandListWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, timeoutMs, epochAtStart)
      return { kind: "valid", result: ambiguousCommandListResult(req) } as CommandListWireOutcome
    })
  } catch (e) {
    if (isCommandListValidationError(e)) {
      console.warn("[Kilo CommandList] validation divergence:", { op: "command/list", invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousCommandListResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    console.warn("[Kilo CommandList] validation divergence:", { op: "command/list", invalid: true })
    return
  }
  reportCommandListValid(outcome.result, sdk)
}

async function observeCommandListParity(
  connection: CommandListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferCommandListParityAfterNegotiation(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const req: CommandListContractRequest = {
      v: 1,
      requestId,
      opId,
      op: "command/list",
      idempotencyKey,
      context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
      payload: {},
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privateCommandListOutcomeWithHandle.bind(connection)
      const handle = factory(req)
      await observeViaOutcome(connection, handle, req, sdk, timeoutMs, epochAtStart)
      return
    } catch (e) {
      if (isCommandListValidationError(e)) {
        console.warn("[Kilo CommandList] validation divergence:", { op: "command/list", invalid: true })
        return
      }
      throw e
    }
  } catch {
    console.warn("[Kilo CommandList] private parity observation failed (fail-closed):", {
      op: "command/list",
      observationFailed: true,
    })
  }
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches command state, config, or errors.
 */
function deferCommandListParityAfterNegotiation(
  connection: CommandListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeCommandListParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs).catch(() =>
      console.warn("[Kilo CommandList] private parity observation failed (fail-closed):", {
        op: "command/list",
        observationFailed: true,
      }),
    )
  }
  const add = connection.addDeferredCommandListObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, workspace, observe)
    } catch {
      console.warn("[Kilo CommandList] deferred parity subscribe failed (fail-closed):", {
        op: "command/list",
        subscribeFailed: true,
      })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        console.warn("[Kilo CommandList] deferred parity unsubscribe failed (fail-closed):", {
          op: "command/list",
          unsubscribeFailed: true,
        })
      }
      observe()
    }
    return
  }
  deferCommandListFallback(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs, observe)
}

function deferCommandListFallback(
  connection: CommandListParityConnection,
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
  const key = deferredCommandListKey(epochAtDefer, dir, workspace)
  let keys = deferredCommandListKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredCommandListKeysByConnection.set(connection, keys)
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
        console.warn("[Kilo CommandList] deferred parity unsubscribe failed (fail-closed):", {
          op: "command/list",
          unsubscribeFailed: true,
        })
      }
      fireDeferredCommandList(connection, epochAtDefer, observe)
    })
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo CommandList] deferred parity unsubscribe failed (fail-closed):", {
          op: "command/list",
          unsubscribeFailed: true,
        })
      }
      fireDeferredCommandList(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    console.warn("[Kilo CommandList] deferred parity subscribe failed (fail-closed):", {
      op: "command/list",
      subscribeFailed: true,
    })
  }
}

function fireDeferredCommandList(connection: CommandListParityConnection, epochAtDefer: number | null, observe: () => void): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (now !== epochAtDefer) {
    console.warn("[Kilo CommandList] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchCommandListParity(
  connection: CommandListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeCommandListParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
    void pending.catch(() =>
      console.warn("[Kilo CommandList] private parity observation failed (fail-closed):", {
        op: "command/list",
        observationFailed: true,
      }),
    )
  } catch {
    console.warn("[Kilo CommandList] private parity observation failed (fail-closed):", {
      op: "command/list",
      observationFailed: true,
    })
  }
}

/**
 * Detached SDK-first `command/list` parity observer.
 *
 * Call only after the SDK `command.list` has settled with a terminal result
 * (entry array data, or a terminal HTTP-class failure). The SDK result stays
 * authoritative: this never mutates command state, config, errors, or UI,
 * and never retries/replays the SDK. It returns synchronously
 * (non-blocking); private work runs detached with the default bounded
 * timeout. Invalid private wire bypasses the comparator and only logs a
 * diagnostic. Only shared `name::source` entries have their
 * name/description/source compared (hints shape-only); membership gaps are
 * `command-list-membership-unknown` unknowns, never failures. Ordering,
 * directory, snapshot atomicity, freshness, and template resolution remain
 * explicitly unknown and are never compared.
 */
export function observeCommandListParityDetached(
  connection: CommandListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace?: string,
  timeoutMs = COMMAND_LIST_PARITY_TIMEOUT_MS,
): void {
  if (!sdkCommandListHasTerminal(sdk)) return
  if (typeof dir !== "string" || dir.length === 0) return
  if (workspace !== undefined && (typeof workspace !== "string" || workspace.length === 0)) return
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildCommandListIdentity()
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch {
    console.warn("[Kilo CommandList] private parity observation failed (fail-closed):", {
      op: "command/list",
      observationFailed: true,
    })
    return
  }
  launchCommandListParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
}
