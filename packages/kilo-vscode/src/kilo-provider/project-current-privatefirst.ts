import * as crypto from "crypto"
import {
  canonicalProjectCurrentOpId,
  isProjectCurrentValidationError,
  projectCurrentHasGit,
  validateProjectCurrentResult,
  type ProjectCurrentContractRequest,
} from "../services/cli-backend/serve-private-project-current-contract"

/**
 * Private-first `project/current` narrow projection for the `hasGit`
 * production boolean consumer only (`vcs === "git"`).
 *
 * Full `Project.Info` is not a private contract: only `{vcs?: "git"}`
 * crosses the private wire, and only the derived boolean is consumed.
 * `directory` is workspace routing identity only; no new owner, no cache,
 * no lifecycle change.
 *
 * Valid private `succeeded`+`accepted` returns the boolean with zero SDK;
 * validated terminal `failed` (`retryable === false`, except `transport`)
 * closes fail-closed `false` with zero SDK; retryable fence plus
 * unavailable/invalid/ambiguous/transport/closed/timeout takes exactly one
 * same-directory SDK `client.project.current` fallback with no retry.
 * SDK failure or malformed SDK data returns `false`.
 *
 * `compareProjectCurrentParity` is intentionally not wired here: with
 * private-first there is at most one private result plus at most one SDK
 * result per read, so a comparator would need a third request to add
 * signal. It stays as pure diagnostic/test evidence only.
 */
export interface ProjectCurrentPrivateConnection {
  isPrivateAvailable(): boolean
  privateProjectCurrentOutcomeWithHandle(req: ProjectCurrentContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildProjectCurrentIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalProjectCurrentOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildProjectCurrentReq(dir: string): ProjectCurrentContractRequest {
  const ids = buildProjectCurrentIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "project/current" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory: dir },
    payload: {},
  }
}

export type ProjectCurrentAttempt =
  | { kind: "ok"; hasGit: boolean }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseProjectCurrentResult(result: unknown, req: ProjectCurrentContractRequest): ProjectCurrentAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateProjectCurrentResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", hasGit: projectCurrentHasGit(out.data) }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateProjectCurrentResult(result, req)
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
    timer = setTimeout(() => reject(new Error(`private project-current timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptProjectCurrentPrivate(
  connection: ProjectCurrentPrivateConnection | null | undefined,
  req: ProjectCurrentContractRequest,
  ms = 3000,
): Promise<ProjectCurrentAttempt> {
  if (!connection) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!connection.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = connection.privateProjectCurrentOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseProjectCurrentResult(outcome.result, req)
  } catch (e) {
    if (isProjectCurrentValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private project-current timeout") && handle) {
      try {
        handle.cancel?.(`private project-current timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  project: {
    current: (args: { directory: string }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

function coerceSdkHasGit(data: unknown): boolean | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const vcs = (data as Record<string, unknown>).vcs
  if (vcs === undefined) return false
  if (vcs === "git") return true
  return null
}

// Shared private-first `hasGit` read: valid private returns the boolean with
// zero SDK; validated terminal closes fail-closed `false` with zero SDK;
// otherwise exactly one same-directory SDK fallback with no retry; SDK
// failure or malformed SDK data returns `false`.
export async function fetchHasGitPrivateFirst(opts: {
  connection?: ProjectCurrentPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
}): Promise<boolean> {
  const req = buildProjectCurrentReq(opts.directory)
  const attempt = await attemptProjectCurrentPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return attempt.hasGit
  if (attempt.kind === "terminal") return false
  const client = opts.client
  if (!client?.project?.current) return false
  try {
    const res = await client.project.current({ directory: opts.directory })
    const coerced = coerceSdkHasGit(res.data)
    if (coerced === null) return false
    return coerced
  } catch {
    return false
  }
}
