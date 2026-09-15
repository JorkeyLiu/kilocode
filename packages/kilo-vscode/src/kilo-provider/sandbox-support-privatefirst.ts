import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { sandboxSupportHandle } from "../services/cli-backend/serve-private-sandbox-support-connection"
import {
  isSandboxSupportValidationError,
  SANDBOX_SUPPORT_TERMINAL_CODES,
  validateSandboxSupportData,
  validateSandboxSupportResult,
} from "../services/cli-backend/serve-private-sandbox-support-contract"
import type {
  SandboxSupportContractRequest,
  SandboxSupportData,
} from "../services/cli-backend/serve-private-sandbox-support-contract"

/**
 * Private-first `sandbox/support` sessionless directory-scoped read (the same
 * `SandboxPolicy.configuredSupport` owner as `client.sandbox.support`).
 *
 * One private attempt plus at most one same-directory SDK fallback per read,
 * never retried inside the helper. Valid private `succeeded`+`accepted`
 * returns the exact support payload with zero SDK (including
 * `available:false` domain data); validated terminal `failed`
 * (`retryable === false` with `validation.failed`/`scope_mismatch`) closes
 * with zero SDK; retryable fence plus `internal` (`retryable === true`) plus
 * unavailable/capability-missing/invalid/ambiguous/transport/closed/timeout
 * takes exactly one same-directory SDK `client.sandbox.support` fallback.
 * Read-only and safely repeatable: no durable op, no journal, no
 * `opId`/`idempotencyKey` (observation identity is `requestId` only). No
 * post, no retry, no cache — the caller keeps revision, generation/client
 * guards, `Promise.all` parallelism with `sandboxDefault`, post shape, and
 * validation-before-persist ordering.
 *
 * Timeout (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport (settled
 * success/terminal across post-response drift is preserved, unresolved drift
 * maps to ambiguous).
 */
export interface SandboxSupportPrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateSandboxSupportOutcomeWithHandle?: (req: SandboxSupportContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildSandboxSupportReq(directory: string): SandboxSupportContractRequest {
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    op: "sandbox/support" as const,
    context: { directory },
    payload: {},
  }
}

export type SandboxSupportAttempt =
  | { kind: "ok"; support: SandboxSupportData }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseSandboxSupportResult(result: unknown, req: SandboxSupportContractRequest): SandboxSupportAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateSandboxSupportResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", support: out.data }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateSandboxSupportResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false && SANDBOX_SUPPORT_TERMINAL_CODES.has(out.failure.code))
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
    timer = setTimeout(() => reject(new Error(`private sandbox-support timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: SandboxSupportPrivateConnection): {
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

export async function attemptSandboxSupportPrivate(
  connection: KiloConnectionService | SandboxSupportPrivateConnection | null | undefined,
  req: SandboxSupportContractRequest,
  ms = 3000,
): Promise<SandboxSupportAttempt> {
  const conn = connection as SandboxSupportPrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateSandboxSupportOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = sandboxSupportHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseSandboxSupportResult(outcome.result, req)
  } catch (e) {
    if (isSandboxSupportValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private sandbox-support timeout") && handle) {
      try {
        handle.cancel?.(`private sandbox-support timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkSandboxClient = {
  sandbox: {
    support: (params: { directory: string }, opts?: unknown) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type SandboxSupportPrivateFirstOutcome =
  | { kind: "ok"; support: SandboxSupportData; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkSupport(data: unknown): SandboxSupportData | null {
  try {
    return validateSandboxSupportData(data)
  } catch {
    return null
  }
}

// Shared private-first sandbox support read: valid private returns the exact
// support payload with zero SDK; validated terminal closes with zero SDK;
// otherwise exactly one same-directory SDK fallback with no retry and no
// second private call; SDK failure/malformed returns `unavailable` for the
// caller to converge (fail-closed post / validation-before-persist) as before.
export async function fetchSandboxSupportPrivateFirst(opts: {
  connection?: KiloConnectionService | SandboxSupportPrivateConnection | null
  client: SdkSandboxClient | null | undefined
  directory: string
}): Promise<SandboxSupportPrivateFirstOutcome> {
  const req = buildSandboxSupportReq(opts.directory)
  const attempt = await attemptSandboxSupportPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", support: attempt.support, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const fn = opts.client?.sandbox?.support
  if (typeof fn !== "function") return { kind: "unavailable" }
  try {
    const res = await (fn as (p: unknown, o?: unknown) => Promise<{ data?: unknown; error?: unknown }>).call(
      opts.client?.sandbox,
      { directory: opts.directory },
      { throwOnError: true },
    )
    const coerced = coerceSdkSupport(res.data)
    if (!coerced) {
      if (res.error !== undefined && res.error !== null) return { kind: "unavailable", cause: res.error }
      return { kind: "unavailable" }
    }
    return { kind: "ok", support: coerced, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
