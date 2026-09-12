import * as crypto from "crypto"
import {
  canonicalRemoteStatusOpId,
  isPrivateRemoteStatusValidationError,
  validateRemoteStatusResult,
} from "../services/cli-backend/serve-private-remote-status"
import type { ServePrivateRemoteStatusRequest } from "../services/cli-backend/serve-private-remote-status"

/**
 * Private-first `remote/status` read (process-global `{enabled, connected}`).
 *
 * The private fd carrier reads the same `KiloSessions.remoteStatus()`
 * authority as `GET /remote/status`; `directory`/`workspace` are routing
 * identity only, never state isolation. Status is a read: never retried.
 * Valid private `succeeded`+`accepted` returns with zero SDK; validated
 * terminal `failed` (`retryable === false`) closes with zero SDK;
 * unavailable/retryable/invalid/ambiguous/transport/closed/timeout takes
 * exactly one same-identity SDK `client.remote.status` fallback.
 *
 * `compareRemoteStatusParity` is intentionally not wired here: with
 * private-first there is at most one private result plus at most one SDK
 * result per read, so a comparator would need a third request to add
 * signal. It stays as pure diagnostic/test evidence only.
 */
export interface RemoteStatusPrivateConnection {
  isPrivateAvailable(): boolean
  privateRemoteStatusOutcomeWithHandle(req: ServePrivateRemoteStatusRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export type RemoteState = { enabled: boolean; connected: boolean }

export function buildRemoteStatusIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalRemoteStatusOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildRemoteStatusReq(dir: string, workspace?: string): ServePrivateRemoteStatusRequest {
  const ids = buildRemoteStatusIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "remote/status" as const,
    idempotencyKey: ids.idempotencyKey,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: {},
  }
}

export type RemoteStatusAttempt =
  | { kind: "ok"; state: RemoteState }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseRemoteStatusResult(result: unknown, req: ServePrivateRemoteStatusRequest): RemoteStatusAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateRemoteStatusResult(result, req)
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
      const out = validateRemoteStatusResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private remote-status timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptRemoteStatusPrivate(
  connection: RemoteStatusPrivateConnection | null | undefined,
  req: ServePrivateRemoteStatusRequest,
  ms = 3000,
): Promise<RemoteStatusAttempt> {
  const conn = connection
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = conn.privateRemoteStatusOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseRemoteStatusResult(outcome.result, req)
  } catch (e) {
    if (isPrivateRemoteStatusValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private remote-status timeout") && handle) {
      try {
        handle.cancel?.(`private remote-status timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  remote: {
    status: (
      params?: { directory?: string; workspace?: string },
      opts?: unknown,
    ) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type RemoteStatusPrivateFirstOutcome =
  | { kind: "ok"; state: RemoteState; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkState(data: unknown): RemoteState | null {
  const rec = data as Record<string, unknown> | null
  if (!rec || typeof rec !== "object") return null
  if (typeof rec.enabled !== "boolean" || typeof rec.connected !== "boolean") return null
  return { enabled: rec.enabled, connected: rec.connected }
}

// Shared private-first remote/status read: valid private returns with zero
// SDK; validated terminal closes with zero SDK; otherwise exactly one
// same-identity SDK fallback with no retry.
export async function fetchRemoteStatusPrivateFirst(opts: {
  connection?: RemoteStatusPrivateConnection | null
  client: SdkClient | null | undefined
  directory?: string
  workspace?: string
}): Promise<RemoteStatusPrivateFirstOutcome> {
  const dir = opts.directory
  if (dir) {
    const req = buildRemoteStatusReq(dir, opts.workspace)
    const attempt = await attemptRemoteStatusPrivate(opts.connection ?? null, req)
    if (attempt.kind === "ok") return { kind: "ok", state: attempt.state, via: "private" }
    if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  }
  const client = opts.client
  if (!client?.remote?.status) return { kind: "unavailable" }
  try {
    const params =
      dir === undefined
        ? undefined
        : opts.workspace === undefined
          ? { directory: dir }
          : { directory: dir, workspace: opts.workspace }
    const res = await client.remote.status(params)
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
