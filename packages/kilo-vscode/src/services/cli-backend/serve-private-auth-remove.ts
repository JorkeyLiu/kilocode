import { isAbsolute, normalize, resolve } from "path"
import {
  isSettledAuthRemoveResult,
  makeAuthRemoveAmbiguous,
  validateAuthRemoveContractRequest,
  validateAuthRemoveResult,
} from "./serve-private-auth-remove-contract"
import type {
  AuthRemoveContractRequest,
  AuthRemoveResult,
  AuthRemoveWireOutcome,
} from "./serve-private-auth-remove-contract"

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

export function failedAuthRemoveResult(
  req: AuthRemoveContractRequest,
  code: string,
  msg: string,
): AuthRemoveResult {
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

export function validateAuthRemoveRequest(raw: unknown): AuthRemoveContractRequest {
  const req = validateAuthRemoveContractRequest(raw)
  if (!isAbsolute(req.context.directory)) throw new Error("context.directory must be absolute path")
  canonicalDir(req.context.directory)
  return req
}

export class PrivateAuthRemoveValidationError extends Error {
  readonly kind = "private-auth-remove-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateAuthRemoveValidationError"
    this.detail = detail
  }
}

export function isPrivateAuthRemoveValidationError(v: unknown): v is PrivateAuthRemoveValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-auth-remove-validation"
}

export function normalizePrivateAuthRemoveWire(
  raw: unknown,
  req: AuthRemoveContractRequest,
): AuthRemoveWireOutcome {
  try {
    const result = validateAuthRemoveResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

export interface AuthRemoveRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

interface AuthRemoveRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

export function requestAuthRemoveOutcome(
  raw: AuthRemoveRawTransport,
  host: AuthRemoveRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: AuthRemoveContractRequest,
): { id: number; promise: Promise<AuthRemoveWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId(req.op, req)
  const promise = (async (): Promise<AuthRemoveWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeAuthRemoveAmbiguous(req, true) }
      const { code, msg } = host.failInfo(e)
      return { kind: "valid", result: failedAuthRemoveResult(req, code, msg) }
    }
    if (host.isStale()) return { kind: "valid", result: makeAuthRemoveAmbiguous(req, true) }
    return normalizePrivateAuthRemoveWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

export function makeAuthRemoveCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
): (msg?: string) => boolean {
  return (msg = "private auth-remove timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate(`${op} stale observer timeout`)
      } catch {
        console.warn("[Kilo Auth] stale observer cleanup failed:", { op, stale: true, cleanupFailed: true })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo Auth] observer timeout cancel failed:", { op, cancelFailed: true })
      try {
        host.invalidate(`${op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Auth] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate(`${op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Auth] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
}

interface AuthRemoveOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

export function wrapAuthRemoveOutcomeForOwner(
  owner: AuthRemoveOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<AuthRemoveWireOutcome> },
  req: AuthRemoveContractRequest,
): { id: number; promise: Promise<AuthRemoveWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      if (outcome.kind === "valid" && isSettledAuthRemoveResult(outcome.result, req)) return outcome
      return { kind: "valid", result: makeAuthRemoveAmbiguous(req, true) } as AuthRemoveWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private auth-remove timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Auth] stale observer cleanup failed:", { op: req.op, stale: true, cleanupFailed: true })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Auth] observer timeout cancel failed:", { op: req.op, cancelFailed: true })
      try {
        owner.invalidate(`${req.op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Auth] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate(`${req.op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Auth] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

export { validateAuthRemoveResult }
export type { AuthRemoveContractRequest as ServePrivateAuthRemoveRequest }
export type { AuthRemoveResult as ServePrivateAuthRemoveResult }
export type { AuthRemoveWireOutcome as PrivateAuthRemoveWireOutcome }
