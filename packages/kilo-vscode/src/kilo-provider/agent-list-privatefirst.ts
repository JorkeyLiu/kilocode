import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { agentListHandle } from "../services/cli-backend/serve-private-agent-list-connection"
import {
  isAgentListValidationError,
  validateAgentListEntries,
  validateAgentListResult,
} from "../services/cli-backend/serve-private-agent-list-contract"
import type {
  AgentListContractRequest,
  AgentListEntry,
} from "../services/cli-backend/serve-private-agent-list-contract"

export type { AgentListEntry }

/**
 * Private-first `agent/list` read-only observation (the same
 * `Agent.Service.list()` source as `client.app.agents`).
 *
 * One private attempt plus at most one same-directory SDK fallback per read,
 * never retried inside the helper. Valid private `succeeded`+`accepted`
 * returns the full `Agent.Info` wire with zero SDK; validated terminal
 * `failed` (`retryable === false`, including `validation.failed`/
 * `scope_mismatch`/`internal`) closes with zero SDK; unavailable/retryable
 * fence/invalid/ambiguous/transport/closed/timeout takes exactly one
 * same-directory SDK `client.app.agents` fallback. Read-only and safely
 * repeatable: no durable op, no journal, no reconcile, no `opId`/
 * `idempotencyKey` (observation identity is `requestId` only). No
 * `postMessage`, no retry, no cache, no filter, no sort — the caller keeps
 * `retry()`, `filterVisibleAgents`, cache/post, and the canonical
 * `sendCanonicalAgents` short-circuit.
 *
 * Timeout (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport (settled
 * success/terminal across post-response drift is preserved, unresolved drift
 * maps to ambiguous).
 */
export interface AgentListPrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateAgentListOutcomeWithHandle?: (req: AgentListContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildAgentListReq(directory: string, workspace?: string): AgentListContractRequest {
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    op: "agent/list" as const,
    context: workspace === undefined ? { directory } : { directory, workspace },
    payload: {},
  }
}

export type AgentListAttempt =
  | { kind: "ok"; agents: AgentListEntry[] }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseAgentListResult(result: unknown, req: AgentListContractRequest): AgentListAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateAgentListResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", agents: out.data.agents }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateAgentListResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private agent-list timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: AgentListPrivateConnection): {
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

export async function attemptAgentListPrivate(
  connection: KiloConnectionService | AgentListPrivateConnection | null | undefined,
  req: AgentListContractRequest,
  ms = 3000,
): Promise<AgentListAttempt> {
  const conn = connection as AgentListPrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateAgentListOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = agentListHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseAgentListResult(outcome.result, req)
  } catch (e) {
    if (isAgentListValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private agent-list timeout") && handle) {
      try {
        handle.cancel?.(`private agent-list timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  app: {
    agents: (
      args: { directory: string; workspace?: string },
      opts: { throwOnError: boolean },
    ) => Promise<{ data?: unknown }>
  }
}

export type AgentListPrivateFirstOutcome =
  | { kind: "ok"; agents: AgentListEntry[]; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkAgents(data: unknown): AgentListEntry[] | null {
  try {
    return validateAgentListEntries(data)
  } catch {
    return null
  }
}

// Shared private-first agent-list read: valid private returns the full
// `Agent.Info` wire with zero SDK; validated terminal closes with zero SDK;
// otherwise exactly one same-directory SDK fallback with no retry and no
// timeout wrapper; SDK failure/malformed returns `unavailable` for the caller
// (whose `retry()` preserves the existing transient retry) to handle.
export async function fetchAgentsPrivateFirst(opts: {
  connection?: KiloConnectionService | AgentListPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
  workspace?: string
}): Promise<AgentListPrivateFirstOutcome> {
  const req = buildAgentListReq(opts.directory, opts.workspace)
  const attempt = await attemptAgentListPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", agents: attempt.agents, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.client
  if (!client?.app?.agents) return { kind: "unavailable" }
  try {
    const res =
      opts.workspace === undefined
        ? await client.app.agents({ directory: opts.directory }, { throwOnError: true })
        : await client.app.agents({ directory: opts.directory, workspace: opts.workspace }, { throwOnError: true })
    const coerced = coerceSdkAgents((res as { data?: unknown }).data)
    if (!coerced) return { kind: "unavailable" }
    return { kind: "ok", agents: coerced, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
