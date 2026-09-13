import type { ServePrivatePeer } from "./serve-private-peer"
import {
  makeMcpAuthenticateAmbiguous,
  makeMcpConnectAmbiguous,
  makeMcpDisconnectAmbiguous,
} from "./serve-private-mcp-connection-contract"
import type {
  McpAuthenticateContractRequest,
  McpAuthenticateWireOutcome,
  McpConnectContractRequest,
  McpConnectWireOutcome,
  McpDisconnectContractRequest,
  McpDisconnectWireOutcome,
} from "./serve-private-mcp-connection-contract"
import { wrapEpochHandle } from "./serve-private-epoch"

type Deps = {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

export function mcpConnectOutcomeHandle(
  deps: Deps,
  req: McpConnectContractRequest,
): { id: number; promise: Promise<McpConnectWireOutcome>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "mcp/connect",
    req,
    call: (peer) => peer.privateMcpConnectOutcomeWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeMcpConnectAmbiguous(r, true) }),
    settled: (outcome) => outcome.kind === "valid",
  })
}

export function mcpDisconnectOutcomeHandle(
  deps: Deps,
  req: McpDisconnectContractRequest,
): { id: number; promise: Promise<McpDisconnectWireOutcome>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "mcp/disconnect",
    req,
    call: (peer) => peer.privateMcpDisconnectOutcomeWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeMcpDisconnectAmbiguous(r, true) }),
    settled: (outcome) => outcome.kind === "valid",
  })
}

export function mcpAuthenticateOutcomeHandle(
  deps: Deps,
  req: McpAuthenticateContractRequest,
): { id: number; promise: Promise<McpAuthenticateWireOutcome>; cancel: (msg?: string) => boolean } {
  return wrapEpochHandle({
    conn: { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
    cap: "mcp/authenticate",
    req,
    call: (peer) => peer.privateMcpAuthenticateOutcomeWithHandle(req),
    vague: (r) => ({ kind: "valid", result: makeMcpAuthenticateAmbiguous(r, true) }),
    settled: (outcome) => outcome.kind === "valid",
  })
}
