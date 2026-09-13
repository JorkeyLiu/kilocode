import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledKiloProfileResult, makeKiloProfileAmbiguous } from "./serve-private-kilo-profile-contract"
import type {
  KiloProfileContractRequest,
  KiloProfileWireOutcome,
} from "./serve-private-kilo-profile-contract"

type Handle = { id: number; promise: Promise<KiloProfileWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `kilo/profile` observation handle (observation identity is
// `requestId`; no `opId`/`idempotencyKey`). Settled success/terminal across
// post-response epoch drift is preserved; only unresolved drift maps to the
// ambiguous `transportUnknown` outcome. Exact pending cancel on timeout; a
// stale captured handle cleans only its captured peer, only a current-epoch
// exact-cancel miss invalidates the owner.
export function kiloProfileHandle(deps: Deps, req: KiloProfileContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("kilo/profile")) throw new Error("Private peer missing kilo/profile capability")
  const handle = (peer as unknown as {
    privateKiloProfileOutcomeWithHandle: (r: KiloProfileContractRequest) => {
      id: number
      promise: Promise<KiloProfileWireOutcome>
      cancel: (msg?: string) => boolean
    }
  }).privateKiloProfileOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledKiloProfileResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at) return { kind: "valid", result: makeKiloProfileAmbiguous(req, true) } as KiloProfileWireOutcome
    if (deps.peer !== peer) return { kind: "valid", result: makeKiloProfileAmbiguous(req, true) } as KiloProfileWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout requestId=${req.requestId}`)
      } catch (err) {
        console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "kilo/profile",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "kilo/profile",
      })
      deps.invalidate(`observer timeout cancel throw requestId=${req.requestId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss requestId=${req.requestId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
