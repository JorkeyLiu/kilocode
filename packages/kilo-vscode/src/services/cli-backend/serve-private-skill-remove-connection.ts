import type { ServePrivatePeer } from "./serve-private-peer"
import { makeSkillRemoveAmbiguous } from "./serve-private-skill-remove-contract"
import type {
  SkillRemoveContractRequest,
  SkillRemoveWireOutcome,
} from "./serve-private-skill-remove-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function skillRemoveOutcomeHandle(
  deps: Deps,
  req: SkillRemoveContractRequest,
): { id: number; promise: Promise<SkillRemoveWireOutcome>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "skill/remove",
    req,
    call: (peer) => peer.privateSkillRemoveOutcomeWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeSkillRemoveAmbiguous(r, true) }),
    settled: (outcome) => outcome.kind === "valid",
  })
}
