import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledSuggestionResult, makeSuggestionAmbiguous } from "./serve-private-suggestion-contract"
import type {
  SuggestionAcceptContractRequest,
  SuggestionDismissContractRequest,
} from "./serve-private-suggestion-contract"
import type { ServePrivateSuggestionResult } from "./serve-private-peer"
import { wrapEpochHandle } from "./serve-private-epoch"

type Handle = { id: number; promise: Promise<ServePrivateSuggestionResult>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function suggestionAcceptHandle(deps: Deps, req: SuggestionAcceptContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "suggestion/accept",
    req,
    call: (peer) => peer.privateSuggestionAcceptWithHandle(req),
    vague: (r) => makeSuggestionAmbiguous(r) as unknown as ServePrivateSuggestionResult,
    settled: (result, want) => isSettledSuggestionResult(result, want),
  })
}

export function suggestionDismissHandle(deps: Deps, req: SuggestionDismissContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "suggestion/dismiss",
    req,
    call: (peer) => peer.privateSuggestionDismissWithHandle(req),
    vague: (r) => makeSuggestionAmbiguous(r) as unknown as ServePrivateSuggestionResult,
    settled: (result, want) => isSettledSuggestionResult(result, want),
  })
}
