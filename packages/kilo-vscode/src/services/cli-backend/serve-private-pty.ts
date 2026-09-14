import { isAbsolute, normalize, resolve } from "path"
import {
  isSettledPtyRemoveResult,
  isSettledPtyUpdateResult,
  makePtyRemoveAmbiguous,
  makePtyUpdateAmbiguous,
  validatePtyRemoveContractRequest,
  validatePtyRemoveResult,
  validatePtyUpdateContractRequest,
  validatePtyUpdateResult,
} from "./serve-private-pty-contract"
import type {
  PtyRemoveContractRequest,
  PtyRemoveResult,
  PtyRemoveWireOutcome,
  PtyUpdateContractRequest,
  PtyUpdateResult,
  PtyUpdateWireOutcome,
} from "./serve-private-pty-contract"

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

export function validatePtyUpdateRequest(raw: unknown): PtyUpdateContractRequest {
  const req = validatePtyUpdateContractRequest(raw)
  if (!isAbsolute(req.context.directory)) throw new Error("context.directory must be absolute path")
  canonicalDir(req.context.directory)
  return req
}

export function validatePtyRemoveRequest(raw: unknown): PtyRemoveContractRequest {
  const req = validatePtyRemoveContractRequest(raw)
  if (!isAbsolute(req.context.directory)) throw new Error("context.directory must be absolute path")
  canonicalDir(req.context.directory)
  return req
}

export class PrivatePtyValidationError extends Error {
  readonly kind = "private-pty-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivatePtyValidationError"
    this.detail = detail
  }
}

export function isPrivatePtyValidationError(v: unknown): v is PrivatePtyValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-pty-validation"
}

export function normalizePrivatePtyUpdateWire(raw: unknown, req: PtyUpdateContractRequest): PtyUpdateWireOutcome {
  try {
    const result = validatePtyUpdateResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

export function normalizePrivatePtyRemoveWire(raw: unknown, req: PtyRemoveContractRequest): PtyRemoveWireOutcome {
  try {
    const result = validatePtyRemoveResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

export interface PtyRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

interface PtyRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

// Local transport failures use the fixed redacted `transport` code with a
// fixed message (never raw host codes or error strings, which may carry
// paths) so the contract allowlist accepts them and the private-first
// helper's explicit `transport` branch takes exactly one same-tuple SDK
// fallback. Mirrors the `project/current` + `config/warnings` convention.
export const PTY_UPDATE_TRANSPORT_MESSAGE = "private pty-update transport failed"
export const PTY_REMOVE_TRANSPORT_MESSAGE = "private pty-remove transport failed"

function failedUpdateResult(req: PtyUpdateContractRequest): PtyUpdateResult {
  const failure = { code: "transport", message: PTY_UPDATE_TRANSPORT_MESSAGE, retryable: false }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure: { ...failure },
  }
}

function failedRemoveResult(req: PtyRemoveContractRequest): PtyRemoveResult {
  const failure = { code: "transport", message: PTY_REMOVE_TRANSPORT_MESSAGE, retryable: false }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure: { ...failure },
  }
}

export function requestPtyUpdateOutcome(
  raw: PtyRawTransport,
  host: PtyRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: PtyUpdateContractRequest,
): { id: number; promise: Promise<PtyUpdateWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId(req.op, req)
  const promise = (async (): Promise<PtyUpdateWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makePtyUpdateAmbiguous(req, true) }
      void host.failInfo
      return { kind: "valid", result: failedUpdateResult(req) }
    }
    if (host.isStale()) return { kind: "valid", result: makePtyUpdateAmbiguous(req, true) }
    return normalizePrivatePtyUpdateWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

export function requestPtyRemoveOutcome(
  raw: PtyRawTransport,
  host: PtyRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: PtyRemoveContractRequest,
): { id: number; promise: Promise<PtyRemoveWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId(req.op, req)
  const promise = (async (): Promise<PtyRemoveWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makePtyRemoveAmbiguous(req, true) }
      void host.failInfo
      return { kind: "valid", result: failedRemoveResult(req) }
    }
    if (host.isStale()) return { kind: "valid", result: makePtyRemoveAmbiguous(req, true) }
    return normalizePrivatePtyRemoveWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

function makeCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
  tag: string,
): (msg?: string) => boolean {
  return (msg = `private ${tag} timeout`): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate(`${op} stale observer timeout`)
      } catch {
        console.warn(tag, "stale observer cleanup failed:", { op, stale: true, cleanupFailed: true })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn(tag, "observer timeout cancel failed:", { op, cancelFailed: true })
      try {
        host.invalidate(`${op} observer timeout cancel throw`)
      } catch {
        console.warn(tag, "observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate(`${op} observer timeout exact cancel miss`)
      } catch {
        console.warn(tag, "observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
}

export function makePtyUpdateCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
): (msg?: string) => boolean {
  return makeCancel(id, host, op, "[Kilo Pty]")
}

export function makePtyRemoveCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
): (msg?: string) => boolean {
  return makeCancel(id, host, op, "[Kilo Pty]")
}

interface PtyOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

export function wrapPtyUpdateOutcomeForOwner(
  owner: PtyOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<PtyUpdateWireOutcome> },
  req: PtyUpdateContractRequest,
): { id: number; promise: Promise<PtyUpdateWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      if (outcome.kind === "valid" && isSettledPtyUpdateResult(outcome.result, req)) return outcome
      return { kind: "valid", result: makePtyUpdateAmbiguous(req, true) } as PtyUpdateWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private pty-update timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Pty] stale observer cleanup failed:", { op: req.op, stale: true, cleanupFailed: true })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Pty] observer timeout cancel failed:", { op: req.op, cancelFailed: true })
      try {
        owner.invalidate(`${req.op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Pty] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate(`${req.op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Pty] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

export function wrapPtyRemoveOutcomeForOwner(
  owner: PtyOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<PtyRemoveWireOutcome> },
  req: PtyRemoveContractRequest,
): { id: number; promise: Promise<PtyRemoveWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      if (outcome.kind === "valid" && isSettledPtyRemoveResult(outcome.result, req)) return outcome
      return { kind: "valid", result: makePtyRemoveAmbiguous(req, true) } as PtyRemoveWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private pty-remove timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Pty] stale observer cleanup failed:", { op: req.op, stale: true, cleanupFailed: true })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Pty] observer timeout cancel failed:", { op: req.op, cancelFailed: true })
      try {
        owner.invalidate(`${req.op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Pty] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate(`${req.op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Pty] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

export { validatePtyUpdateResult, validatePtyRemoveResult }
export type { PtyUpdateContractRequest as ServePrivatePtyUpdateRequest }
export type { PtyRemoveContractRequest as ServePrivatePtyRemoveRequest }
export type { PtyUpdateResult as ServePrivatePtyUpdateResult }
export type { PtyRemoveResult as ServePrivatePtyRemoveResult }
export type { PtyUpdateWireOutcome as PrivatePtyUpdateWireOutcome }
export type { PtyRemoveWireOutcome as PrivatePtyRemoveWireOutcome }
