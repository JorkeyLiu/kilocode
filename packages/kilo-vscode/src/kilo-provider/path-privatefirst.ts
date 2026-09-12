import * as crypto from "crypto"
import {
  canonicalPathOpId,
  isPathValidationError,
  validatePathResult,
  type PathContractRequest,
  type PathPayload,
} from "../services/cli-backend/serve-private-path-contract"

/**
 * Private-first `path/get` read. `model-state` needs only `Path.state`;
 * `home`/`config`/`worktree`/`directory` stay shape-only and never become a
 * new isolation or consistency contract. No global-field comparison, no
 * retry: at most one private attempt plus at most one SDK fallback.
 *
 * Valid private `succeeded`+`accepted` returns with zero SDK; validated
 * terminal `failed` (`retryable === false`) closes with zero SDK; only
 * retryable fence/unavailable/invalid/ambiguous/transport/closed/timeout
 * takes exactly one same-identity SDK `client.path.get` fallback.
 */
export interface PathPrivateConnection {
  isPrivateAvailable(): boolean
  privatePathOutcomeWithHandle(req: PathContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
  getPrivateEpoch?(): number | null
}

export function buildPathIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalPathOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildPathReq(dir: string): PathContractRequest {
  const ids = buildPathIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "path/get" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory: dir },
    payload: {},
  }
}

export type PathAttempt = { kind: "ok"; path: PathPayload } | { kind: "terminal"; code?: string } | { kind: "fallback"; reason: string }

export function parsePathResult(result: unknown, req: PathContractRequest): PathAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validatePathResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", path: out.data.path }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validatePathResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private path timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptPathPrivate(
  connection: PathPrivateConnection | null | undefined,
  req: PathContractRequest,
  ms = 3000,
): Promise<PathAttempt> {
  if (!connection) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!connection.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = connection.privatePathOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parsePathResult(outcome.result, req)
  } catch (e) {
    if (isPathValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private path timeout") && handle) {
      try {
        handle.cancel?.(`private path timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  path: {
    get: (params?: { directory?: string }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type PathPrivateFirstOutcome =
  | { kind: "ok"; path: PathPayload; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkPath(data: unknown): PathPayload | null {
  const rec = data as Record<string, unknown> | null
  if (!rec || typeof rec !== "object") return null
  const state = rec.state
  if (typeof state !== "string" || state.length === 0 || state.includes("\0")) return null
  return data as PathPayload
}

// Shared private-first path read: with a routing directory the private read
// runs first; without one no private request is sent and the SDK read uses
// no args (never `process.cwd()` or a session-dir substitute).
export async function fetchPathPrivateFirst(opts: {
  connection?: PathPrivateConnection | null
  client: SdkClient | null | undefined
  directory?: string
}): Promise<PathPrivateFirstOutcome> {
  const dir = opts.directory
  if (dir) {
    const req = buildPathReq(dir)
    const attempt = await attemptPathPrivate(opts.connection ?? null, req)
    if (attempt.kind === "ok") return { kind: "ok", path: attempt.path, via: "private" }
    if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
    const client = opts.client
    if (!client?.path?.get) return { kind: "unavailable" }
    try {
      const res = await client.path.get({ directory: dir })
      const coerced = coerceSdkPath(res.data)
      if (!coerced) return { kind: "unavailable", cause: res.error ?? null }
      return { kind: "ok", path: coerced, via: "sdk" }
    } catch (e) {
      return { kind: "unavailable", cause: e }
    }
  }
  const client = opts.client
  if (!client?.path?.get) return { kind: "unavailable" }
  try {
    const res = await client.path.get()
    const coerced = coerceSdkPath(res.data)
    if (!coerced) return { kind: "unavailable", cause: res.error ?? null }
    return { kind: "ok", path: coerced, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
