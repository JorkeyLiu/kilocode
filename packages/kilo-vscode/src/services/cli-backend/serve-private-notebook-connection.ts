import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledNotebookListResult, makeNotebookListAmbiguous } from "./serve-private-notebook-list-contract"
import type { NotebookListContractRequest, NotebookListWireOutcome } from "./serve-private-notebook-list-contract"
import { isSettledNotebookResult, makeNotebookAmbiguous } from "./serve-private-notebook-contract"
import type { NotebookRejectContractRequest, NotebookReplyContractRequest } from "./serve-private-notebook-contract"
import type { ServePrivateNotebookResult } from "./serve-private-peer"
import { wrapEpochHandle } from "./serve-private-epoch"

type Handle = { id: number; promise: Promise<ServePrivateNotebookResult>; cancel: (msg?: string) => boolean }

type ListHandle = { id: number; promise: Promise<NotebookListWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function notebookReplyHandle(deps: Deps, req: NotebookReplyContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "notebook/reply",
    req,
    call: (peer) => peer.privateNotebookReplyWithHandle(req),
    vague: (r) => makeNotebookAmbiguous(r) as unknown as ServePrivateNotebookResult,
    settled: (result, want) => isSettledNotebookResult(result, want),
  })
}

export function notebookRejectHandle(deps: Deps, req: NotebookRejectContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "notebook/reject",
    req,
    call: (peer) => peer.privateNotebookRejectWithHandle(req),
    vague: (r) => makeNotebookAmbiguous(r) as unknown as ServePrivateNotebookResult,
    settled: (result, want) => isSettledNotebookResult(result, want),
  })
}

export function notebookListHandle(deps: Deps, req: NotebookListContractRequest): ListHandle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "notebook/list",
    req,
    call: (peer) => peer.privateNotebookListWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeNotebookListAmbiguous(r, true) }),
    settled: (outcome, want) => {
      if (outcome.kind !== "valid") return false
      return isSettledNotebookListResult(outcome.result, want)
    },
  })
}
