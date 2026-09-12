import { isAbsolute, normalize, resolve } from "path"
import {
  isSettledRemoteToggleResult,
  makeRemoteToggleAmbiguous,
  validateRemoteToggleContractRequest,
  validateRemoteToggleResult,
} from "./serve-private-remote-toggle-contract"
import type {
  RemoteToggleContractRequest,
  RemoteToggleResult,
  RemoteToggleWireOutcome,
} from "./serve-private-remote-toggle-contract"

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

export function failedRemoteToggleResult(
  req: RemoteToggleContractRequest,
  code: string,
  msg: string,
): RemoteToggleResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
    accepted: false,
    failure: { code, message: msg, retryable: false },
  }
}

export function validateRemoteToggleRequest(raw: unknown): RemoteToggleContractRequest {
  const req = validateRemoteToggleContractRequest(raw)
  if (!isAbsolute(req.context.directory)) throw new Error("context.directory must be absolute path")
  canonicalDir(req.context.directory)
  return req
}

export class PrivateRemoteToggleValidationError extends Error {
  readonly kind = "private-remote-toggle-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateRemoteToggleValidationError"
    this.detail = detail
  }
}

export function isPrivateRemoteToggleValidationError(v: unknown): v is PrivateRemoteToggleValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-remote-toggle-validation"
}

export function normalizePrivateRemoteToggleWire(
  raw: unknown,
  req: RemoteToggleContractRequest,
): RemoteToggleWireOutcome {
  try {
    const result = validateRemoteToggleResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

export interface RemoteToggleRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

interface RemoteToggleRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

export function requestRemoteToggleOutcome(
  raw: RemoteToggleRawTransport,
  host: RemoteToggleRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: RemoteToggleContractRequest,
): { id: number; promise: Promise<RemoteToggleWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId(req.op, req)
  const promise = (async (): Promise<RemoteToggleWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeRemoteToggleAmbiguous(req, true) }
      const { code, msg } = host.failInfo(e)
      return { kind: "valid", result: failedRemoteToggleResult(req, code, msg) }
    }
    if (host.isStale()) return { kind: "valid", result: makeRemoteToggleAmbiguous(req, true) }
    return normalizePrivateRemoteToggleWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

export function makeRemoteToggleCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
): (msg?: string) => boolean {
  return (msg = "private toggle timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate(`${op} stale observer timeout`)
      } catch {
        console.warn("[Kilo Remote] stale observer cleanup failed:", { op, stale: true, cleanupFailed: true })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo Remote] observer timeout cancel failed:", { op, cancelFailed: true })
      try {
        host.invalidate(`${op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Remote] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate(`${op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Remote] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
}

interface RemoteToggleOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

export function wrapRemoteToggleOutcomeForOwner(
  owner: RemoteToggleOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<RemoteToggleWireOutcome> },
  req: RemoteToggleContractRequest,
): { id: number; promise: Promise<RemoteToggleWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      if (outcome.kind === "valid" && isSettledRemoteToggleResult(outcome.result, req)) return outcome
      return { kind: "valid", result: makeRemoteToggleAmbiguous(req, true) } as RemoteToggleWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private toggle timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Remote] stale observer cleanup failed:", { op: req.op, stale: true, cleanupFailed: true })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Remote] observer timeout cancel failed:", { op: req.op, cancelFailed: true })
      try {
        owner.invalidate(`${req.op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Remote] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate(`${req.op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Remote] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

export { validateRemoteToggleResult }
export type { RemoteToggleContractRequest as ServePrivateRemoteToggleRequest }
export type { RemoteToggleResult as ServePrivateRemoteToggleResult }
export type { RemoteToggleWireOutcome as PrivateRemoteToggleWireOutcome }
