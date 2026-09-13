import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import {
  canonicalMcpAddOpId,
  validateMcpAddContractRequest,
} from "../services/cli-backend/serve-private-mcp-add-contract"
import type {
  McpAddConfig,
  McpAddContractRequest,
} from "../services/cli-backend/serve-private-mcp-add-contract"
import type { McpStatusMap } from "../services/cli-backend/serve-private-mcp-status-contract"
import { mcpAddOutcomeHandle } from "../services/cli-backend/serve-private-mcp-connection"

export type { McpStatusMap }

export function buildMcpAddReq(directory: string, name: string, config: McpAddConfig): McpAddContractRequest {
  const token = crypto.randomUUID()
  const opId = canonicalMcpAddOpId(token)
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId,
    op: "mcp/add" as const,
    idempotencyKey: opId,
    context: { directory },
    payload: { name, config },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private mcp-add timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export type McpAddAttempt =
  | { kind: "ok"; status: McpStatusMap }
  | { kind: "failed"; code: string }
  | { kind: "closed"; reason: string }

// Short local registration settles fast: 3 s exact-cancel, same as
// connect/disconnect (non-OAuth; no browser callback to await).
export const MCP_ADD_TIMEOUT_MS = 3000

const ACTIONABLE_MCP_ADD_FAILURE: Record<string, string> = {
  "validation.failed": "invalid MCP registration request",
  scope_mismatch: "directory mismatch",
  InstanceUnavailableDuringConfigRebuild: "backend is rebuilding; retry shortly",
  internal: "internal error",
  unavailable: "backend unavailable",
  ambiguous: "result ambiguous",
  invalid: "invalid response",
  transport: "transport error",
  timeout: "operation timed out",
}

export function mcpAddFailureMessage(code: string): string {
  return ACTIONABLE_MCP_ADD_FAILURE[code] ?? ACTIONABLE_MCP_ADD_FAILURE["internal"]!
}

function normalizeMcpAddCode(code: unknown): string {
  if (typeof code !== "string") return "internal"
  return code in ACTIONABLE_MCP_ADD_FAILURE ? code : "internal"
}

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateMcpAddOutcomeWithHandle?: (r: McpAddContractRequest) => Handle
}

function parseAttempt(result: unknown): McpAddAttempt {
  const rec = result as {
    status?: unknown
    accepted?: unknown
    failure?: unknown
    data?: unknown
    transportUnknown?: unknown
  } | null
  if (!rec || typeof rec !== "object") return { kind: "closed", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "closed", reason: "transport" }
  if (rec.status === "ambiguous") return { kind: "closed", reason: "ambiguous" }
  if (rec.status === "succeeded" && rec.accepted === true) {
    const data = rec.data as { status?: unknown } | undefined
    if (!data || typeof data !== "object" || !data.status || typeof data.status !== "object")
      return { kind: "closed", reason: "invalid" }
    return { kind: "ok", status: data.status as McpStatusMap }
  }
  if (rec.status === "failed" && rec.accepted === false) {
    const failure = rec.failure as { code?: unknown; retryable?: unknown } | undefined
    const code = normalizeMcpAddCode(failure?.code)
    if (failure?.retryable === true) return { kind: "closed", reason: code }
    return { kind: "failed", code }
  }
  return { kind: "closed", reason: "ambiguous" }
}

// Shared private-only MCP add registration: at most one private call per
// registration with zero SDK fallback and zero retry. The `opId` token is
// correlation/diagnostic identity only; there is no cross-request replay.
// The returned status map is the sole convergence source for caller state.
export async function attemptMcpAddPrivate(
  connection: KiloConnectionService | Conn | null | undefined,
  req: McpAddContractRequest,
  ms = MCP_ADD_TIMEOUT_MS,
): Promise<McpAddAttempt> {
  try {
    validateMcpAddContractRequest(req)
  } catch {
    return { kind: "closed", reason: "invalid" }
  }
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "closed", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "closed", reason: "unavailable" }
  } catch {
    return { kind: "closed", reason: "unavailable" }
  }
  let handle: Handle | null = null
  try {
    const direct = conn.privateMcpAddOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const typed = conn as unknown as {
        getPrivatePeer?: () => { [k: string]: unknown } | null
        getPrivateEpoch?: () => number | null
        invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
      }
      if (typeof typed.getPrivatePeer !== "function" || typeof typed.getPrivateEpoch !== "function")
        return { kind: "closed", reason: "unavailable" }
      const peer = typed.getPrivatePeer() as never
      const epoch = typed.getPrivateEpoch() ?? null
      const invalidate = (reason: string) => typed.invalidatePrivatePeerOnObserverTimeout?.(reason)
      handle = mcpAddOutcomeHandle({ peer, live: true, epoch, invalidate }, req)
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "closed", reason: "invalid" }
    return parseAttempt(outcome.result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private mcp-add timeout") && handle) {
      try {
        handle.cancel?.(`private mcp-add timeout opId=${req.opId}`)
      } catch {}
      return { kind: "closed", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "closed", reason: "transport" }
    return { kind: "closed", reason: "internal" }
  }
}
