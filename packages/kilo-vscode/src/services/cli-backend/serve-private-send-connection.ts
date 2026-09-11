import type { ServePrivatePeer } from "./serve-private-peer"
import { makePromptAmbiguous } from "./serve-private-prompt-contract"
import type { PromptContractRequest, PromptResult } from "./serve-private-prompt-contract"
import { makeCommandAmbiguous } from "./serve-private-command-contract"
import type { CommandContractRequest, CommandResult } from "./serve-private-command-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type SendConn = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

// Shared prompt/command send path. `conn` is held by reference so post-call
// epoch/peer drift maps to ambiguous and exact-cancel miss invalidates the
// owner; a stale captured handle cleans only its captured peer.
export function promptSendHandle(
  conn: SendConn,
  req: PromptContractRequest,
): { id: number; promise: Promise<PromptResult>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn,
    cap: "session/prompt",
    req,
    call: (peer) => peer.privatePromptWithHandle(req),
    vague: (r) => makePromptAmbiguous(r),
  })
}

export function commandSendHandle(
  conn: SendConn,
  req: CommandContractRequest,
): { id: number; promise: Promise<CommandResult>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn,
    cap: "session/command",
    req,
    call: (peer) => peer.privateCommandWithHandle(req),
    vague: (r) => makeCommandAmbiguous(r),
  })
}
