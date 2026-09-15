import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledSessionViewedResult, makeSessionViewedAmbiguous } from "./serve-private-session-viewed-contract"
import type {
  SessionViewedContractRequest,
  SessionViewedWireOutcome,
} from "./serve-private-session-viewed-contract"

type Handle = { id: number; promise: Promise<SessionViewedWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `session/viewed` presence-write handle (request identity is
// `requestId`; no `opId`/`idempotencyKey`; semantic identity is
// `(viewer.id, sequence)`). Settled success/terminal across post-response
// epoch drift is preserved; only unresolved drift maps to the ambiguous
// `transportUnknown` outcome. Exact pending cancel on timeout; a stale
// captured handle cleans only its captured peer, only a current-epoch
// exact-cancel miss invalidates the owner.
export function sessionViewedHandle(deps: Deps, req: SessionViewedContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("session/viewed")) throw new Error("Private peer missing session/viewed capability")
  const handle = (peer as unknown as {
    privateSessionViewedOutcomeWithHandle: (r: SessionViewedContractRequest) => {
      id: number
      promise: Promise<SessionViewedWireOutcome>
      cancel: (msg?: string) => boolean
    }
  }).privateSessionViewedOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledSessionViewedResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at) return { kind: "valid", result: makeSessionViewedAmbiguous(req, true) } as SessionViewedWireOutcome
    if (deps.peer !== peer) return { kind: "valid", result: makeSessionViewedAmbiguous(req, true) } as SessionViewedWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout requestId=${req.requestId}`)
      } catch (err) {
        console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "session/viewed",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "session/viewed",
      })
      deps.invalidate(`observer timeout cancel throw requestId=${req.requestId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss requestId=${req.requestId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
