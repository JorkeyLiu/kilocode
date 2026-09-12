import type { ServePrivatePeer } from "./serve-private-peer"
import {
  isSettledQuestionListResult,
  makeQuestionListAmbiguous,
} from "./serve-private-question-list-contract"
import type {
  QuestionListContractRequest,
  QuestionListWireOutcome,
} from "./serve-private-question-list-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Handle = { id: number; promise: Promise<QuestionListWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function questionListHandle(deps: Deps, req: QuestionListContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "question/list",
    req,
    call: (peer) => peer.privateQuestionListWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeQuestionListAmbiguous(r, true) }),
    settled: (outcome, want) => {
      if (outcome.kind !== "valid") return false
      return isSettledQuestionListResult(outcome.result, want)
    },
  })
}
