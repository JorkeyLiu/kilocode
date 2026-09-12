import type { ServePrivatePeer } from "./serve-private-peer"
import {
  isSettledPermissionListResult,
  makePermissionListAmbiguous,
} from "./serve-private-permission-list-contract"
import type {
  PermissionListContractRequest,
  PermissionListWireOutcome,
} from "./serve-private-permission-list-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Handle = { id: number; promise: Promise<PermissionListWireOutcome>; cancel: (msg?: string) => boolean }

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function permissionListHandle(deps: Deps, req: PermissionListContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "permission/list",
    req,
    call: (peer) => peer.privatePermissionListWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makePermissionListAmbiguous(r, true) }),
    settled: (outcome, want) => {
      if (outcome.kind !== "valid") return false
      return isSettledPermissionListResult(outcome.result, want)
    },
  })
}
