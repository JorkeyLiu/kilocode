import { isAbsolute, normalize, resolve } from "path"
import {
  isSettledInstanceReloadResult,
  makeInstanceReloadAmbiguous,
  validateInstanceReloadContractRequest,
  validateInstanceReloadResult,
} from "./serve-private-instance-reload-contract"
import type {
  InstanceReloadContractRequest,
  InstanceReloadResult,
  InstanceReloadWireOutcome,
} from "./serve-private-instance-reload-contract"

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

export function failedInstanceReloadResult(
  req: InstanceReloadContractRequest,
  code: string,
  msg: string,
): InstanceReloadResult {
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

export function validateInstanceReloadRequest(raw: unknown): InstanceReloadContractRequest {
  const req = validateInstanceReloadContractRequest(raw)
  if (!isAbsolute(req.context.directory)) throw new Error("context.directory must be absolute path")
  canonicalDir(req.context.directory)
  return req
}

export class PrivateInstanceReloadValidationError extends Error {
  readonly kind = "private-instance-reload-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateInstanceReloadValidationError"
    this.detail = detail
  }
}

export function isPrivateInstanceReloadValidationError(v: unknown): v is PrivateInstanceReloadValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-instance-reload-validation"
}

export function normalizePrivateInstanceReloadWire(
  raw: unknown,
  req: InstanceReloadContractRequest,
): InstanceReloadWireOutcome {
  try {
    const result = validateInstanceReloadResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

export interface InstanceReloadRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

interface InstanceReloadRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

export function requestInstanceReloadOutcome(
  raw: InstanceReloadRawTransport,
  host: InstanceReloadRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: InstanceReloadContractRequest,
): { id: number; promise: Promise<InstanceReloadWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId(req.op, req)
  const promise = (async (): Promise<InstanceReloadWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeInstanceReloadAmbiguous(req, true) }
      const { code, msg } = host.failInfo(e)
      return { kind: "valid", result: failedInstanceReloadResult(req, code, msg) }
    }
    if (host.isStale()) return { kind: "valid", result: makeInstanceReloadAmbiguous(req, true) }
    return normalizePrivateInstanceReloadWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

export function makeInstanceReloadCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
): (msg?: string) => boolean {
  return (msg = "private instance-reload timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate(`${op} stale observer timeout`)
      } catch {
        console.warn("[Kilo Reload] stale observer cleanup failed:", { op, stale: true, cleanupFailed: true })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo Reload] observer timeout cancel failed:", { op, cancelFailed: true })
      try {
        host.invalidate(`${op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Reload] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate(`${op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Reload] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
}

interface InstanceReloadOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

export function wrapInstanceReloadOutcomeForOwner(
  owner: InstanceReloadOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<InstanceReloadWireOutcome> },
  req: InstanceReloadContractRequest,
): { id: number; promise: Promise<InstanceReloadWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      if (outcome.kind === "valid" && isSettledInstanceReloadResult(outcome.result, req)) return outcome
      return { kind: "valid", result: makeInstanceReloadAmbiguous(req, true) } as InstanceReloadWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private instance-reload timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Reload] stale observer cleanup failed:", { op: req.op, stale: true, cleanupFailed: true })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Reload] observer timeout cancel failed:", { op: req.op, cancelFailed: true })
      try {
        owner.invalidate(`${req.op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Reload] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate(`${req.op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Reload] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

export { validateInstanceReloadResult }
export type { InstanceReloadContractRequest as ServePrivateInstanceReloadRequest }
export type { InstanceReloadResult as ServePrivateInstanceReloadResult }
export type { InstanceReloadWireOutcome as PrivateInstanceReloadWireOutcome }
