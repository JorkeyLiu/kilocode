import * as crypto from "crypto"
import { normalize } from "path"
import { resolve } from "path"
import {
  makeCommandListAmbiguous,
  normalizePrivateCommandListWire,
} from "./serve-private-command-list-contract"
import type {
  CommandListContractRequest,
  CommandListResult,
  CommandListWireOutcome,
} from "./serve-private-command-list-contract"

// `command/list` read-only parity mechanics (detached, warn-only).
// Success data is `{commands: [{name, description?, source?, hints?}]}`;
// `template` (lazy promise content), `agent`, `model`, and `subtask` are
// excluded by projection and never compared. Diagnostics never expose names,
// descriptions, sources, hints, directories, workspaces, op/request ids,
// backend codes, or raw error strings: only fixed categories, counts,
// booleans, and the constant op.

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
 * Peer-side normalized outcome handle core for the read-only command-list
 * parity observer. The caller validates the request and checks availability
 * and capability first. Transport/closed maps to ambiguous transportUnknown,
 * thrown errors map to failed results with a fixed message, and malformed
 * wire resolves as `{ kind: "invalid" }` before any comparator. No retries,
 * no replays.
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
 * captured peer and returns `"stale"` so the observer never invalidates the
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
  const cancel = (msg = "private parity timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo CommandList] stale observer cleanup failed:", {
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
      console.warn("[Kilo CommandList] observer timeout cancel failed:", {
        op: "command/list",
        cancelFailed: true,
      })
      try {
        owner.invalidate("command-list observer timeout cancel throw")
      } catch {
        console.warn("[Kilo CommandList] observer timeout invalidate failed:", {
          op: "command/list",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("command-list observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo CommandList] observer timeout invalidate failed:", {
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

/**
 * Keyed deferred command-list observers: at most one deferred private
 * command-list observation per backend epoch + canonical directory +
 * workspace identity. Every component is opaque and domain-separated
 * (`e-`/`d-`/`w-` SHA-256 digests with `command-list/epoch`,
 * `command-list/dir`, `command-list/workspace` domains): serialized keys
 * never carry raw directory/workspace material and `:` inside a raw value
 * cannot collide across tuples. Exact `dir`/`workspace` closure values stay
 * with the caller for request construction; only the digest key is stored
 * here. Owner-managed: wrappers live in the owner's one-shot listener set;
 * this store only provides the dedupe key. No timers, no polling, no
 * detached work, no new peer lifecycle.
 */
export class DeferredCommandList {
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
      epoch === null
        ? "none"
        : `e-${crypto.createHash("sha256").update(`command-list/epoch\x00${epoch}`, "utf8").digest("hex")}`
    const dirPart = `d-${crypto.createHash("sha256").update(`command-list/dir\x00${canonical}`, "utf8").digest("hex")}`
    const wsPart =
      workspace === undefined
        ? "none"
        : `w-${crypto.createHash("sha256").update(`command-list/workspace\x00${workspace}`, "utf8").digest("hex")}`
    return `command-list:${epochPart}:${dirPart}:${wsPart}`
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
      epoch === null
        ? "none"
        : `e-${crypto.createHash("sha256").update(`command-list/epoch\x00${epoch}`, "utf8").digest("hex")}`
    const prefix = `command-list:${epochPart}:`
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
