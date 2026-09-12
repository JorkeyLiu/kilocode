import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import {
  canonicalSkillRemoveOpId,
  validateSkillRemoveContractRequest,
} from "../services/cli-backend/serve-private-skill-remove-contract"
import type { SkillRemoveContractRequest } from "../services/cli-backend/serve-private-skill-remove-contract"
import { skillRemoveOutcomeHandle } from "../services/cli-backend/serve-private-skill-remove-connection"

export function buildSkillRemoveReq(directory: string, location: string): SkillRemoveContractRequest {
  const token = crypto.randomUUID()
  const opId = canonicalSkillRemoveOpId(token)
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId,
    op: "skill/remove" as const,
    idempotencyKey: opId,
    context: { directory },
    payload: { location },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export type SkillRemoveAttempt =
  | { kind: "ok" }
  | { kind: "failed"; code: string }
  | { kind: "closed"; reason: string }

const ACTIONABLE_SKILL_REMOVE_FAILURE: Record<string, string> = {
  "skill.builtin": "cannot remove built-in skill",
  "skill.url": "remove URL-backed skills from configuration",
  "skill.not_found": "skill not found in registry",
}

export function skillRemoveFailureMessage(code: string): string {
  return ACTIONABLE_SKILL_REMOVE_FAILURE[code] ?? code
}

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateSkillRemoveOutcomeWithHandle?: (r: SkillRemoveContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel: (msg?: string) => boolean
  }
}

function parseAttempt(result: unknown): SkillRemoveAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; failure?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "closed", reason: "invalid" }
  if (rec.status === "succeeded" && rec.accepted === true) return { kind: "ok" }
  if (rec.status === "failed" && rec.accepted === false) {
    const failure = rec.failure as { code?: unknown; retryable?: unknown } | undefined
    const code = typeof failure?.code === "string" ? failure.code : "internal"
    if (failure?.retryable === true) return { kind: "closed", reason: code }
    return { kind: "failed", code }
  }
  return { kind: "closed", reason: "ambiguous" }
}

export async function attemptSkillRemovePrivate(
  connection: KiloConnectionService | Conn | null | undefined,
  req: SkillRemoveContractRequest,
  ms = 3000,
): Promise<SkillRemoveAttempt> {
  try {
    validateSkillRemoveContractRequest(req)
  } catch {
    return { kind: "closed", reason: "invalid" }
  }
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "closed", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "closed", reason: "unavailable" }
  } catch {
    return { kind: "closed", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
  try {
    if (conn.privateSkillRemoveOutcomeWithHandle) {
      handle = conn.privateSkillRemoveOutcomeWithHandle(req)
    } else {
      const peer = conn.getPrivatePeer()
      handle = skillRemoveOutcomeHandle(
        {
          peer,
          live: true,
          epoch: conn.getPrivateEpoch(),
          invalidate: (r) => conn.invalidatePrivatePeerOnObserverTimeout?.(r),
        },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "closed", reason: "invalid" }
    return parseAttempt(outcome.result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private parity timeout") && handle) {
      try {
        handle.cancel?.(`private parity timeout opId=${req.opId}`)
      } catch {}
      return { kind: "closed", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "closed", reason: "transport" }
    return { kind: "closed", reason: msg.slice(0, 120) }
  }
}
