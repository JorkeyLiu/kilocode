import { normalize, resolve } from "path"
import * as crypto from "crypto"
import { makePathAmbiguous, normalizePrivatePathWire } from "./serve-private-path-contract"
import type {
  PathContractRequest,
  PathResult,
  PathWireOutcome,
} from "./serve-private-path-contract"

// `path/get` read-only parity mechanics (detached, warn-only).
// Success data is `{path: {home,state,config,worktree,directory}}`; globals
// stay process-global and are never compared. Diagnostics never expose path
// material, directories, workspaces, op/request ids, backend codes, or raw
// error strings: only fixed categories, booleans, and the constant op.

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
 * Peer-side normalized outcome handle core for the read-only path parity
 * observer. The caller validates the request and checks availability and
 * capability first. Transport/closed maps to ambiguous transportUnknown,
 * thrown errors map to redacted failed results, and malformed wire resolves
 * as `{ kind: "invalid" }` before any comparator. No retries, no replays.
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
  const cancel = (msg = "private parity timeout"): boolean | "stale" => {
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

/**
 * Keyed deferred path observers: at most one deferred private path
 * observation per backend epoch + canonical directory + workspace identity.
 * Every component is opaque and domain-separated (`e-`/`d-`/`w-` SHA-256
 * digests with `path/epoch`, `path/dir`, `path/workspace` domains): serialized
 * keys never carry raw directory/workspace material and `:` inside a raw
 * value cannot collide across tuples. Exact `dir`/`workspace` closure values
 * stay with the caller for request construction; only the digest key is
 * stored here. Owner-managed: wrappers live in the owner's one-shot listener
 * set; this store only provides the dedupe key. No timers, no polling, no
 * detached work, no new peer lifecycle.
 */
export class DeferredPath {
  private readonly keys = new Map<string, () => void>()
  constructor(private readonly listeners: Set<() => void>) {}

  key(epoch: number | null, dir: string, workspace: string | undefined): string {
    let canonical = dir
    try {
      canonical = normalize(resolve(dir))
    } catch {
      canonical = dir
    }
    const epochPart =
      epoch === null ? "none" : `e-${crypto.createHash("sha256").update(`path/epoch\x00${epoch}`, "utf8").digest("hex")}`
    const dirPart = `d-${crypto.createHash("sha256").update(`path/dir\x00${canonical}`, "utf8").digest("hex")}`
    const wsPart =
      workspace === undefined
        ? "none"
        : `w-${crypto.createHash("sha256").update(`path/workspace\x00${workspace}`, "utf8").digest("hex")}`
    return `path:${epochPart}:${dirPart}:${wsPart}`
  }

  add(
    epoch: number | null,
    failedEpoch: number | null,
    available: boolean,
    dir: string,
    workspace: string | undefined,
    listener: () => void,
  ): () => void {
    if (epoch === null) return () => {}
    if (failedEpoch !== null && epoch === failedEpoch) return () => {}
    if (available) return () => {}
    const key = this.key(epoch, dir, workspace)
    if (this.keys.has(key)) return () => {}
    let wrapper: () => void = () => {
      this.remove(key, wrapper)
      listener()
    }
    this.keys.set(key, wrapper)
    this.listeners.add(wrapper)
    return () => {
      this.remove(key, wrapper)
    }
  }

  clearForEpoch(epoch: number | null): void {
    const epochPart =
      epoch === null ? "none" : `e-${crypto.createHash("sha256").update(`path/epoch\x00${epoch}`, "utf8").digest("hex")}`
    const prefix = `path:${epochPart}:`
    for (const [key, wrapper] of [...this.keys]) {
      if (!key.startsWith(prefix)) continue
      this.keys.delete(key)
      this.listeners.delete(wrapper)
    }
  }

  clearAll(): void {
    for (const [, wrapper] of [...this.keys]) this.listeners.delete(wrapper)
    this.keys.clear()
  }

  private remove(key: string, wrapper: () => void): void {
    if (this.keys.get(key) === wrapper) this.keys.delete(key)
    this.listeners.delete(wrapper)
  }
}
