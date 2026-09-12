import type { ServePrivatePeer } from "./serve-private-peer"
import { makeSkillRemoveAmbiguous } from "./serve-private-skill-remove-contract"
import type {
  SkillRemoveContractRequest,
  SkillRemoveWireOutcome,
} from "./serve-private-skill-remove-contract"

interface SkillRemoveOwner {
  isCurrent(): boolean
  tryCancel(id: number, msg: string): boolean
  invalidate(reason: string): void
  staleCleanup(): void
}

interface SkillRemoveSvc {
  isPrivateAvailable(): boolean
  getPrivatePeer(): ServePrivatePeer | null
  getPrivateEpoch(): number | null
  invalidatePrivatePeerOnObserverTimeout(reason: string): void
}

/**
 * Thin owner delegation for the connection pass-through: availability and
 * capability checks, exact-id handle acquisition, then the epoch-aware
 * wrapper. Only this entry plus the peer methods stay inline per the
 * connection-service cap convention.
 */
export function skillRemoveOutcomeForOwner(
  svc: SkillRemoveSvc,
  req: SkillRemoveContractRequest,
): { id: number; promise: Promise<SkillRemoveWireOutcome>; cancel: (msg?: string) => boolean } {
  const peer = svc.getPrivatePeer()
  if (!peer || !svc.isPrivateAvailable() || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("skill/remove")) throw new Error("Private peer missing skill/remove capability")
  const epochAtCall = svc.getPrivateEpoch()
  const peerAtCall = peer
  const handle = peerAtCall.privateSkillRemoveOutcomeWithHandle(req)
  return wrapSkillRemoveOutcomeForOwner(
    {
      isCurrent: () =>
        svc.getPrivatePeer() === peerAtCall && (epochAtCall === null || svc.getPrivateEpoch() === epochAtCall),
      tryCancel: (id, msg) => peerAtCall.tryCancelPending(id, msg),
      invalidate: (reason) => svc.invalidatePrivatePeerOnObserverTimeout(reason),
      staleCleanup: () => peerAtCall.invalidateOnObserverTimeout(`stale observer timeout opId=${req.opId}`),
    },
    handle,
    req,
  )
}

/**
 * Connection-side epoch-aware wrapper around a peer skill/remove outcome
 * handle. Settled authoritative terminals (any valid wire outcome) survive
 * post-response drift; only unresolved drift maps to ambiguous
 * transportUnknown. Exact cancel preserves the peer while current-epoch
 * cancel miss/throw fail-closed via owner invalidation. A stale captured
 * handle cleans only its captured peer. There is no SDK fallback: every
 * non-succeeded outcome fails closed and re-observes authoritative skills.
 */
export function wrapSkillRemoveOutcomeForOwner(
  owner: SkillRemoveOwner,
  handle: { id: number; promise: Promise<SkillRemoveWireOutcome> },
  req: SkillRemoveContractRequest,
): { id: number; promise: Promise<SkillRemoveWireOutcome>; cancel: (msg?: string) => boolean } {
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid") return outcome
    if (!owner.isCurrent()) return { kind: "valid", result: makeSkillRemoveAmbiguous(req, true) } as SkillRemoveWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (!owner.isCurrent()) {
      try {
        owner.staleCleanup()
      } catch (err) {
        console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "skill/remove",
          opId: req.opId,
        })
      }
      return false
    }
    let ok = false
    try {
      ok = owner.tryCancel(handle.id, msg)
    } catch (err) {
      console.warn("[Kilo] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "skill/remove",
        opId: req.opId,
      })
      try {
        owner.invalidate(`observer timeout cancel throw opId=${req.opId}`)
      } catch (inner) {
        console.warn("[Kilo] observer timeout invalidate failed:", String(inner).slice(0, 200), {
          op: "skill/remove",
          opId: req.opId,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate(`observer timeout exact cancel miss opId=${req.opId}`)
      } catch (err) {
        console.warn("[Kilo] observer timeout invalidate failed:", String(err).slice(0, 200), {
          op: "skill/remove",
          opId: req.opId,
        })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}
