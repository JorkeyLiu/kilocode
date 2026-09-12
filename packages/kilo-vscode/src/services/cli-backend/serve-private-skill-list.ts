import {
  makeSkillListAmbiguous,
  normalizePrivateSkillListWire,
} from "./serve-private-skill-list-contract"
import type {
  SkillListContractRequest,
  SkillListResult,
  SkillListWireOutcome,
} from "./serve-private-skill-list-contract"

// `skill/list` private-first read mechanics. Success data is
// `{skills: [{name, description?, location}]}` preserving the
// carrier's `Skill.Service.all()` insertion order; SKILL.md `content`
// and file bytes are excluded by projection and never cross the
// boundary.

export const SKILL_LIST_TRANSPORT_FAILURE_MESSAGE = "private skill-list transport failed"

export function failedSkillListResult(
  req: SkillListContractRequest,
  code: string,
  msg: string,
): SkillListResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "skill/list",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
    accepted: false,
    failure: { code, message: msg, retryable: false },
  }
}

/** Minimal raw transport surface a peer owner needs for the skill-list outcome handle. */
export interface SkillListRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape. */
interface SkillListRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the private-first
 * skill-list read. The caller validates the request and checks
 * availability and capability first. Transport/closed maps to ambiguous
 * transportUnknown, thrown errors map to failed results with a fixed
 * message, and malformed wire resolves as `{ kind: "invalid" }` before any
 * settler. No retries, no replays.
 */
export function requestSkillListOutcome(
  raw: SkillListRawTransport,
  host: SkillListRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: SkillListContractRequest,
): { id: number; promise: Promise<SkillListWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId("skill/list", req)
  const promise = (async (): Promise<SkillListWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeSkillListAmbiguous(req, true) }
      const { code } = host.failInfo(e)
      return { kind: "valid", result: failedSkillListResult(req, code, SKILL_LIST_TRANSPORT_FAILURE_MESSAGE) }
    }
    if (host.isStale()) return { kind: "valid", result: makeSkillListAmbiguous(req, true) }
    return normalizePrivateSkillListWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

/** Owner-level epoch mapping for the connection pass-through. */
interface SkillListOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

/**
 * Connection-side epoch-aware wrapper around a peer skill-list outcome
 * handle. Epoch drift or peer replacement maps to ambiguous transportUnknown;
 * exact cancel preserves the peer while current-epoch cancel miss/throw
 * fail-closed via owner invalidation. A stale captured handle cleans only its
 * captured peer and returns `"stale"` so the private read never invalidates the
 * replacement peer.
 */
export function wrapSkillListOutcomeForOwner(
  owner: SkillListOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<SkillListWireOutcome> },
  req: SkillListContractRequest,
): { id: number; promise: Promise<SkillListWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      return { kind: "valid", result: makeSkillListAmbiguous(req, true) } as SkillListWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private read timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo SkillList] stale private read cleanup failed:", {
          op: "skill/list",
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
      console.warn("[Kilo SkillList] private read timeout cancel failed:", {
        op: "skill/list",
        cancelFailed: true,
      })
      try {
        owner.invalidate("skill-list private read timeout cancel throw")
      } catch {
        console.warn("[Kilo SkillList] private read timeout invalidate failed:", {
          op: "skill/list",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("skill-list private read timeout exact cancel miss")
      } catch {
        console.warn("[Kilo SkillList] private read timeout invalidate failed:", {
          op: "skill/list",
          invalidateFailed: true,
        })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}
