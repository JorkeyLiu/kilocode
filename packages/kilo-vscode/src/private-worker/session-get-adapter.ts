import { isAbsolute } from "path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { canonicalDirectory } from "./canonical-directory"
import { ErrorCode } from "./json-rpc"
import type { ObservationGetResult } from "./observation"

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

function isValidMessageId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("msg") && !v.includes("\0")
}

function isValidPartId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("prt") && !v.includes("\0")
}

function isValidTimestamp(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v as number)
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

function parseSummaryDiffs(raw: unknown): unknown[] | undefined {
  if (raw === null || raw === undefined) return undefined
  const arr = (() => {
    if (Array.isArray(raw)) return raw
    if (typeof raw === "string") {
      try {
        const p = JSON.parse(raw)
        if (!Array.isArray(p)) throw new Error("not array")
        return p
      } catch {
        throw internalError("invalid stored summary diffs shape")
      }
    }
    throw internalError("invalid stored summary diffs shape")
  })()
  for (const d of arr) {
    if (typeof d !== "object" || d === null || Array.isArray(d)) throw internalError("invalid stored summary diffs shape")
    const diff = d as Record<string, unknown>
    const allowed = new Set(["file", "additions", "deletions", "status"])
    for (const k of Object.keys(diff)) if (!allowed.has(k)) throw internalError("invalid stored summary diffs shape")
    if (!isFiniteNumber(diff.additions)) throw internalError("invalid stored summary diffs shape")
    if (!isFiniteNumber(diff.deletions)) throw internalError("invalid stored summary diffs shape")
    if ("file" in diff && diff.file !== undefined && typeof diff.file !== "string") throw internalError("invalid stored summary diffs shape")
    if ("status" in diff && diff.status !== undefined) {
      if (typeof diff.status !== "string" || !["added", "deleted", "modified"].includes(diff.status as string)) throw internalError("invalid stored summary diffs shape")
    }
  }
  return arr
}

function buildSummary(row: {
  summary_additions: number | null
  summary_deletions: number | null
  summary_files: number | null
  summary_diffs: unknown
}): { additions: number; deletions: number; files: number; diffs?: unknown[] } | undefined {
  const has = row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
  if (!has) return undefined
  const additions = row.summary_additions ?? 0
  const deletions = row.summary_deletions ?? 0
  const files = row.summary_files ?? 0
  if (!isFiniteNumber(additions) || !isFiniteNumber(deletions) || !isFiniteNumber(files)) throw internalError("invalid stored summary shape")
  const diffs = parseSummaryDiffs(row.summary_diffs)
  return diffs === undefined ? { additions, deletions, files } : { additions, deletions, files, diffs }
}

function buildModel(raw: unknown): { providerID: string; id: string; variant?: string } | undefined {
  if (raw === null || raw === undefined) return undefined
  const m = (() => {
    if (typeof raw === "string") {
      try {
        const p = JSON.parse(raw)
        if (p === null || p === undefined) return undefined
        if (typeof p !== "object" || Array.isArray(p)) throw new Error("not object")
        return p as Record<string, unknown>
      } catch {
        throw internalError("invalid stored model shape")
      }
    }
    if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
    throw internalError("invalid stored model shape")
  })()
  if (m === undefined) return undefined
  const allowed = new Set(["id", "providerID", "variant"])
  for (const k of Object.keys(m)) if (!allowed.has(k)) throw internalError("invalid stored model shape")
  if (typeof m.providerID !== "string" || m.providerID.length === 0 || (m.providerID as string).includes("\0")) {
    throw internalError("invalid stored model shape")
  }
  if (typeof m.id !== "string" || m.id.length === 0 || (m.id as string).includes("\0")) throw internalError("invalid stored model shape")
  if ("variant" in m && m.variant !== undefined && (typeof m.variant !== "string" || (m.variant as string).includes("\0"))) {
    throw internalError("invalid stored model shape")
  }
  const out: { providerID: string; id: string; variant?: string } = { providerID: m.providerID as string, id: m.id as string }
  if (typeof m.variant === "string") out.variant = m.variant as string
  return out
}

function buildRevert(raw: unknown): { messageID: string; partID?: string; snapshot?: string; diff?: string } | undefined {
  if (raw === null || raw === undefined) return undefined
  const rev = (() => {
    if (typeof raw === "string") {
      try {
        const p = JSON.parse(raw)
        if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error("not object")
        return p as Record<string, unknown>
      } catch {
        throw internalError("invalid stored revert shape")
      }
    }
    if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
    throw internalError("invalid stored revert shape")
  })()
  const allowed = new Set(["messageID", "partID", "snapshot", "diff"])
  for (const k of Object.keys(rev)) if (!allowed.has(k)) throw internalError("invalid stored revert shape")
  if (!isValidMessageId(rev.messageID)) throw internalError("invalid stored revert shape")
  if ("partID" in rev && rev.partID !== undefined && !isValidPartId(rev.partID)) throw internalError("invalid stored revert shape")
  if ("snapshot" in rev && rev.snapshot !== undefined && typeof rev.snapshot !== "string") throw internalError("invalid stored revert shape")
  if ("diff" in rev && rev.diff !== undefined && typeof rev.diff !== "string") throw internalError("invalid stored revert shape")
  const out: { messageID: string; partID?: string; snapshot?: string; diff?: string } = { messageID: rev.messageID as string }
  if (typeof rev.partID === "string") out.partID = rev.partID as string
  if (typeof rev.snapshot === "string") out.snapshot = rev.snapshot as string
  if (typeof rev.diff === "string") out.diff = rev.diff as string
  return out
}

export function createSessionGetDeps(db: Database.Interface["db"]): {
  get: (input: { directory: string; sessionId: string }) => Promise<ObservationGetResult>
} {
  return {
    // eslint-disable-next-line complexity
    get: async (input) => {
      const directory = parseDirectory((input as { directory?: unknown }).directory)
      const sessionId = parseSessionId((input as { sessionId?: unknown }).sessionId)
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
      const r = row as unknown as {
        id: string
        title: string
        parent_id: string | null
        directory: string
        project_id: string
        time_created: number
        time_updated: number
        agent: string | null
        model: unknown
        summary_additions: number | null
        summary_deletions: number | null
        summary_files: number | null
        summary_diffs: unknown
        revert: unknown
      }
      if (typeof r.id !== "string" || !isValidSessionId(r.id)) throw internalError("invalid stored id shape")
      if (typeof r.title !== "string") throw internalError("invalid stored title shape")
      if (r.parent_id !== null && r.parent_id !== undefined && !isValidSessionId(r.parent_id)) throw internalError("invalid stored parentID shape")
      if (typeof r.project_id !== "string" || r.project_id.length === 0 || r.project_id.includes("\0")) throw internalError("invalid stored projectID shape")
      if (!isValidTimestamp(r.time_created)) throw internalError("invalid stored createdAt shape")
      if (!isValidTimestamp(r.time_updated)) throw internalError("invalid stored updatedAt shape")
      if (r.agent !== null && r.agent !== undefined && typeof r.agent !== "string") throw internalError("invalid stored agent shape")
      if (typeof r.agent === "string" && r.agent.includes("\0")) throw internalError("invalid stored agent shape")
      const summary = buildSummary(r as unknown as { summary_additions: number | null; summary_deletions: number | null; summary_files: number | null; summary_diffs: unknown })
      const revert = buildRevert((r as unknown as { revert: unknown }).revert)
      const model = buildModel((r as unknown as { model: unknown }).model)
      const session: ObservationGetResult & { status: "found" } = {
        v: "1.0",
        status: "found",
        session: {
          id: r.id,
          title: r.title,
          parentID: r.parent_id ?? null,
          directory,
          projectID: r.project_id as unknown as string,
          createdAt: r.time_created,
          updatedAt: r.time_updated,
        },
      } as unknown as ObservationGetResult & { status: "found" }
      const sess = (session as unknown as { session: Record<string, unknown> }).session
      if (typeof r.agent === "string") sess.agent = r.agent
      if (model !== undefined) sess.model = model as unknown as Record<string, unknown>
      if (summary !== undefined) sess.summary = summary as unknown as Record<string, unknown>
      if (revert !== undefined) sess.revert = revert as unknown as Record<string, unknown>
      return session
    },
  }
}
