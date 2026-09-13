import type { ServePrivatePeer } from "./serve-private-peer"
import { isSettledPermissionResult, makePermissionAmbiguous } from "./serve-private-permission-contract"
import type {
  PermissionReplyContractRequest,
  PermissionSaveContractRequest,
} from "./serve-private-permission-contract"
import {
  isSettledPermissionAllowEverythingResult,
  makePermissionAllowEverythingAmbiguous,
} from "./serve-private-permission-allow-everything-contract"
import type { PermissionAllowEverythingContractRequest } from "./serve-private-permission-allow-everything-contract"
import type { ServePrivatePermissionAllowEverythingResult, ServePrivatePermissionResult } from "./serve-private-peer"
import { wrapEpochHandle } from "./serve-private-epoch"

type Handle = { id: number; promise: Promise<ServePrivatePermissionResult>; cancel: (msg?: string) => boolean }

type AllowEverythingHandle = {
  id: number
  promise: Promise<ServePrivatePermissionAllowEverythingResult>
  cancel: (msg?: string) => boolean
}

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function permissionSaveHandle(deps: Deps, req: PermissionSaveContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "permission/save-always-rules",
    req,
    call: (peer) => peer.privatePermissionSaveWithHandle(req),
    vague: (r) => makePermissionAmbiguous(r) as unknown as ServePrivatePermissionResult,
    settled: (result, want) => isSettledPermissionResult(result, want),
  })
}

export function permissionReplyHandle(deps: Deps, req: PermissionReplyContractRequest): Handle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "permission/reply",
    req,
    call: (peer) => peer.privatePermissionReplyWithHandle(req),
    vague: (r) => makePermissionAmbiguous(r) as unknown as ServePrivatePermissionResult,
    settled: (result, want) => isSettledPermissionResult(result, want),
  })
}

export function permissionAllowEverythingHandle(
  deps: Deps,
  req: PermissionAllowEverythingContractRequest,
): AllowEverythingHandle {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "permission/allow-everything",
    req,
    call: (peer) => peer.privatePermissionAllowEverythingWithHandle(req),
    vague: (r) => makePermissionAllowEverythingAmbiguous(r) as unknown as ServePrivatePermissionAllowEverythingResult,
    settled: (result, want) => isSettledPermissionAllowEverythingResult(result, want),
  })
}
