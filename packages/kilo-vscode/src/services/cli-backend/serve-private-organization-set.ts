import { isAbsolute, normalize, resolve } from "path"
import {
  isSettledOrganizationSetResult,
  makeOrganizationSetAmbiguous,
  validateOrganizationSetContractRequest,
  validateOrganizationSetResult,
} from "./serve-private-organization-set-contract"
import type {
  OrganizationSetContractRequest,
  OrganizationSetResult,
  OrganizationSetWireOutcome,
} from "./serve-private-organization-set-contract"

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

export function failedOrganizationSetResult(
  req: OrganizationSetContractRequest,
  code: string,
  msg: string,
): OrganizationSetResult {
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

export function validateOrganizationSetRequest(raw: unknown): OrganizationSetContractRequest {
  const req = validateOrganizationSetContractRequest(raw)
  if (!isAbsolute(req.context.directory)) throw new Error("context.directory must be absolute path")
  canonicalDir(req.context.directory)
  return req
}

export class PrivateOrganizationSetValidationError extends Error {
  readonly kind = "private-organization-set-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateOrganizationSetValidationError"
    this.detail = detail
  }
}

export function isPrivateOrganizationSetValidationError(v: unknown): v is PrivateOrganizationSetValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-organization-set-validation"
}

export function normalizePrivateOrganizationSetWire(
  raw: unknown,
  req: OrganizationSetContractRequest,
): OrganizationSetWireOutcome {
  try {
    const result = validateOrganizationSetResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

export interface OrganizationSetRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

interface OrganizationSetRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

export function requestOrganizationSetOutcome(
  raw: OrganizationSetRawTransport,
  host: OrganizationSetRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: OrganizationSetContractRequest,
): { id: number; promise: Promise<OrganizationSetWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId(req.op, req)
  const promise = (async (): Promise<OrganizationSetWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeOrganizationSetAmbiguous(req, true) }
      const { code, msg } = host.failInfo(e)
      return { kind: "valid", result: failedOrganizationSetResult(req, code, msg) }
    }
    if (host.isStale()) return { kind: "valid", result: makeOrganizationSetAmbiguous(req, true) }
    return normalizePrivateOrganizationSetWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

export function makeOrganizationSetCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
): (msg?: string) => boolean {
  return (msg = "private organization-set timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate(`${op} stale observer timeout`)
      } catch {
        console.warn("[Kilo Org] stale observer cleanup failed:", { op, stale: true, cleanupFailed: true })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo Org] observer timeout cancel failed:", { op, cancelFailed: true })
      try {
        host.invalidate(`${op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Org] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate(`${op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Org] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
}

interface OrganizationSetOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

export function wrapOrganizationSetOutcomeForOwner(
  owner: OrganizationSetOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<OrganizationSetWireOutcome> },
  req: OrganizationSetContractRequest,
): { id: number; promise: Promise<OrganizationSetWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      if (outcome.kind === "valid" && isSettledOrganizationSetResult(outcome.result, req)) return outcome
      return { kind: "valid", result: makeOrganizationSetAmbiguous(req, true) } as OrganizationSetWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private organization-set timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Org] stale observer cleanup failed:", { op: req.op, stale: true, cleanupFailed: true })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Org] observer timeout cancel failed:", { op: req.op, cancelFailed: true })
      try {
        owner.invalidate(`${req.op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Org] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate(`${req.op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Org] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

export { validateOrganizationSetResult }
export type { OrganizationSetContractRequest as ServePrivateOrganizationSetRequest }
export type { OrganizationSetResult as ServePrivateOrganizationSetResult }
export type { OrganizationSetWireOutcome as PrivateOrganizationSetWireOutcome }
