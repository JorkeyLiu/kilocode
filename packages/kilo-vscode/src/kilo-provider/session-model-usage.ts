import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import {
  canonicalSessionModelUsageOpId,
  validateSessionModelUsageResult,
} from "../services/cli-backend/serve-private-session-model-usage-contract"
import type { SessionModelUsagePayload } from "../services/cli-backend/serve-private-session-model-usage-contract"
import { sessionModelUsageOutcomeHandle } from "../services/cli-backend/serve-private-session-model-usage-connection"

export function buildSessionModelUsageIdentity(sessionId: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID()
  const opId = canonicalSessionModelUsageOpId(sessionId, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
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

export type SessionModelUsageAttempt =
  | { kind: "ok"; usage: SessionModelUsagePayload }
  | { kind: "terminal" }
  | { kind: "fallback"; reason: string }

export function parseSessionModelUsageResult(result: unknown, req: unknown): SessionModelUsageAttempt {
  const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      validateSessionModelUsageResult(result as never, req as never)
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const usage = (result as { data?: { usage?: unknown } }).data?.usage
    if (!usage || typeof usage !== "object") return { kind: "fallback", reason: "invalid private usage" }
    return { kind: "ok", usage: usage as SessionModelUsagePayload }
  }
  if (typed.status === "failed") {
    try {
      validateSessionModelUsageResult(result as never, req as never)
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const failure = (result as { failure?: { code?: unknown; retryable?: unknown } }).failure
    if (failure?.retryable === true)
      return { kind: "fallback", reason: String(typeof failure?.code === "string" ? failure.code : "retryable") }
    if (failure?.retryable === false) return { kind: "terminal" }
    return { kind: "fallback", reason: "failed without retryable" }
  }
  return { kind: "fallback", reason: `private not succeeded: ${String(typed.status)}` }
}

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateSessionModelUsageOutcomeWithHandle?: (r: SessionModelUsageReq) => {
    id: number
    promise: Promise<unknown>
    cancel: (msg?: string) => boolean | "stale"
  }
}

type SessionModelUsageReq = {
  v: 1
  requestId: string
  opId: string
  op: "session/model-usage"
  idempotencyKey: string
  context: { directory: string; sessionId: string }
  payload: Record<string, never>
}

export async function attemptSessionModelUsagePrivate(
  connection: KiloConnectionService | Conn | null | undefined,
  req: SessionModelUsageReq,
  ms = 3000,
): Promise<SessionModelUsageAttempt> {
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    if (conn.privateSessionModelUsageOutcomeWithHandle) {
      handle = conn.privateSessionModelUsageOutcomeWithHandle(req)
    } else {
      const peer = conn.getPrivatePeer()
      handle = sessionModelUsageOutcomeHandle(
        {
          peer,
          live: true,
          epoch: conn.getPrivateEpoch(),
          invalidate: (r) => conn.invalidatePrivatePeerOnObserverTimeout?.(r),
        },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseSessionModelUsageResult(outcome.result, req)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private parity timeout") && handle) {
      try {
        handle.cancel?.(`private parity timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}
