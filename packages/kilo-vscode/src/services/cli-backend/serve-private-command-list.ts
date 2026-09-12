import {
  makeCommandListAmbiguous,
  normalizePrivateCommandListWire,
} from "./serve-private-command-list-contract"
import type {
  CommandListContractRequest,
  CommandListResult,
  CommandListWireOutcome,
} from "./serve-private-command-list-contract"

// `command/list` private-first read mechanics. Success data is
// `{commands: [{name, description?, source?, hints?}]}` preserving the
// carrier's `Command.Service.list()` order; `template` (lazy promise
// content), `agent`, `model`, and `subtask` are excluded by projection and
// never cross the boundary.

export const COMMAND_LIST_TRANSPORT_FAILURE_MESSAGE = "private command-list transport failed"

export function failedCommandListResult(
  req: CommandListContractRequest,
  code: string,
  msg: string,
): CommandListResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "command/list",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
    accepted: false,
    failure: { code, message: msg, retryable: false },
  }
}

/** Minimal raw transport surface a peer owner needs for the command-list outcome handle. */
export interface CommandListRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape. */
interface CommandListRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the private-first
 * command-list read. The caller validates the request and checks
 * availability and capability first. Transport/closed maps to ambiguous
 * transportUnknown, thrown errors map to failed results with a fixed
 * message, and malformed wire resolves as `{ kind: "invalid" }` before any
 * settler. No retries, no replays.
 */
export function requestCommandListOutcome(
  raw: CommandListRawTransport,
  host: CommandListRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: CommandListContractRequest,
): { id: number; promise: Promise<CommandListWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId("command/list", req)
  const promise = (async (): Promise<CommandListWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeCommandListAmbiguous(req, true) }
      const { code } = host.failInfo(e)
      return { kind: "valid", result: failedCommandListResult(req, code, COMMAND_LIST_TRANSPORT_FAILURE_MESSAGE) }
    }
    if (host.isStale()) return { kind: "valid", result: makeCommandListAmbiguous(req, true) }
    return normalizePrivateCommandListWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

/** Owner-level epoch mapping for the connection pass-through. */
interface CommandListOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

/**
 * Connection-side epoch-aware wrapper around a peer command-list outcome
 * handle. Epoch drift or peer replacement maps to ambiguous transportUnknown;
 * exact cancel preserves the peer while current-epoch cancel miss/throw
 * fail-closed via owner invalidation. A stale captured handle cleans only its
 * captured peer and returns `"stale"` so the private read never invalidates the
 * replacement peer.
 */
export function wrapCommandListOutcomeForOwner(
  owner: CommandListOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<CommandListWireOutcome> },
  req: CommandListContractRequest,
): { id: number; promise: Promise<CommandListWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      return { kind: "valid", result: makeCommandListAmbiguous(req, true) } as CommandListWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private read timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo CommandList] stale private read cleanup failed:", {
          op: "command/list",
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
      console.warn("[Kilo CommandList] private read timeout cancel failed:", {
        op: "command/list",
        cancelFailed: true,
      })
      try {
        owner.invalidate("command-list private read timeout cancel throw")
      } catch {
        console.warn("[Kilo CommandList] private read timeout invalidate failed:", {
          op: "command/list",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("command-list private read timeout exact cancel miss")
      } catch {
        console.warn("[Kilo CommandList] private read timeout invalidate failed:", {
          op: "command/list",
          invalidateFailed: true,
        })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}


