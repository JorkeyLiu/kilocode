import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { providerModelsDiscoverHandle } from "../services/cli-backend/serve-private-provider-models-discover-connection"
import {
  isProviderModelsDiscoverValidationError,
  validateProviderModelsDiscoverData,
  validateProviderModelsDiscoverResult,
} from "../services/cli-backend/serve-private-provider-models-discover-contract"
import type {
  ProviderModelsDiscoverContractRequest,
  ProviderModelsDiscoverEntry,
} from "../services/cli-backend/serve-private-provider-models-discover-contract"

export type { ProviderModelsDiscoverEntry }

/**
 * Private-first `provider/models-discover` read-only observation (the same
 * stored-backend-credential `fetchProviderModelsDiscoverData` source as
 * `client.provider.models.discover`).
 *
 * One private attempt plus at most one same-directory SDK fallback per read,
 * never retried inside the helper. Valid private `succeeded`+`accepted`
 * returns the exact `{models:[{id,name}]}` wire with zero SDK; validated
 * terminal `failed` (`retryable === false`, including `validation.failed`/
 * `scope_mismatch`/`unauthorized`/`invalid_response`/`upstream_error`/
 * `internal`) closes with zero SDK; unavailable/retryable fence/invalid/
 * ambiguous/transport/closed/timeout takes exactly one same-directory SDK
 * `client.provider.models.discover` fallback. Read-only and safely
 * repeatable: no durable op, no journal, no reconcile, no `opId`/
 * `idempotencyKey` (observation identity is `requestId` only). No
 * `postMessage`, no retry, no cache, no journal — the caller keeps the
 * freshly-typed-key/custom-headers/missing-providerID extension-host paths
 * and the `customProviderModelsFetched` shape untouched.
 *
 * Timeout (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport (settled
 * success/terminal across post-response drift is preserved, unresolved drift
 * maps to ambiguous).
 */
export interface ProviderModelsDiscoverPrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateProviderModelsDiscoverOutcomeWithHandle?: (req: ProviderModelsDiscoverContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildProviderModelsDiscoverReq(
  directory: string,
  providerID: string,
  baseURL: string,
  workspace?: string,
): ProviderModelsDiscoverContractRequest {
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    op: "provider/models-discover" as const,
    context: workspace === undefined ? { directory } : { directory, workspace },
    payload: { providerID, baseURL },
  }
}

export type ProviderModelsDiscoverAttempt =
  | { kind: "ok"; models: ProviderModelsDiscoverEntry[] }
  | { kind: "terminal"; code: string; message: string }
  | { kind: "fallback"; reason: string }

export function parseProviderModelsDiscoverResult(
  result: unknown,
  req: ProviderModelsDiscoverContractRequest,
): ProviderModelsDiscoverAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateProviderModelsDiscoverResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", models: out.data.models }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateProviderModelsDiscoverResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false)
        return { kind: "terminal", code: out.failure.code, message: out.failure.message }
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
    timer = setTimeout(() => reject(new Error(`private provider-models-discover timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: ProviderModelsDiscoverPrivateConnection): {
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

export async function attemptProviderModelsDiscoverPrivate(
  connection: KiloConnectionService | ProviderModelsDiscoverPrivateConnection | null | undefined,
  req: ProviderModelsDiscoverContractRequest,
  ms = 3000,
): Promise<ProviderModelsDiscoverAttempt> {
  const conn = connection as ProviderModelsDiscoverPrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateProviderModelsDiscoverOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = providerModelsDiscoverHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseProviderModelsDiscoverResult(outcome.result, req)
  } catch (e) {
    if (isProviderModelsDiscoverValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private provider-models-discover timeout") && handle) {
      try {
        handle.cancel?.(`private provider-models-discover timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  provider: {
    models: {
      discover: (
        args: { providerID: string; baseURL: string; directory: string },
        opts: { throwOnError: boolean },
      ) => Promise<{ data?: unknown }>
    }
  }
}

export type ProviderModelsDiscoverPrivateFirstOutcome =
  | { kind: "ok"; models: ProviderModelsDiscoverEntry[]; via: "private" | "sdk" }
  | { kind: "terminal"; code: string; message: string; auth: boolean }
  | { kind: "unavailable"; cause?: unknown }

function coerceSdkModels(data: unknown): ProviderModelsDiscoverEntry[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const models = (data as { models?: unknown }).models
  if (!Array.isArray(models)) return null
  try {
    return validateProviderModelsDiscoverData({ models }).models
  } catch {
    return null
  }
}

// Shared private-first stored-credential model discovery: valid private
// returns the exact `{models:[{id,name}]}` wire with zero SDK; validated
// terminal closes with zero SDK (the caller posts the redacted message with
// the `unauthorized` auth UX); otherwise exactly one same-directory SDK
// fallback with no retry and no timeout wrapper; SDK failure/malformed
// returns `unavailable` for the caller to handle.
export async function discoverModelsPrivateFirst(opts: {
  connection?: KiloConnectionService | ProviderModelsDiscoverPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
  providerID: string
  baseURL: string
}): Promise<ProviderModelsDiscoverPrivateFirstOutcome> {
  const req = buildProviderModelsDiscoverReq(opts.directory, opts.providerID, opts.baseURL)
  const attempt = await attemptProviderModelsDiscoverPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", models: attempt.models, via: "private" }
  if (attempt.kind === "terminal")
    return { kind: "terminal", code: attempt.code, message: attempt.message, auth: attempt.code === "unauthorized" }
  const client = opts.client
  if (!client?.provider?.models?.discover) return { kind: "unavailable" }
  try {
    const res = await client.provider.models.discover(
      { providerID: opts.providerID, baseURL: opts.baseURL, directory: opts.directory },
      { throwOnError: true },
    )
    const models = coerceSdkModels((res as { data?: unknown }).data)
    if (!models) return { kind: "unavailable" }
    return { kind: "ok", models, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
