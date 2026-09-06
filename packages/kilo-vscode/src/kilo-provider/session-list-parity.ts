import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type {
  PrivateSessionListWireOutcome,
  ServePrivateSessionListRequest,
  ServePrivateSessionListResult,
} from "../services/cli-backend/serve-private-session-list-contract"
import {
  compareSessionListParity,
  isPrivateSessionListValidationError,
} from "../services/cli-backend/serve-private-session-list-contract"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only `experimental/session/list` parity observer. The connection
 * service itself satisfies this interface; tests supply fakes.
 */
export interface SessionListParityConnection {
  isPrivateAvailable(): boolean
  privateSessionListOutcomeWithHandle(req: ServePrivateSessionListRequest): {
    id: number
    promise: Promise<PrivateSessionListWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  privateSessionListWithHandle?(req: ServePrivateSessionListRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredSessionListObserver?(
    dir: string,
    workspace: string | undefined,
    filter: SessionListParityFilter,
    listener: () => void,
  ): () => void
}

export interface SessionListParityFilter {
  projectID?: string
  roots?: boolean
  start?: number
  cursor?: string
  search?: string
  limit?: number
  archived?: boolean
}

export const SESSION_LIST_PARITY_TIMEOUT_MS = 3000

const SESSION_LIST_FILTER_FIELDS = new Set(["projectID", "roots", "start", "cursor", "search", "limit", "archived"])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

// Canonical session-list cursor grammar duplicate (LOCK-002):
// the extension cannot import the opencode decoder, so this mirrors it
// exactly ({v:1,updated:non-negative-int,id:ses* without NUL}, strict
// 3-key JSON/base64url) rather than inventing a second grammar.
function isOpaqueCursor(v: unknown): boolean {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) return false
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return false
  try {
    const parsed = JSON.parse(Buffer.from(v, "base64url").toString("utf8")) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const keys = Object.keys(parsed)
    if (keys.length !== 3 || !keys.includes("v") || !keys.includes("updated") || !keys.includes("id")) return false
    if (parsed.v !== 1) return false
    if (typeof parsed.updated !== "number" || !Number.isInteger(parsed.updated) || (parsed.updated as number) < 0)
      return false
    if (
      typeof parsed.id !== "string" ||
      !(parsed.id as string).startsWith("ses") ||
      (parsed.id as string).includes("\0")
    )
      return false
    return true
  } catch {
    return false
  }
}

function isValidLimit(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0
}

function isValidSessionListFilter(filter: SessionListParityFilter): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false
  for (const k of Object.keys(filter)) if (!SESSION_LIST_FILTER_FIELDS.has(k)) return false
  const rec = filter as Record<string, unknown>
  if (rec.projectID !== undefined && !isNonEmptyString(rec.projectID)) return false
  if (rec.roots !== undefined && typeof rec.roots !== "boolean") return false
  if (rec.start !== undefined && !isFiniteNumber(rec.start)) return false
  if (rec.cursor !== undefined && !isOpaqueCursor(rec.cursor)) return false
  if (rec.search !== undefined && typeof rec.search !== "string") return false
  if (rec.limit !== undefined && !isValidLimit(rec.limit)) return false
  if (rec.archived !== undefined && typeof rec.archived !== "boolean") return false
  return true
}

export function buildSessionListIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = `experimental-session-list:${token}`
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

function isGeneratedInvalidRequestTag(v: unknown): boolean {
  return typeof v === "string" && (v as string) === "InvalidRequestError"
}

function errorHasTerminalClass(err: Record<string, unknown>): boolean | null {
  if (isGeneratedInvalidRequestTag(err._tag)) return true
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
  if (isGeneratedInvalidRequestTag(rec._tag)) return true
  const nested = rec.error as Record<string, unknown> | undefined
  if (nested && typeof nested === "object" && isGeneratedInvalidRequestTag(nested._tag)) return true
  const cause = rec.cause as Record<string, unknown> | undefined
  if (cause && typeof cause === "object" && isGeneratedInvalidRequestTag(cause._tag)) return true
  const s = thrownStatusFromRecord(rec)
  return s !== null && TERMINAL_HTTP.has(s)
}

function sdkListItems(sdk: { data?: unknown }): unknown[] | null {
  const data = (sdk as { data?: unknown }).data
  return Array.isArray(data) ? (data as unknown[]) : null
}

function sdkListError(sdk: { error?: unknown }): Record<string, unknown> | null {
  const err = (sdk as { error?: unknown }).error
  return err !== undefined && err !== null ? (err as Record<string, unknown>) : null
}

function terminalResponseStatus(sdk: { response?: unknown }): number | null {
  const n = responseStatusOf(sdk)
  if (n !== null && Number.isInteger(n) && n >= 100 && n < 600) return n
  return null
}

export function sdkSessionListHasTerminal(
  sdk: { data?: unknown; error?: unknown; response?: unknown } | Error | unknown,
): boolean {
  if (sdk instanceof Error) return thrownErrorHasTerminal(sdk as unknown as Record<string, unknown>)
  if (!sdk || typeof sdk !== "object") return false
  const typed = sdk as { data?: unknown; error?: unknown; response?: unknown }
  const items = sdkListItems(typed)
  const err = sdkListError(typed)
  if (items === null && err === null) return thrownErrorHasTerminal(sdk as unknown as Record<string, unknown>)
  const n = terminalResponseStatus(typed)
  if (n !== null) {
    if (TERMINAL_HTTP.has(n)) return true
    if (err !== null) return false
    return items !== null
  }
  if (err === null) return items !== null
  const gated = errorHasTerminalClass(err)
  if (gated !== null) return gated
  return false
}

function stableFilterString(filter: SessionListParityFilter): string {
  const keys = Object.keys(filter as Record<string, unknown>).sort()
  const parts: string[] = []
  for (const k of keys) parts.push(`${k}=${JSON.stringify((filter as Record<string, unknown>)[k])}`)
  return parts.join("&")
}

/**
 * Fallback dedupe for connections without keyed registration: pending
 * deferred keys per connection instance. Bounded by distinct
 * epoch+directory+workspace+filter triples; no timers, no polling.
 */
const deferredSessionListKeysByConnection = new WeakMap<object, Set<string>>()

function deferredSessionListKey(
  epoch: number | null,
  dir: string,
  workspace: string | undefined,
  filter: SessionListParityFilter,
): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const ws =
    workspace === undefined ? "none" : `h-${crypto.createHash("sha256").update(workspace, "utf8").digest("hex")}`
  const f = `h-${crypto.createHash("sha256").update(stableFilterString(filter), "utf8").digest("hex")}`
  return `session-list:${epoch ?? "none"}:${canonical}:${ws}:${f}`
}

function ambiguousSessionListResult(req: ServePrivateSessionListRequest): ServePrivateSessionListResult {
  return {
    v: 2,
    requestId: req.requestId,
    opId: req.opId,
    op: "experimental/session/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as ServePrivateSessionListResult
}

function cancelObserverTimeout(
  connection: SessionListParityConnection,
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
      console.warn("[Kilo SessionList] handle.cancel failed:", { op: "experimental/session/list", cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      console.warn("[Kilo SessionList] tryCancelPrivatePending failed:", {
        op: "experimental/session/list",
        cancelFailed: true,
      })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo SessionList] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "experimental/session/list",
      stale: true,
    })
    return
  }
  if (result === true) {
    console.warn(`[Kilo SessionList] private parity timeout after ${timeoutMs}ms:`, {
      op: "experimental/session/list",
      timeoutMs,
    })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo SessionList] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "experimental/session/list",
      stale: true,
    })
    return
  }
  if (invalidate) {
    try {
      invalidate("session-list observer timeout")
    } catch {
      console.warn("[Kilo SessionList] invalidatePrivatePeerOnObserverTimeout failed:", {
        op: "experimental/session/list",
        invalidateFailed: true,
      })
    }
  }
  console.warn(`[Kilo SessionList] private parity timeout after ${timeoutMs}ms:`, {
    op: "experimental/session/list",
    timeoutMs,
  })
}

function reportSessionListValid(
  result: ServePrivateSessionListResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): void {
  const parity = compareSessionListParity(result, sdk)
  if (parity.divergence) console.warn("[Kilo SessionList] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown)
    console.warn("[Kilo SessionList] transport-unknown parity:", {
      op: "experimental/session/list",
      transportUnknown: true,
    })
}

function validationDivergence(): void {
  console.warn("[Kilo SessionList] validation divergence:", { op: "experimental/session/list", invalid: true })
}

async function observeViaOutcome(
  connection: SessionListParityConnection,
  handle: { id: number; promise: Promise<PrivateSessionListWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: ServePrivateSessionListRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: PrivateSessionListWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isPrivateSessionListValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as PrivateSessionListWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, timeoutMs, epochAtStart)
      return { kind: "valid", result: ambiguousSessionListResult(req) } as PrivateSessionListWireOutcome
    })
  } catch (e) {
    if (isPrivateSessionListValidationError(e)) {
      console.warn("[Kilo SessionList] validation divergence:", { op: "experimental/session/list", invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousSessionListResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    validationDivergence()
    return
  }
  reportSessionListValid(outcome.result, sdk)
}

async function observeSessionListParity(
  connection: SessionListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  filter: SessionListParityFilter,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferSessionListParityAfterNegotiation(
      connection,
      sdk,
      dir,
      workspace,
      filter,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const req: ServePrivateSessionListRequest = {
      v: 2,
      requestId,
      opId,
      op: "experimental/session/list",
      idempotencyKey,
      context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
      payload: { filter: { ...filter } },
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privateSessionListOutcomeWithHandle.bind(connection)
      const handle = factory(req)
      await observeViaOutcome(connection, handle, req, sdk, timeoutMs, epochAtStart)
      return
    } catch (e) {
      if (isPrivateSessionListValidationError(e)) {
        console.warn("[Kilo SessionList] validation divergence:", { op: "experimental/session/list", invalid: true })
        return
      }
      throw e
    }
  } catch {
    console.warn("[Kilo SessionList] private parity observation failed (fail-closed):", {
      op: "experimental/session/list",
      observationFailed: true,
    })
  }
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches session state, events, or errors.
 * Different filter combinations are different observations; the deferred key
 * binds the exact filter so observations never compare across queries.
 */
function deferSessionListParityAfterNegotiation(
  connection: SessionListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  filter: SessionListParityFilter,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeSessionListParity(
      connection,
      sdk,
      dir,
      workspace,
      filter,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    ).catch(() =>
      console.warn("[Kilo SessionList] private parity observation failed (fail-closed):", {
        op: "experimental/session/list",
        observationFailed: true,
      }),
    )
  }
  const add = connection.addDeferredSessionListObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, workspace, filter, observe)
    } catch {
      console.warn("[Kilo SessionList] deferred parity subscribe failed (fail-closed):", {
        op: "experimental/session/list",
        subscribeFailed: true,
      })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        console.warn("[Kilo SessionList] deferred parity unsubscribe failed (fail-closed):", {
          op: "experimental/session/list",
          unsubscribeFailed: true,
        })
      }
      observe()
    }
    return
  }
  deferSessionListFallback(connection, sdk, dir, workspace, filter, opId, idempotencyKey, requestId, timeoutMs, observe)
}

function deferSessionListFallback(
  connection: SessionListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  filter: SessionListParityFilter,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
  observe: () => void,
): void {
  const epochAtDefer = connection.getPrivateEpoch?.() ?? null
  const key = deferredSessionListKey(epochAtDefer, dir, workspace, filter)
  let keys = deferredSessionListKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredSessionListKeysByConnection.set(connection, keys)
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
        console.warn("[Kilo SessionList] deferred parity unsubscribe failed (fail-closed):", {
          op: "experimental/session/list",
          unsubscribeFailed: true,
        })
      }
      fireDeferredSessionList(connection, epochAtDefer, observe)
    })
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo SessionList] deferred parity unsubscribe failed (fail-closed):", {
          op: "experimental/session/list",
          unsubscribeFailed: true,
        })
      }
      fireDeferredSessionList(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    console.warn("[Kilo SessionList] deferred parity subscribe failed (fail-closed):", {
      op: "experimental/session/list",
      subscribeFailed: true,
    })
  }
}

function fireDeferredSessionList(
  connection: SessionListParityConnection,
  epochAtDefer: number | null,
  observe: () => void,
): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (now !== epochAtDefer) {
    console.warn("[Kilo SessionList] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchSessionListParity(
  connection: SessionListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  filter: SessionListParityFilter,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeSessionListParity(
      connection,
      sdk,
      dir,
      workspace,
      filter,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
    void pending.catch(() =>
      console.warn("[Kilo SessionList] private parity observation failed (fail-closed):", {
        op: "experimental/session/list",
        observationFailed: true,
      }),
    )
  } catch {
    console.warn("[Kilo SessionList] private parity observation failed (fail-closed):", {
      op: "experimental/session/list",
      observationFailed: true,
    })
  }
}

/**
 * Detached SDK-first `experimental/session/list` parity observer.
 *
 * Call only after the SDK `experimental.session.list` has settled with a
 * terminal result (array data with optional `x-next-cursor` header, or a
 * terminal HTTP-class failure). The SDK result stays authoritative: this
 * never mutates session state, events, errors, pagination, or UI, and never
 * retries/replays the SDK. It returns synchronously (non-blocking); private
 * work runs detached with the default bounded timeout. Invalid private wire
 * bypasses the comparator and only logs a diagnostic. Shared-id projection
 * differences, membership gaps, and cursor presence/value differences are
 * warn-only observation divergence, never parity failure. Ordering,
 * freshness, and lifecycle remain explicitly unknown and are never compared.
 */
export function observeSessionListParityDetached(
  connection: SessionListParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace?: string,
  filter: SessionListParityFilter = {},
  timeoutMs = SESSION_LIST_PARITY_TIMEOUT_MS,
): void {
  if (!sdkSessionListHasTerminal(sdk)) return
  if (typeof dir !== "string" || dir.length === 0) return
  if (workspace !== undefined && (typeof workspace !== "string" || workspace.length === 0)) return
  if (!isValidSessionListFilter(filter)) return
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildSessionListIdentity()
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch {
    console.warn("[Kilo SessionList] private parity observation failed (fail-closed):", {
      op: "experimental/session/list",
      observationFailed: true,
    })
    return
  }
  launchSessionListParity(connection, sdk, dir, workspace, { ...filter }, opId, idempotencyKey, requestId, timeoutMs)
}
