import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { sandboxSetHandle } from "../services/cli-backend/serve-private-sandbox-set-connection"
import {
  canonicalSandboxSetOpId,
  validateSandboxSetResult,
} from "../services/cli-backend/serve-private-sandbox-set-contract"
import { isPrivateSandboxSetValidationError } from "../services/cli-backend/serve-private-sandbox-set"
import type { ServePrivateSandboxSetRequest } from "../services/cli-backend/serve-private-sandbox-set"

/**
 * Private-first idempotent `sandbox/set` mutation (same `SandboxPolicy.setGuarded`
 * owner as `POST /session/:sessionID/sandbox/set`; directory/session routing
 * follows production sandbox ownership).
 *
 * One private attempt plus at most one same-target SDK fallback per user
 * action, never retried. Valid private `succeeded`+`accepted` returns with
 * zero SDK; validated terminal `failed` (`retryable === false`) closes with
 * zero SDK; unavailable/capability-missing/invalid/ambiguous/transport/closed/
 * timeout/retryable takes exactly one same-target SDK `client.sandbox.set`
 * fallback. Set is idempotent, so ambiguous safely repeats without toggle-back.
 */
export interface SandboxSetPrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateSandboxSetOutcomeWithHandle?: (req: ServePrivateSandboxSetRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export interface SandboxSetStatus {
  directory: string
  enabled: boolean
  available: boolean
  version: number
  reason?: string
}

export function buildSandboxSetReq(sessionId: string, dir: string, enabled: boolean): ServePrivateSandboxSetRequest {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalSandboxSetOpId(sessionId, token)
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId,
    op: "sandbox/set" as const,
    idempotencyKey: opId,
    context: { directory: dir, sessionId },
    payload: { enabled, sessionId },
  }
}

export type SandboxSetAttempt =
  | { kind: "ok"; status: SandboxSetStatus }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseSandboxSetResult(result: unknown, req: ServePrivateSandboxSetRequest): SandboxSetAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateSandboxSetResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      const st = out.data.status as unknown as Record<string, unknown>
      if (typeof st.directory !== "string" || typeof st.enabled !== "boolean" || typeof st.available !== "boolean")
        return { kind: "fallback", reason: "invalid" }
      if (st.reason !== undefined && typeof st.reason !== "string") return { kind: "fallback", reason: "invalid" }
      if (typeof st.version !== "number" || !Number.isInteger(st.version)) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", status: st as unknown as SandboxSetStatus }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateSandboxSetResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private sandbox-set timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: SandboxSetPrivateConnection): {
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

export async function attemptSandboxSetPrivate(
  connection: KiloConnectionService | SandboxSetPrivateConnection | null | undefined,
  req: ServePrivateSandboxSetRequest,
  ms = 3000,
): Promise<SandboxSetAttempt> {
  const conn = connection as SandboxSetPrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateSandboxSetOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "unavailable" }
      handle = sandboxSetHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseSandboxSetResult(outcome.result, req)
  } catch (e) {
    if (isPrivateSandboxSetValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private sandbox-set timeout") && handle) {
      try {
        handle.cancel?.(`private sandbox-set timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkSandboxClient = {
  sandbox: {
    set: (
      params: { sessionID: string; directory: string; enabled: boolean },
      opts?: unknown,
    ) => Promise<{ data?: unknown; error?: unknown }>
  }
}

function coerceSdkStatus(data: unknown): SandboxSetStatus | null {
  const rec = data as Record<string, unknown> | null
  if (!rec || typeof rec !== "object") return null
  if (typeof rec.directory !== "string" || typeof rec.enabled !== "boolean") return null
  if (typeof rec.available !== "boolean" || typeof rec.version !== "number") return null
  if (rec.reason !== undefined && typeof rec.reason !== "string") return null
  return rec as unknown as SandboxSetStatus
}

export type SandboxSetPrivateFirstOutcome =
  | { kind: "ok"; status: SandboxSetStatus; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

// Shared private-first sandbox set: exactly one private attempt plus at most
// one same-target SDK fallback, never retried. The request snapshot
// (`sessionId`/`directory`/`enabled`) is frozen before the private attempt and
// reused verbatim for the fallback.
export async function setSandboxPrivateFirst(opts: {
  connection?: KiloConnectionService | SandboxSetPrivateConnection | null
  client: SdkSandboxClient | null | undefined
  sessionId: string
  directory: string
  enabled: boolean
}): Promise<SandboxSetPrivateFirstOutcome> {
  const req = buildSandboxSetReq(opts.sessionId, opts.directory, opts.enabled)
  const attempt = await attemptSandboxSetPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", status: attempt.status, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const fn = opts.client?.sandbox?.set
  if (typeof fn !== "function") return { kind: "unavailable" }
  try {
    const res = await (fn as (p: unknown, o?: unknown) => Promise<{ data?: unknown; error?: unknown }>).call(
      opts.client?.sandbox,
      { sessionID: opts.sessionId, directory: opts.directory, enabled: opts.enabled },
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
