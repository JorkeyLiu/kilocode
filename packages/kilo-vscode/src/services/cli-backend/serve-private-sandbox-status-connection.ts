import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledSandboxStatusResult, makeSandboxStatusAmbiguous } from "./serve-private-sandbox-status-contract"
import type {
  SandboxStatusContractRequest,
  SandboxStatusWireOutcome,
} from "./serve-private-sandbox-status-contract"

type Handle = { id: number; promise: Promise<SandboxStatusWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `sandbox/status` observation handle (observation identity is
// `requestId`; no `opId`/`idempotencyKey`). Settled success/terminal across
// post-response epoch drift is preserved; only unresolved drift maps to the
// ambiguous `transportUnknown` outcome. Exact pending cancel on timeout; a
// stale captured handle cleans only its captured peer, only a current-epoch
// exact-cancel miss invalidates the owner.
export function sandboxStatusHandle(deps: Deps, req: SandboxStatusContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("sandbox/status")) throw new Error("Private peer missing sandbox/status capability")
  const handle = (peer as unknown as {
    privateSandboxStatusOutcomeWithHandle: (r: SandboxStatusContractRequest) => {
      id: number
      promise: Promise<SandboxStatusWireOutcome>
      cancel: (msg?: string) => boolean
    }
  }).privateSandboxStatusOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledSandboxStatusResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at) return { kind: "valid", result: makeSandboxStatusAmbiguous(req, true) } as SandboxStatusWireOutcome
    if (deps.peer !== peer) return { kind: "valid", result: makeSandboxStatusAmbiguous(req, true) } as SandboxStatusWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout requestId=${req.requestId}`)
      } catch (err) {
        console.warn("[Kilo Sandbox] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "sandbox/status",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo Sandbox] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "sandbox/status",
      })
      deps.invalidate(`observer timeout cancel throw requestId=${req.requestId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss requestId=${req.requestId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
