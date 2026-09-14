import type { ServePrivatePeer } from "./serve-private-peer"
import { wrapPtyRemoveOutcomeForOwner, wrapPtyUpdateOutcomeForOwner } from "./serve-private-pty"
import type {
  PrivatePtyRemoveWireOutcome,
  PrivatePtyUpdateWireOutcome,
  ServePrivatePtyRemoveRequest,
  ServePrivatePtyUpdateRequest,
} from "./serve-private-pty"

interface PtySvc {
  isPrivateAvailable(): boolean
  getPrivatePeer(): ServePrivatePeer | null
  getPrivateEpoch(): number | null
  invalidatePrivatePeerOnObserverTimeout(reason: string): void
}

/**
 * Thin owner delegation for the connection pass-through: availability check,
 * exact-id handle acquisition, then the epoch-aware wrapper. Only this entry
 * plus the peer methods stay inline per the connection-service cap convention.
 */
export function ptyUpdateOutcomeForOwner(
  svc: PtySvc,
  req: ServePrivatePtyUpdateRequest,
): {
  id: number
  promise: Promise<PrivatePtyUpdateWireOutcome>
  cancel: (msg?: string) => boolean | "stale"
} {
  const peer = svc.getPrivatePeer()
  if (!peer || !svc.isPrivateAvailable() || !peer.isAvailable()) throw new Error("Private peer unavailable")
  const epochAtCall = svc.getPrivateEpoch()
  const peerAtCall = peer
  return wrapPtyUpdateOutcomeForOwner(
    {
      epochAtCall,
      isCurrent: () => svc.getPrivatePeer() === peerAtCall && svc.getPrivateEpoch() === epochAtCall,
      invalidate: (reason) => svc.invalidatePrivatePeerOnObserverTimeout(reason),
    },
    (id, msg) => peerAtCall.tryCancelPending(id, msg),
    () => peerAtCall.invalidateOnObserverTimeout(`${req.op} stale observer timeout`),
    peerAtCall.privatePtyUpdateOutcomeWithHandle(req),
    req,
  )
}

export function ptyRemoveOutcomeForOwner(
  svc: PtySvc,
  req: ServePrivatePtyRemoveRequest,
): {
  id: number
  promise: Promise<PrivatePtyRemoveWireOutcome>
  cancel: (msg?: string) => boolean | "stale"
} {
  const peer = svc.getPrivatePeer()
  if (!peer || !svc.isPrivateAvailable() || !peer.isAvailable()) throw new Error("Private peer unavailable")
  const epochAtCall = svc.getPrivateEpoch()
  const peerAtCall = peer
  return wrapPtyRemoveOutcomeForOwner(
    {
      epochAtCall,
      isCurrent: () => svc.getPrivatePeer() === peerAtCall && svc.getPrivateEpoch() === epochAtCall,
      invalidate: (reason) => svc.invalidatePrivatePeerOnObserverTimeout(reason),
    },
    (id, msg) => peerAtCall.tryCancelPending(id, msg),
    () => peerAtCall.invalidateOnObserverTimeout(`${req.op} stale observer timeout`),
    peerAtCall.privatePtyRemoveOutcomeWithHandle(req),
    req,
  )
}
