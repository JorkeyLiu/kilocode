import * as crypto from "crypto"
import {
  canonicalOrganizationSetOpId,
  validateOrganizationSetResult,
} from "../services/cli-backend/serve-private-organization-set-contract"
import { isPrivateOrganizationSetValidationError } from "../services/cli-backend/serve-private-organization-set"
import type { ServePrivateOrganizationSetRequest } from "../services/cli-backend/serve-private-organization-set"

/**
 * Private-first `kilo/organization/set` mutation (the same global cold
 * organization switch as `client.kilo.organization.set`;
 * `directory`/`workspace` are routing identity only, never an auth scope).
 *
 * One private attempt plus at most one same-identity SDK fallback per switch,
 * never retried. Valid private `succeeded`+`accepted` returns with zero SDK;
 * validated terminal `failed` (`retryable === false`, including
 * `unauthorized` for the backend's real auth-not-found semantics) closes
 * with zero SDK; unavailable/retryable/invalid/ambiguous/transport/closed/
 * timeout takes exactly one same-identity SDK
 * `client.kilo.organization.set` fallback with the same `organizationId`
 * (`null` is the personal account). Repeating the same `organizationId` is
 * a safe overwrite, so an ambiguous private outcome may safely repeat via
 * the SDK fallback.
 */
export interface OrganizationSetPrivateConnection {
  isPrivateAvailable(): boolean
  privateOrganizationSetOutcomeWithHandle(req: ServePrivateOrganizationSetRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildOrganizationSetIdentity(): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalOrganizationSetOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildOrganizationSetReq(
  organizationId: string | null,
  dir: string,
  workspace?: string,
): ServePrivateOrganizationSetRequest {
  const ids = buildOrganizationSetIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "kilo/organization/set" as const,
    idempotencyKey: ids.idempotencyKey,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: { organizationId },
  }
}

export type OrganizationSetAttempt = { kind: "ok" } | { kind: "terminal"; code?: string } | { kind: "fallback"; reason: string }

export function parseOrganizationSetResult(result: unknown, req: ServePrivateOrganizationSetRequest): OrganizationSetAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateOrganizationSetResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateOrganizationSetResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private organization-set timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptOrganizationSetPrivate(
  connection: OrganizationSetPrivateConnection | null | undefined,
  req: ServePrivateOrganizationSetRequest,
  ms = 3000,
): Promise<OrganizationSetAttempt> {
  const conn = connection
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = conn.privateOrganizationSetOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseOrganizationSetResult(outcome.result, req)
  } catch (e) {
    if (isPrivateOrganizationSetValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private organization-set timeout") && handle) {
      try {
        handle.cancel?.(`private organization-set timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  kilo: {
    organization: {
      set: (params?: unknown, opts?: unknown) => Promise<{ data?: unknown; error?: unknown }>
    }
  }
}

export type OrganizationSetPrivateFirstOutcome =
  | { kind: "ok"; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable"; cause?: unknown }

// Shared private-first organization switch: valid private returns with zero
// SDK; validated terminal closes with zero SDK; otherwise exactly one
// same-identity SDK `client.kilo.organization.set` fallback with the same
// `organizationId` and no retry. Repeating the same `organizationId` is a
// safe overwrite, so an ambiguous private outcome may safely repeat via the
// SDK fallback.
export async function setOrganizationPrivateFirst(opts: {
  connection?: OrganizationSetPrivateConnection | null
  client: SdkClient | null | undefined
  organizationId: string | null
  directory?: string
  workspace?: string
}): Promise<OrganizationSetPrivateFirstOutcome> {
  const dir = opts.directory
  if (dir) {
    const req = buildOrganizationSetReq(opts.organizationId, dir, opts.workspace)
    const attempt = await attemptOrganizationSetPrivate(opts.connection ?? null, req)
    if (attempt.kind === "ok") return { kind: "ok", via: "private" }
    if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  }
  const fn = opts.client?.kilo?.organization?.set
  if (typeof fn !== "function") return { kind: "unavailable" }
  try {
    await (fn as (p?: unknown, o?: unknown) => Promise<unknown>).call(
      opts.client?.kilo?.organization,
      { organizationId: opts.organizationId },
      { throwOnError: true },
    )
    return { kind: "ok", via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
