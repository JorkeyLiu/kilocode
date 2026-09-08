import { Schema } from "effect"
import { SessionV1 } from "../v1/session"

export const MAX_MESSAGE_PATCH_SIZE = 256 * 1024

export const MESSAGE_CURSOR_MAX_LENGTH = 512

export interface MessageCursor {
  id: string
  time: number
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

function isValidMsgId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("msg") && !v.includes("\0")
}

function isValidCursorTime(v: unknown): boolean {
  // Shared base is deliberately finite-tolerant (not integer-only) so legacy
  // MessageV2 cursors issued with fractional times keep decoding. The
  // observation/messages wire enforces integer timestamps on top of this.
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

function stripPatch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  if (Buffer.byteLength(value) > MAX_MESSAGE_PATCH_SIZE) return undefined
  return value
}

function withPatch(value: unknown): { patch?: string } {
  const kept = stripPatch(value)
  return kept ? { patch: kept } : {}
}

export function stripPartMetadata(part: SessionV1.Part): SessionV1.Part {
  if (part.type !== "tool") return part
  const state = (part as Extract<SessionV1.Part, { type: "tool" }>).state
  if (state.status !== "completed" && state.status !== "running") return part
  const meta = (state as { metadata?: Record<string, unknown> }).metadata
  if (!meta) return part

  let changed = false
  let next: Record<string, unknown> = meta

  if (meta.diff !== undefined) {
    const { diff: _drop, ...rest } = next
    next = rest
    changed = true
  }

  if (meta.filediff) {
    const fd = meta.filediff as Record<string, unknown>
    const { before: _b, after: _a, patch, ...rest } = fd
    next = { ...next, filediff: { ...rest, ...withPatch(patch) } }
    changed = true
  }

  if (Array.isArray(meta.files) && meta.files.length > 0) {
    next = {
      ...next,
      files: (meta.files as Record<string, unknown>[]).map((f) => {
        const { before: _b, after: _a, patch, diff, ...rest } = f
        const kept = stripPatch(patch) ?? stripPatch(diff)
        return { ...rest, ...(kept ? { patch: kept } : {}) }
      }),
    }
    changed = true
  }

  if (Array.isArray(meta.results) && meta.results.length > 0) {
    next = {
      ...next,
      results: (meta.results as Record<string, unknown>[]).map((r) => {
        const { diff: _d, ...rest } = r
        if (!r.filediff || typeof r.filediff !== "object") return rest
        const fd = r.filediff as Record<string, unknown>
        const { before: _b, after: _a, patch, ...file } = fd
        return { ...rest, filediff: { ...file, ...withPatch(patch) } }
      }),
    }
    changed = true
  }

  if (!changed) return part
  return { ...part, state: { ...state, metadata: next } } as SessionV1.Part
}

export function stripMessageMetadata(info: SessionV1.Info): SessionV1.Info {
  if (info.role !== "user") return info
  const user = info as SessionV1.User
  if (!user.summary?.diffs?.length) return info
  const oversized = (d: { patch?: string }) => d.patch && Buffer.byteLength(d.patch) > MAX_MESSAGE_PATCH_SIZE
  if (!user.summary.diffs.some(oversized)) return info
  return {
    ...user,
    summary: {
      ...user.summary,
      diffs: user.summary.diffs.map((d) => (oversized(d) ? { ...d, patch: "" } : d)),
    },
  } as SessionV1.Info
}

// Storage projection must preserve unknown legacy fields. Effect `Schema.is`
// validates required/current shape without transforming, while
// `Schema.decodeUnknownSync` strips excess keys. All row/controller validation
// uses the `is`-based helpers below and returns the original enriched object.
const isInfoShape = Schema.is(SessionV1.Info)
const isPartShape = Schema.is(SessionV1.Part)

export function validateInfo(raw: unknown): SessionV1.Info {
  if (!isInfoShape(raw)) throw new Error("invalid message shape")
  return raw as SessionV1.Info
}

export function validatePart(raw: unknown): SessionV1.Part {
  if (!isPartShape(raw)) throw new Error("invalid part shape")
  return raw as SessionV1.Part
}

// Compatibility aliases: historic decode names now validate without stripping
// unknown fields. New code prefers validate/project helpers.
export const decodeInfo = validateInfo
export const decodePart = validatePart

export function projectMessageInfo(data: unknown, ids: { id: string; sessionID: string }): SessionV1.Info {
  const enriched = { ...((data ?? {}) as Record<string, unknown>), ...ids }
  return stripMessageMetadata(validateInfo(enriched))
}

export function projectMessagePart(
  data: unknown,
  ids: { id: string; sessionID: string; messageID: string },
): SessionV1.Part {
  const enriched = { ...((data ?? {}) as Record<string, unknown>), ...ids }
  return stripPartMetadata(validatePart(enriched))
}

export function messageTimeCreated(info: SessionV1.Info): number {
  return (info as { time: { created: number } }).time.created
}

export function messageIdOf(info: SessionV1.Info): string {
  return (info as { id: string }).id
}

// Controller-boundary page invariants for observation/messages `found` pages.
// DB emits time_created DESC, id DESC then reverses to chronological ASC, so the
// wire must be ASC by info.time.created then id. nextCursor, when present,
// anchors the oldest returned message (first in the ASC page).
export function assertFoundMessagePage(
  messages: Array<{ info: SessionV1.Info; parts: SessionV1.Part[] }>,
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
