import * as crypto from "crypto"
import {
  canonicalSkillListOpId,
  validateSkillListResult,
} from "../services/cli-backend/serve-private-skill-list-contract"
import type {
  SkillListContractRequest,
  SkillListEntry,
} from "../services/cli-backend/serve-private-skill-list-contract"
import { SKILL_LIST_TRANSPORT_FAILURE_MESSAGE } from "../services/cli-backend/serve-private-skill-list"

export function buildSkillListPrivateIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalSkillListOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildSkillListPrivateReq(dir: string): SkillListContractRequest {
  const ids = buildSkillListPrivateIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "skill/list" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory: dir },
    payload: {},
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private read timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export type SkillListPrivateAttempt = { kind: "ok"; skills: SkillListEntry[] } | { kind: "fallback"; reason: string }

export function parseSkillListPrivateResult(result: unknown, req: unknown): SkillListPrivateAttempt {
  const typed = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      const out = validateSkillListResult(result as never, req as never)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", skills: out.data.skills }
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
  }
  if (typed.status === "failed") {
    try {
      const out = validateSkillListResult(result as never, req as never)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      // Skill list has no domain terminal: every failed result is
      // fallback-eligible, including validation/scope/internal and the
      // transport-synthesized fixed redacted failure.
      if (out.failure.message === SKILL_LIST_TRANSPORT_FAILURE_MESSAGE) {
        return { kind: "fallback", reason: "transport" }
      }
      return { kind: "fallback", reason: String(typeof out.failure.code === "string" ? out.failure.code : "failed") }
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
  }
  return { kind: "fallback", reason: `private not succeeded: ${String(typed.status)}` }
}

type Conn = {
  isPrivateAvailable(): boolean
  privateSkillListOutcomeWithHandle(req: SkillListContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export async function attemptSkillListPrivate(
  connection: Conn | null | undefined,
  req: SkillListContractRequest,
  ms = 3000,
): Promise<SkillListPrivateAttempt> {
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = conn.privateSkillListOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseSkillListPrivateResult(outcome.result, req)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private read timeout") && handle) {
      try {
        handle.cancel?.(`private read timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}
