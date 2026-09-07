import { normalize, resolve } from "path"
import * as crypto from "crypto"
import { makeSessionListAmbiguous, normalizePrivateSessionListWire } from "./serve-private-session-list-contract"
import type {
  PrivateSessionListWireOutcome,
  ServePrivateSessionListRequest,
  ServePrivateSessionListResult,
} from "./serve-private-session-list-contract"

// `experimental/session/list` read-only parity mechanics (detached, warn-only).
// Success data is `{sessions, nextCursor?}`; `nextCursor` is the inline
// opaque composite production `x-next-cursor` equivalent, omitted exactly when
// production omits the header. Diagnostics never expose ids, directories,
// titles, summaries, cursors, op/request ids, backend codes, or raw error
// strings: only fixed categories, counts, booleans, and the constant op.

export const SESSION_LIST_TRANSPORT_FAILURE_MESSAGE = "private session-list transport failed"

export function failedSessionListResult(
  req: ServePrivateSessionListRequest,
  code: string,
  msg: string,
): ServePrivateSessionListResult {
  return {
    v: 2,
    requestId: req.requestId,
    opId: req.opId,
    op: "experimental/session/list",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
    accepted: false,
    failure: { code, message: msg, retryable: false },
  }
}

/** Minimal raw transport surface a peer owner needs for the session-list outcome handle. */
export interface SessionListRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape. */
interface SessionListRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the read-only session-list
 * parity observer. The caller validates the request and checks availability
 * and capability first. Transport/closed maps to ambiguous transportUnknown,
 * thrown errors map to failed results, and malformed wire resolves as
 * `{ kind: "invalid" }` before any comparator. No retries, no replays.
 */
export function requestSessionListOutcome(
  raw: SessionListRawTransport,
  host: SessionListRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: ServePrivateSessionListRequest,
): { id: number; promise: Promise<PrivateSessionListWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId("experimental/session/list", req)
  const promise = (async (): Promise<PrivateSessionListWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeSessionListAmbiguous(req, true) }
      const { code } = host.failInfo(e)
      return { kind: "valid", result: failedSessionListResult(req, code, SESSION_LIST_TRANSPORT_FAILURE_MESSAGE) }
    }
    if (host.isStale()) return { kind: "valid", result: makeSessionListAmbiguous(req, true) }
    return normalizePrivateSessionListWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

/** Owner-level epoch mapping for the connection pass-through. */
interface SessionListOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

/**
 * Connection-side epoch-aware wrapper around a peer session-list outcome
 * handle. Epoch drift or peer replacement maps to ambiguous transportUnknown;
 * exact cancel preserves the peer while current-epoch cancel miss/throw
 * fail-closed via owner invalidation. A stale captured handle cleans only its
 * captured peer and returns `"stale"` so the observer never invalidates the
 * replacement peer.
 */
export function wrapSessionListOutcomeForOwner(
  owner: SessionListOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<PrivateSessionListWireOutcome> },
  req: ServePrivateSessionListRequest,
): { id: number; promise: Promise<PrivateSessionListWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      return { kind: "valid", result: makeSessionListAmbiguous(req, true) } as PrivateSessionListWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo SessionList] stale observer cleanup failed:", {
          op: "experimental/session/list",
          stale: true,
          cleanupFailed: true,
        })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo SessionList] observer timeout cancel failed:", {
        op: "experimental/session/list",
        cancelFailed: true,
      })
      try {
        owner.invalidate("session-list observer timeout cancel throw")
      } catch {
        console.warn("[Kilo SessionList] observer timeout invalidate failed:", {
          op: "experimental/session/list",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("session-list observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo SessionList] observer timeout invalidate failed:", {
          op: "experimental/session/list",
          invalidateFailed: true,
        })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

/** Filter identity the deferred session-list observer binds; structurally matches the parity filter. */
export interface DeferredSessionListFilter {
  projectID?: string
  roots?: boolean
  start?: number
  cursor?: string
  search?: string
  limit?: number
  archived?: boolean
}

function stableSessionListFilterString(filter: DeferredSessionListFilter): string {
  const rec = filter as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  const parts: string[] = []
  for (const k of keys) parts.push(`${k}=${JSON.stringify(rec[k])}`)
  return parts.join("&")
}

/**
 * Keyed deferred session-list observers: at most one deferred private
 * session-list observation per backend epoch + canonical directory +
 * workspace identity + exact filter. Every component is opaque and
 * domain-separated (`e-`/`d-`/`w-`/`f-` SHA-256 digests with
 * `session-list/epoch`, `session-list/dir`, `session-list/workspace`,
 * `session-list/filter` domains): serialized keys never carry raw
 * directory/workspace/filter material and `:` inside a raw value cannot
 * collide across tuples. Exact `dir`/`workspace`/`filter` closure values
 * stay with the caller for request construction; only the digest key is
 * stored here. Owner-managed: wrappers live in the owner's one-shot
 * listener set; this store only provides the dedupe key. No timers, no
 * polling, no detached work, no new peer lifecycle.
 */
export class DeferredSessionList {
  private readonly keys = new Map<string, () => void>()
  constructor(private readonly listeners: Set<() => void>) {}

  key(epoch: number | null, dir: string, workspace: string | undefined, filter: DeferredSessionListFilter): string {
    let canonical = dir
    try {
      canonical = normalize(resolve(dir))
    } catch {
      canonical = dir
    }
    const epochPart =
      epoch === null
        ? "none"
        : `e-${crypto.createHash("sha256").update(`session-list/epoch\x00${epoch}`, "utf8").digest("hex")}`
    const dirPart = `d-${crypto.createHash("sha256").update(`session-list/dir\x00${canonical}`, "utf8").digest("hex")}`
    const wsPart =
      workspace === undefined
        ? "none"
        : `w-${crypto.createHash("sha256").update(`session-list/workspace\x00${workspace}`, "utf8").digest("hex")}`
    const filterPart = `f-${crypto.createHash("sha256").update(`session-list/filter\x00${stableSessionListFilterString(filter)}`, "utf8").digest("hex")}`
    return `session-list:${epochPart}:${dirPart}:${wsPart}:${filterPart}`
  }

  add(
    epoch: number | null,
    failedEpoch: number | null,
    available: boolean,
    dir: string,
    workspace: string | undefined,
    filter: DeferredSessionListFilter,
    listener: () => void,
  ): () => void {
    if (epoch === null) return () => {}
    if (failedEpoch !== null && epoch === failedEpoch) return () => {}
    if (available) return () => {}
    const key = this.key(epoch, dir, workspace, filter)
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
      epoch === null
        ? "none"
        : `e-${crypto.createHash("sha256").update(`session-list/epoch\x00${epoch}`, "utf8").digest("hex")}`
    const prefix = `session-list:${epochPart}:`
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

  get size(): number {
    return this.keys.size
  }

  private remove(key: string, wrapper: () => void): void {
    if (this.keys.get(key) === wrapper) this.keys.delete(key)
    this.listeners.delete(wrapper)
  }
}
