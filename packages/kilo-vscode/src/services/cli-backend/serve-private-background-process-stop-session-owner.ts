import type { ServePrivatePeer } from "./serve-private-peer"
import { wrapBackgroundStopSessionOutcomeForOwner } from "./serve-private-background-process-stop-session"
import type {
  PrivateBackgroundStopSessionWireOutcome,
  ServePrivateBackgroundStopSessionRequest,
} from "./serve-private-background-process-stop-session"

interface BackgroundStopSessionSvc {
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
export function backgroundStopSessionOutcomeForOwner(
  svc: BackgroundStopSessionSvc,
  req: ServePrivateBackgroundStopSessionRequest,
): {
  id: number
  promise: Promise<PrivateBackgroundStopSessionWireOutcome>
  cancel: (msg?: string) => boolean | "stale"
} {
  const peer = svc.getPrivatePeer()
  if (!peer || !svc.isPrivateAvailable() || !peer.isAvailable()) throw new Error("Private peer unavailable")
  const epochAtCall = svc.getPrivateEpoch()
  const peerAtCall = peer
  return wrapBackgroundStopSessionOutcomeForOwner(
    {
      epochAtCall,
      isCurrent: () => svc.getPrivatePeer() === peerAtCall && svc.getPrivateEpoch() === epochAtCall,
      invalidate: (reason) => svc.invalidatePrivatePeerOnObserverTimeout(reason),
    },
    (id, msg) => peerAtCall.tryCancelPending(id, msg),
    () => peerAtCall.invalidateOnObserverTimeout(`${req.op} stale observer timeout`),
    peerAtCall.privateBackgroundStopSessionOutcomeWithHandle(req),
    req,
  )
}
