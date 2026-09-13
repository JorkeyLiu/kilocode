import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { kiloProfileHandle } from "../services/cli-backend/serve-private-kilo-profile-connection"
import {
  isKiloProfileValidationError,
  validateKiloProfileData,
  validateKiloProfileResult,
} from "../services/cli-backend/serve-private-kilo-profile-contract"
import type {
  KiloProfileContractRequest,
  KiloProfileData,
} from "../services/cli-backend/serve-private-kilo-profile-contract"

export type { KiloProfileData }

/**
 * Private-first `kilo/profile` read-only observation (the same gateway
 * `fetchProfile`/`fetchBalance`/`fetchKiloPassState` source as
 * `client.kilo.profile`).
 *
 * One private attempt plus at most one same-directory SDK fallback per read,
 * never retried. Valid private `succeeded`+`accepted` returns SDK-equivalent
 * data with zero SDK; validated terminal `failed` (`retryable === false`,
 * including `validation.failed`/`unauthorized`/`internal`) closes with zero
 * SDK; unavailable/retryable upstream/invalid/ambiguous/transport/closed/
 * timeout takes exactly one same-directory SDK `client.kilo.profile`
 * fallback. Read-only and safely repeatable: no durable op, no journal, no
 * reconcile. No `postMessage`, no retry, no toast, no dispose.
 *
 * Timeout (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport (settled
 * success/terminal across post-response drift is preserved, unresolved drift
 * maps to ambiguous).
 */
export interface KiloProfilePrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateKiloProfileOutcomeWithHandle?: (req: KiloProfileContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildKiloProfileReq(directory: string, workspace?: string): KiloProfileContractRequest {
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    op: "kilo/profile" as const,
    context: workspace === undefined ? { directory } : { directory, workspace },
    payload: {},
  }
}

export type KiloProfileAttempt =
  | { kind: "ok"; data: KiloProfileData }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseKiloProfileResult(result: unknown, req: KiloProfileContractRequest): KiloProfileAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateKiloProfileResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", data: out.data }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateKiloProfileResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private kilo-profile timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: KiloProfilePrivateConnection): {
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

export async function attemptKiloProfilePrivate(
  connection: KiloConnectionService | KiloProfilePrivateConnection | null | undefined,
  req: KiloProfileContractRequest,
  ms = 3000,
): Promise<KiloProfileAttempt> {
  const conn = connection as KiloProfilePrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateKiloProfileOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = kiloProfileHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseKiloProfileResult(outcome.result, req)
  } catch (e) {
    if (isKiloProfileValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private kilo-profile timeout") && handle) {
      try {
        handle.cancel?.(`private kilo-profile timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  kilo: {
    profile: (args?: { directory?: string; workspace?: string }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type KiloProfilePrivateFirstOutcome =
  | { kind: "ok"; data: KiloProfileData; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkData(data: unknown): KiloProfileData | null {
  try {
    return validateKiloProfileData(data)
  } catch {
    return null
  }
}

// Shared private-first profile read: valid private returns SDK-equivalent data
// with zero SDK; validated terminal closes with zero SDK; otherwise exactly
// one same-directory SDK fallback with no retry and no timeout wrapper; SDK
// failure/malformed returns `unavailable` for the caller to handle.
export async function fetchKiloProfilePrivateFirst(opts: {
  connection?: KiloConnectionService | KiloProfilePrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
  workspace?: string
}): Promise<KiloProfilePrivateFirstOutcome> {
  const req = buildKiloProfileReq(opts.directory, opts.workspace)
  const attempt = await attemptKiloProfilePrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", data: attempt.data, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.client
  if (!client?.kilo?.profile) return { kind: "unavailable" }
  try {
    const res =
      opts.workspace === undefined
        ? await client.kilo.profile({ directory: opts.directory })
        : await client.kilo.profile({ directory: opts.directory, workspace: opts.workspace })
    const coerced = coerceSdkData(res.data)
    if (!coerced) {
      if (res.error !== undefined && res.error !== null) return { kind: "unavailable", cause: res.error }
      return { kind: "unavailable" }
    }
    return { kind: "ok", data: coerced, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
