import { makePathAmbiguous, normalizePrivatePathWire } from "./serve-private-path-contract"
import type {
  PathContractRequest,
  PathResult,
  PathWireOutcome,
} from "./serve-private-path-contract"

// `path/get` private-first read mechanics. Success data is
// `{path: {home,state,config,worktree,directory}}`; only `state` is consumed
// by `model-state` and globals stay process-global (never compared).
// Diagnostics never expose path material, directories, workspaces,
// op/request ids, backend codes, or raw error strings: only fixed
// categories, booleans, and the constant op.

export const PATH_TRANSPORT_FAILURE_MESSAGE = "private path transport failed"

function sanitizePathFailureCode(code: string): string {
  if (typeof code !== "string" || code.length === 0) return "internal"
  if (code.includes("/") || code.includes("\\") || code.includes("\0")) return "internal"
  return code
}

export function failedPathResult(req: PathContractRequest, code: string, _msg: string): PathResult {
  const safeCode = sanitizePathFailureCode(code)
  const message = PATH_TRANSPORT_FAILURE_MESSAGE
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "path/get",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code: safeCode, message, retryable: false } },
    accepted: false,
    failure: { code: safeCode, message, retryable: false },
  }
}

/** Minimal raw transport surface a peer owner needs for the path outcome handle. */
export interface PathRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape. */
interface PathRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the private-first path read.
 * The caller validates the request and checks availability and capability
 * first. Transport/closed maps to ambiguous transportUnknown, thrown errors
 * map to redacted failed results, and malformed wire resolves as
 * `{ kind: "invalid" }` before any consumer. No retries, no replays.
 */
export function requestPathOutcome(
  raw: PathRawTransport,
  host: PathRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: PathContractRequest,
): { id: number; promise: Promise<PathWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId("path/get", req)
  const promise = (async (): Promise<PathWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makePathAmbiguous(req, true) }
      const { code } = host.failInfo(e)
      return { kind: "valid", result: failedPathResult(req, code, PATH_TRANSPORT_FAILURE_MESSAGE) }
    }
    if (host.isStale()) return { kind: "valid", result: makePathAmbiguous(req, true) }
    return normalizePrivatePathWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

/** Owner-level epoch mapping for the connection pass-through. */
interface PathOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

/**
 * Connection-side epoch-aware wrapper around a peer path outcome handle.
 * Epoch drift or peer replacement maps to ambiguous transportUnknown; exact
 * cancel preserves the peer while current-epoch cancel miss/throw fail-closed
 * via owner invalidation. A stale captured handle cleans only its captured
 * peer and returns `"stale"` so the observer never invalidates the
 * replacement peer.
 */
export function wrapPathOutcomeForOwner(
  owner: PathOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<PathWireOutcome> },
  req: PathContractRequest,
): { id: number; promise: Promise<PathWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      return { kind: "valid", result: makePathAmbiguous(req, true) } as PathWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private path timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo Path] stale observer cleanup failed:", { op: "path/get", stale: true, cleanupFailed: true })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo Path] observer timeout cancel failed:", { op: "path/get", cancelFailed: true })
      try {
        owner.invalidate("path observer timeout cancel throw")
      } catch {
        console.warn("[Kilo Path] observer timeout invalidate failed:", { op: "path/get", invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("path observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo Path] observer timeout invalidate failed:", { op: "path/get", invalidateFailed: true })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

/**
 * Shared observer-timeout branch classification for the peer invalidation
 * switch. Covers the pre-existing messages/children/remote-status safe
 * reasons plus the `path/get` safe reasons so the peer method stays within
 * the complexity budget. Returns the redacted op label or null.
 */
export function pathObserverTimeoutBranch(reason: string): { op: string } | null {
  if (
    reason === "stale observer timeout" ||
    reason === "observer timeout cancel throw" ||
    reason === "observer timeout exact cancel miss" ||
    reason === "messages observer timeout"
  )
    return { op: "session/messages" }
  if (
    reason === "children stale observer timeout" ||
    reason === "children observer timeout cancel throw" ||
    reason === "children observer timeout exact cancel miss" ||
    reason === "children observer timeout"
  )
    return { op: "session/children" }
  if (
    reason === "remote-status stale observer timeout" ||
    reason === "remote-status observer timeout cancel throw" ||
    reason === "remote-status observer timeout exact cancel miss" ||
    reason === "remote-status observer timeout"
  )
    return { op: "remote/status" }
  if (
    reason === "path stale observer timeout" ||
    reason === "path observer timeout cancel throw" ||
    reason === "path observer timeout exact cancel miss" ||
    reason === "path observer timeout"
  )
    return { op: "path/get" }
  return null
}
