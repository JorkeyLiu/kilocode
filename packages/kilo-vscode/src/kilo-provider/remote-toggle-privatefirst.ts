import * as crypto from "crypto"
import {
  canonicalRemoteDisableOpId,
  canonicalRemoteEnableOpId,
  validateRemoteToggleResult,
} from "../services/cli-backend/serve-private-remote-toggle-contract"
import { isPrivateRemoteToggleValidationError } from "../services/cli-backend/serve-private-remote-toggle"
import type { ServePrivateRemoteToggleRequest } from "../services/cli-backend/serve-private-remote-toggle"

/**
 * Private-first `remote/enable` + `remote/disable` mutations (process-global
 * `{enabled, connected}` over the same `KiloSessions` owner as
 * `POST /remote/enable|disable`; `directory`/`workspace` are routing identity
 * only, never state isolation).
 *
 * One private attempt plus at most one same-action SDK fallback per user
 * action, never retried. Valid private `succeeded`+`accepted` returns with
 * zero SDK; validated terminal `failed` (`retryable === false`) closes with
 * zero SDK; unavailable/retryable/invalid/ambiguous/transport/closed/timeout
 * takes exactly one same-action SDK `client.remote.enable|disable` fallback.
 * The owner is idempotent, so an ambiguous private outcome may safely repeat
 * via the SDK fallback.
 *
 * Write results use the distinct `remote/enable` + `remote/disable` envelope
 * (`remote-enable:<token>` / `remote-disable:<token>`); they are never mixed
 * with the `remote/status` read type.
 */
export interface RemoteTogglePrivateConnection {
  isPrivateAvailable(): boolean
  privateRemoteToggleOutcomeWithHandle(req: ServePrivateRemoteToggleRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export type RemoteToggleAction = "enable" | "disable"
export type RemoteState = { enabled: boolean; connected: boolean }

export function buildRemoteToggleIdentity(action: RemoteToggleAction): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = action === "enable" ? canonicalRemoteEnableOpId(token) : canonicalRemoteDisableOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildRemoteToggleReq(
  action: RemoteToggleAction,
  dir: string,
  workspace?: string,
): ServePrivateRemoteToggleRequest {
  const ids = buildRemoteToggleIdentity(action)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: (action === "enable" ? "remote/enable" : "remote/disable") as "remote/enable" | "remote/disable",
    idempotencyKey: ids.idempotencyKey,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: {},
  }
}

export type RemoteToggleAttempt =
  | { kind: "ok"; state: RemoteState }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseRemoteToggleResult(
  result: unknown,
  req: ServePrivateRemoteToggleRequest,
): RemoteToggleAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateRemoteToggleResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      const payload = out.data.status as unknown as Record<string, unknown>
      if (typeof payload.enabled !== "boolean" || typeof payload.connected !== "boolean")
        return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", state: { enabled: payload.enabled, connected: payload.connected } }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateRemoteToggleResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private remote-toggle timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptRemoteTogglePrivate(
  connection: RemoteTogglePrivateConnection | null | undefined,
  req: ServePrivateRemoteToggleRequest,
  ms = 3000,
): Promise<RemoteToggleAttempt> {
  const conn = connection
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = conn.privateRemoteToggleOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseRemoteToggleResult(outcome.result, req)
  } catch (e) {
    if (isPrivateRemoteToggleValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private remote-toggle timeout") && handle) {
      try {
        handle.cancel?.(`private remote-toggle timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  remote: {
    enable: (params?: unknown, opts?: unknown) => Promise<{ data?: unknown; error?: unknown }>
    disable: (params?: unknown, opts?: unknown) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type RemoteTogglePrivateFirstOutcome =
  | { kind: "ok"; state: RemoteState; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkState(data: unknown): RemoteState | null {
  const rec = data as Record<string, unknown> | null
  if (!rec || typeof rec !== "object") return null
  if (typeof rec.enabled !== "boolean" || typeof rec.connected !== "boolean") return null
  return { enabled: rec.enabled, connected: rec.connected }
}

// Shared private-first remote enable/disable mutation: valid private returns
// with zero SDK; validated terminal closes with zero SDK; otherwise exactly
// one same-action SDK fallback with no retry. The owner is idempotent, so an
// ambiguous private outcome may safely repeat via the SDK fallback.
export async function fetchRemoteTogglePrivateFirst(opts: {
  connection?: RemoteTogglePrivateConnection | null
  client: SdkClient | null | undefined
  directory?: string
  workspace?: string
  action: RemoteToggleAction
}): Promise<RemoteTogglePrivateFirstOutcome> {
  const dir = opts.directory
  if (dir) {
    const req = buildRemoteToggleReq(opts.action, dir, opts.workspace)
    const attempt = await attemptRemoteTogglePrivate(opts.connection ?? null, req)
    if (attempt.kind === "ok") return { kind: "ok", state: attempt.state, via: "private" }
    if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  }
  const client = opts.client
  const fn = opts.action === "enable" ? client?.remote?.enable : client?.remote?.disable
  if (typeof fn !== "function") return { kind: "unavailable" }
  try {
    const params =
      dir === undefined
        ? undefined
        : opts.workspace === undefined
          ? { directory: dir }
          : { directory: dir, workspace: opts.workspace }
    const res = await (fn as (p?: unknown) => Promise<{ data?: unknown; error?: unknown }>).call(
      client?.remote,
      params,
    )
    const coerced = coerceSdkState(res.data)
    if (!coerced) {
      if (res.error !== undefined && res.error !== null) return { kind: "unavailable", cause: res.error }
      return { kind: "unavailable" }
    }
    return { kind: "ok", state: coerced, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
