import type { ServePrivatePeer } from "./serve-private-peer"
import { makeRevertAmbiguous, makeUnrevertAmbiguous } from "./serve-private-revert-contract"
import type {
  ServePrivateRevertRequest,
  ServePrivateRevertResult,
  ServePrivateUnrevertRequest,
  ServePrivateUnrevertResult,
} from "./serve-private-revert-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function revertHandle(deps: Deps, req: ServePrivateRevertRequest): { id: number; promise: Promise<ServePrivateRevertResult>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "session/revert",
    req,
    call: (peer) => peer.privateRevertWithHandle(req),
    vague: (r) => makeRevertAmbiguous(r),
  })
}

export function unrevertHandle(deps: Deps, req: ServePrivateUnrevertRequest): { id: number; promise: Promise<ServePrivateUnrevertResult>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "session/unrevert",
    req,
    call: (peer) => peer.privateUnrevertWithHandle(req),
    vague: (r) => makeUnrevertAmbiguous(r),
  })
}
