import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type {
  ProjectCurrentContractRequest,
  ProjectCurrentResult,
  ProjectCurrentWireOutcome,
} from "../services/cli-backend/serve-private-project-current-contract"
import {
  canonicalProjectCurrentOpId,
  compareProjectCurrentParity,
  isProjectCurrentValidationError,
} from "../services/cli-backend/serve-private-project-current-contract"

/**
 * Minimal structural surface of KiloConnectionService needed for the
 * read-only `project/current` vcs-only parity observer. The connection
 * service itself satisfies this interface; tests supply fakes.
 */
export interface ProjectCurrentParityConnection {
  isPrivateAvailable(): boolean
  privateProjectCurrentOutcomeWithHandle(req: ProjectCurrentContractRequest): {
    id: number
    promise: Promise<ProjectCurrentWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredProjectCurrentObserver?(dir: string, workspace: string | undefined, listener: () => void): () => void
}

export const PROJECT_CURRENT_PARITY_TIMEOUT_MS = 3000

export function buildProjectCurrentIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalProjectCurrentOpId(token)
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

export function sdkProjectCurrentHasTerminal(
  sdk: { data?: unknown; error?: unknown; response?: unknown } | Error | unknown,
): boolean {
  if (sdk instanceof Error) return thrownErrorHasTerminal(sdk as unknown as Record<string, unknown>)
  if (!sdk || typeof sdk !== "object") return false
  const typed = sdk as { data?: unknown; error?: unknown; response?: unknown }
  const resp = (typed as { response?: { status?: unknown } }).response
  if (resp && typeof resp.status === "number" && Number.isInteger(resp.status)) {
    if (TERMINAL_HTTP.has(resp.status)) return true
    if (typed.error) return false
    return isRecordLike(typed.data)
  }
  if (!typed.error) return isRecordLike(typed.data)
  const gated = errorHasTerminalClass(typed.error as Record<string, unknown>)
  if (gated !== null) return gated
  return false
}

function isRecordLike(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/**
 * Fallback-only dedupe for connections without keyed registration: pending
 * deferred keys per connection instance. Bounded by distinct opaque
 * epoch+directory+workspace digest triples with `project-current/epoch`,
 * `project-current/dir`, `project-current/workspace` domains; no timers, no
 * polling. The production owner `DeferredProjectCurrent` holds its own
 * opaque key in the same digest style; this fallback form lives only in this
 * per-connection set and never the production key. Exact `dir`/`workspace`
 * closure values stay with the caller for request construction; only the
 * digest key is stored here. Serialized keys never carry raw
 * directory/workspace material and `:` inside a raw value cannot collide
 * across tuples.
 */
const deferredProjectCurrentKeysByConnection = new WeakMap<object, Set<string>>()

export function deferredProjectCurrentKey(epoch: number | null, dir: string, workspace: string | undefined): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const epochPart =
    epoch === null
      ? "none"
      : `e-${crypto.createHash("sha256").update(`project-current/epoch\x00${epoch}`, "utf8").digest("hex")}`
  const dirPart = `d-${crypto.createHash("sha256").update(`project-current/dir\x00${canonical}`, "utf8").digest("hex")}`
  const wsPart =
    workspace === undefined
      ? "none"
      : `w-${crypto.createHash("sha256").update(`project-current/workspace\x00${workspace}`, "utf8").digest("hex")}`
  return `project-current:${epochPart}:${dirPart}:${wsPart}`
}

function ambiguousProjectCurrentResult(req: ProjectCurrentContractRequest): ProjectCurrentResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "project/current",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  } as ProjectCurrentResult
}

function cancelObserverTimeout(
  connection: ProjectCurrentParityConnection,
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
      console.warn("[Kilo ProjectCurrent] handle.cancel failed:", { op: "project/current", cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      console.warn("[Kilo ProjectCurrent] tryCancelPrivatePending failed:", {
        op: "project/current",
        cancelFailed: true,
      })
      result = false
    }
  }
  if (result === "stale") {
    console.warn(`[Kilo ProjectCurrent] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "project/current",
      stale: true,
    })
    return
  }
  if (result === true) {
    console.warn(`[Kilo ProjectCurrent] private parity timeout after ${timeoutMs}ms:`, {
      op: "project/current",
      timeoutMs,
    })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn(`[Kilo ProjectCurrent] stale observer timeout skipped invalidation (epoch changed):`, {
      op: "project/current",
      stale: true,
    })
    return
  }
  if (invalidate) {
    try {
      invalidate("project-current observer timeout")
    } catch {
      console.warn("[Kilo ProjectCurrent] invalidatePrivatePeerOnObserverTimeout failed:", {
        op: "project/current",
        invalidateFailed: true,
      })
    }
  }
  console.warn(`[Kilo ProjectCurrent] private parity timeout after ${timeoutMs}ms:`, {
    op: "project/current",
    timeoutMs,
  })
}

function reportProjectCurrentValid(
  result: ProjectCurrentResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): void {
  const parity = compareProjectCurrentParity(result, sdk)
  if (parity.divergence) console.warn("[Kilo ProjectCurrent] parity divergence:", parity.divergence, parity.details)
  else if ((result as Record<string, unknown>).transportUnknown)
    console.warn("[Kilo ProjectCurrent] transport-unknown parity:", { op: "project/current", transportUnknown: true })
}

async function observeViaOutcome(
  connection: ProjectCurrentParityConnection,
  handle: { id: number; promise: Promise<ProjectCurrentWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: ProjectCurrentContractRequest,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: ProjectCurrentWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isProjectCurrentValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as ProjectCurrentWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, timeoutMs, epochAtStart)
      return { kind: "valid", result: ambiguousProjectCurrentResult(req) } as ProjectCurrentWireOutcome
    })
  } catch (e) {
    if (isProjectCurrentValidationError(e)) {
      console.warn("[Kilo ProjectCurrent] validation divergence:", { op: "project/current", invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousProjectCurrentResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    console.warn("[Kilo ProjectCurrent] validation divergence:", { op: "project/current", invalid: true })
    return
  }
  reportProjectCurrentValid(outcome.result, sdk)
}

async function observeProjectCurrentParity(
  connection: ProjectCurrentParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferProjectCurrentParityAfterNegotiation(
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
    const req: ProjectCurrentContractRequest = {
      v: 1,
      requestId,
      opId,
      op: "project/current",
      idempotencyKey,
      context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
      payload: {},
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privateProjectCurrentOutcomeWithHandle.bind(connection)
      const handle = factory(req)
      await observeViaOutcome(connection, handle, req, sdk, timeoutMs, epochAtStart)
      return
    } catch (e) {
      if (isProjectCurrentValidationError(e)) {
        console.warn("[Kilo ProjectCurrent] validation divergence:", { op: "project/current", invalid: true })
        return
      }
      throw e
    }
  } catch {
    console.warn("[Kilo ProjectCurrent] private parity observation failed (fail-closed):", {
      op: "project/current",
      observationFailed: true,
    })
  }
}

/**
 * One-shot late observation when the private peer was still negotiating at
 * SDK-apply time. Re-runs exactly one read-only parity observation when the
 * current backend's negotiation completes. The SDK snapshot stays
 * authoritative — this never touches git state, cache, UI, or errors.
 */
function deferProjectCurrentParityAfterNegotiation(
  connection: ProjectCurrentParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeProjectCurrentParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs).catch(
      () =>
        console.warn("[Kilo ProjectCurrent] private parity observation failed (fail-closed):", {
          op: "project/current",
          observationFailed: true,
        }),
    )
  }
  const add = connection.addDeferredProjectCurrentObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, workspace, observe)
    } catch {
      console.warn("[Kilo ProjectCurrent] deferred parity subscribe failed (fail-closed):", {
        op: "project/current",
        subscribeFailed: true,
      })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        console.warn("[Kilo ProjectCurrent] deferred parity unsubscribe failed (fail-closed):", {
          op: "project/current",
          unsubscribeFailed: true,
        })
      }
      observe()
    }
    return
  }
  deferProjectCurrentFallback(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs, observe)
}

function deferProjectCurrentFallback(
  connection: ProjectCurrentParityConnection,
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
  const key = deferredProjectCurrentKey(epochAtDefer, dir, workspace)
  let keys = deferredProjectCurrentKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredProjectCurrentKeysByConnection.set(connection, keys)
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
        console.warn("[Kilo ProjectCurrent] deferred parity unsubscribe failed (fail-closed):", {
          op: "project/current",
          unsubscribeFailed: true,
        })
      }
      fireDeferredProjectCurrent(connection, epochAtDefer, observe)
    })
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo ProjectCurrent] deferred parity unsubscribe failed (fail-closed):", {
          op: "project/current",
          unsubscribeFailed: true,
        })
      }
      fireDeferredProjectCurrent(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    console.warn("[Kilo ProjectCurrent] deferred parity subscribe failed (fail-closed):", {
      op: "project/current",
      subscribeFailed: true,
    })
  }
}

function fireDeferredProjectCurrent(
  connection: ProjectCurrentParityConnection,
  epochAtDefer: number | null,
  observe: () => void,
): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (now !== epochAtDefer) {
    console.warn("[Kilo ProjectCurrent] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchProjectCurrentParity(
  connection: ProjectCurrentParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace: string | undefined,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeProjectCurrentParity(
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
      console.warn("[Kilo ProjectCurrent] private parity observation failed (fail-closed):", {
        op: "project/current",
        observationFailed: true,
      }),
    )
  } catch {
    console.warn("[Kilo ProjectCurrent] private parity observation failed (fail-closed):", {
      op: "project/current",
      observationFailed: true,
    })
  }
}

/**
 * Detached SDK-first `project/current` vcs-only parity observer.
 *
 * Call only after the SDK `project.current` has settled with a terminal
 * result (project data, or a terminal HTTP-class failure). The SDK result
 * stays authoritative: this never mutates git state, cache, UI, errors, or
 * caches, and never retries/replays the SDK. It returns synchronously
 * (non-blocking); private work runs detached with the default bounded
 * timeout. Invalid private wire bypasses the comparator and only logs a
 * diagnostic. Both sides compare as the derived `hasGit` boolean
 * (`vcs === "git"`); ordering, directory, and freshness remain explicitly
 * unknown and are never compared.
 */
export function observeProjectCurrentParityDetached(
  connection: ProjectCurrentParityConnection,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace?: string,
  timeoutMs = PROJECT_CURRENT_PARITY_TIMEOUT_MS,
): void {
  if (!sdkProjectCurrentHasTerminal(sdk)) return
  if (typeof dir !== "string" || dir.length === 0) return
  if (workspace !== undefined && (typeof workspace !== "string" || workspace.length === 0)) return
  let opId: string
  let idempotencyKey: string
  let requestId: string
  try {
    const ident = buildProjectCurrentIdentity()
    opId = ident.opId
    idempotencyKey = ident.idempotencyKey
    requestId = ident.requestId
  } catch {
    console.warn("[Kilo ProjectCurrent] private parity observation failed (fail-closed):", {
      op: "project/current",
      observationFailed: true,
    })
    return
  }
  launchProjectCurrentParity(connection, sdk, dir, workspace, opId, idempotencyKey, requestId, timeoutMs)
}
