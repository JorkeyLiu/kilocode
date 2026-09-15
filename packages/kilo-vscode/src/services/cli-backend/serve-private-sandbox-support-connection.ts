import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledSandboxSupportResult, makeSandboxSupportAmbiguous } from "./serve-private-sandbox-support-contract"
import type {
  SandboxSupportContractRequest,
  SandboxSupportWireOutcome,
} from "./serve-private-sandbox-support-contract"

type Handle = { id: number; promise: Promise<SandboxSupportWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `sandbox/support` sessionless observation handle (observation identity is
// `requestId`; no `opId`/`idempotencyKey`). Settled success/terminal across
// post-response epoch drift is preserved; only unresolved drift maps to the
// ambiguous `transportUnknown` outcome. Exact pending cancel on timeout; a
// stale captured handle cleans only its captured peer, only a current-epoch
// exact-cancel miss invalidates the owner.
export function sandboxSupportHandle(deps: Deps, req: SandboxSupportContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("sandbox/support")) throw new Error("Private peer missing sandbox/support capability")
  const handle = (peer as unknown as {
    privateSandboxSupportOutcomeWithHandle: (r: SandboxSupportContractRequest) => {
      id: number
      promise: Promise<SandboxSupportWireOutcome>
      cancel: (msg?: string) => boolean
    }
  }).privateSandboxSupportOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledSandboxSupportResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at) return { kind: "valid", result: makeSandboxSupportAmbiguous(req, true) } as SandboxSupportWireOutcome
    if (deps.peer !== peer) return { kind: "valid", result: makeSandboxSupportAmbiguous(req, true) } as SandboxSupportWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout requestId=${req.requestId}`)
      } catch (err) {
        console.warn("[Kilo Sandbox] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "sandbox/support",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo Sandbox] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "sandbox/support",
      })
      deps.invalidate(`observer timeout cancel throw requestId=${req.requestId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss requestId=${req.requestId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
