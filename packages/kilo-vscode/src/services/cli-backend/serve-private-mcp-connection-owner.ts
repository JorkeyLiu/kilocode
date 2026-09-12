import type { ServePrivatePeer } from "./serve-private-peer"
import { makeMcpConnectAmbiguous, makeMcpDisconnectAmbiguous } from "./serve-private-mcp-connection-contract"
import type {
  McpConnectContractRequest,
  McpConnectWireOutcome,
  McpDisconnectContractRequest,
  McpDisconnectWireOutcome,
} from "./serve-private-mcp-connection-contract"

interface McpConnectionOwner {
  isCurrent(): boolean
  tryCancel(id: number, msg: string): boolean
  invalidate(reason: string): void
  staleCleanup(): void
}

interface McpConnectionSvc {
  isPrivateAvailable(): boolean
  getPrivatePeer(): ServePrivatePeer | null
  getPrivateEpoch(): number | null
  invalidatePrivatePeerOnObserverTimeout(reason: string): void
}

function wrapOutcome<Req extends { opId: string }, Out>(
  owner: McpConnectionOwner,
  handle: { id: number; promise: Promise<Out> },
  req: Req,
  op: string,
  vague: (r: Req) => Out,
): { id: number; promise: Promise<Out>; cancel: (msg?: string) => boolean } {
  const promise = handle.promise.then((outcome) => {
    if ((outcome as { kind?: unknown }).kind === "valid") return outcome
    if (!owner.isCurrent()) return vague(req)
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (!owner.isCurrent()) {
      try {
        owner.staleCleanup()
      } catch (err) {
        console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), {
          op,
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
        op,
        opId: req.opId,
      })
      try {
        owner.invalidate(`observer timeout cancel throw opId=${req.opId}`)
      } catch (inner) {
        console.warn("[Kilo] observer timeout invalidate failed:", String(inner).slice(0, 200), {
          op,
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
          op,
          opId: req.opId,
        })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

function ownerOf(
  svc: McpConnectionSvc,
  peerAtCall: ServePrivatePeer,
  epochAtCall: number | null,
  opId: string,
): McpConnectionOwner {
  return {
    isCurrent: () =>
      svc.getPrivatePeer() === peerAtCall && (epochAtCall === null || svc.getPrivateEpoch() === epochAtCall),
    tryCancel: (id, msg) => peerAtCall.tryCancelPending(id, msg),
    invalidate: (reason) => svc.invalidatePrivatePeerOnObserverTimeout(reason),
    staleCleanup: () => peerAtCall.invalidateOnObserverTimeout(`stale observer timeout opId=${opId}`),
  }
}

function checkPeer(svc: McpConnectionSvc, cap: string): ServePrivatePeer {
  const peer = svc.getPrivatePeer()
  if (!peer || !svc.isPrivateAvailable() || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability(cap)) throw new Error(`Private peer missing ${cap} capability`)
  return peer
}

/**
 * Thin owner delegation for the private-only mcp/connect mutation: availability
 * and capability checks, exact-id handle acquisition, then the epoch-aware
 * wrapper. There is no SDK fallback: every non-succeeded outcome fails closed
 * and re-observes authoritative mcp/status.
 */
export function mcpConnectOutcomeForOwner(
  svc: McpConnectionSvc,
  req: McpConnectContractRequest,
): { id: number; promise: Promise<McpConnectWireOutcome>; cancel: (msg?: string) => boolean } {
  const peer = checkPeer(svc, "mcp/connect")
  const epochAtCall = svc.getPrivateEpoch()
  const peerAtCall = peer
  const handle = peerAtCall.privateMcpConnectOutcomeWithHandle(req)
  return wrapOutcome(ownerOf(svc, peerAtCall, epochAtCall, req.opId), handle, req, "mcp/connect", (r) => ({
    kind: "valid",
    result: makeMcpConnectAmbiguous(r, true),
  }))
}

/**
 * Thin owner delegation for the private-only mcp/disconnect mutation, same
 * fail-closed semantics as mcp/connect above.
 */
export function mcpDisconnectOutcomeForOwner(
  svc: McpConnectionSvc,
  req: McpDisconnectContractRequest,
): { id: number; promise: Promise<McpDisconnectWireOutcome>; cancel: (msg?: string) => boolean } {
  const peer = checkPeer(svc, "mcp/disconnect")
  const epochAtCall = svc.getPrivateEpoch()
  const peerAtCall = peer
  const handle = peerAtCall.privateMcpDisconnectOutcomeWithHandle(req)
  return wrapOutcome(ownerOf(svc, peerAtCall, epochAtCall, req.opId), handle, req, "mcp/disconnect", (r) => ({
    kind: "valid",
    result: makeMcpDisconnectAmbiguous(r, true),
  }))
}
