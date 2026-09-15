import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { sandboxStatusHandle } from "../services/cli-backend/serve-private-sandbox-status-connection"
import {
  isSandboxStatusValidationError,
  SANDBOX_STATUS_TERMINAL_CODES,
  validateSandboxStatusData,
  validateSandboxStatusResult,
} from "../services/cli-backend/serve-private-sandbox-status-contract"
import type {
  SandboxStatusContractRequest,
  SandboxStatusData,
} from "../services/cli-backend/serve-private-sandbox-status-contract"

/**
 * Private-first `sandbox/status` read-only observation (the same
 * `SandboxPolicy.status` owner as `client.sandbox.status`).
 *
 * One private attempt plus at most one same-session/directory SDK fallback
 * per read, never retried inside the helper. Valid private
 * `succeeded`+`accepted` returns the exact status with zero SDK (including
 * `available:false` domain data); validated domain terminal `failed`
 * (`retryable === false` with `validation.failed`/`scope_mismatch`/
 * `session.not_found`) closes with zero SDK; retryable fence plus `internal`
 * (`retryable === true`) plus unavailable/capability-missing/invalid/
 * ambiguous/transport/closed/timeout takes exactly one same-session/directory
 * SDK `client.sandbox.status` fallback. Read-only and safely repeatable: no
 * durable op, no journal, no `opId`/`idempotencyKey` (observation identity is
 * `requestId` only). No post, no retry, no cache — the caller keeps revision,
 * generation/client guards, same-directory drift re-fetch, post shape, and
 * failure convergence.
 *
 * Timeout (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport (settled
 * success/terminal across post-response drift is preserved, unresolved drift
 * maps to ambiguous).
 */
export interface SandboxStatusPrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateSandboxStatusOutcomeWithHandle?: (req: SandboxStatusContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildSandboxStatusReq(sessionId: string, directory: string): SandboxStatusContractRequest {
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    op: "sandbox/status" as const,
    context: { directory, sessionId },
    payload: {},
  }
}

export type SandboxStatusAttempt =
  | { kind: "ok"; status: SandboxStatusData }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseSandboxStatusResult(result: unknown, req: SandboxStatusContractRequest): SandboxStatusAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateSandboxStatusResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", status: out.data.status }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateSandboxStatusResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false && SANDBOX_STATUS_TERMINAL_CODES.has(out.failure.code))
        return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: out.failure.code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private sandbox-status timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: SandboxStatusPrivateConnection): {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
} | null {
  const typed = conn as unknown as {
    getPrivatePeer?: () => ServePrivatePeer | null
    getPrivateEpoch?: () => number | null
    invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  }
  if (typeof typed.getPrivatePeer !== "function" || typeof typed.getPrivateEpoch !== "function") return null
  const peer = typed.getPrivatePeer()
  const epoch = typed.getPrivateEpoch() ?? null
  const invalidate = (reason: string) => typed.invalidatePrivatePeerOnObserverTimeout?.(reason)
  return { peer, live: true, epoch, invalidate }
}

export async function attemptSandboxStatusPrivate(
  connection: KiloConnectionService | SandboxStatusPrivateConnection | null | undefined,
  req: SandboxStatusContractRequest,
  ms = 3000,
): Promise<SandboxStatusAttempt> {
  const conn = connection as SandboxStatusPrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateSandboxStatusOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = sandboxStatusHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseSandboxStatusResult(outcome.result, req)
  } catch (e) {
    if (isSandboxStatusValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private sandbox-status timeout") && handle) {
      try {
        handle.cancel?.(`private sandbox-status timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkSandboxClient = {
  sandbox: {
    status: (
      params: { sessionID: string; directory: string },
      opts?: unknown,
    ) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type SandboxStatusPrivateFirstOutcome =
  | { kind: "ok"; status: SandboxStatusData; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkStatus(data: unknown): SandboxStatusData | null {
  try {
    return validateSandboxStatusData(data)
  } catch {
    return null
  }
}

// Shared private-first sandbox status read: valid private returns the exact
// status with zero SDK; validated domain terminal closes with zero SDK;
// otherwise exactly one same-session/directory SDK fallback with no retry and
// no second private call; SDK failure/malformed returns `unavailable` for the
// caller to converge (post error) as before.
export async function fetchSandboxStatusPrivateFirst(opts: {
  connection?: KiloConnectionService | SandboxStatusPrivateConnection | null
  client: SdkSandboxClient | null | undefined
  sessionId: string
  directory: string
}): Promise<SandboxStatusPrivateFirstOutcome> {
  const req = buildSandboxStatusReq(opts.sessionId, opts.directory)
  const attempt = await attemptSandboxStatusPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", status: attempt.status, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const fn = opts.client?.sandbox?.status
  if (typeof fn !== "function") return { kind: "unavailable" }
  try {
    const res = await (fn as (p: unknown, o?: unknown) => Promise<{ data?: unknown; error?: unknown }>).call(
      opts.client?.sandbox,
      { sessionID: opts.sessionId, directory: opts.directory },
      { throwOnError: true },
    )
    const coerced = coerceSdkStatus(res.data)
    if (!coerced) {
      if (res.error !== undefined && res.error !== null) return { kind: "unavailable", cause: res.error }
      return { kind: "unavailable" }
    }
    return { kind: "ok", status: coerced, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
