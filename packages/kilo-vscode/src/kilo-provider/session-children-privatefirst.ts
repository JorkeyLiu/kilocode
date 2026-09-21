import * as crypto from "crypto"
import { isAbsolute, normalize, resolve } from "path"
import type { Session } from "@kilocode/sdk/v2/client"
import {
  canonicalChildrenOpId,
  isPrivateChildrenValidationError,
  validateChildrenResult,
  type ServePrivateChildrenRequest,
} from "../services/cli-backend/serve-private-children"

/**
 * Private-authority `session/children` read (same parent-bound
 * `Session.Service.children` source as `client.session.children`).
 *
 * Bounded authority: valid private `succeeded`+`accepted` (including valid
 * empty) and validated terminal `failed` (`retryable === false`) are
 * authoritative with zero SDK; every other branch — gate-off/not-started/
 * worker-error/transport/protocol/malformed/ambiguous/retryable-fence/timeout/
 * closed — fails closed to explicit `unavailable` with zero SDK calls
 * (`getClientAsync`, `client.session.children`). No second private request,
 * no SDK fallback. Signal is transport-only cancellation via existing
 * `$/cancelRequest` exact-cancel with abort-listener cleanup and
 * before-read `throwIfAborted` guard; signal never becomes a wire payload,
 * no DB-query cancellation, no protocol/schema change.
 *
 * Parent directory is the strict scope; child entries keep their own
 * canonical directories and may differ from the parent directory (unordered
 * parent-project relation, no ordering/revision/cursor contract).
 * `compareChildrenParity` stays as pure diagnostic/test evidence only and
 * issues no third request.
 *
 * Timeout (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport.
 */
export interface SessionChildrenPrivateConnection {
  isPrivateAvailable(): boolean
  privateChildrenOutcomeWithHandle(req: ServePrivateChildrenRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildSessionChildrenIdentity(parentSessionId: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalChildrenOpId(parentSessionId, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildSessionChildrenReq(parentSessionId: string, directory: string): ServePrivateChildrenRequest {
  const ids = buildSessionChildrenIdentity(parentSessionId)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "session/children" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, parentSessionId },
    payload: {},
  }
}

export type SessionChildrenAttempt =
  | { kind: "ok"; children: Session[] }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function isStrictChildren(children: unknown, parentSessionId: string): children is Session[] {
  if (!Array.isArray(children)) return false
  const seen = new Set<string>()
  for (const item of children) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== "string" || rec.id.length === 0) return false
    if (seen.has(rec.id)) return false
    seen.add(rec.id)
    if (rec.parentID !== parentSessionId) return false
    if (typeof rec.directory !== "string" || rec.directory.length === 0) return false
    if (!isAbsolute(rec.directory)) return false
    try {
      const canon = canonicalDir(rec.directory)
      if (!isAbsolute(canon) || canon.includes("\0")) return false
    } catch {
      return false
    }
  }
  return true
}

export function parseSessionChildrenResult(
  result: unknown,
  req: ServePrivateChildrenRequest,
): SessionChildrenAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateChildrenResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      const kids = (out.data as { children: unknown }).children
      if (!isStrictChildren(kids, req.context.parentSessionId)) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", children: kids }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateChildrenResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private session-children timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptSessionChildrenPrivate(
  connection: SessionChildrenPrivateConnection | null | undefined,
  req: ServePrivateChildrenRequest,
  ms = 3000,
  signal?: AbortSignal,
): Promise<SessionChildrenAttempt> {
  if (signal?.aborted) {
    const s = signal
    if (typeof s.throwIfAborted === "function") s.throwIfAborted()
    throw s.reason ?? new DOMException("This operation was aborted", "AbortError")
  }
  if (!connection) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!connection.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  let abortHandler: (() => void) | null = null
  let abortPromise: Promise<never> | null = null
  if (signal) {
    abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        try {
          handle?.cancel?.(`private session-children signal abort opId=${req.opId}`)
        } catch {}
        const reason = (signal as unknown as { reason?: unknown }).reason ?? new DOMException("This operation was aborted", "AbortError")
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      }
      abortHandler = onAbort
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener("abort", onAbort, { once: true })
      }
    })
  }
  try {
    handle = connection.privateChildrenOutcomeWithHandle(req)
    const outcomePromise = withTimeout(handle.promise, ms) as Promise<unknown>
    const raced = abortPromise ? Promise.race([outcomePromise, abortPromise]) : outcomePromise
    const outcome = (await raced) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseSessionChildrenResult(outcome.result, req)
  } catch (e) {
    if (signal?.aborted) throw e
    if (isPrivateChildrenValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private session-children timeout") && handle) {
      try {
        handle.cancel?.(`private session-children timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  } finally {
    if (abortHandler && signal) {
      try {
        signal.removeEventListener("abort", abortHandler)
      } catch {}
    }
  }
}

type SdkClient = {
  session: {
    children: (
      params: { sessionID: string; directory: string },
      opts?: unknown,
    ) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type SessionChildrenPrivateFirstOutcome =
  | { kind: "ok"; children: Session[]; via: "private" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

export type SessionChildrenPrivateOutcome = SessionChildrenPrivateFirstOutcome

export function coerceSdkChildren(data: unknown, parentSessionId: string): Session[] | null {
  if (!Array.isArray(data)) return null
  if (!isStrictChildren(data, parentSessionId)) return null
  return data
}

// Private-authority children read: valid private returns with zero SDK;
// validated terminal closes with zero SDK; every other branch (gate-off/
// not-started/worker-error/transport/protocol/malformed/ambiguous/
// retryable-fence/timeout/closed) fails closed to explicit unavailable with
// zero SDK; no second private request, no SDK fallback. Signal is
// transport-only cancellation via existing `$/cancelRequest` exact-cancel
// with abort-listener cleanup and before-read `throwIfAborted` guard.
export async function fetchSessionChildrenPrivate(opts: {
  connection?: SessionChildrenPrivateConnection | null
  parentSessionId: string
  directory: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<SessionChildrenPrivateOutcome> {
  if (opts.signal?.aborted) {
    const s = opts.signal
    if (typeof s.throwIfAborted === "function") s.throwIfAborted()
    throw s.reason ?? new DOMException("This operation was aborted", "AbortError")
  }
  const req = buildSessionChildrenReq(opts.parentSessionId, opts.directory)
  const attempt = await attemptSessionChildrenPrivate(opts.connection ?? null, req, opts.timeoutMs ?? 3000, opts.signal)
  if (attempt.kind === "ok") return { kind: "ok", children: attempt.children, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  return { kind: "unavailable" }
}

// Legacy alias — now private-authority (zero SDK fallback). The `client`
// parameter is accepted for compatibility but ignored: every gate-off/
// not-started/worker-error/transport/protocol/malformed/ambiguous branch
// fails closed with zero SDK calls and no second private request. Prefer
// `fetchSessionChildrenPrivate` for new call sites.
export async function fetchSessionChildrenPrivateFirst(opts: {
  connection?: SessionChildrenPrivateConnection | null
  client?: SdkClient | null | undefined
  parentSessionId: string
  directory: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<SessionChildrenPrivateFirstOutcome> {
  return fetchSessionChildrenPrivate({
    connection: opts.connection ?? null,
    parentSessionId: opts.parentSessionId,
    directory: opts.directory,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  })
}
