import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import {
  canonicalMcpAuthenticateOpId,
  canonicalMcpConnectOpId,
  canonicalMcpDisconnectOpId,
  validateMcpAuthenticateContractRequest,
  validateMcpConnectContractRequest,
  validateMcpDisconnectContractRequest,
} from "../services/cli-backend/serve-private-mcp-connection-contract"
import type {
  McpAuthenticateContractRequest,
  McpConnectContractRequest,
  McpDisconnectContractRequest,
} from "../services/cli-backend/serve-private-mcp-connection-contract"
import {
  mcpAuthenticateOutcomeHandle,
  mcpConnectOutcomeHandle,
  mcpDisconnectOutcomeHandle,
} from "../services/cli-backend/serve-private-mcp-connection"

export function buildMcpConnectReq(directory: string, name: string): McpConnectContractRequest {
  const token = crypto.randomUUID()
  const opId = canonicalMcpConnectOpId(token)
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId,
    op: "mcp/connect" as const,
    idempotencyKey: opId,
    context: { directory },
    payload: { name },
  }
}

export function buildMcpDisconnectReq(directory: string, name: string): McpDisconnectContractRequest {
  const token = crypto.randomUUID()
  const opId = canonicalMcpDisconnectOpId(token)
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId,
    op: "mcp/disconnect" as const,
    idempotencyKey: opId,
    context: { directory },
    payload: { name },
  }
}

export function buildMcpAuthenticateReq(directory: string, name: string): McpAuthenticateContractRequest {
  const token = crypto.randomUUID()
  const opId = canonicalMcpAuthenticateOpId(token)
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId,
    op: "mcp/authenticate" as const,
    idempotencyKey: opId,
    context: { directory },
    payload: { name },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private mcp-connection timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export type McpConnectionAttempt =
  | { kind: "ok" }
  | { kind: "failed"; code: string }
  | { kind: "closed"; reason: string }

// Short local mutations (connect/disconnect) settle fast: 3 s exact-cancel.
export const MCP_CONNECTION_TIMEOUT_MS = 3000
// OAuth browser callback legitimately outlasts seconds: the backend waits up
// to 5 min for the user to complete sign-in in the browser
// (`CALLBACK_TIMEOUT_MS = 5 * 60 * 1000` in
// `packages/opencode/src/mcp/oauth-callback.ts`, awaited by
// `MCP.authenticate` in `packages/opencode/src/mcp/index.ts` after opening
// the browser). The extension therefore bounds authenticate at the same 5 min
// with the same once-only exact-cancel semantics: one private call, no SDK
// fallback/retry, cancel exact id on expiry, then converge mcp/status.
export const MCP_AUTHENTICATE_TIMEOUT_MS = 5 * 60 * 1000

const ACTIONABLE_MCP_CONNECTION_FAILURE: Record<string, string> = {
  "mcp.not_found": "MCP server not found",
  "validation.failed": "invalid MCP connection request",
  scope_mismatch: "directory mismatch",
  InstanceUnavailableDuringConfigRebuild: "backend is rebuilding; retry shortly",
  internal: "internal error",
  unavailable: "backend unavailable",
  ambiguous: "result ambiguous",
  invalid: "invalid response",
  transport: "transport error",
  timeout: "operation timed out",
}

export function mcpConnectionFailureMessage(code: string): string {
  return ACTIONABLE_MCP_CONNECTION_FAILURE[code] ?? ACTIONABLE_MCP_CONNECTION_FAILURE["internal"]!
}

function normalizeMcpConnectionCode(code: unknown): string {
  if (typeof code !== "string") return "internal"
  return code in ACTIONABLE_MCP_CONNECTION_FAILURE ? code : "internal"
}

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateMcpConnectOutcomeWithHandle?: (r: McpConnectContractRequest) => Handle
  privateMcpDisconnectOutcomeWithHandle?: (r: McpDisconnectContractRequest) => Handle
  privateMcpAuthenticateOutcomeWithHandle?: (r: McpAuthenticateContractRequest) => Handle
}

function parseAttempt(result: unknown): McpConnectionAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; failure?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "closed", reason: "invalid" }
  if (rec.status === "succeeded" && rec.accepted === true) return { kind: "ok" }
  if (rec.status === "failed" && rec.accepted === false) {
    const failure = rec.failure as { code?: unknown; retryable?: unknown } | undefined
    const code = normalizeMcpConnectionCode(failure?.code)
    if (failure?.retryable === true) return { kind: "closed", reason: code }
    return { kind: "failed", code }
  }
  return { kind: "closed", reason: "ambiguous" }
}

async function attemptOnce(
  connection: KiloConnectionService | Conn | null | undefined,
  req: McpConnectContractRequest | McpDisconnectContractRequest | McpAuthenticateContractRequest,
  ms: number,
): Promise<McpConnectionAttempt> {
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "closed", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "closed", reason: "unavailable" }
  } catch {
    return { kind: "closed", reason: "unavailable" }
  }
  let handle: Handle | null = null
  try {
    const direct =
      req.op === "mcp/connect"
        ? conn.privateMcpConnectOutcomeWithHandle?.bind(conn)
        : req.op === "mcp/disconnect"
          ? conn.privateMcpDisconnectOutcomeWithHandle?.bind(conn)
          : conn.privateMcpAuthenticateOutcomeWithHandle?.bind(conn)
    if (direct) {
      handle = direct(req as never)
    } else {
      const peer = conn.getPrivatePeer()
      const deps = {
        peer,
        live: true,
        epoch: conn.getPrivateEpoch(),
        invalidate: (r: string) => conn.invalidatePrivatePeerOnObserverTimeout?.(r),
      }
      handle =
        req.op === "mcp/connect"
          ? mcpConnectOutcomeHandle(deps, req as McpConnectContractRequest)
          : req.op === "mcp/disconnect"
            ? mcpDisconnectOutcomeHandle(deps, req as McpDisconnectContractRequest)
            : mcpAuthenticateOutcomeHandle(deps, req as McpAuthenticateContractRequest)
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "closed", reason: "invalid" }
    return parseAttempt(outcome.result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private mcp-connection timeout") && handle) {
      try {
        handle.cancel?.(`private mcp-connection timeout opId=${req.opId}`)
      } catch {}
      return { kind: "closed", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "closed", reason: "transport" }
    return { kind: "closed", reason: "internal" }
  }
}

// Shared private-only MCP connect mutation: at most one private call per
// user action with zero SDK fallback and zero retry. The `opId` token is
// correlation/diagnostic identity only; there is no cross-request replay.
export async function attemptMcpConnectPrivate(
  connection: KiloConnectionService | Conn | null | undefined,
  req: McpConnectContractRequest,
  ms = MCP_CONNECTION_TIMEOUT_MS,
): Promise<McpConnectionAttempt> {
  try {
    validateMcpConnectContractRequest(req)
  } catch {
    return { kind: "closed", reason: "invalid" }
  }
  return attemptOnce(connection, req, ms)
}

// Shared private-only MCP disconnect mutation: same once-only semantics.
export async function attemptMcpDisconnectPrivate(
  connection: KiloConnectionService | Conn | null | undefined,
  req: McpDisconnectContractRequest,
  ms = MCP_CONNECTION_TIMEOUT_MS,
): Promise<McpConnectionAttempt> {
  try {
    validateMcpDisconnectContractRequest(req)
  } catch {
    return { kind: "closed", reason: "invalid" }
  }
  return attemptOnce(connection, req, ms)
}

// Shared private-only MCP authenticate mutation: same once-only semantics
// (one private call, zero SDK fallback/retry, exact-cancel on expiry), but
// with the OAuth-appropriate 5 min bound above instead of the short 3 s
// action timeout so the browser callback can complete.
export async function attemptMcpAuthenticatePrivate(
  connection: KiloConnectionService | Conn | null | undefined,
  req: McpAuthenticateContractRequest,
  ms = MCP_AUTHENTICATE_TIMEOUT_MS,
): Promise<McpConnectionAttempt> {
  try {
    validateMcpAuthenticateContractRequest(req)
  } catch {
    return { kind: "closed", reason: "invalid" }
  }
  return attemptOnce(connection, req, ms)
}
