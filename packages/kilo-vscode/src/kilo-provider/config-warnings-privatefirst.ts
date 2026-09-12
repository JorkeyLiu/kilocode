import * as crypto from "crypto"
import {
  canonicalConfigWarningsOpId,
  isConfigWarningsValidationError,
  validateConfigWarningsResult,
  type ConfigWarning,
  type ConfigWarningsContractRequest,
} from "../services/cli-backend/serve-private-config-warnings-contract"

/**
 * Private-first `config/warnings` read for the `checkConfigWarnings`
 * production consumer.
 *
 * The private fd carrier reads the same `Config.Service.warnings()` source
 * as `GET /config/warnings` through the existing drain-control + `InstanceRef`
 * lane for the target directory. Success data is the locked safe projection
 * `{pathCategory,messageCategory}` only; raw paths, raw diagnostic text, and
 * `detail` never cross the private boundary. `directory`/`workspace` are
 * routing identity only; no new owner, no cache, no lifecycle change.
 *
 * Valid private `succeeded`+`accepted` returns the safe list with zero SDK;
 * validated terminal `failed` (`retryable === false` except `transport`,
 * such as `validation.failed`/`internal`) closes with zero SDK; retryable
 * fence plus unavailable/invalid/ambiguous/transport/closed/timeout takes
 * exactly one same-directory SDK `client.config.warnings` fallback with no
 * retry. SDK failure or malformed SDK data returns `unavailable` for the
 * caller to fail closed.
 *
 * `compareConfigWarningsParity` is intentionally not wired here: with
 * private-first there is at most one private result plus at most one SDK
 * result per read, so a comparator would need a third request to add
 * signal. It stays as pure diagnostic/test evidence only.
 */
export interface ConfigWarningsPrivateConnection {
  isPrivateAvailable(): boolean
  privateConfigWarningsOutcomeWithHandle(req: ConfigWarningsContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildConfigWarningsIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalConfigWarningsOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildConfigWarningsReq(dir: string, workspace?: string): ConfigWarningsContractRequest {
  const ids = buildConfigWarningsIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "config/warnings" as const,
    idempotencyKey: ids.idempotencyKey,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: {},
  }
}

export type ConfigWarningsAttempt =
  | { kind: "ok"; warnings: ConfigWarning[] }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseConfigWarningsResult(result: unknown, req: ConfigWarningsContractRequest): ConfigWarningsAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateConfigWarningsResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", warnings: out.data.warnings }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateConfigWarningsResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.code === "transport") return { kind: "fallback", reason: "transport" }
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
    timer = setTimeout(() => reject(new Error(`private config-warnings timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptConfigWarningsPrivate(
  connection: ConfigWarningsPrivateConnection | null | undefined,
  req: ConfigWarningsContractRequest,
  ms = 3000,
): Promise<ConfigWarningsAttempt> {
  if (!connection) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!connection.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = connection.privateConfigWarningsOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseConfigWarningsResult(outcome.result, req)
  } catch (e) {
    if (isConfigWarningsValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private config-warnings timeout") && handle) {
      try {
        handle.cancel?.(`private config-warnings timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

export interface ConfigWarningsSdkEntry {
  path: string
  message: string
  detail?: string
}

type SdkClient = {
  config: {
    warnings: (args: { directory: string; workspace?: string }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type ConfigWarningsPrivateFirstOutcome =
  | { kind: "ok"; via: "private"; warnings: ConfigWarning[] }
  | { kind: "ok"; via: "sdk"; warnings: ConfigWarningsSdkEntry[] }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.includes("\0")
}

function coerceSdkWarnings(data: unknown): ConfigWarningsSdkEntry[] | null {
  if (!Array.isArray(data)) return null
  const out: ConfigWarningsSdkEntry[] = []
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const rec = item as Record<string, unknown>
    if (!isNonEmpty(rec.path) || !isNonEmpty(rec.message)) return null
    if (rec.detail !== undefined && (typeof rec.detail !== "string" || (rec.detail as string).includes("\0")))
      return null
    const entry: ConfigWarningsSdkEntry =
      rec.detail === undefined
        ? { path: rec.path as string, message: rec.message as string }
        : { path: rec.path as string, message: rec.message as string, detail: rec.detail as string }
    out.push(entry)
  }
  return out
}

// Shared private-first warnings read: valid private returns the safe list
// with zero SDK; validated terminal closes with zero SDK; otherwise exactly
// one same-directory SDK fallback with no retry; SDK failure or malformed
// SDK data returns `unavailable` for the caller to fail closed.
export async function fetchConfigWarningsPrivateFirst(opts: {
  connection?: ConfigWarningsPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
  workspace?: string
  timeoutMs?: number
}): Promise<ConfigWarningsPrivateFirstOutcome> {
  const req = buildConfigWarningsReq(opts.directory, opts.workspace)
  const attempt = await attemptConfigWarningsPrivate(opts.connection ?? null, req, opts.timeoutMs ?? 3000)
  if (attempt.kind === "ok") return { kind: "ok", via: "private", warnings: attempt.warnings }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.client
  if (!client?.config?.warnings) return { kind: "unavailable" }
  try {
    const res =
      opts.workspace === undefined
        ? await client.config.warnings({ directory: opts.directory })
        : await client.config.warnings({ directory: opts.directory, workspace: opts.workspace })
    const coerced = coerceSdkWarnings(res.data)
    if (!coerced) {
      if (res.error !== undefined && res.error !== null) return { kind: "unavailable", cause: res.error }
      return { kind: "unavailable" }
    }
    return { kind: "ok", via: "sdk", warnings: coerced }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
