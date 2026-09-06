import * as crypto from "crypto"
import { normalize } from "path"
import { resolve } from "path"
import {
  FIND_FILES_FAILED_CODE,
  FIND_FILES_FAILED_MESSAGE,
  makeFindFilesAmbiguous,
  normalizePrivateFindFilesWire,
} from "./serve-private-find-files-contract"
import type {
  FindFilesContractRequest,
  FindFilesResult,
  FindFilesWireOutcome,
} from "./serve-private-find-files-contract"

// `find/files` read-only parity mechanics (detached, warn-only).
// Success data is `{files: [{path, type}]}` with relative POSIX-normalized
// paths and explicit `file|directory` type; absolute paths, URIs, sensitive
// names, contents, and raw filesystem metadata never cross the boundary.
// Diagnostics never expose query, paths, directories, workspaces, op/request
// ids, backend codes, or raw error strings: only fixed categories, counts,
// booleans, and the constant op.
//
// Known residual: transport exact-cancel/pending cleanup does not abort the
// underlying FileSystem/ripgrep scan or release its server-side drain lease
// until source completion. No AbortSignal/source-cancellation plumbing is
// added here.

export const FIND_FILES_TRANSPORT_FAILURE_MESSAGE = FIND_FILES_FAILED_MESSAGE

export function failedFindFilesResult(req: FindFilesContractRequest): FindFilesResult {
  const failure = { code: FIND_FILES_FAILED_CODE, message: FIND_FILES_FAILED_MESSAGE, retryable: false }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "find/files",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

/** Minimal raw transport surface a peer owner needs for the find/files outcome handle. */
export interface FindFilesRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape. */
interface FindFilesRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the read-only find/files
 * parity observer. The caller validates the request and checks availability
 * and capability first. Transport/closed maps to ambiguous transportUnknown,
 * thrown errors map to failed results with a fixed message, and malformed
 * wire resolves as `{ kind: "invalid" }` before any comparator. No retries,
 * no replays.
 */
export function requestFindFilesOutcome(
  raw: FindFilesRawTransport,
  host: FindFilesRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: FindFilesContractRequest,
): { id: number; promise: Promise<FindFilesWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId("find/files", req)
  const promise = (async (): Promise<FindFilesWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeFindFilesAmbiguous(req, true) }
      void host.failInfo
      void e
      return { kind: "valid", result: failedFindFilesResult(req) }
    }
    if (host.isStale()) return { kind: "valid", result: makeFindFilesAmbiguous(req, true) }
    return normalizePrivateFindFilesWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

/** Owner-level epoch mapping for the connection pass-through. */
interface FindFilesOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

/**
 * Connection-side epoch-aware wrapper around a peer find/files outcome
 * handle. Epoch drift or peer replacement maps to ambiguous transportUnknown;
 * exact cancel preserves the peer while current-epoch cancel miss/throw
 * fail-closed via owner invalidation. A stale captured handle cleans only its
 * captured peer and returns `"stale"` so the observer never invalidates the
 * replacement peer.
 */
export function wrapFindFilesOutcomeForOwner(
  owner: FindFilesOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<FindFilesWireOutcome> },
  req: FindFilesContractRequest,
): { id: number; promise: Promise<FindFilesWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      return { kind: "valid", result: makeFindFilesAmbiguous(req, true) } as FindFilesWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo FindFiles] stale observer cleanup failed:", {
          op: "find/files",
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
      console.warn("[Kilo FindFiles] observer timeout cancel failed:", {
        op: "find/files",
        cancelFailed: true,
      })
      try {
        owner.invalidate("find-files observer timeout cancel throw")
      } catch {
        console.warn("[Kilo FindFiles] observer timeout invalidate failed:", {
          op: "find/files",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("find-files observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo FindFiles] observer timeout invalidate failed:", {
          op: "find/files",
          invalidateFailed: true,
        })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

/**
 * Exact-id timeout cancel ownership for a find/files observer handle.
 * Only fixed categories reach diagnostics: the constant op plus booleans.
 * Stale handles clean only their captured peer; current-epoch miss/throw
 * reports through `invalidate` so the owner can fail-closed. Never echoes
 * op/request ids, query, directories, workspaces, backend codes, or raw
 * errors.
 */
export function makeFindFilesCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
): (msg?: string) => boolean {
  return (msg = "private parity timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate("find-files stale observer timeout")
      } catch {
        console.warn("[Kilo FindFiles] stale observer cleanup failed:", {
          op: "find/files",
          stale: true,
          cleanupFailed: true,
        })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo FindFiles] observer timeout cancel failed:", {
        op: "find/files",
        cancelFailed: true,
      })
      try {
        host.invalidate("find-files observer timeout cancel throw")
      } catch {
        console.warn("[Kilo FindFiles] observer timeout invalidate failed:", {
          op: "find/files",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate("find-files observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo FindFiles] observer timeout invalidate failed:", {
          op: "find/files",
          invalidateFailed: true,
        })
      }
      return false
    }
    void id
    return true
  }
}

/**
 * Shared observer-timeout branch classification for the peer invalidation
 * switch. Covers the `find/files` safe reasons so the peer method stays
 * within the complexity budget. Returns the redacted op label or null.
 */
export function findFilesObserverTimeoutBranch(reason: string): { op: string } | null {
  if (
    reason === "find-files stale observer timeout" ||
    reason === "find-files observer timeout cancel throw" ||
    reason === "find-files observer timeout exact cancel miss" ||
    reason === "find-files observer timeout"
  )
    return { op: "find/files" }
  return null
}

/**
 * Keyed deferred find/files observers: at most one deferred private
 * find/files observation per backend epoch + canonical directory +
 * workspace identity + exact query (query/type/limit). Every component is
 * opaque and domain-separated (`e-`/`d-`/`w-`/`q-`/`t-`/`l-` SHA-256 digests
 * with `find-files/epoch`, `find-files/dir`, `find-files/workspace`,
 * `find-files/query`, `find-files/type`, `find-files/limit` domains):
 * serialized keys never carry raw directory/workspace/query material and
 * `:` inside a raw value cannot collide across tuples. Exact
 * `dir`/`workspace`/`query` closure values stay with the caller for request
 * construction; only the digest key is stored here. Owner-managed: wrappers
 * live in the owner's one-shot listener set; this store only provides the
 * dedupe key. No timers, no polling, no detached work, no new peer
 * lifecycle.
 */
export class DeferredFindFiles {
  private readonly keys = new Map<string, () => void>()
  constructor(private readonly listeners: Set<() => void>) {}

  key(
    epoch: number | null,
    dir: string,
    workspace: string | undefined,
    query: string,
    type: string,
    limit: number | undefined,
  ): string {
    let canonical = dir
    try {
      canonical = normalize(resolve(dir))
    } catch {
      canonical = dir
    }
    const epochPart =
      epoch === null
        ? "none"
        : `e-${crypto.createHash("sha256").update(`find-files/epoch\x00${epoch}`, "utf8").digest("hex")}`
    const dirPart = `d-${crypto.createHash("sha256").update(`find-files/dir\x00${canonical}`, "utf8").digest("hex")}`
    const wsPart =
      workspace === undefined
        ? "none"
        : `w-${crypto.createHash("sha256").update(`find-files/workspace\x00${workspace}`, "utf8").digest("hex")}`
    const qPart = `q-${crypto.createHash("sha256").update(`find-files/query\x00${query}`, "utf8").digest("hex")}`
    const tPart = `t-${crypto.createHash("sha256").update(`find-files/type\x00${type}`, "utf8").digest("hex")}`
    const lPart =
      limit === undefined
        ? "none"
        : `l-${crypto.createHash("sha256").update(`find-files/limit\x00${limit}`, "utf8").digest("hex")}`
    return `find-files:${epochPart}:${dirPart}:${wsPart}:${qPart}:${tPart}:${lPart}`
  }

  add(
    epoch: number | null,
    failedEpoch: number | null,
    available: boolean,
    dir: string,
    workspace: string | undefined,
    query: string,
    type: string,
    limit: number | undefined,
    listener: () => void,
  ): () => void {
    if (epoch === null) return () => {}
    if (failedEpoch !== null && epoch === failedEpoch) return () => {}
    if (available) return () => {}
    const key = this.key(epoch, dir, workspace, query, type, limit)
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
        : `e-${crypto.createHash("sha256").update(`find-files/epoch\x00${epoch}`, "utf8").digest("hex")}`
    const prefix = `find-files:${epochPart}:`
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
