import type { ServePrivatePeer } from "./serve-private-peer"
import { makeAgentRequirementsAmbiguous } from "./serve-private-agent-requirements-contract"
import type {
  AgentRequirementsContractRequest,
  AgentRequirementsWireOutcome,
} from "./serve-private-agent-requirements-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function agentRequirementsOutcomeHandle(
  deps: Deps,
  req: AgentRequirementsContractRequest,
): { id: number; promise: Promise<AgentRequirementsWireOutcome>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "agent/requirements",
    req,
    call: (peer) => peer.privateAgentRequirementsOutcomeWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeAgentRequirementsAmbiguous(r, true) }),
  })
}
