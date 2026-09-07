export const GLOBAL_LIST_CURSOR_VERSION = 1 as const
export const GLOBAL_LIST_CURSOR_MAX_LENGTH = 512 as const

export interface GlobalListCursor {
  v: typeof GLOBAL_LIST_CURSOR_VERSION
  updated: number
  id: string
}

export function encodeGlobalListCursor(updated: number, id: string): string {
  return Buffer.from(JSON.stringify({ v: GLOBAL_LIST_CURSOR_VERSION, updated, id }), "utf8").toString("base64url")
}

export function decodeGlobalListCursor(raw: unknown): GlobalListCursor {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > GLOBAL_LIST_CURSOR_MAX_LENGTH)
    throw new Error("cursor must be opaque session-list cursor string")
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("cursor must be opaque session-list cursor string")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    throw new Error("cursor must be opaque session-list cursor string")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("cursor must be opaque session-list cursor string")
  const rec = parsed as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length !== 3 || !keys.includes("v") || !keys.includes("updated") || !keys.includes("id"))
    throw new Error("cursor must be opaque session-list cursor string")
  if (rec.v !== GLOBAL_LIST_CURSOR_VERSION) throw new Error("cursor must be opaque session-list cursor string")
  if (
    typeof rec.updated !== "number" ||
    !Number.isFinite(rec.updated as number) ||
    !Number.isSafeInteger(rec.updated as number) ||
    (rec.updated as number) < 0 ||
    (rec.updated as number) > 8640000000000000
  )
    throw new Error("cursor must be opaque session-list cursor string")
  if (
    typeof rec.id !== "string" ||
    (rec.id as string).length === 0 ||
    !(rec.id as string).startsWith("ses") ||
    (rec.id as string).includes("\0")
  )
    throw new Error("cursor must be opaque session-list cursor string")
  return { v: GLOBAL_LIST_CURSOR_VERSION, updated: rec.updated as number, id: rec.id as string }
}
