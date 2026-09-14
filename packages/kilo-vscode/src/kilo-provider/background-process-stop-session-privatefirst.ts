import * as crypto from "crypto"
import {
  canonicalBackgroundStopSessionOpId,
  validateBackgroundStopSessionResult,
} from "../services/cli-backend/serve-private-background-process-stop-session-contract"
import { isPrivateBackgroundStopSessionValidationError } from "../services/cli-backend/serve-private-background-process-stop-session"
import type { ServePrivateBackgroundStopSessionRequest } from "../services/cli-backend/serve-private-background-process-stop-session"

/**
 * Private-first `background-process/stop-session` cleanup (the same
 * `BackgroundProcess.stopSession` owner as `client.backgroundProcess.
 * stopSession`; `directory` + `sessionId` are routing identity only).
 *
 * One private attempt plus at most one same-identity SDK fallback per cleanup,
 * never retried. Valid private `succeeded`+`accepted` returns with zero SDK;
 * validated terminal `failed` (`retryable === false`) closes with zero SDK;
 * unavailable/retryable/invalid/ambiguous/transport/closed/timeout takes
 * exactly one same-identity SDK `backgroundProcess.stopSession` fallback.
 * Stopping is idempotent, so an ambiguous private outcome may safely repeat
 * via the SDK fallback.
 */
export interface BackgroundStopSessionPrivateConnection {
  isPrivateAvailable(): boolean
  privateBackgroundStopSessionOutcomeWithHandle(req: ServePrivateBackgroundStopSessionRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildBackgroundStopSessionIdentity(): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalBackgroundStopSessionOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildBackgroundStopSessionReq(
  sessionId: string,
  dir: string,
): ServePrivateBackgroundStopSessionRequest {
  const ids = buildBackgroundStopSessionIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "background-process/stop-session" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory: dir, sessionId },
    payload: {},
  }
}

export type BackgroundStopSessionAttempt =
  | { kind: "ok" }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseBackgroundStopSessionResult(
  result: unknown,
  req: ServePrivateBackgroundStopSessionRequest,
): BackgroundStopSessionAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateBackgroundStopSessionResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateBackgroundStopSessionResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: `private not succeeded: ${String(rec.status)}` }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private background-stop-session timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptBackgroundStopSessionPrivate(
  connection: BackgroundStopSessionPrivateConnection | null | undefined,
  req: ServePrivateBackgroundStopSessionRequest,
  ms = 3000,
): Promise<BackgroundStopSessionAttempt> {
  const conn = connection
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = conn.privateBackgroundStopSessionOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseBackgroundStopSessionResult(outcome.result, req)
  } catch (e) {
    if (isPrivateBackgroundStopSessionValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private background-stop-session timeout") && handle) {
      try {
        handle.cancel?.(`private background-stop-session timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  backgroundProcess: {
    stopSession: (params: { sessionID: string; directory: string }) => Promise<unknown>
  }
}

export type BackgroundStopSessionPrivateFirstOutcome =
  | { kind: "ok"; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable" }

// Shared private-first background stop-session cleanup: valid private returns
// with zero SDK; validated terminal closes with zero SDK; otherwise exactly
// one same-identity SDK `backgroundProcess.stopSession` fallback with no
// retry. Stopping is idempotent, so an ambiguous private outcome may safely
// repeat via the SDK fallback. SDK fallback rejection throws so the outer
// `stopSessionProcesses` warn-only wrapper emits the original fixed-prefix
// warning with the same error object. Logs use fixed categories with opaque
// op IDs; session IDs and directories are never logged.
export async function stopSessionProcessesPrivateFirst(opts: {
  connection?: BackgroundStopSessionPrivateConnection | null
  client: SdkClient | null | undefined
  sessionId: string
  directory: string
  timeoutMs?: number
}): Promise<BackgroundStopSessionPrivateFirstOutcome> {
  const req = buildBackgroundStopSessionReq(opts.sessionId, opts.directory)
  const attempt = await attemptBackgroundStopSessionPrivate(opts.connection ?? null, req, opts.timeoutMs ?? 3000)
  if (attempt.kind === "ok") return { kind: "ok", via: "private" }
  if (attempt.kind === "terminal") {
    console.warn("[Kilo New] background stop-session private terminal:", {
      code: attempt.code ?? "unknown",
      opId: req.opId,
    })
    return { kind: "terminal", code: attempt.code }
  }
  if (attempt.reason !== "unavailable") {
    console.warn("[Kilo New] background stop-session private fallback:", { reason: attempt.reason, opId: req.opId })
  }
  const fn = opts.client?.backgroundProcess?.stopSession
  if (typeof fn !== "function") return { kind: "unavailable" }
  await (fn as (p: { sessionID: string; directory: string }) => Promise<unknown>).call(opts.client?.backgroundProcess, {
    sessionID: opts.sessionId,
    directory: opts.directory,
  })
  return { kind: "ok", via: "sdk" }
}
