import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { kiloAuthStatusHandle } from "../services/cli-backend/serve-private-kilo-auth-status-connection"
import {
  isKiloAuthStatusValidationError,
  validateKiloAuthStatusResult,
} from "../services/cli-backend/serve-private-kilo-auth-status-contract"
import type {
  KiloAuthStatusContractRequest,
  KiloAuthStatusData,
} from "../services/cli-backend/serve-private-kilo-auth-status-contract"

export type { KiloAuthStatusData }

/**
 * Private-authority `kilo/auth-status` read-only observation (the same
 * `Auth.Service.get("kilo")` + `getToken` projection as `GET /kilo/auth-status`).
 *
 * Exactly one private attempt per read with zero SDK, never retried inside the
 * helper. Valid private `succeeded`+`accepted` returns the closed
 * `{authenticated,type?}` shape; validated terminal `failed`
 * (`retryable === false`, including `validation.failed`/`internal`) remains
 * terminal; unavailable/missing-capability/invalid/ambiguous/transport/closed/
 * timeout map to explicit unavailable. There is no config fence for this op.
 * Read-only and safely repeatable: no durable op, no journal, no reconcile, no
 * `opId`/`idempotencyKey` (observation identity is `requestId` only). No
 * `postMessage`, no retry, no cache — the caller keeps catalog authority and
 * `provider.auth` failure isolation with `catch`-to-`null` degradation.
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
  | { kind: "unavailable"; reason: string }

export function parseKiloAuthStatusResult(
  result: unknown,
  req: KiloAuthStatusContractRequest,
): KiloAuthStatusAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "unavailable", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "unavailable", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "unavailable", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateKiloAuthStatusResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "unavailable", reason: "invalid" }
      return { kind: "ok", data: out.data }
    } catch {
      return { kind: "unavailable", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateKiloAuthStatusResult(result, req)
      if (out.status !== "failed") return { kind: "unavailable", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "unavailable", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "unavailable", reason: "failed without retryable" }
    } catch {
      return { kind: "unavailable", reason: "invalid" }
    }
  }
  return { kind: "unavailable", reason: "invalid" }
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
  if (!conn) return { kind: "unavailable", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "unavailable", reason: "unavailable" }
  } catch {
    return { kind: "unavailable", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateKiloAuthStatusOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "unavailable", reason: "missing-capability" }
      handle = kiloAuthStatusHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "unavailable", reason: "invalid" }
    return parseKiloAuthStatusResult(outcome.result, req)
  } catch (e) {
    if (isKiloAuthStatusValidationError(e)) return { kind: "unavailable", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private kilo-auth-status timeout") && handle) {
      try {
        handle.cancel?.(`private kilo-auth-status timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "unavailable", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "unavailable", reason: "transport" }
    return { kind: "unavailable", reason: msg.slice(0, 120) }
  }
}

export type KiloAuthStatusPrivateOutcome =
  | { kind: "ok"; data: KiloAuthStatusData }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable" }

// Shared private-authority auth-status read: valid private `succeeded+accepted`
// returns the exact `{authenticated,type?}` shape with zero SDK; validated
// non-retryable terminal (`retryable === false`) remains terminal with zero
// SDK; unavailable, missing capability, invalid, ambiguous/epoch drift,
// transport/closed, and timeout return explicit unavailable with zero SDK and
// no retry. Never falls back to stale data as a new success.
export async function fetchKiloAuthStatusPrivate(opts: {
  connection?: KiloConnectionService | KiloAuthStatusPrivateConnection | null
  directory: string
}): Promise<KiloAuthStatusPrivateOutcome> {
  const req = buildKiloAuthStatusReq(opts.directory)
  const attempt = await attemptKiloAuthStatusPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", data: attempt.data }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  return { kind: "unavailable" }
}
