import type { SessionV1 } from "@opencode-ai/core/v1/session"

// vscode-local pure port of the storage-free message-read protocol leaf.
// Provenance: mirrors packages/core/src/session/message-read.ts cursor codec,
// strict-time predicate, info/part validation entry points, and
// found-page invariants without importing Effect schemas or storage-coupled
// SessionV1 runtime modules (which pull Database/global/migration.gen
// top-level await into the CJS extension bundle). Extension callsites
// (private-worker/observation, kilo-provider/session-messages-private) use
// this module; storage projection (session-messages-adapter) keeps the core
// implementation. Error strings match core verbatim for wire compatibility.

export const MESSAGE_CURSOR_MAX_LENGTH = 512

export interface MessageCursor {
  id: string
  time: number
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

function isValidMsgId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("msg") && !v.includes("\0")
}

function isValidPrtId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("prt") && !v.includes("\0")
}

function isValidSesId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("ses") && !v.includes("\0")
}

function isValidCursorTime(v: unknown): boolean {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= 0 &&
    v <= 8640000000000000 &&
    Math.abs(v) <= Number.MAX_SAFE_INTEGER
  )
}

export function isStrictCursorTime(v: unknown): boolean {
  return isValidCursorTime(v) && Number.isSafeInteger(v)
}

export function encodeMessageCursor(input: MessageCursor): string {
  return Buffer.from(JSON.stringify({ id: input.id, time: input.time }), "utf8").toString("base64url")
}

export function decodeMessageCursor(raw: unknown): MessageCursor {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MESSAGE_CURSOR_MAX_LENGTH)
    throw new Error("message cursor must be opaque base64url JSON")
  if (!BASE64URL.test(raw)) throw new Error("message cursor must be opaque base64url JSON")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    throw new Error("message cursor must be opaque base64url JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("message cursor must be opaque base64url JSON")
  const rec = parsed as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("time"))
    throw new Error("message cursor must be opaque base64url JSON")
  if (!isValidMsgId(rec.id)) throw new Error("message cursor must be opaque base64url JSON")
  if (!isValidCursorTime(rec.time)) throw new Error("message cursor must be opaque base64url JSON")
  return { id: rec.id as string, time: rec.time as number }
}

export const cursor = {
  encode(input: MessageCursor) {
    return encodeMessageCursor(input)
  },
  decode(input: string) {
    return decodeMessageCursor(input)
  },
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v)
}

function isNonNegativeFinite(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && (v as number) >= 0
}

function isValidCreated(v: unknown): boolean {
  return isNonNegativeFinite(v)
}

function checkModel(m: unknown): boolean {
  if (!isRecord(m)) return false
  if (typeof m.providerID !== "string" || typeof m.modelID !== "string") return false
  if ("variant" in m && m.variant !== undefined && typeof m.variant !== "string") return false
  return true
}

function checkUserTime(t: unknown): boolean {
  if (!isRecord(t)) return false
  return isValidCreated(t.created)
}

function checkAssistantTime(t: unknown): boolean {
  if (!isRecord(t)) return false
  if (!isValidCreated(t.created)) return false
  if ("completed" in t && t.completed !== undefined && !isValidCreated(t.completed)) return false
  return true
}

function checkTokens(t: unknown): boolean {
  if (!isRecord(t)) return false
  if (!isFiniteNumber(t.input) || !isFiniteNumber(t.output) || !isFiniteNumber(t.reasoning)) return false
  const cache = t.cache
  if (!isRecord(cache)) return false
  return isFiniteNumber(cache.read) && isFiniteNumber(cache.write)
}

function checkPath(p: unknown): boolean {
  if (!isRecord(p)) return false
  return typeof p.cwd === "string" && typeof p.root === "string"
}

// Minimal structural mirror of SessionV1.Info required shape. Allows unknown
// legacy top-level extras (returned untouched) like Schema.is does; rejects
// missing/bad discriminator, ids, time, and role-required fields.
function isInfoShape(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  const r = raw
  if (!isValidMsgId(r.id)) return false
  if (!isValidSesId(r.sessionID)) return false
  if (r.role !== "user" && r.role !== "assistant") return false
  if (!isRecord(r.time)) return false
  if (r.role === "user") {
    if (!checkUserTime(r.time)) return false
    if (typeof r.agent !== "string") return false
    if (!checkModel(r.model)) return false
    return true
  }
  if (!checkAssistantTime(r.time)) return false
  if (!isValidMsgId(r.parentID)) return false
  if (typeof r.modelID !== "string" || typeof r.providerID !== "string") return false
  if (typeof r.mode !== "string" || typeof r.agent !== "string") return false
  if (!checkPath(r.path)) return false
  if (!isFiniteNumber(r.cost)) return false
  if (!checkTokens(r.tokens)) return false
  return true
}

const PART_TYPES = new Set([
  "text",
  "subtask",
  "reasoning",
  "file",
  "tool",
  "step-start",
  "step-finish",
  "snapshot",
  "patch",
  "agent",
  "retry",
  "compaction",
])

function checkToolState(s: unknown): boolean {
  if (!isRecord(s)) return false
  const status = s.status
  if (status !== "pending" && status !== "running" && status !== "completed" && status !== "error") return false
  if (!isRecord(s.input)) return false
  if (status === "pending") return typeof s.raw === "string"
  if (!isRecord(s.time)) return false
  if (!isValidCreated((s.time as Record<string, unknown>).start)) return false
  if (status === "running") return true
  if (!isValidCreated((s.time as Record<string, unknown>).end)) return false
  if (status === "error") return typeof s.error === "string"
  if (typeof s.output !== "string" || typeof s.title !== "string") return false
  if (!isRecord(s.metadata)) return false
  return true
}

// eslint-disable-next-line complexity
function isPartShape(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  const r = raw
  if (!isValidPrtId(r.id)) return false
  if (!isValidSesId(r.sessionID)) return false
  if (!isValidMsgId(r.messageID)) return false
  if (typeof r.type !== "string" || !PART_TYPES.has(r.type)) return false
  switch (r.type as string) {
    case "text":
      return typeof r.text === "string"
    case "reasoning":
      return typeof r.text === "string" && isRecord(r.time) && isValidCreated((r.time as Record<string, unknown>).start)
    case "file":
      return typeof r.mime === "string" && typeof r.url === "string"
    case "agent":
      return typeof r.name === "string"
    case "subtask":
      return typeof r.prompt === "string" && typeof r.description === "string" && typeof r.agent === "string"
    case "compaction":
      return typeof r.auto === "boolean"
    case "snapshot":
      return typeof r.snapshot === "string"
    case "patch":
      return typeof r.hash === "string" && Array.isArray(r.files)
    case "step-start":
      return true
    case "step-finish":
      return typeof r.reason === "string" && isFiniteNumber(r.cost) && checkTokens(r.tokens)
    case "tool":
      return typeof r.callID === "string" && typeof r.tool === "string" && checkToolState(r.state)
    case "retry":
      return (
        Number.isInteger(r.attempt) &&
        (r.attempt as number) >= 0 &&
        isRecord(r.error) &&
        isRecord(r.time) &&
        isValidCreated((r.time as Record<string, unknown>).created)
      )
    default:
      return false
  }
}

export function validateInfo(raw: unknown): SessionV1.Info {
  if (!isInfoShape(raw)) throw new Error("invalid message shape")
  return raw as SessionV1.Info
}

export function validatePart(raw: unknown): SessionV1.Part {
  if (!isPartShape(raw)) throw new Error("invalid part shape")
  return raw as SessionV1.Part
}

export const decodeInfo = validateInfo
export const decodePart = validatePart

function messageTimeCreated(info: { time: { created: number } }): number {
  return (info as { time: { created: number } }).time.created
}

function messageIdOf(info: { id: string }): string {
  return (info as { id: string }).id
}

// Controller-boundary page invariants for observation/messages `found` pages.
// DB emits time_created DESC, id DESC then reverses to chronological ASC, so the
// wire must be ASC by info.time.created then id. nextCursor, when present,
// anchors the oldest returned message (first in the ASC page).
export function assertFoundMessagePage(
  messages: Array<{ info: { id: string; time: { created: number } }; parts: unknown[] }>,
  limit: number,
  nextCursor: string | undefined,
): void {
  if (messages.length > limit) throw new Error("messages returned too many messages")
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!
    const cur = messages[i]!
    const pt = messageTimeCreated(prev.info)
    const ct = messageTimeCreated(cur.info)
    if (typeof pt !== "number" || typeof ct !== "number" || !Number.isFinite(pt) || !Number.isFinite(ct))
      throw new Error("messages returned invalid message shape")
    const pid = messageIdOf(prev.info)
    const cid = messageIdOf(cur.info)
    if (ct < pt || (ct === pt && cid <= pid)) throw new Error("messages returned out-of-order page")
  }
  if (nextCursor === undefined) return
  if (messages.length !== limit) throw new Error("messages returned cursor on short page")
  const anchor = decodeMessageCursor(nextCursor)
  if (!isStrictCursorTime(anchor.time)) throw new Error("messages returned invalid nextCursor")
  const first = messages[0]!.info
  if (messageIdOf(first) !== anchor.id || messageTimeCreated(first) !== anchor.time)
    throw new Error("messages returned stale cursor")
}
