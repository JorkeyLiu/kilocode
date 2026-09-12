import {
  CONFIG_WARNINGS_FAILURE_MESSAGES,
  CONFIG_WARNINGS_FAILURE_RETRYABLE,
  CONFIG_WARNINGS_TRANSPORT_FAILURE_CODE,
  makeConfigWarningsAmbiguous,
  normalizePrivateConfigWarningsWire,
} from "./serve-private-config-warnings-contract"
import type {
  ConfigWarningsContractRequest,
  ConfigWarningsResult,
  ConfigWarningsWireOutcome,
} from "./serve-private-config-warnings-contract"

// `config/warnings` read-only private-first mechanics (safe projection).
// Success data is `{warnings: [{pathCategory, messageCategory}]}`; raw paths,
// raw diagnostic text, and detail never cross the boundary. Diagnostics never
// expose paths, messages, details, directories, workspaces, op/request ids,
// backend codes, or raw error strings: only fixed categories, counts,
// booleans, and the constant op.

export const CONFIG_WARNINGS_TRANSPORT_FAILURE_MESSAGE =
  CONFIG_WARNINGS_FAILURE_MESSAGES[CONFIG_WARNINGS_TRANSPORT_FAILURE_CODE]

export function failedConfigWarningsResult(
  req: ConfigWarningsContractRequest,
  code: string = CONFIG_WARNINGS_TRANSPORT_FAILURE_CODE,
  msg: string = CONFIG_WARNINGS_TRANSPORT_FAILURE_MESSAGE,
): ConfigWarningsResult {
  const safeCode =
    code === "validation.failed" ||
    code === "InstanceUnavailableDuringConfigRebuild" ||
    code === "internal" ||
    code === "transport"
      ? code
      : CONFIG_WARNINGS_TRANSPORT_FAILURE_CODE
  const message = CONFIG_WARNINGS_FAILURE_MESSAGES[safeCode]
  const retryable = CONFIG_WARNINGS_FAILURE_RETRYABLE[safeCode]
  void msg
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "config/warnings",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code: safeCode, message, retryable } },
    accepted: false,
    failure: { code: safeCode, message, retryable },
  }
}

/** Minimal raw transport surface a peer owner needs for the config-warnings outcome handle. */
export interface ConfigWarningsRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape. */
interface ConfigWarningsRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the private-first
 * config-warnings read. The caller validates the request and checks availability
 * and capability first. Transport/closed maps to ambiguous transportUnknown,
 * thrown errors map to failed results with a fixed message, and malformed
 * wire resolves as `{ kind: "invalid" }` before any consumer. No retries,
 * no replays.
 */
export function requestConfigWarningsOutcome(
  raw: ConfigWarningsRawTransport,
  host: ConfigWarningsRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: ConfigWarningsContractRequest,
): { id: number; promise: Promise<ConfigWarningsWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId("config/warnings", req)
  const promise = (async (): Promise<ConfigWarningsWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeConfigWarningsAmbiguous(req, true) }
      void host.failInfo
      void e
      return { kind: "valid", result: failedConfigWarningsResult(req) }
    }
    if (host.isStale()) return { kind: "valid", result: makeConfigWarningsAmbiguous(req, true) }
    return normalizePrivateConfigWarningsWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

/** Owner-level epoch mapping for the connection pass-through. */
interface ConfigWarningsOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

/**
 * Connection-side epoch-aware wrapper around a peer config-warnings outcome
 * handle. Epoch drift or peer replacement maps to ambiguous transportUnknown;
 * exact cancel preserves the peer while current-epoch cancel miss/throw
 * fail-closed via owner invalidation. A stale captured handle cleans only its
 * captured peer and returns `"stale"` so the private-first read never invalidates the
 * replacement peer.
 */
export function wrapConfigWarningsOutcomeForOwner(
  owner: ConfigWarningsOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<ConfigWarningsWireOutcome> },
  req: ConfigWarningsContractRequest,
): { id: number; promise: Promise<ConfigWarningsWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      return { kind: "valid", result: makeConfigWarningsAmbiguous(req, true) } as ConfigWarningsWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo ConfigWarnings] stale observer cleanup failed:", {
          op: "config/warnings",
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
      console.warn("[Kilo ConfigWarnings] observer timeout cancel failed:", {
        op: "config/warnings",
        cancelFailed: true,
      })
      try {
        owner.invalidate("config-warnings observer timeout cancel throw")
      } catch {
        console.warn("[Kilo ConfigWarnings] observer timeout invalidate failed:", {
          op: "config/warnings",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("config-warnings observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo ConfigWarnings] observer timeout invalidate failed:", {
          op: "config/warnings",
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
 * Exact-id timeout cancel ownership for a config-warnings private-first handle.
 * Only fixed categories reach diagnostics: the constant op plus booleans.
 * Stale handles clean only their captured peer; current-epoch miss/throw
 * reports through `invalidate` so the owner can fail-closed. Never echoes
 * op/request ids, directories, workspaces, backend codes, or raw errors.
 */
export function makeConfigWarningsCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
): (msg?: string) => boolean {
  return (msg = "private parity timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate("config-warnings stale observer timeout")
      } catch {
        console.warn("[Kilo ConfigWarnings] stale observer cleanup failed:", {
          op: "config/warnings",
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
      console.warn("[Kilo ConfigWarnings] observer timeout cancel failed:", {
        op: "config/warnings",
        cancelFailed: true,
      })
      try {
        host.invalidate("config-warnings observer timeout cancel throw")
      } catch {
        console.warn("[Kilo ConfigWarnings] observer timeout invalidate failed:", {
          op: "config/warnings",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate("config-warnings observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo ConfigWarnings] observer timeout invalidate failed:", {
          op: "config/warnings",
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
 * switch. Covers the `config/warnings` safe reasons so the peer method stays
 * within the complexity budget. Returns the redacted op label or null.
 */
export function configWarningsObserverTimeoutBranch(reason: string): { op: string } | null {
  if (
    reason === "config-warnings stale observer timeout" ||
    reason === "config-warnings observer timeout cancel throw" ||
    reason === "config-warnings observer timeout exact cancel miss" ||
    reason === "config-warnings observer timeout"
  )
    return { op: "config/warnings" }
  return null
}
