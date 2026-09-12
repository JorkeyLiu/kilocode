import * as crypto from "crypto"
import {
  canonicalPermissionOpId,
  validatePermissionReplyContractRequest,
  validatePermissionReplyResult,
  validatePermissionSaveContractRequest,
  validatePermissionSaveResult,
  validatePermissionTerminalFailure,
} from "../services/cli-backend/serve-private-permission-contract"
import type {
  PermissionFailureCode,
  PermissionReplyContractRequest,
  PermissionSaveContractRequest,
} from "../services/cli-backend/serve-private-permission-contract"
import type { KiloConnectionService } from "../services/cli-backend"
import { permissionReplyHandle, permissionSaveHandle } from "../services/cli-backend/serve-private-permission-connection"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"

export type PermissionPrivateOutcome =
  | { kind: "terminal" }
  | { kind: "terminal-failure"; code: PermissionFailureCode }
  | { kind: "fallback"; reason: string }

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

export function buildPermissionSaveIdentity(requestID: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = canonicalPermissionOpId(requestID, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildPermissionReplyIdentity(requestID: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = canonicalPermissionOpId(requestID, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private permission timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function buildSaveReq(
  directory: string,
  requestID: string,
  approvedAlways: string[],
  deniedAlways: string[],
): PermissionSaveContractRequest {
  const ids = buildPermissionSaveIdentity(requestID)
  const payload: { approvedAlways?: string[]; deniedAlways?: string[] } = {}
  if (approvedAlways.length > 0) payload.approvedAlways = [...approvedAlways]
  if (deniedAlways.length > 0) payload.deniedAlways = [...deniedAlways]
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "permission/save-always-rules" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, requestID },
    payload,
  }
}

function buildReplyReq(directory: string, requestID: string, reply: "once" | "always" | "reject"): PermissionReplyContractRequest {
  const ids = buildPermissionReplyIdentity(requestID)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "permission/reply" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, requestID },
    payload: { reply },
  }
}

function validSave(req: PermissionSaveContractRequest): boolean {
  try {
    validatePermissionSaveContractRequest(req)
    return true
  } catch {
    return false
  }
}

function validReply(req: PermissionReplyContractRequest): boolean {
  try {
    validatePermissionReplyContractRequest(req)
    return true
  } catch {
    return false
  }
}

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privatePermissionWithHandle?: (req: PermissionSaveContractRequest | PermissionReplyContractRequest) => Handle
  privatePermissionSaveWithHandle?: (req: PermissionSaveContractRequest) => Handle
  privatePermissionReplyWithHandle?: (req: PermissionReplyContractRequest) => Handle
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

function acquireSave(conn: Conn, req: PermissionSaveContractRequest): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const generic = conn.privatePermissionWithHandle?.bind(conn) ?? null
    if (generic) {
      const got = generic(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const factory = conn.privatePermissionSaveWithHandle?.bind(conn) ?? null
    if (factory) {
      const got = factory(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const deps = ownerDeps(conn)
    if (!deps || !deps.peer) return { ok: false, reason: "missing-capability" }
    const got = permissionSaveHandle({ peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate }, req)
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function acquireReply(conn: Conn, req: PermissionReplyContractRequest): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const generic = conn.privatePermissionWithHandle?.bind(conn) ?? null
    if (generic) {
      const got = generic(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const factory = conn.privatePermissionReplyWithHandle?.bind(conn) ?? null
    if (factory) {
      const got = factory(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const deps = ownerDeps(conn)
    if (!deps || !deps.peer) return { ok: false, reason: "missing-capability" }
    const got = permissionReplyHandle({ peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate }, req)
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function expired(handle: Handle | null, opId: string): void {
  if (!handle?.cancel) return
  try {
    handle.cancel(`private permission timeout opId=${opId}`)
  } catch (err) {
    console.warn("[Kilo Permission] private timeout cancel failed:", String(err).slice(0, 200), { opId })
  }
}

function settleSave(req: PermissionSaveContractRequest, result: unknown): PermissionPrivateOutcome {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validatePermissionSaveResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "terminal" }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validatePermissionTerminalFailure(result, req)
      return { kind: "terminal-failure", code: out.failure.code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

function settleReply(req: PermissionReplyContractRequest, result: unknown): PermissionPrivateOutcome {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validatePermissionReplyResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "terminal" }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validatePermissionTerminalFailure(result, req)
      return { kind: "terminal-failure", code: out.failure.code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

export async function savePermissionPrivateFirst(opts: {
  connection?: Conn | null
  directory: string
  requestID: string
  approvedAlways: string[]
  deniedAlways: string[]
}): Promise<{ outcome: PermissionPrivateOutcome; req: PermissionSaveContractRequest }> {
  let req: PermissionSaveContractRequest
  try {
    req = buildSaveReq(opts.directory, opts.requestID, opts.approvedAlways, opts.deniedAlways)
  } catch {
    const token = crypto.randomUUID()
    const fallback: PermissionSaveContractRequest = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `permission:${opts.requestID}:${token}`,
      op: "permission/save-always-rules" as const,
      idempotencyKey: `permission:${opts.requestID}:${token}`,
      context: { directory: opts.directory, requestID: opts.requestID },
      payload: {},
    }
    return { outcome: { kind: "fallback", reason: "invalid" }, req: fallback }
  }
  if (!validSave(req)) return { outcome: { kind: "fallback", reason: "invalid" }, req }
  const conn = opts.connection ?? null
  if (!conn) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  try {
    if (!conn.isPrivateAvailable()) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  } catch {
    return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  }
  const acq = acquireSave(conn, req)
  if (!acq.ok) return { outcome: { kind: "fallback", reason: "missing-capability" }, req }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { outcome: { kind: "fallback", reason: "timeout" }, req }
  }
  return { outcome: settleSave(req, result), req }
}

export async function replyPermissionPrivateFirst(opts: {
  connection?: Conn | null
  directory: string
  requestID: string
  reply: "once" | "always" | "reject"
}): Promise<{ outcome: PermissionPrivateOutcome; req: PermissionReplyContractRequest }> {
  let req: PermissionReplyContractRequest
  try {
    req = buildReplyReq(opts.directory, opts.requestID, opts.reply)
  } catch {
    const token = crypto.randomUUID()
    const fallback: PermissionReplyContractRequest = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `permission:${opts.requestID}:${token}`,
      op: "permission/reply" as const,
      idempotencyKey: `permission:${opts.requestID}:${token}`,
      context: { directory: opts.directory, requestID: opts.requestID },
      payload: { reply: opts.reply },
    }
    return { outcome: { kind: "fallback", reason: "invalid" }, req: fallback }
  }
  if (!validReply(req)) return { outcome: { kind: "fallback", reason: "invalid" }, req }
  const conn = opts.connection ?? null
  if (!conn) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  try {
    if (!conn.isPrivateAvailable()) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  } catch {
    return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  }
  const acq = acquireReply(conn, req)
  if (!acq.ok) return { outcome: { kind: "fallback", reason: "missing-capability" }, req }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { outcome: { kind: "fallback", reason: "timeout" }, req }
  }
  return { outcome: settleReply(req, result), req }
}
