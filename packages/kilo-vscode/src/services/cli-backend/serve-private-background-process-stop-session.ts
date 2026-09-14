import { isAbsolute, normalize, resolve } from "path"
import {
  isSettledBackgroundStopSessionResult,
  makeBackgroundStopSessionAmbiguous,
  validateBackgroundStopSessionContractRequest,
  validateBackgroundStopSessionResult,
} from "./serve-private-background-process-stop-session-contract"
import type {
  BackgroundStopSessionContractRequest,
  BackgroundStopSessionResult,
  BackgroundStopSessionWireOutcome,
} from "./serve-private-background-process-stop-session-contract"

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

export function failedBackgroundStopSessionResult(
  req: BackgroundStopSessionContractRequest,
  code: string,
  msg: string,
): BackgroundStopSessionResult {
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

export function validateBackgroundStopSessionRequest(raw: unknown): BackgroundStopSessionContractRequest {
  const req = validateBackgroundStopSessionContractRequest(raw)
  if (!isAbsolute(req.context.directory)) throw new Error("context.directory must be absolute path")
  canonicalDir(req.context.directory)
  return req
}

export class PrivateBackgroundStopSessionValidationError extends Error {
  readonly kind = "private-background-stop-session-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateBackgroundStopSessionValidationError"
    this.detail = detail
  }
}

export function isPrivateBackgroundStopSessionValidationError(
  v: unknown,
): v is PrivateBackgroundStopSessionValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-background-stop-session-validation"
}

export function normalizePrivateBackgroundStopSessionWire(
  raw: unknown,
  req: BackgroundStopSessionContractRequest,
): BackgroundStopSessionWireOutcome {
  try {
    const result = validateBackgroundStopSessionResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

export interface BackgroundStopSessionRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

interface BackgroundStopSessionRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

export function requestBackgroundStopSessionOutcome(
  raw: BackgroundStopSessionRawTransport,
  host: BackgroundStopSessionRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: BackgroundStopSessionContractRequest,
): { id: number; promise: Promise<BackgroundStopSessionWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId(req.op, req)
  const promise = (async (): Promise<BackgroundStopSessionWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeBackgroundStopSessionAmbiguous(req, true) }
      const { code, msg } = host.failInfo(e)
      return { kind: "valid", result: failedBackgroundStopSessionResult(req, code, msg) }
    }
    if (host.isStale()) return { kind: "valid", result: makeBackgroundStopSessionAmbiguous(req, true) }
    return normalizePrivateBackgroundStopSessionWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

export function makeBackgroundStopSessionCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
): (msg?: string) => boolean {
  return (msg = "private background-stop-session timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate(`${op} stale observer timeout`)
      } catch {
        console.warn("[Kilo Bg] stale observer cleanup failed:", { op, stale: true, cleanupFailed: true })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo Bg] observer timeout cancel failed:", { op, cancelFailed: true })
      try {
        host.invalidate(`${op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Bg] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate(`${op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Bg] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
}

interface BackgroundStopSessionOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

export function wrapBackgroundStopSessionOutcomeForOwner(
  owner: BackgroundStopSessionOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<BackgroundStopSessionWireOutcome> },
  req: BackgroundStopSessionContractRequest,
): { id: number; promise: Promise<BackgroundStopSessionWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      if (outcome.kind === "valid" && isSettledBackgroundStopSessionResult(outcome.result, req)) return outcome
      return {
        kind: "valid",
        result: makeBackgroundStopSessionAmbiguous(req, true),
      } as BackgroundStopSessionWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private background-stop-session timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Bg] stale observer cleanup failed:", { op: req.op, stale: true, cleanupFailed: true })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Bg] observer timeout cancel failed:", { op: req.op, cancelFailed: true })
      try {
        owner.invalidate(`${req.op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Bg] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate(`${req.op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Bg] observer timeout invalidate failed:", { op: req.op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

export { validateBackgroundStopSessionResult }
export type { BackgroundStopSessionContractRequest as ServePrivateBackgroundStopSessionRequest }
export type { BackgroundStopSessionResult as ServePrivateBackgroundStopSessionResult }
export type { BackgroundStopSessionWireOutcome as PrivateBackgroundStopSessionWireOutcome }
