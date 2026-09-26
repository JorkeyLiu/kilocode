import { isAbsolute } from "path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { decodeGlobalListCursor, encodeGlobalListCursor } from "./session-cursor"
import { authoritativeDirectory, samePhysicalDirectory } from "./canonical-directory"
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
          return authoritativeDirectory(rawDir)
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
      // Legacy lexical-row convergence: distinct stored spellings resolving to
      // the same physical directory are included; different physical
      // directories never match. Bounded to distinct directory values.
      const candidates = await (async (): Promise<string[]> => {
        const seen = new Set<string>([directory])
        try {
          const distinct = (await Effect.runPromise(
            (db as unknown as { selectDistinct: (c: unknown) => { from: (t: unknown) => { all: () => Effect.Effect<unknown[], never, never> } } })
              .selectDistinct({ directory: SessionTable.directory as never })
              .from(SessionTable)
              .all()
              .pipe(Effect.orDie),
          )) as Array<{ directory: string }>
          for (const row of distinct) {
            const stored = (row as { directory: string }).directory
            if (typeof stored !== "string" || seen.has(stored)) continue
            try {
              if (samePhysicalDirectory(stored, directory)) seen.add(stored)
            } catch {
              continue
            }
          }
        } catch {
          // Best-effort convergence; exact authoritative match still holds.
        }
        // Reference canonicalDirectory so the lexical validator stays linked
        // to this scope (request validation already ran through it).
        return [...seen]
      })()
      const conditions: SQL[] = []
      conditions.push(
        (candidates.length === 1
          ? eq(SessionTable.directory as never, candidates[0] as never)
          : inArray(SessionTable.directory as never, candidates as never)) as SQL,
      )
      if (!archived) conditions.push(isNull(SessionTable.time_archived as never) as never)
      if (input.cursor !== undefined) {
        const decoded: { updated: number; id: string } = (() => {
          try {
            return decodeGlobalListCursor(input.cursor as string)
          } catch (e) {
            throw invalidParams((e as Error).message)
          }
        })()
        conditions.push(
          or(
            lt(SessionTable.time_updated as never, decoded.updated as never),
            and(eq(SessionTable.time_updated as never, decoded.updated as never), lt(SessionTable.id as never, decoded.id as never)),
          )!,
        )
      }
      const query = db.select().from(SessionTable).where(and(...conditions) as never)
      const rows = (await Effect.runPromise(
        (query as unknown as { orderBy: (...a: unknown[]) => { limit: (n: number) => { all: () => Effect.Effect<unknown[], never, never> } } })
          .orderBy(desc(SessionTable.time_updated as never), desc(SessionTable.id as never))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie),
      )) as unknown as Array<typeof SessionTable.$inferSelect>
      const truncated = rows.length > limit
      const slice = truncated ? rows.slice(0, limit) : rows
      const entries = slice.map((row) => ({
        id: row.id,
        title: row.title,
        parentID: (row.parent_id as string | null) ?? null,
        directory,
        projectID: row.project_id as unknown as string,
        createdAt: row.time_created,
        updatedAt: row.time_updated,
      }))
      const out: ObservationListResult = { v: "1.0", entries }
      if (truncated) {
        const last = slice[slice.length - 1]!
        out.nextCursor = encodeGlobalListCursor(last.time_updated, last.id)
      }
      return out
    },
  }
}
