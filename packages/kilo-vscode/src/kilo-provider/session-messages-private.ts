import {
  assertFoundMessagePage,
  decodeMessageCursor,
  isStrictCursorTime,
  validateInfo,
  validatePart,
} from "@opencode-ai/core/session/message-read"
import type { ObservationMessagesResult } from "../private-worker/observation"
import { ErrorCode } from "../private-worker/json-rpc"
import type { PrivateSessionReader } from "./options"
import { SessionNotFoundError, SessionScopeMismatchError } from "./session-detail"

export type PrivateMessagesAttempt =
  | { kind: "skip" }
  | { kind: "found"; items: import("@opencode-ai/core/v1/session").SessionV1.WithParts[]; cursor?: string }
  | { kind: "terminal"; error: SessionNotFoundError | SessionScopeMismatchError }
  | { kind: "fallback" }

function isUsable(reader: PrivateSessionReader | null | undefined): reader is PrivateSessionReader & { messages: NonNullable<PrivateSessionReader["messages"]> } {
  return !!reader && typeof reader.messages === "function" && reader.isEnabled() && reader.isStarted()
}

/**
 * Non-owning single private paged-read attempt. Never init/reconnect/dispose.
 * skip: gate off/legacy (silent SDK fallback). found/terminal: authoritative
 * with no SDK. fallback: bounded warn once (no raw directory/session data),
 * caller does exactly one SDK read with the original signal.
 */
export async function tryPrivateMessagesPage(
  reader: PrivateSessionReader | null | undefined,
  input: { directory: string; sessionId: string; limit: number; cursor?: string },
): Promise<PrivateMessagesAttempt> {
  if (!isUsable(reader)) return { kind: "skip" }
  let raw: unknown
  try {
    raw = await reader.messages({ directory: input.directory, sessionId: input.sessionId, limit: input.limit, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) })
  } catch {
    console.warn("[Kilo Messages] private messages failed, falling back to SDK", { fallback: true })
    return { kind: "fallback" }
  }
  let validated: ObservationMessagesResult
  try {
    validated = validatePrivateMessagesResult(raw, input.limit, input.sessionId)
  } catch {
    console.warn("[Kilo Messages] private messages malformed, falling back to SDK", { fallback: true })
    return { kind: "fallback" }
  }
  if (validated.status === "found") return { kind: "found", items: validated.messages, cursor: validated.nextCursor }
  if (validated.status === "not_found") return { kind: "terminal", error: new SessionNotFoundError() }
  return { kind: "terminal", error: new SessionScopeMismatchError() }
}

function internal(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InternalError
  return err
}

/**
 * Defensive revalidation of the private observation/messages result at the
 * provider boundary. Mirrors the controller wire invariants without
 * duplicating storage logic. Throws an InternalError-coded error on any
 * malformed shape so callers fall back to exactly one SDK read.
 */
// eslint-disable-next-line complexity
export function validatePrivateMessagesResult(raw: unknown, limit: number, sessionId: string): ObservationMessagesResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw internal("messages returned invalid shape")
  const r = raw as Record<string, unknown>
  if (r.v !== "1.0") throw internal("messages returned invalid version")
  if (typeof r.status !== "string" || !["found", "not_found", "scope_mismatch"].includes(r.status as string))
    throw internal("messages returned invalid status")
  const status = r.status as string
  if (status === "not_found" || status === "scope_mismatch") {
    const allowed = new Set(["v", "status"])
    for (const k of Object.keys(r)) if (!allowed.has(k)) throw internal("messages returned invalid shape")
    if ("messages" in r || "nextCursor" in r) throw internal("messages returned invalid shape")
    return r as ObservationMessagesResult
  }
  const allowedFound = new Set(["v", "status", "messages", "nextCursor"])
  for (const k of Object.keys(r)) if (!allowedFound.has(k)) throw internal("messages returned invalid shape")
  if (!Array.isArray(r.messages)) throw internal("messages returned invalid messages")
  const messages = r.messages as unknown[]
  try {
    for (const m of messages) {
      if (m === null || typeof m !== "object" || Array.isArray(m)) throw new Error("messages returned invalid message shape")
      const rec = m as Record<string, unknown>
      const keys = Object.keys(rec)
      if (keys.length !== 2 || !keys.includes("info") || !keys.includes("parts"))
        throw new Error("messages returned invalid message shape")
      const info = validateInfo(rec.info)
      if (!Array.isArray(rec.parts)) throw new Error("messages returned invalid message shape")
      const sid = (info as unknown as { sessionID?: unknown }).sessionID
      if (sid !== sessionId) throw new Error("messages returned session mismatch")
      const mid = (info as unknown as { id?: unknown }).id
      for (const p of rec.parts as unknown[]) {
        const part = validatePart(p)
        const psid = (part as unknown as { sessionID?: unknown }).sessionID
        if (psid !== sessionId) throw new Error("messages returned part session mismatch")
        const pmid = (part as unknown as { messageID?: unknown }).messageID
        if (pmid !== mid) throw new Error("messages returned part message mismatch")
      }
    }
    const rawCursor = "nextCursor" in r ? r.nextCursor : undefined
    if (rawCursor !== undefined && typeof rawCursor !== "string") throw new Error("messages returned invalid nextCursor")
    if (rawCursor !== undefined) {
      const decoded = decodeMessageCursor(rawCursor)
      if (!isStrictCursorTime(decoded.time)) throw new Error("non-integer cursor time")
    }
    assertFoundMessagePage(
      messages as Array<{ info: import("@opencode-ai/core/v1/session").SessionV1.Info; parts: import("@opencode-ai/core/v1/session").SessionV1.Part[] }>,
      limit,
      rawCursor as string | undefined,
    )
  } catch (e) {
    if (e instanceof Error && (e as { code?: number }).code !== undefined) throw e
    throw internal(e instanceof Error ? e.message : String(e))
  }
  return r as ObservationMessagesResult
}
