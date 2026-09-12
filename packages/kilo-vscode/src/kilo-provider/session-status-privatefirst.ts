import * as crypto from "crypto"
import type { SessionStatus } from "@kilocode/sdk/v2/client"
import {
  buildStatusOpId,
  isPrivateStatusValidationError,
  validateStatusResult,
  type ServePrivateStatusRequest,
} from "../services/cli-backend/serve-private-peer"

/**
 * Private-first `session/status` read (same `SessionStatus.Service.list()`
 * source as `client.session.status`).
 *
 * Shared by the seed and fork-guard callers. No cache, no post, no
 * reconcile: valid private `succeeded`+`accepted` returns the full map with
 * zero SDK; validated terminal `failed` (`retryable === false`) closes with
 * zero SDK; retryable fence plus unavailable/invalid/ambiguous/transport/
 * closed/timeout takes exactly one same-directory SDK
 * `client.session.status` fallback with no retry. SDK error/malformed
 * returns `unavailable` for the caller to handle.
 *
 * At most one private attempt plus at most one SDK read per call. Timeout
 * (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport.
 */
export interface SessionStatusPrivateConnection {
  isPrivateAvailable(): boolean
  privateStatusOutcomeWithHandle?(req: ServePrivateStatusRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
  privateStatusWithHandle?(req: ServePrivateStatusRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export type SessionStatusMap = Record<string, SessionStatus>

export function buildSessionStatusIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = buildStatusOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildSessionStatusReq(directory: string): ServePrivateStatusRequest {
  const ids = buildSessionStatusIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "session/status" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory },
    payload: {},
  }
}

export type SessionStatusAttempt =
  | { kind: "ok"; statuses: SessionStatusMap }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

const STATUS_TYPES = new Set(["idle", "busy", "retry", "offline"])

export function parseSessionStatusResult(result: unknown, req: ServePrivateStatusRequest): SessionStatusAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateStatusResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", statuses: out.data.statuses as unknown as SessionStatusMap }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateStatusResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.code === "transport") return { kind: "fallback", reason: "transport" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

function unwrapOutcome(raw: unknown): { kind: "outcome"; value: unknown } | { kind: "direct"; value: unknown } {
  const rec = raw as Record<string, unknown> | null
  if (rec && typeof rec === "object" && (rec.kind === "valid" || rec.kind === "invalid")) return { kind: "outcome", value: raw }
  return { kind: "direct", value: raw }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private session-status timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

// eslint-disable-next-line complexity
export async function attemptSessionStatusPrivate(
  connection: SessionStatusPrivateConnection | null | undefined,
  req: ServePrivateStatusRequest,
  ms = 3000,
): Promise<SessionStatusAttempt> {  if (!connection) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!connection.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const outcomeFactory = connection.privateStatusOutcomeWithHandle?.bind(connection) ?? null
    const legacyFactory = connection.privateStatusWithHandle?.bind(connection) ?? null
    if (outcomeFactory) handle = outcomeFactory(req)
    else if (legacyFactory) handle = legacyFactory(req)
    else return { kind: "fallback", reason: "unavailable" }
    const raw = await withTimeout(handle.promise, ms)
    const wrapped = unwrapOutcome(raw)
    if (wrapped.kind === "outcome") {
      const outcome = wrapped.value as { kind: "valid" | "invalid"; result?: unknown; detail?: string }
      if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
      return parseSessionStatusResult(outcome.result, req)
    }
    return parseSessionStatusResult(wrapped.value, req)
  } catch (e) {
    if (isPrivateStatusValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private session-status timeout") && handle) {
      try {
        handle.cancel?.(`private session-status timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  session: {
    status: (params: { directory: string }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type SessionStatusPrivateFirstOutcome =
  | { kind: "ok"; statuses: SessionStatusMap; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isSafeInteger(v)
}

function isSdkEntry(v: unknown): v is SessionStatus {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  const rec = v as Record<string, unknown>
  if (typeof rec.type !== "string" || !STATUS_TYPES.has(rec.type)) return false
  if (rec.type === "retry") {
    if (!isSafeInt(rec.attempt) || typeof rec.message !== "string" || !isSafeInt(rec.next)) return false
    return true
  }
  if (rec.type === "offline") {
    if (typeof rec.requestID !== "string" || !(rec.requestID as string).startsWith("que")) return false
    if (typeof rec.message !== "string") return false
    return true
  }
  return true
}

export function coerceSdkStatuses(data: unknown): SessionStatusMap | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const rec = data as Record<string, unknown>
  for (const v of Object.values(rec)) {
    if (!isSdkEntry(v)) return null
  }
  return rec as unknown as SessionStatusMap
}

// Shared private-first status read: valid private returns with zero SDK;
// validated terminal closes with zero SDK; otherwise exactly one
// same-directory SDK fallback with no retry; SDK failure/malformed returns
// unavailable for the caller to handle.
export async function fetchSessionStatusesPrivateFirst(opts: {
  connection?: SessionStatusPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
  timeoutMs?: number
}): Promise<SessionStatusPrivateFirstOutcome> {
  const req = buildSessionStatusReq(opts.directory)
  const attempt = await attemptSessionStatusPrivate(opts.connection ?? null, req, opts.timeoutMs ?? 3000)
  if (attempt.kind === "ok") return { kind: "ok", statuses: attempt.statuses, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.client
  if (!client?.session?.status) return { kind: "unavailable" }
  try {
    const res = await client.session.status({ directory: opts.directory })
    const coerced = coerceSdkStatuses(res.data)
    if (!coerced) {
      if (res.error !== undefined && res.error !== null) return { kind: "unavailable", cause: res.error }
      return { kind: "unavailable" }
    }
    return { kind: "ok", statuses: coerced, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
