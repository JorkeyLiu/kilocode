import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { mcpStatusOutcomeHandle } from "../services/cli-backend/serve-private-mcp-status-connection"
import type { McpStatusContractRequest, McpStatusMap } from "../services/cli-backend/serve-private-mcp-status-contract"
import { canonicalMcpStatusOpId, validateMcpStatusResult } from "../services/cli-backend/serve-private-mcp-status-contract"

export type { McpStatusMap }

export function buildMcpStatusIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = canonicalMcpStatusOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildMcpStatusReq(directory: string): McpStatusContractRequest {
  const ids = buildMcpStatusIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "mcp/status" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory },
    payload: {},
  }
}

export type McpStatusAttempt =
  | { kind: "ok"; status: McpStatusMap }
  | { kind: "terminal" }
  | { kind: "unavailable"; reason: string }

export function parseMcpStatusResult(result: unknown, req: McpStatusContractRequest): McpStatusAttempt {
  const rec = result as { kind?: unknown; status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "unavailable", reason: "invalid" }
  if (rec.kind === "invalid") return { kind: "unavailable", reason: "invalid" }
  const wire = rec as { kind?: string; result?: unknown }
  const inner = wire.kind === "valid" ? wire.result : result
  const typed = inner as { status?: unknown; accepted?: unknown; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "unavailable", reason: "transportUnknown" }
  if (typed.status === "ambiguous") return { kind: "unavailable", reason: "ambiguous" }
  if (typed.status === "succeeded") {
    try {
      const out = validateMcpStatusResult(inner, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "unavailable", reason: "invalid" }
      return { kind: "ok", status: out.data.status }
    } catch {
      return { kind: "unavailable", reason: "invalid" }
    }
  }
  if (typed.status === "failed") {
    try {
      const out = validateMcpStatusResult(inner, req)
      if (out.status !== "failed") return { kind: "unavailable", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "unavailable", reason: out.failure.code }
      return { kind: "terminal" }
    } catch {
      return { kind: "unavailable", reason: "invalid" }
    }
  }
  return { kind: "unavailable", reason: "invalid" }
}

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateMcpStatusOutcomeWithHandle?: (req: McpStatusContractRequest) => Handle
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private mcp-status timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: Conn): {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
} | null {
  const typed = conn as unknown as {
    getPrivatePeer?: () => ServePrivatePeer | null
    getPrivateEpoch?: () => number | null
    invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  }
  if (typeof typed.getPrivatePeer !== "function" || typeof typed.getPrivateEpoch !== "function") return null
  const peer = typed.getPrivatePeer()
  const epoch = typed.getPrivateEpoch() ?? null
  const invalidate = (reason: string) => typed.invalidatePrivatePeerOnObserverTimeout?.(reason)
  return { peer, live: true, epoch, invalidate }
}

export async function attemptMcpStatusPrivate(
  connection: KiloConnectionService | Conn | null | undefined,
  req: McpStatusContractRequest,
  ms = 3000,
): Promise<McpStatusAttempt> {
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "unavailable", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "unavailable", reason: "unavailable" }
  } catch {
    return { kind: "unavailable", reason: "unavailable" }
  }
  let handle: Handle | null = null
  try {
    const direct = conn.privateMcpStatusOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "unavailable", reason: "missing-capability" }
      handle = mcpStatusOutcomeHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "unavailable", reason: "invalid" }
    return parseMcpStatusResult(outcome.result, req)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private mcp-status timeout") && handle) {
      try {
        handle.cancel?.(`private mcp-status timeout opId=${req.opId}`)
      } catch {}
      return { kind: "unavailable", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "unavailable", reason: "transport" }
    return { kind: "unavailable", reason: msg.slice(0, 120) }
  }
}

export type McpStatusPrivateOutcome =
  | { kind: "ok"; status: McpStatusMap }
  | { kind: "terminal" }
  | { kind: "unavailable" }

// Shared private-authority MCP status read: valid private `succeeded+accepted`
// returns the exact status map with zero SDK; validated non-retryable
// terminal (`retryable === false`) remains terminal with zero SDK; private
// unavailable, missing capability, invalid, ambiguous/epoch drift,
// transport/closed, timeout, and retryable config-convergence fence all
// return explicit unavailable with zero SDK status calls and no retry.
// Never falls back to stale data as a new success.
export async function fetchMcpStatusPrivate(opts: {
  connection?: KiloConnectionService | Conn | null
  directory: string
}): Promise<McpStatusPrivateOutcome> {
  const req = buildMcpStatusReq(opts.directory)
  const attempt = await attemptMcpStatusPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", status: attempt.status }
  if (attempt.kind === "terminal") return { kind: "terminal" }
  return { kind: "unavailable" }
}
