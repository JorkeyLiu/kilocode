import type { ServePrivatePeer } from "./serve-private-peer"
import {
  isSettledProviderModelsDiscoverResult,
  makeProviderModelsDiscoverAmbiguous,
} from "./serve-private-provider-models-discover-contract"
import type {
  ProviderModelsDiscoverContractRequest,
  ProviderModelsDiscoverWireOutcome,
} from "./serve-private-provider-models-discover-contract"

type Handle = { id: number; promise: Promise<ProviderModelsDiscoverWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `provider/models-discover` observation handle (observation
// identity is `requestId`; no `opId`/`idempotencyKey`). Settled
// success/terminal across post-response epoch drift is preserved; only
// unresolved drift maps to the ambiguous `transportUnknown` outcome. Exact
// pending cancel on timeout; a stale captured handle cleans only its captured
// peer, only a current-epoch exact-cancel miss invalidates the owner.
export function providerModelsDiscoverHandle(deps: Deps, req: ProviderModelsDiscoverContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("provider/models-discover"))
    throw new Error("Private peer missing provider/models-discover capability")
  const handle = (
    peer as unknown as {
      privateProviderModelsDiscoverOutcomeWithHandle: (r: ProviderModelsDiscoverContractRequest) => {
        id: number
        promise: Promise<ProviderModelsDiscoverWireOutcome>
        cancel: (msg?: string) => boolean
      }
    }
  ).privateProviderModelsDiscoverOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledProviderModelsDiscoverResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at)
      return {
        kind: "valid",
        result: makeProviderModelsDiscoverAmbiguous(req, true),
      } as ProviderModelsDiscoverWireOutcome
    if (deps.peer !== peer)
      return {
        kind: "valid",
        result: makeProviderModelsDiscoverAmbiguous(req, true),
      } as ProviderModelsDiscoverWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout requestId=${req.requestId}`)
      } catch (err) {
        console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "provider/models-discover",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "provider/models-discover",
      })
      deps.invalidate(`observer timeout cancel throw requestId=${req.requestId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss requestId=${req.requestId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
