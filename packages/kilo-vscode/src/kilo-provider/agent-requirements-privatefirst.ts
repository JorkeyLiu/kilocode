import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import {
  canonicalAgentRequirementsOpId,
  validateAgentRequirementsResult,
} from "../services/cli-backend/serve-private-agent-requirements-contract"
import type { AgentRequirementsPayload } from "../services/cli-backend/serve-private-agent-requirements-contract"
import { agentRequirementsOutcomeHandle } from "../services/cli-backend/serve-private-agent-requirements-connection"

export function buildAgentRequirementsIdentity(agent: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID()
  const opId = canonicalAgentRequirementsOpId(agent, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export type AgentRequirementsAttempt =
  | { kind: "ok"; requirements: AgentRequirementsPayload }
  | { kind: "terminal" }
  | { kind: "fallback"; reason: string }

export function parseAgentRequirementsResult(result: unknown, req: unknown): AgentRequirementsAttempt {
  const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      validateAgentRequirementsResult(result as never, req as never)
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const requirements = (result as { data?: { requirements?: unknown } }).data?.requirements
    if (!requirements || typeof requirements !== "object")
      return { kind: "fallback", reason: "invalid private requirements" }
    return { kind: "ok", requirements: requirements as AgentRequirementsPayload }
  }
  if (typed.status === "failed") {
    try {
      validateAgentRequirementsResult(result as never, req as never)
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const failure = (result as { failure?: { code?: unknown; retryable?: unknown } }).failure
    if (failure?.retryable === true)
      return { kind: "fallback", reason: String(typeof failure?.code === "string" ? failure.code : "retryable") }
    if (failure?.retryable === false) return { kind: "terminal" }
    return { kind: "fallback", reason: "failed without retryable" }
  }
  return { kind: "fallback", reason: `private not succeeded: ${String(typed.status)}` }
}

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateAgentRequirementsOutcomeWithHandle?: (r: AgentRequirementsReq) => {
    id: number
    promise: Promise<unknown>
    cancel: (msg?: string) => boolean | "stale"
  }
}

type AgentRequirementsReq = {
  v: 1
  requestId: string
  opId: string
  op: "agent/requirements"
  idempotencyKey: string
  context: { directory: string; agent: string }
  payload: Record<string, never>
}

export async function attemptAgentRequirementsPrivate(
  connection: KiloConnectionService | Conn | null | undefined,
  req: AgentRequirementsReq,
  ms = 3000,
): Promise<AgentRequirementsAttempt> {
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    if (conn.privateAgentRequirementsOutcomeWithHandle) {
      handle = conn.privateAgentRequirementsOutcomeWithHandle(req)
    } else {
      const peer = conn.getPrivatePeer()
      handle = agentRequirementsOutcomeHandle(
        {
          peer,
          live: true,
          epoch: conn.getPrivateEpoch(),
          invalidate: (r) => conn.invalidatePrivatePeerOnObserverTimeout?.(r),
        },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseAgentRequirementsResult(outcome.result, req)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private parity timeout") && handle) {
      try {
        handle.cancel?.(`private parity timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}
