import { makeFindFilesAmbiguous, normalizePrivateFindFilesWire } from "./serve-private-find-files-contract"
import type { FindFilesContractRequest, FindFilesWireOutcome } from "./serve-private-find-files-contract"

// `find/files` read-only private-authority mechanics (bounded search).
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

/** Minimal raw transport surface a peer owner needs for the find/files outcome handle. */
export interface FindFilesRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape.
 * `isClosed`/`failInfo` stay for caller compatibility; every inner rejection
 * maps uniformly to ambiguous so closed and non-closed are both
 * fallback-eligible. */
interface FindFilesRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the private-authority find/files
 * read. The caller validates the request and checks availability
 * and capability first. A non-closed inner rawPromise rejection carries no
 * trustworthy wire result, so it maps to unavailable-eligible ambiguous
 * transportUnknown (same as closed) rather than validated non-retryable
 * `find.failed`; genuine validated server `failed retryable:false` still
 * flows through `normalizePrivateFindFilesWire` as terminal. Thrown errors
 * never echo query/paths; malformed wire resolves as `{ kind: "invalid" }`
 * before any consumer. No retries, no replays.
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
    } catch {
      return { kind: "valid", result: makeFindFilesAmbiguous(req, true) }
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
 * Exact-id timeout cancel ownership for a find/files private-first handle.
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
 * Shared private-first timeout branch classification for the peer invalidation
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
