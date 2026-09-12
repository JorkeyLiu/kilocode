import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledMcpStatusResult, makeMcpStatusAmbiguous } from "./serve-private-mcp-status-contract"
import type { McpStatusContractRequest, McpStatusWireOutcome } from "./serve-private-mcp-status-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Handle = { id: number; promise: Promise<McpStatusWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function mcpStatusOutcomeHandle(deps: Deps, req: McpStatusContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "mcp/status",
    req,
    call: (peer) => peer.privateMcpStatusOutcomeWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeMcpStatusAmbiguous(r, true) }),
    settled: (outcome, want) => {
      if (outcome.kind !== "valid") return false
      return isSettledMcpStatusResult(outcome.result, want)
    },
  })
}
