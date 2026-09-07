import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { and, desc, eq, lt, or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { SessionID } from "@/session/schema"
import { decodeGlobalListCursor, encodeGlobalListCursor } from "@/session/global-cursor"
import { ErrorCode } from "./json-rpc"
import type { ObservationListResult } from "./observation"

function invalidParams(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InvalidParams
  return err
}

export function createSessionListDeps(db: Database.Interface["db"]): {
  list: (input: { cursor?: string; limit: number }) => Promise<ObservationListResult>
} {
  return {
    list: async (input) => {
      const limit = input.limit
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw invalidParams("limit must be integer 1..500")
      }
      const conditions: SQL[] = []
      if (input.cursor !== undefined) {
        const decoded: { updated: number; id: string } = (() => {
          try {
            return decodeGlobalListCursor(input.cursor as string)
          } catch (e) {
            throw invalidParams((e as Error).message)
          }
        })()
        const anchor = SessionID.make(decoded.id)
        conditions.push(
          or(
            lt(SessionTable.time_updated, decoded.updated),
            and(eq(SessionTable.time_updated, decoded.updated), lt(SessionTable.id, anchor)),
          )!,
        )
      }
      const query =
        conditions.length > 0
          ? db.select().from(SessionTable).where(and(...conditions))
          : db.select().from(SessionTable)
      const rows = await Effect.runPromise(
        query
          .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie),
      )
      const truncated = rows.length > limit
      const slice = truncated ? rows.slice(0, limit) : rows
      const entries = slice.map((row) => ({
        id: row.id,
        title: row.title,
        parentID: (row.parent_id as string | null) ?? null,
        directory: row.directory,
        createdAt: row.time_created,
        updatedAt: row.time_updated,
      }))
      const out: ObservationListResult = {
        v: "1.0",
        entries,
      }
      if (truncated) {
        const last = slice[slice.length - 1]!
        out.nextCursor = encodeGlobalListCursor(last.time_updated, last.id)
      }
      return out
    },
  }
}
