import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { kiloAuthStatusHandle } from "../services/cli-backend/serve-private-kilo-auth-status-connection"
import {
  isKiloAuthStatusValidationError,
  validateKiloAuthStatusData,
  validateKiloAuthStatusResult,
} from "../services/cli-backend/serve-private-kilo-auth-status-contract"
import type {
  KiloAuthStatusContractRequest,
  KiloAuthStatusData,
} from "../services/cli-backend/serve-private-kilo-auth-status-contract"

export type { KiloAuthStatusData }

/**
 * Private-first `kilo/auth-status` read-only observation (the same
 * `Auth.Service.get("kilo")` + `getToken` projection as
 * `client.kilo.authStatus`).
 *
 * One private attempt plus at most one same-directory SDK fallback per read,
 * never retried inside the helper. Valid private `succeeded`+`accepted`
 * returns the closed `{authenticated,type?}` shape with zero SDK; validated
 * terminal `failed` (`retryable === false`, including `validation.failed`/
 * `internal`) closes with zero SDK; unavailable/retryable/invalid/ambiguous/
 * transport/closed/timeout takes exactly one same-directory SDK
 * `client.kilo.authStatus` fallback. Read-only and safely repeatable: no
 * durable op, no journal, no reconcile, no `opId`/`idempotencyKey`
 * (observation identity is `requestId` only). No `postMessage`, no retry, no
 * cache, no journal — the caller keeps catalog authority and `provider.auth`
 * failure isolation with `catch`-to-`null` degradation.
 *
 * Timeout (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport (settled
 * success/terminal across post-response drift is preserved, unresolved drift
 * maps to ambiguous).
 */
export interface KiloAuthStatusPrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateKiloAuthStatusOutcomeWithHandle?: (req: KiloAuthStatusContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildKiloAuthStatusReq(directory: string, workspace?: string): KiloAuthStatusContractRequest {
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    op: "kilo/auth-status" as const,
    context: workspace === undefined ? { directory } : { directory, workspace },
    payload: {},
  }
}

export type KiloAuthStatusAttempt =
  | { kind: "ok"; data: KiloAuthStatusData }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseKiloAuthStatusResult(
  result: unknown,
  req: KiloAuthStatusContractRequest,
): KiloAuthStatusAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateKiloAuthStatusResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", data: out.data }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateKiloAuthStatusResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private kilo-auth-status timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: KiloAuthStatusPrivateConnection): {
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

export async function attemptKiloAuthStatusPrivate(
  connection: KiloConnectionService | KiloAuthStatusPrivateConnection | null | undefined,
  req: KiloAuthStatusContractRequest,
  ms = 3000,
): Promise<KiloAuthStatusAttempt> {
  const conn = connection as KiloAuthStatusPrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateKiloAuthStatusOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = kiloAuthStatusHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseKiloAuthStatusResult(outcome.result, req)
  } catch (e) {
    if (isKiloAuthStatusValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private kilo-auth-status timeout") && handle) {
      try {
        handle.cancel?.(`private kilo-auth-status timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  kilo: {
    authStatus: (args: { directory: string }, opts: { throwOnError: boolean }) => Promise<{ data?: unknown }>
  }
}

export type KiloAuthStatusPrivateFirstOutcome =
  | { kind: "ok"; data: KiloAuthStatusData; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkData(data: unknown): KiloAuthStatusData | null {
  try {
    return validateKiloAuthStatusData(data)
  } catch {
    return null
  }
}

// Shared private-first auth-status read: valid private returns the closed
// `{authenticated,type?}` shape with zero SDK; validated terminal closes with
// zero SDK (the caller degrades to `null`); otherwise exactly one
// same-directory SDK fallback with no retry and no timeout wrapper; SDK
// failure/malformed returns `unavailable` for the caller to degrade.
export async function fetchKiloAuthStatusPrivateFirst(opts: {
  connection?: KiloConnectionService | KiloAuthStatusPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
}): Promise<KiloAuthStatusPrivateFirstOutcome> {
  const req = buildKiloAuthStatusReq(opts.directory)
  const attempt = await attemptKiloAuthStatusPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", data: attempt.data, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.client
  if (typeof client?.kilo?.authStatus !== "function") return { kind: "unavailable" }
  try {
    const res = await client.kilo.authStatus({ directory: opts.directory }, { throwOnError: true })
    const coerced = coerceSdkData((res as { data?: unknown }).data)
    if (!coerced) return { kind: "unavailable" }
    return { kind: "ok", data: coerced, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
