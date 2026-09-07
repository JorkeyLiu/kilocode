import { isAbsolute } from "path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { and, desc, eq, isNull, lt, or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { SessionID } from "@/session/schema"
import { decodeGlobalListCursor, encodeGlobalListCursor } from "@/session/global-cursor"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { ErrorCode } from "./json-rpc"
import type { ObservationListResult } from "./observation"

function invalidParams(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InvalidParams
  return err
}

export function createSessionListDeps(db: Database.Interface["db"]): {
  list: (input: { directory: string; archived?: boolean; cursor?: string; limit: number }) => Promise<ObservationListResult>
} {
  return {
    list: async (input) => {
      const rawDir = (input as { directory?: unknown }).directory
      if (typeof rawDir !== "string" || rawDir.length === 0 || rawDir.includes("\0")) throw invalidParams("directory must be non-empty absolute path")
      if (!isAbsolute(rawDir)) throw invalidParams("directory must be non-empty absolute path")
      const directory = (() => {
        try {
          return canonicalDirectory(rawDir)
        } catch (e) {
          throw invalidParams((e as Error).message.includes("directory") ? (e as Error).message : "directory must be non-empty absolute path")
        }
      })()
      if ("archived" in input && input.archived !== undefined && typeof input.archived !== "boolean") throw invalidParams("archived must be boolean when present")
      const archived = input.archived
      const limit = input.limit
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw invalidParams("limit must be integer 1..500")
      }
      const conditions: SQL[] = []
      conditions.push(eq(SessionTable.directory, directory))
      if (!archived) conditions.push(isNull(SessionTable.time_archived))
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
      const query = db.select().from(SessionTable).where(and(...conditions))
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
        projectID: row.project_id as unknown as string,
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
