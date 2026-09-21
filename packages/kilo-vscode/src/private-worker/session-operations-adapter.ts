import { isAbsolute } from "path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { desc, eq } from "drizzle-orm"
import { canonicalDirectory } from "./canonical-directory"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { ErrorCode } from "./json-rpc"
import type { ObservationOperationsResult } from "./observation"

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

export function createSessionOperationsDeps(db: Database.Interface["db"]): {
  operations: (input: { directory: string; sessionId: string; limit?: number }) => Promise<ObservationOperationsResult>
} {
  return {
    operations: async (input) => {
      const directory = parseDirectory((input as { directory?: unknown }).directory)
      const sessionId = parseSessionId((input as { sessionId?: unknown }).sessionId)
      const rawLimit = (input as { limit?: unknown }).limit
      const limit = (() => {
        if (rawLimit === undefined) return 1
        if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 20) throw invalidParams("limit must be integer 1..20")
        return rawLimit as number
      })()
      const row = (await Effect.runPromise(
        (db as unknown as { select: () => { from: (t: unknown) => { where: (c: unknown) => { get: () => Effect.Effect<unknown, never, never> } } } })
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id as never, sessionId as never))
          .get()
          .pipe(Effect.orDie),
      )) as unknown as typeof SessionTable.$inferSelect | undefined
      if (!row) return { v: "1.0", status: "not_found" }
      const storedDir = (() => {
        try {
          return canonicalDirectory(row.directory)
        } catch {
          throw internalError("invalid stored directory shape")
        }
      })()
      if (storedDir !== directory) return { v: "1.0", status: "scope_mismatch" }
      const rows = (await Effect.runPromise(
        (db as unknown as { select: () => { from: (t: unknown) => { where: (c: unknown) => { orderBy: (...a: unknown[]) => { limit: (n: number) => { all: () => Effect.Effect<unknown[], never, never> } } } } } })
          .select()
          .from(SessionOperationTable)
          .where(eq(SessionOperationTable.session_id as never, sessionId as never))
          .orderBy(desc(SessionOperationTable.time as never), desc(SessionOperationTable.op_id as never))
          .limit(limit)
          .all()
          .pipe(Effect.orDie),
      )) as unknown as Array<typeof SessionOperationTable.$inferSelect>
      if (rows.length === 0) return { v: "1.0", status: "found", operations: [] }
      const ops = rows.map((r) => {
        let rec: SessionOperation.FailureRecord
        try {
          rec = SessionOperation.validatedRowToRecord(r as typeof SessionOperationTable.$inferSelect)
        } catch (e) {
          throw internalError(e instanceof Error ? e.message : String(e))
        }
        const panel = SessionOperation.toPanelRecord(rec) as Record<string, unknown>
        const allowed = new Set(["opId", "outcome", "code", "message", "cancel"])
        for (const k of Object.keys(panel)) if (!allowed.has(k)) throw internalError("panel projection leaked non-panel field")
        const out: Record<string, unknown> = {
          opId: panel.opId,
          outcome: panel.outcome,
          code: panel.code,
          message: panel.message,
          time: rec.time,
        }
        if (panel.cancel !== undefined) out.cancel = panel.cancel
        const rb = (r as Record<string, unknown>).recovery_budget as number | null | undefined
        const rn = (r as Record<string, unknown>).recovery_next_at as number | null | undefined
        const rp = (r as Record<string, unknown>).recovery_provenance as string | null | undefined
        if (rb !== null && rb !== undefined) {
          if (rb !== 0) throw internalError("invalid recovery budget")
          if (rn !== null && rn !== undefined) throw internalError("invalid recovery nextAt")
          if (rp !== "terminal") throw internalError("invalid recovery provenance")
          if (rec.outcome !== "failed" && rec.outcome !== "abandoned") throw internalError("recovery only for failed/abandoned")
          out.recovery = { budget: 0 as const, nextAt: null, provenance: "terminal" as const }
        }
        return out as unknown as ObservationOperationsResult extends { status: "found"; operations: infer U } ? (U extends (infer E)[] ? E : never) : never
      })
      return { v: "1.0", status: "found", operations: ops as any }
    },
  }
}
