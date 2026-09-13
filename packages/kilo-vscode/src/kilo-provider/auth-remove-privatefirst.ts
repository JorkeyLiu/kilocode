import * as crypto from "crypto"
import {
  canonicalAuthRemoveOpId,
  validateAuthRemoveResult,
} from "../services/cli-backend/serve-private-auth-remove-contract"
import { isPrivateAuthRemoveValidationError } from "../services/cli-backend/serve-private-auth-remove"
import type { ServePrivateAuthRemoveRequest } from "../services/cli-backend/serve-private-auth-remove"

/**
 * Private-first `auth/remove` mutation (the same global cold `Auth.remove`
 * owner as `client.auth.remove`; `directory`/`workspace` are routing identity
 * only, never an auth scope).
 *
 * One private attempt plus at most one same-identity SDK fallback per logout,
 * never retried. Valid private `succeeded`+`accepted` returns with zero SDK;
 * validated terminal `failed` (`retryable === false`) closes with zero SDK;
 * unavailable/retryable/invalid/ambiguous/transport/closed/timeout takes
 * exactly one same-identity SDK `client.auth.remove` fallback. `Auth.remove`
 * is idempotent, so an ambiguous private outcome may safely repeat via the
 * SDK fallback.
 */
export interface AuthRemovePrivateConnection {
  isPrivateAvailable(): boolean
  privateAuthRemoveOutcomeWithHandle(req: ServePrivateAuthRemoveRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildAuthRemoveIdentity(): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalAuthRemoveOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildAuthRemoveReq(
  providerID: string,
  dir: string,
  workspace?: string,
): ServePrivateAuthRemoveRequest {
  const ids = buildAuthRemoveIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "auth/remove" as const,
    idempotencyKey: ids.idempotencyKey,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: { providerID },
  }
}

export type AuthRemoveAttempt = { kind: "ok" } | { kind: "terminal"; code?: string } | { kind: "fallback"; reason: string }

export function parseAuthRemoveResult(result: unknown, req: ServePrivateAuthRemoveRequest): AuthRemoveAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateAuthRemoveResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateAuthRemoveResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: `private not succeeded: ${String(rec.status)}` }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private auth-remove timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptAuthRemovePrivate(
  connection: AuthRemovePrivateConnection | null | undefined,
  req: ServePrivateAuthRemoveRequest,
  ms = 3000,
): Promise<AuthRemoveAttempt> {
  const conn = connection
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = conn.privateAuthRemoveOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseAuthRemoveResult(outcome.result, req)
  } catch (e) {
    if (isPrivateAuthRemoveValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private auth-remove timeout") && handle) {
      try {
        handle.cancel?.(`private auth-remove timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  auth: {
    remove: (params?: unknown, opts?: unknown) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type AuthRemovePrivateFirstOutcome =
  | { kind: "ok"; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

// Shared private-first auth-remove mutation: valid private returns with zero
// SDK; validated terminal closes with zero SDK; otherwise exactly one
// same-identity SDK `client.auth.remove` fallback with no retry. `Auth.remove`
// is idempotent, so an ambiguous private outcome may safely repeat via the
// SDK fallback.
export async function removeAuthPrivateFirst(opts: {
  connection?: AuthRemovePrivateConnection | null
  client: SdkClient | null | undefined
  providerID: string
  directory?: string
  workspace?: string
}): Promise<AuthRemovePrivateFirstOutcome> {
  const dir = opts.directory
  if (dir) {
    const req = buildAuthRemoveReq(opts.providerID, dir, opts.workspace)
    const attempt = await attemptAuthRemovePrivate(opts.connection ?? null, req)
    if (attempt.kind === "ok") return { kind: "ok", via: "private" }
    if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  }
  const fn = opts.client?.auth?.remove
  if (typeof fn !== "function") return { kind: "unavailable" }
  try {
    await (fn as (p?: unknown, o?: unknown) => Promise<unknown>).call(opts.client?.auth, { providerID: opts.providerID }, { throwOnError: true })
    return { kind: "ok", via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
