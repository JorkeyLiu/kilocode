import * as crypto from "crypto"
import {
  canonicalSessionListOpId,
  validateSessionListResult,
} from "../services/cli-backend/serve-private-session-list-contract"
import type { SessionListContractRequest } from "../services/cli-backend/serve-private-session-list-contract"
import { SESSION_LIST_TRANSPORT_FAILURE_MESSAGE } from "../services/cli-backend/serve-private-session-list"

export function buildSessionExistencePrivateIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalSessionListOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildSessionExistencePrivateReq(dir: string): SessionListContractRequest {
  const ids = buildSessionExistencePrivateIdentity()
  return {
    v: 2 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "experimental/session/list" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory: dir },
    payload: { filter: { limit: 1, archived: true } },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private read timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export type SessionExistencePrivateAttempt = { kind: "ok"; has: boolean } | { kind: "fallback"; reason: string }

export function parseSessionExistencePrivateResult(result: unknown, req: unknown): SessionExistencePrivateAttempt {
  const typed = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      const out = validateSessionListResult(result as never, req as never)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", has: out.data.sessions.length > 0 }
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
  }
  if (typed.status === "failed") {
    try {
      const out = validateSessionListResult(result as never, req as never)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.message === SESSION_LIST_TRANSPORT_FAILURE_MESSAGE) {
        return { kind: "fallback", reason: "transport" }
      }
      return { kind: "fallback", reason: String(typeof out.failure.code === "string" ? out.failure.code : "failed") }
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
  }
  return { kind: "fallback", reason: `private not succeeded: ${String(typed.status)}` }
}

type Conn = {
  isPrivateAvailable(): boolean
  privateSessionListOutcomeWithHandle(req: SessionListContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

type Client = {
  experimental: {
    session: {
      list(
        args: { directory: string; limit: number; archived: boolean },
        opts: { throwOnError: boolean },
      ): Promise<{ data?: unknown }>
    }
  }
}

type Full = Conn & {
  getClientAsync(dir: string): Promise<Client>
}

export async function attemptSessionExistencePrivate(
  connection: Conn | null | undefined,
  req: SessionListContractRequest,
  ms = 3000,
): Promise<SessionExistencePrivateAttempt> {
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = conn.privateSessionListOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseSessionExistencePrivateResult(outcome.result, req)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private read timeout") && handle) {
      try {
        handle.cancel?.(`private read timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

/**
 * Bounded onboarding existence probe. One private `experimental/session/list`
 * attempt (`context {directory}` + `filter {limit:1, archived:true}`, 3 s
 * exact-cancel/epoch); a valid `succeeded`+`accepted` result is authoritative
 * boolean `sessions.length > 0` with zero SDK. Every other private outcome
 * takes exactly one same-directory SDK
 * `experimental.session.list({directory, limit:1, archived:true})` fallback
 * with current error propagation (transient SDK failure throws so the caller
 * posts `skipped` without persistence). `getClientAsync` runs only on
 * fallback so private success never acquires the SDK client. The directory
 * tuple intentionally corrects the prior omitted-directory global probe so
 * private availability cannot change onboarding.
 */
export async function hasAnySession(connection: Full | null | undefined, dir: string): Promise<boolean> {
  const conn = connection as Full | null | undefined
  let req: SessionListContractRequest | null = null
  try {
    req = buildSessionExistencePrivateReq(dir)
  } catch {
    req = null
  }
  if (req && conn) {
    const out = await attemptSessionExistencePrivate(conn, req)
    if (out.kind === "ok") return out.has
  }
  const client = await (conn as Full).getClientAsync(dir)
  const res = await client.experimental.session.list(
    { directory: dir, limit: 1, archived: true },
    { throwOnError: true },
  )
  const data = (res as { data?: unknown }).data
  return Array.isArray(data) ? data.length > 0 : false
}
