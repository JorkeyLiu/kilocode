import type { ServePrivatePeer } from "./serve-private-peer"
import { makeSessionModelUsageAmbiguous } from "./serve-private-session-model-usage-contract"
import type {
  SessionModelUsageContractRequest,
  SessionModelUsageWireOutcome,
} from "./serve-private-session-model-usage-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function sessionModelUsageOutcomeHandle(
  deps: Deps,
  req: SessionModelUsageContractRequest,
): { id: number; promise: Promise<SessionModelUsageWireOutcome>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "session/model-usage",
    req,
    call: (peer) => peer.privateSessionModelUsageOutcomeWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeSessionModelUsageAmbiguous(r, true) }),
  })
}
