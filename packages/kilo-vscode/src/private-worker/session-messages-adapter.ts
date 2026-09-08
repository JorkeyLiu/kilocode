import { isAbsolute } from "path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, desc, eq, inArray, lt, or } from "drizzle-orm"
import { canonicalDirectory } from "./canonical-directory"
import {
  decodeMessageCursor,
  encodeMessageCursor,
  isStrictCursorTime,
  projectMessageInfo,
  projectMessagePart,
} from "@opencode-ai/core/session/message-read"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ErrorCode } from "./json-rpc"
import type { ObservationMessagesResult } from "./observation"

function invalidParams(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InvalidParams
  return err
}

function internalError(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InternalError
  return err
}

function isValidSessionId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("ses") && !v.includes("\0")
}

function parseDirectory(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) throw invalidParams("directory must be non-empty absolute path")
  if (!isAbsolute(raw)) throw invalidParams("directory must be non-empty absolute path")
  try {
    return canonicalDirectory(raw)
  } catch (e) {
    throw invalidParams((e as Error).message.includes("directory") ? (e as Error).message : "directory must be non-empty absolute path")
  }
}

function parseSessionId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !raw.startsWith("ses")) throw invalidParams("sessionId must be non-empty session id")
  if (!isValidSessionId(raw)) throw invalidParams("sessionId must be non-empty session id")
  return raw as string
}

function parseLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 100) throw invalidParams("limit must be integer 1..100")
  return raw as number
}

function projectPartRow(pr: typeof PartTable.$inferSelect): SessionV1.Part {
  const raw = pr.data
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw internalError("invalid stored part shape")
  try {
    return projectMessagePart(raw, { id: pr.id as string, sessionID: pr.session_id as string, messageID: pr.message_id as string })
  } catch (e) {
    if (e instanceof Error && (e as { code?: number }).code !== undefined) throw e
    throw internalError("invalid stored part shape")
  }
}

function projectInfoRow(mr: typeof MessageTable.$inferSelect): SessionV1.Info {
  const raw = mr.data
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw internalError("invalid stored message shape")
  try {
    return projectMessageInfo(raw, { id: mr.id as string, sessionID: mr.session_id as string })
  } catch (e) {
    if (e instanceof Error && (e as { code?: number }).code !== undefined) throw e
    throw internalError("invalid stored message shape")
  }
}

export function createSessionMessagesDeps(db: Database.Interface["db"]): {
  messages: (input: { directory: string; sessionId: string; limit: number; cursor?: string }) => Promise<ObservationMessagesResult>
} {
  return {
    messages: async (input) => {
      const directory = parseDirectory((input as { directory?: unknown }).directory)
      const sessionId = parseSessionId((input as { sessionId?: unknown }).sessionId)
      const limit = parseLimit((input as { limit?: unknown }).limit)
      const rawCursor = (input as { cursor?: unknown }).cursor
      const cur = (() => {
        if (rawCursor === undefined) return undefined
        if (typeof rawCursor !== "string") throw invalidParams("cursor must be opaque message cursor string")
        try {
          const decoded = decodeMessageCursor(rawCursor)
          if (!isStrictCursorTime(decoded.time)) throw new Error("message cursor must be opaque base64url JSON")
          return decoded
        } catch (e) {
          throw internalError((e as Error).message)
        }
      })()
      const row = await Effect.runPromise(
        (db.select().from(SessionTable as never).where(eq(SessionTable.id as never, sessionId as never) as never).get() as unknown as Effect.Effect<typeof SessionTable.$inferSelect | undefined, never, never>).pipe(Effect.orDie),
      )
      if (!row) return { v: "1.0", status: "not_found" }
      const storedDir = (() => {
        try {
          return canonicalDirectory((row as unknown as { directory: string }).directory)
        } catch {
          throw internalError("invalid stored directory shape")
        }
      })()
      if (storedDir !== directory) return { v: "1.0", status: "scope_mismatch" }
      const base = eq(MessageTable.session_id as never, sessionId as never)
      const where = cur
        ? and(
            base as never,
            or(
              lt(MessageTable.time_created as never, cur.time as never),
              and(eq(MessageTable.time_created as never, cur.time as never), lt(MessageTable.id as never, cur.id as never)),
            ) as never,
          )
        : base
      const query = (db.select().from(MessageTable as never).where(where as never) as unknown as {
        orderBy: (...a: unknown[]) => { limit: (n: number) => { all: () => Effect.Effect<unknown[], never, never> } }
      })
      const rawRows = (await Effect.runPromise(
        query
          .orderBy(desc(MessageTable.time_created as never), desc(MessageTable.id as never))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie),
      )) as unknown as Array<typeof MessageTable.$inferSelect>
      if (rawRows.length === 0) return { v: "1.0", status: "found", messages: [] }
      const truncated = rawRows.length > limit
      const slice = truncated ? rawRows.slice(0, limit) : rawRows
      const ids = slice.map((r) => r.id)
      const partQuery = (db.select().from(PartTable as never).where(inArray(PartTable.message_id as never, ids as never) as never) as unknown as {
        orderBy: (...a: unknown[]) => { all: () => Effect.Effect<unknown[], never, never> }
      })
      const partRows = (
        ids.length > 0
          ? await Effect.runPromise(partQuery.orderBy(PartTable.message_id as never, PartTable.id as never).all().pipe(Effect.orDie))
          : []
      ) as unknown as Array<typeof PartTable.$inferSelect>
      const byMessage = new Map<string, SessionV1.Part[]>()
      for (const pr of partRows) {
        const projected = projectPartRow(pr)
        const key = pr.message_id as string
        const list = byMessage.get(key)
        if (list) list.push(projected)
        else byMessage.set(key, [projected])
      }
      const descMessages: SessionV1.WithParts[] = slice.map((mr) => {
        const info = projectInfoRow(mr)
        if (typeof mr.time_created !== "number" || !Number.isInteger(mr.time_created)) throw internalError("invalid stored message shape")
        return { info, parts: byMessage.get(mr.id as string) ?? [] }
      })
      descMessages.reverse()
      const out: ObservationMessagesResult = { v: "1.0", status: "found", messages: descMessages }
      if (truncated) {
        const tail = slice.at(-1)!
        if (typeof tail.time_created !== "number" || !Number.isInteger(tail.time_created)) throw internalError("invalid stored message shape")
        out.nextCursor = encodeMessageCursor({ id: tail.id as string, time: tail.time_created })
      }
      return out
    },
  }
}
