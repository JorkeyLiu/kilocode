import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledAgentListResult, makeAgentListAmbiguous } from "./serve-private-agent-list-contract"
import type {
  AgentListContractRequest,
  AgentListWireOutcome,
} from "./serve-private-agent-list-contract"

type Handle = { id: number; promise: Promise<AgentListWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Epoch-guarded `agent/list` observation handle (observation identity is
// `requestId`; no `opId`/`idempotencyKey`). Settled success/terminal across
// post-response epoch drift is preserved; only unresolved drift maps to the
// ambiguous `transportUnknown` outcome. Exact pending cancel on timeout; a
// stale captured handle cleans only its captured peer, only a current-epoch
// exact-cancel miss invalidates the owner.
export function agentListHandle(deps: Deps, req: AgentListContractRequest): Handle {
  const at = deps.epoch
  const peer = deps.peer
  if (!peer || !deps.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability("agent/list")) throw new Error("Private peer missing agent/list capability")
  const handle = (peer as unknown as {
    privateAgentListOutcomeWithHandle: (r: AgentListContractRequest) => {
      id: number
      promise: Promise<AgentListWireOutcome>
      cancel: (msg?: string) => boolean
    }
  }).privateAgentListOutcomeWithHandle(req)
  const promise = handle.promise.then((outcome) => {
    if (outcome.kind === "valid" && isSettledAgentListResult(outcome.result, req)) return outcome
    if (at !== null && deps.epoch !== at) return { kind: "valid", result: makeAgentListAmbiguous(req, true) } as AgentListWireOutcome
    if (deps.peer !== peer) return { kind: "valid", result: makeAgentListAmbiguous(req, true) } as AgentListWireOutcome
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (deps.peer !== peer || deps.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout requestId=${req.requestId}`)
      } catch (err) {
        console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), {
          op: "agent/list",
        })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo] observer timeout cancel failed:", String(err).slice(0, 200), {
        op: "agent/list",
      })
      deps.invalidate(`observer timeout cancel throw requestId=${req.requestId}`)
      return false
    }
    if (!ok) deps.invalidate(`observer timeout exact cancel miss requestId=${req.requestId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
