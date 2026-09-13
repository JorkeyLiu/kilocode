import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { configUiDefaultsHandle } from "../services/cli-backend/serve-private-config-ui-defaults-connection"
import {
  isConfigUiDefaultsValidationError,
  validateConfigUiDefaultsResult,
  validateUiDefaultsData,
} from "../services/cli-backend/serve-private-config-ui-defaults-contract"
import type {
  ConfigUiDefaultsContractRequest,
  UiDefaultsData,
} from "../services/cli-backend/serve-private-config-ui-defaults-contract"
import type { WorkStyleConfig } from "./work-style-presets"

export type { UiDefaultsData }

/**
 * Private-first `config/ui-defaults` read-only observation (the same
 * effective `Config.Service.get()` source as `client.config.get`, projected
 * to the closed minimal shape the work-style and sandbox readers need).
 *
 * Lives in `shared/` so both `kilo-provider/work-style-apply-handler.ts` and
 * `shared/sandbox-session.ts` converge on it without a cross-layer import.
 *
 * One private attempt plus at most one same-directory SDK fallback per read,
 * never retried inside the helper. Valid private `succeeded`+`accepted`
 * returns the closed projection with zero SDK; validated terminal `failed`
 * (`retryable === false`, including `validation.failed`/`scope_mismatch`/
 * `internal`) closes with zero SDK; unavailable/retryable fence/invalid/
 * ambiguous/transport/closed/timeout takes exactly one same-directory SDK
 * `client.config.get` fallback projected locally to the same closed shape
 * (old-CLI compatible). Read-only and safely repeatable: no durable op, no
 * journal, no reconcile, no `opId`/`idempotencyKey` (observation identity is
 * `requestId` only). No `postMessage`, no retry, no cache, no journal — both
 * callers keep their throw-on-failure error propagation.
 *
 * Timeout (default 3000 ms) exact-cancels the pending by `id` via the owned
 * transport handle; epoch coherence stays inside the transport (settled
 * success/terminal across post-response drift is preserved, unresolved drift
 * maps to ambiguous).
 */
export interface ConfigUiDefaultsPrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateConfigUiDefaultsOutcomeWithHandle?: (req: ConfigUiDefaultsContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildConfigUiDefaultsReq(directory: string, workspace?: string): ConfigUiDefaultsContractRequest {
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    op: "config/ui-defaults" as const,
    context: workspace === undefined ? { directory } : { directory, workspace },
    payload: {},
  }
}

export type ConfigUiDefaultsAttempt =
  | { kind: "ok"; data: UiDefaultsData }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseConfigUiDefaultsResult(
  result: unknown,
  req: ConfigUiDefaultsContractRequest,
): ConfigUiDefaultsAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateConfigUiDefaultsResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", data: out.data }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateConfigUiDefaultsResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private config-ui-defaults timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: ConfigUiDefaultsPrivateConnection): {
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

export async function attemptConfigUiDefaultsPrivate(
  connection: KiloConnectionService | ConfigUiDefaultsPrivateConnection | null | undefined,
  req: ConfigUiDefaultsContractRequest,
  ms = 3000,
): Promise<ConfigUiDefaultsAttempt> {
  const conn = connection as ConfigUiDefaultsPrivateConnection | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateConfigUiDefaultsOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = configUiDefaultsHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseConfigUiDefaultsResult(outcome.result, req)
  } catch (e) {
    if (isConfigUiDefaultsValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private config-ui-defaults timeout") && handle) {
      try {
        handle.cancel?.(`private config-ui-defaults timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

// Local whitelist projection of a `client.config.get` payload onto the same
// closed shape the private op returns. Only the three work-style signals and
// `sandbox.enabled` survive; permission rule content and every other field
// (providers, MCP, secrets) are dropped here and never cross. Returns `null`
// when the whitelisted fields themselves are malformed.
export function projectUiDefaultsFromSdk(data: unknown): UiDefaultsData | null {
  if (!record(data)) return null
  const style: UiDefaultsData["workStyle"] = { hasPermission: data.permission !== undefined }
  if (data.terminal_command_display !== undefined) {
    if (data.terminal_command_display !== "expanded" && data.terminal_command_display !== "collapsed") return null
    style.terminalCommandDisplay = data.terminal_command_display
  }
  if (data.auto_collapse_reasoning !== undefined) {
    if (typeof data.auto_collapse_reasoning !== "boolean") return null
    style.autoCollapseReasoning = data.auto_collapse_reasoning
  }
  const box = data.sandbox
  if (box !== undefined && !record(box)) return null
  const out: UiDefaultsData = {
    workStyle: style,
    sandbox: { enabled: (record(box) ? box.enabled : undefined) === true },
  }
  try {
    return validateUiDefaultsData(out)
  } catch {
    return null
  }
}

type SdkClient = {
  config: {
    get: (args: { directory: string }, opts: { throwOnError: boolean }) => Promise<{ data?: unknown }>
  }
}

export type ConfigUiDefaultsPrivateFirstOutcome =
  | { kind: "ok"; data: UiDefaultsData; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

// Shared private-first config-ui-defaults read: valid private returns the
// closed projection with zero SDK; validated terminal closes with zero SDK;
// otherwise exactly one same-directory SDK `client.config.get` fallback
// projected locally with no retry and no timeout wrapper; missing SDK method
// or SDK failure/malformed returns `unavailable`. Callers throw on
// terminal/unavailable to preserve the legacy `config.get` throw propagation.
export async function fetchConfigUiDefaultsPrivateFirst(opts: {
  connection?: KiloConnectionService | ConfigUiDefaultsPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
}): Promise<ConfigUiDefaultsPrivateFirstOutcome> {
  const req = buildConfigUiDefaultsReq(opts.directory)
  const attempt = await attemptConfigUiDefaultsPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", data: attempt.data, via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.client
  if (typeof client?.config?.get !== "function") return { kind: "unavailable" }
  try {
    const res = await client.config.get({ directory: opts.directory }, { throwOnError: true })
    const projected = projectUiDefaultsFromSdk((res as { data?: unknown }).data)
    if (!projected) return { kind: "unavailable" }
    return { kind: "ok", data: projected, via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}

// Throw-preserving unwrap for the two production readers: `ok` returns the
// closed projection, `terminal`/`unavailable` throw like the legacy
// `client.config.get` failure did so no caller silently degrades.
export function requireUiDefaults(out: ConfigUiDefaultsPrivateFirstOutcome, what: string): UiDefaultsData {
  if (out.kind === "ok") return out.data
  if (out.kind === "terminal") throw new Error(`${what} unavailable: ${out.code ?? "terminal"}`)
  if (out.cause instanceof Error) throw out.cause
  throw new Error(`${what} unavailable`)
}

// Maps the closed projection onto the `WorkStyleConfig` the untouched
// `buildWorkStyleApplyPlan` consumes. Only presence/values flow: a present
// `permission` becomes a non-empty presence marker (never rule content — the
// plan only asks `hasPermissionConfig`, and the marker is never written
// because a present permission skips the preset write), absent fields stay
// `undefined` so preset defaults still apply.
export function toWorkStyleConfig(data: UiDefaultsData): WorkStyleConfig {
  return {
    ...(data.workStyle.hasPermission ? { permission: { "*": "ask" } as WorkStyleConfig["permission"] } : {}),
    ...(data.workStyle.terminalCommandDisplay !== undefined
      ? { terminal_command_display: data.workStyle.terminalCommandDisplay }
      : {}),
    ...(data.workStyle.autoCollapseReasoning !== undefined
      ? { auto_collapse_reasoning: data.workStyle.autoCollapseReasoning }
      : {}),
  }
}
