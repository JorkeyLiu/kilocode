import * as crypto from "crypto"
import {
  canonicalPermissionAllowEverythingOpId,
  validatePermissionAllowEverythingContractRequest,
  validatePermissionAllowEverythingResult,
  validatePermissionAllowEverythingTerminalFailure,
} from "../services/cli-backend/serve-private-permission-allow-everything-contract"
import type {
  PermissionAllowEverythingContractRequest,
  PermissionAllowEverythingFailureCode,
} from "../services/cli-backend/serve-private-permission-allow-everything-contract"
import type { KiloConnectionService } from "../services/cli-backend"
import { permissionAllowEverythingHandle } from "../services/cli-backend/serve-private-permission-connection"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"

export type AllowEverythingPrivateOutcome =
  | { kind: "terminal" }
  | { kind: "terminal-failure"; code: PermissionAllowEverythingFailureCode }
  | { kind: "fallback"; reason: string }

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

export const ALLOW_EVERYTHING_TIMEOUT_MS = 3000

export function buildPermissionAllowEverythingIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = canonicalPermissionAllowEverythingOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildPermissionAllowEverythingReq(
  directory: string,
  enable: boolean,
  sessionID?: string,
  requestID?: string,
): PermissionAllowEverythingContractRequest {
  const ids = buildPermissionAllowEverythingIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "permission/allow-everything" as const,
    idempotencyKey: ids.idempotencyKey,
    context: {
      directory,
      ...(sessionID !== undefined ? { sessionID } : {}),
      ...(requestID !== undefined ? { requestID } : {}),
    },
    payload: { enable },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private allow-everything timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function valid(req: PermissionAllowEverythingContractRequest): boolean {
  try {
    validatePermissionAllowEverythingContractRequest(req)
    return true
  } catch {
    return false
  }
}

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privatePermissionAllowEverythingWithHandle?: (req: PermissionAllowEverythingContractRequest) => Handle
}

function ownerDeps(conn: Conn): { peer: ServePrivatePeer | null; live: boolean; epoch: number | null; invalidate: (reason: string) => void } | null {
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

function acquire(conn: Conn, req: PermissionAllowEverythingContractRequest): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const factory = conn.privatePermissionAllowEverythingWithHandle?.bind(conn) ?? null
    if (factory) {
      const got = factory(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const deps = ownerDeps(conn)
    if (!deps || !deps.peer) return { ok: false, reason: "missing-capability" }
    const got = permissionAllowEverythingHandle({ peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate }, req)
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function expired(handle: Handle | null, opId: string): void {
  if (!handle?.cancel) return
  try {
    handle.cancel(`private allow-everything timeout opId=${opId}`)
  } catch (err) {
    console.warn("[Kilo Permission] private timeout cancel failed:", String(err).slice(0, 200), { opId })
  }
}

function settle(req: PermissionAllowEverythingContractRequest, result: unknown): AllowEverythingPrivateOutcome {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validatePermissionAllowEverythingResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "terminal" }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validatePermissionAllowEverythingTerminalFailure(result, req)
      return { kind: "terminal-failure", code: out.failure.code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

export async function allowEverythingPermissionPrivateFirst(opts: {
  connection?: Conn | null
  directory: string
  enable: boolean
  sessionID?: string
  requestID?: string
}): Promise<{ outcome: AllowEverythingPrivateOutcome; req: PermissionAllowEverythingContractRequest }> {
  let req: PermissionAllowEverythingContractRequest
  try {
    req = buildPermissionAllowEverythingReq(opts.directory, opts.enable, opts.sessionID, opts.requestID)
  } catch {
    const token = crypto.randomUUID()
    const opId = `permission-allow-everything:${token}`
    const fallback: PermissionAllowEverythingContractRequest = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId,
      op: "permission/allow-everything" as const,
      idempotencyKey: opId,
      context: { directory: opts.directory },
      payload: { enable: opts.enable },
    }
    return { outcome: { kind: "fallback", reason: "invalid" }, req: fallback }
  }
  if (!valid(req)) return { outcome: { kind: "fallback", reason: "invalid" }, req }
  const conn = opts.connection ?? null
  if (!conn) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  try {
    if (!conn.isPrivateAvailable()) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  } catch {
    return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  }
  const acq = acquire(conn, req)
  if (!acq.ok) return { outcome: { kind: "fallback", reason: "missing-capability" }, req }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, ALLOW_EVERYTHING_TIMEOUT_MS)
  } catch {
    expired(acq.handle, req.opId)
    return { outcome: { kind: "fallback", reason: "timeout" }, req }
  }
  return { outcome: settle(req, result), req }
}

type SdkClient = {
  permission?: {
    allowEverything?: (args: { directory: string; enable: boolean; sessionID?: string; requestID?: string }) => Promise<unknown>
  }
} | null

// Private-first allow-everything mutation: validated private `terminal` and
// validated `terminal-failure` close with zero SDK; only fallback-eligible
// (retryable/unavailable/invalid/ambiguous/transport/closed/timeout) takes
// exactly one same-tuple SDK `permission.allowEverything` with the identical
// directory/enable/sessionID/requestID. Evaluator semantics unchanged.
export async function setAllowEverythingPrivateFirst(opts: {
  connection?: Conn | null
  client: unknown
  directory: string
  enable: boolean
  sessionID?: string
  requestID?: string
}): Promise<{ kind: "ok" } | { kind: "error"; detail: unknown }> {
  const attempt = await allowEverythingPermissionPrivateFirst({
    connection: opts.connection ?? null,
    directory: opts.directory,
    enable: opts.enable,
    sessionID: opts.sessionID,
    requestID: opts.requestID,
  })
  if (attempt.outcome.kind === "terminal") return { kind: "ok" }
  if (attempt.outcome.kind === "terminal-failure") {
    console.error("[Kilo New] KiloProvider: Failed to set allow-everything:", attempt.outcome.code)
    return { kind: "error", detail: attempt.outcome.code }
  }
  const client = opts.client as SdkClient
  if (!client?.permission?.allowEverything) return { kind: "error", detail: attempt.outcome.reason }
  try {
    await client.permission.allowEverything({
      directory: opts.directory,
      enable: opts.enable,
      ...(opts.sessionID !== undefined ? { sessionID: opts.sessionID } : {}),
      ...(opts.requestID !== undefined ? { requestID: opts.requestID } : {}),
    })
    return { kind: "ok" }
  } catch (err) {
    console.error("[Kilo New] KiloProvider: Failed to set allow-everything:", err)
    return { kind: "error", detail: err }
  }
}
