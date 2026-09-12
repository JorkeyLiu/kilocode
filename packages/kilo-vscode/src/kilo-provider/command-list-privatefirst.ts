import * as crypto from "crypto"
import {
  canonicalCommandListOpId,
  validateCommandListResult,
} from "../services/cli-backend/serve-private-command-list-contract"
import type {
  CommandListContractRequest,
  CommandListEntry,
} from "../services/cli-backend/serve-private-command-list-contract"
import { COMMAND_LIST_TRANSPORT_FAILURE_MESSAGE } from "../services/cli-backend/serve-private-command-list"

export function buildCommandListPrivateIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalCommandListOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildCommandListPrivateReq(dir: string): CommandListContractRequest {
  const ids = buildCommandListPrivateIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "command/list" as const,
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

export type CommandListPrivateAttempt =
  | { kind: "ok"; commands: CommandListEntry[] }
  | { kind: "terminal"; code: string; message: string }
  | { kind: "fallback"; reason: string }

export function parseCommandListPrivateResult(result: unknown, req: unknown): CommandListPrivateAttempt {
  const typed = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      const out = validateCommandListResult(result as never, req as never)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", commands: out.data.commands }
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
  }
  if (typed.status === "failed") {
    try {
      const out = validateCommandListResult(result as never, req as never)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      // Transport-layer failures are synthesized as failed with a fixed
      // redacted message; they are fallback-eligible, never terminal.
      if (out.failure.message === COMMAND_LIST_TRANSPORT_FAILURE_MESSAGE) {
        return { kind: "fallback", reason: "transport" }
      }
      if (out.failure.retryable === true) {
        return { kind: "fallback", reason: String(typeof out.failure.code === "string" ? out.failure.code : "retryable") }
      }
      if (out.failure.retryable === false) {
        return { kind: "terminal", code: out.failure.code, message: out.failure.message }
      }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch (e) {
      return { kind: "fallback", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
  }
  return { kind: "fallback", reason: `private not succeeded: ${String(typed.status)}` }
}

type Conn = {
  isPrivateAvailable(): boolean
  privateCommandListOutcomeWithHandle(req: CommandListContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export async function attemptCommandListPrivate(
  connection: Conn | null | undefined,
  req: CommandListContractRequest,
  ms = 3000,
): Promise<CommandListPrivateAttempt> {
  const conn = connection as Conn | null | undefined
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = conn.privateCommandListOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseCommandListPrivateResult(outcome.result, req)
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
