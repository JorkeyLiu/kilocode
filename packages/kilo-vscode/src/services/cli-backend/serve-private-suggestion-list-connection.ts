import type { ServePrivatePeer } from "./serve-private-peer"
import {
  isSettledSuggestionListResult,
  makeSuggestionListAmbiguous,
} from "./serve-private-suggestion-list-contract"
import type {
  SuggestionListContractRequest,
  SuggestionListWireOutcome,
} from "./serve-private-suggestion-list-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Handle = { id: number; promise: Promise<SuggestionListWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function suggestionListHandle(deps: Deps, req: SuggestionListContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "suggestion/list",
    req,
    call: (peer) => peer.privateSuggestionListWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeSuggestionListAmbiguous(r, true) }),
    settled: (outcome, want) => {
      if (outcome.kind !== "valid") return false
      return isSettledSuggestionListResult(outcome.result, want)
    },
  })
}
