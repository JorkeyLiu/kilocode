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
 * Accepted-only: one private attempt with 3 s exact-cancel/settled-first
 * epoch. Valid private `succeeded`+`accepted` returns `ok` with zero SDK;
 * validated terminal `failed` (`retryable === false`, including `conflict`
 * for the existing active-session guard) closes as `terminal` with zero SDK.
 * Proven pre-send (`unavailable`/`missing-capability` before any private
 * request leaves the extension) plus the strictly validated pre-accept
 * retryable fence (`failed` `retryable === true` with `accepted === false`
 * and exact identity, proven never accepted before reload) return `fallback`
 * for exactly one same-directory SDK `client.instance.reload` (owned by
 * `kilo-provider/instance-reload.ts`, never here and never retried). Every
 * after-send uncertainty (`ambiguous`/`timeout`/`closed`/`invalid`/
 * `transportUnknown`/throw, including a retryable-shaped but unproven
 * result) returns explicit `unresolved` carrying the stable `opId` with zero
 * SDK and zero second dispatch. The disposed events stay the final
 * convergence owner; this unit promises no exactly-once boots, no new
 * dedup/singleflight owner, and no polling/scheduler.
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

export type InstanceReloadAttempt =
  | { kind: "ok" }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }
  | { kind: "unresolved"; reason: string; opId: string }

function unresolvedOf(req: ServePrivateInstanceReloadRequest, reason: string): InstanceReloadAttempt {
  return { kind: "unresolved", reason: reason.slice(0, 200), opId: req.opId }
}

function provenPreSend(reason: string): boolean {
  if (reason === "unavailable" || reason === "missing-capability") return true
  const low = reason.toLowerCase()
  if (low.includes("missing") && low.includes("capability")) return true
  if (low.includes("private peer missing")) return true
  if (low.includes("private peer unavailable")) return true
  return false
}

export function parseInstanceReloadResult(
  result: unknown,
  req: ServePrivateInstanceReloadRequest,
): InstanceReloadAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return unresolvedOf(req, "invalid")
  if (rec.transportUnknown === true) return unresolvedOf(req, "transportUnknown")
  if (rec.status === "ambiguous") return unresolvedOf(req, "ambiguous")
  if (rec.status === "succeeded") {
    try {
      const out = validateInstanceReloadResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return unresolvedOf(req, "invalid")
      return { kind: "ok" }
    } catch (e) {
      return unresolvedOf(req, `invalid: ${String(e).slice(0, 120)}`)
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateInstanceReloadResult(result, req)
      if (out.status !== "failed") return unresolvedOf(req, "invalid")
      if (out.failure.retryable === true) {
        if (out.accepted === false) return { kind: "fallback", reason: out.failure.code }
        return unresolvedOf(req, out.failure.code)
      }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return unresolvedOf(req, "failed without retryable")
    } catch (e) {
      return unresolvedOf(req, `invalid: ${String(e).slice(0, 120)}`)
    }
  }
  return unresolvedOf(req, `private not succeeded: ${String(rec.status)}`)
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

type ReloadHandle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" }

function acquireReloadHandle(
  conn: InstanceReloadPrivateConnection,
  req: ServePrivateInstanceReloadRequest,
): { kind: "handle"; handle: ReloadHandle } | InstanceReloadAttempt {
  const direct = conn.privateInstanceReloadOutcomeWithHandle?.bind(conn) ?? null
  if (direct) {
    try {
      return { kind: "handle", handle: direct(req) }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (provenPreSend(msg)) return { kind: "fallback", reason: "missing-capability" }
      return unresolvedOf(req, msg.slice(0, 200))
    }
  }
  const deps = ownerDeps(conn)
  if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
  try {
    const handle = instanceReloadHandle(
      { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
      req,
    )
    return { kind: "handle", handle }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (provenPreSend(msg)) return { kind: "fallback", reason: "missing-capability" }
    return unresolvedOf(req, msg.slice(0, 200))
  }
}

function unresolvedFromWaitError(
  req: ServePrivateInstanceReloadRequest,
  handle: ReloadHandle | null,
  e: unknown,
): InstanceReloadAttempt {
  if (isPrivateInstanceReloadValidationError(e)) return unresolvedOf(req, "invalid")
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes("private instance-reload timeout") && handle) {
    try {
      handle.cancel?.(`private instance-reload timeout opId=${req.opId}`)
    } catch {}
    return unresolvedOf(req, "timeout")
  }
  return unresolvedOf(req, msg.slice(0, 200))
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
  const acq = acquireReloadHandle(conn, req)
  if (acq.kind !== "handle") return acq
  const handle = acq.handle
  try {
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return unresolvedOf(req, `invalid: ${outcome.detail.slice(0, 120)}`)
    return parseInstanceReloadResult(outcome.result, req)
  } catch (e) {
    return unresolvedFromWaitError(req, handle, e)
  }
}
