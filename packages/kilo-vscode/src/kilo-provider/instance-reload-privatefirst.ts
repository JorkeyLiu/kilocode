import * as crypto from "crypto"
import {
  canonicalInstanceReloadOpId,
  validateInstanceReloadResult,
} from "../services/cli-backend/serve-private-instance-reload-contract"
import { isPrivateInstanceReloadValidationError } from "../services/cli-backend/serve-private-instance-reload"
import type { ServePrivateInstanceReloadRequest } from "../services/cli-backend/serve-private-instance-reload"
import { instanceReloadHandle } from "../services/cli-backend/serve-private-instance-reload-connection"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

/**
 * Private-first `instance/reload` attempt (the same directory-scoped reboot
 * as `client.instance.reload`; `directory`/`workspace` are routing identity
 * only, never state isolation).
 *
 * One private attempt with 3 s exact-cancel/settled-first epoch. Valid
 * private `succeeded`+`accepted` returns with zero SDK; validated terminal
 * `failed` (`retryable === false`, including `conflict` for the existing
 * active-session guard) closes with zero SDK; unavailable/invalid/ambiguous/
 * retryable/transport/closed/timeout takes exactly one same-directory SDK
 * `client.instance.reload` fallback (owned by `kilo-provider/instance-reload.ts`,
 * never here and never retried). An ambiguous fallback can produce at most
 * two underlying reloads and two disposed events (merged by the existing
 * `LifecycleRefreshCoordinator`); this unit promises no exactly-once boots
 * and no new dedup/singleflight owner.
 *
 * Production `KiloConnectionService` reaches the peer through the extracted
 * `instanceReloadHandle` owner shape with no new `connection-service`
 * wrapper (same as `agent/list`); direct `privateInstanceReloadOutcomeWithHandle`
 * owners (tests, peer) use the same path without a second transport.
 */
export interface InstanceReloadPrivateConnection {
  isPrivateAvailable(): boolean
  privateInstanceReloadOutcomeWithHandle?(req: ServePrivateInstanceReloadRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildInstanceReloadIdentity(): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalInstanceReloadOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildInstanceReloadReq(dir: string, workspace?: string): ServePrivateInstanceReloadRequest {
  const ids = buildInstanceReloadIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "instance/reload" as const,
    idempotencyKey: ids.idempotencyKey,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: {},
  }
}

export type InstanceReloadAttempt = { kind: "ok" } | { kind: "terminal"; code?: string } | { kind: "fallback"; reason: string }

export function parseInstanceReloadResult(
  result: unknown,
  req: ServePrivateInstanceReloadRequest,
): InstanceReloadAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateInstanceReloadResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateInstanceReloadResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private instance-reload timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: InstanceReloadPrivateConnection): {
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

export async function attemptInstanceReloadPrivate(
  connection: KiloConnectionService | InstanceReloadPrivateConnection | null | undefined,
  req: ServePrivateInstanceReloadRequest,
  ms = 3000,
): Promise<InstanceReloadAttempt> {
  const conn = connection as InstanceReloadPrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateInstanceReloadOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = instanceReloadHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseInstanceReloadResult(outcome.result, req)
  } catch (e) {
    if (isPrivateInstanceReloadValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private instance-reload timeout") && handle) {
      try {
        handle.cancel?.(`private instance-reload timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}
