import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledQuestionResult, makeQuestionAmbiguous } from "./serve-private-question-contract"
import type {
  QuestionRejectContractRequest,
  QuestionReplyContractRequest,
} from "./serve-private-question-contract"
import type { ServePrivateQuestionResult } from "./serve-private-peer"
import { wrapEpochHandle } from "./serve-private-epoch"

type Handle = { id: number; promise: Promise<ServePrivateQuestionResult>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function questionReplyHandle(deps: Deps, req: QuestionReplyContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "question/reply",
    req,
    call: (peer) => peer.privateQuestionReplyWithHandle(req),
    vague: (r) => makeQuestionAmbiguous(r) as unknown as ServePrivateQuestionResult,
    settled: (result, want) => isSettledQuestionResult(result, want),
  })
}

export function questionRejectHandle(deps: Deps, req: QuestionRejectContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "question/reject",
    req,
    call: (peer) => peer.privateQuestionRejectWithHandle(req),
    vague: (r) => makeQuestionAmbiguous(r) as unknown as ServePrivateQuestionResult,
    settled: (result, want) => isSettledQuestionResult(result, want),
  })
}
