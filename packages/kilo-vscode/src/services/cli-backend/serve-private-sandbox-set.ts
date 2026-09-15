import { isAbsolute, normalize, resolve } from "path"
import {
  makeSandboxSetAmbiguous,
  validateSandboxSetContractRequest,
  validateSandboxSetResult,
} from "./serve-private-sandbox-set-contract"
import type {
  SandboxSetContractRequest,
  SandboxSetResult,
  SandboxSetWireOutcome,
} from "./serve-private-sandbox-set-contract"

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

export function validateSandboxSetRequest(raw: unknown): SandboxSetContractRequest {
  const req = validateSandboxSetContractRequest(raw)
  if (!isAbsolute(req.context.directory)) throw new Error("context.directory must be absolute path")
  canonicalDir(req.context.directory)
  return req
}

export class PrivateSandboxSetValidationError extends Error {
  readonly kind = "private-sandbox-set-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateSandboxSetValidationError"
    this.detail = detail
  }
}

export function isPrivateSandboxSetValidationError(v: unknown): v is PrivateSandboxSetValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-sandbox-set-validation"
}

export function normalizePrivateSandboxSetWire(raw: unknown, req: SandboxSetContractRequest): SandboxSetWireOutcome {
  try {
    const result = validateSandboxSetResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

export interface SandboxSetRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

interface SandboxSetRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

function ambiguousTransportUnknown(req: SandboxSetContractRequest): SandboxSetWireOutcome {
  return { kind: "valid", result: makeSandboxSetAmbiguous(req, true) }
}

export function requestSandboxSetOutcome(
  raw: SandboxSetRawTransport,
  host: SandboxSetRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: SandboxSetContractRequest,
): { id: number; promise: Promise<SandboxSetWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId(req.op, req)
  const promise = (async (): Promise<SandboxSetWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch {
      // Any async peer/transport rejection is unresolved: the server may or
      // may not have applied the idempotent set. Never synthesize a terminal
      // `retryable:false` failure here; only a validated server `failed`
      // result may close with zero SDK. Map every rejection (closed or
      // generic) to ambiguous `transportUnknown` so the caller takes exactly
      // one same-target SDK fallback. `host.isClosed`/`failInfo` are retained
      // for caller compatibility and are intentionally not used to close.
      void host
      return ambiguousTransportUnknown(req)
    }
    if (host.isStale()) return { kind: "valid", result: makeSandboxSetAmbiguous(req, true) }
    return normalizePrivateSandboxSetWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

export function makeSandboxSetCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
  op: string,
): (msg?: string) => boolean {
  return (msg = "private sandbox-set timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate(`${op} stale observer timeout`)
      } catch {
        console.warn("[Kilo Sandbox] stale observer cleanup failed:", { op, stale: true, cleanupFailed: true })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo Sandbox] observer timeout cancel failed:", { op, cancelFailed: true })
      try {
        host.invalidate(`${op} observer timeout cancel throw`)
      } catch {
        console.warn("[Kilo Sandbox] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate(`${op} observer timeout exact cancel miss`)
      } catch {
        console.warn("[Kilo Sandbox] observer timeout invalidate failed:", { op, invalidateFailed: true })
      }
      return false
    }
    return true
  }
}

export { validateSandboxSetResult }
export type { SandboxSetContractRequest as ServePrivateSandboxSetRequest }
export type { SandboxSetResult as ServePrivateSandboxSetResult }
export type { SandboxSetWireOutcome as PrivateSandboxSetWireOutcome }
