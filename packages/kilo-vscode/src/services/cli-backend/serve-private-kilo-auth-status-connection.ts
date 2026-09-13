import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledKiloAuthStatusResult, makeKiloAuthStatusAmbiguous } from "./serve-private-kilo-auth-status-contract"
import type {
  KiloAuthStatusContractRequest,
  KiloAuthStatusWireOutcome,
} from "./serve-private-kilo-auth-status-contract"

type Handle = { id: number; promise: Promise<KiloAuthStatusWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `kilo/auth-status` observation handle (observation identity is
// `requestId`; no `opId`/`idempotencyKey`). Settled success/terminal across
// post-response epoch drift is preserved; only unresolved drift maps to the
// ambiguous `transportUnknown` outcome. Exact pending cancel on timeout; a
// stale captured handle cleans only its captured peer, only a current-epoch
// exact-cancel miss invalidates the owner.
export function kiloAuthStatusHandle(deps: Deps, req: KiloAuthStatusContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("kilo/auth-status")) throw new Error("Private peer missing kilo/auth-status capability")
  const handle = (peer as unknown as {
    privateKiloAuthStatusOutcomeWithHandle: (r: KiloAuthStatusContractRequest) => {
      id: number
      promise: Promise<KiloAuthStatusWireOutcome>
      cancel: (msg?: string) => boolean
    }
  }).privateKiloAuthStatusOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledKiloAuthStatusResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at) return { kind: "valid", result: makeKiloAuthStatusAmbiguous(req, true) } as KiloAuthStatusWireOutcome
    if (deps.peer !== peer) return { kind: "valid", result: makeKiloAuthStatusAmbiguous(req, true) } as KiloAuthStatusWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout requestId=${req.requestId}`)
      } catch (err) {
        console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "kilo/auth-status",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "kilo/auth-status",
      })
      deps.invalidate(`observer timeout cancel throw requestId=${req.requestId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss requestId=${req.requestId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
