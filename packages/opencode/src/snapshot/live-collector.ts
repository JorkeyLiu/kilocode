import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectV2 } from "@opencode-ai/core/project"

export function extractLiveHashes(
  rows: Array<{ revert?: { snapshot?: string } | null }>,
  parts: Array<{ data: unknown }>,
): Set<string> {
  const set = new Set<string>()
  for (const row of rows) {
    const snap = row.revert?.snapshot
    if (typeof snap === "string" && snap) set.add(snap)
  }
  for (const part of parts) {
    const data = part.data as Record<string, unknown> | null | undefined
    if (!data || typeof data.type !== "string") continue
    const rec = data as Record<string, unknown>
    if (data.type === "snapshot") {
      const snap = rec["snapshot"]
      if (typeof snap === "string" && snap) set.add(snap)
      continue
    }
    if (data.type === "patch") {
      const hash = rec["hash"]
      if (typeof hash === "string" && hash) set.add(hash)
      continue
    }
    if (data.type === "step-start" || data.type === "step-finish") {
      const snap = rec["snapshot"]
      if (typeof snap === "string" && snap) set.add(snap)
    }
  }
  return set
}

export const fetchLiveHashes = Effect.fnUntraced(function* (db: Database.Interface["db"], projectID: ProjectV2.ID) {
  const sessions = yield* db
    .select({ id: SessionTable.id, revert: SessionTable.revert })
    .from(SessionTable)
    .where(eq(SessionTable.project_id, projectID))
    .all()
    .pipe(Effect.orDie)
  if (!sessions.length) return new Set<string>()
  const ids = sessions.map((row) => row.id)
  const parts = yield* db
    .select({ data: PartTable.data })
    .from(PartTable)
    .where(inArray(PartTable.session_id, ids))
    .all()
    .pipe(Effect.orDie)
  return extractLiveHashes(sessions, parts)
})
