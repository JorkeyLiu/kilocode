import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledInstanceReloadResult, makeInstanceReloadAmbiguous } from "./serve-private-instance-reload-contract"
import type {
  InstanceReloadContractRequest,
  InstanceReloadWireOutcome,
} from "./serve-private-instance-reload-contract"

type Handle = { id: number; promise: Promise<InstanceReloadWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `instance/reload` mutation handle (mutation identity is
// `instance-reload:<token>` for `opId`/`idempotencyKey` plus `requestId`).
// Settled success/terminal across post-response epoch drift is preserved;
// only unresolved drift maps to the ambiguous `transportUnknown` outcome.
// Exact pending cancel on timeout; a stale captured handle cleans only its
// captured peer, only a current-epoch exact-cancel miss invalidates the owner.
// Extracted `kilo/profile` owner shape with no new `connection-service` wrapper
// so the shared connection service stays under its file cap.
export function instanceReloadHandle(deps: Deps, req: InstanceReloadContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("instance/reload")) throw new Error("Private peer missing instance/reload capability")
  const handle = (peer as unknown as {
    privateInstanceReloadOutcomeWithHandle: (r: InstanceReloadContractRequest) => {
      id: number
      promise: Promise<InstanceReloadWireOutcome>
      cancel: (msg?: string) => boolean
    }
  }).privateInstanceReloadOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledInstanceReloadResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at) return { kind: "valid", result: makeInstanceReloadAmbiguous(req, true) } as InstanceReloadWireOutcome
    if (deps.peer !== peer) return { kind: "valid", result: makeInstanceReloadAmbiguous(req, true) } as InstanceReloadWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout opId=${req.opId}`)
      } catch (err) {
        console.warn("[Kilo Reload] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "instance/reload",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo Reload] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "instance/reload",
      })
      deps.invalidate(`observer timeout cancel throw opId=${req.opId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss opId=${req.opId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
