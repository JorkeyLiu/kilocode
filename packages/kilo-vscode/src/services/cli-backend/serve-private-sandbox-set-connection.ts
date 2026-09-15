import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledSandboxSetResult, makeSandboxSetAmbiguous } from "./serve-private-sandbox-set-contract"
import type {
  SandboxSetContractRequest,
  SandboxSetWireOutcome,
} from "./serve-private-sandbox-set-contract"

type Handle = { id: number; promise: Promise<SandboxSetWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `sandbox/set` mutation handle. Settled success/terminal across
// post-response epoch drift is preserved; only unresolved drift maps to the
// ambiguous `transportUnknown` outcome. Exact pending cancel on timeout; a
// stale captured handle cleans only its captured peer, only a current-epoch
// exact-cancel miss invalidates the owner.
export function sandboxSetHandle(deps: Deps, req: SandboxSetContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("sandbox/set")) throw new Error("Private peer missing sandbox/set capability")
  const handle = (peer as unknown as {
    privateSandboxSetOutcomeWithHandle: (r: SandboxSetContractRequest) => {
      id: number
      promise: Promise<SandboxSetWireOutcome>
      cancel: (msg?: string) => boolean
    }
  }).privateSandboxSetOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledSandboxSetResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at) return { kind: "valid", result: makeSandboxSetAmbiguous(req, true) } as SandboxSetWireOutcome
    if (deps.peer !== peer) return { kind: "valid", result: makeSandboxSetAmbiguous(req, true) } as SandboxSetWireOutcome
    return outcome
  })
  const cancel = (msg = "private sandbox-set timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout opId=${req.opId}`)
      } catch (err) {
        console.warn("[Kilo Sandbox] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "sandbox/set",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo Sandbox] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "sandbox/set",
      })
      deps.invalidate(`observer timeout cancel throw opId=${req.opId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss opId=${req.opId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
