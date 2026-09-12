import type { KiloClient } from "@kilocode/sdk/v2/client"
import { retry } from "../services/cli-backend/retry"
import type { SkillListContractRequest } from "../services/cli-backend/serve-private-skill-list-contract"
import { attemptSkillListPrivate, buildSkillListPrivateReq } from "./skill-list-privatefirst"

type SkillListConnection = {
  isPrivateAvailable(): boolean
  privateSkillListOutcomeWithHandle(req: SkillListContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export interface SkillListSafeEntry {
  name: string
  description?: string
  location: string
}

function projectEntry(item: unknown): SkillListSafeEntry {
  const rec = item as Record<string, unknown>
  const name = rec.name
  if (typeof name !== "string" || name.length === 0) throw new Error("skill entry must have non-empty name")
  const description = rec.description
  if (description !== undefined && typeof description !== "string") throw new Error("skill entry description invalid")
  const location = rec.location
  if (typeof location !== "string" || location.length === 0) throw new Error("skill entry must have non-empty location")
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    location,
  }
}

function mapSkills(items: unknown): { type: string; skills: SkillListSafeEntry[] } {
  if (!Array.isArray(items)) throw new Error("skills must be array")
  return {
    type: "skillsLoaded",
    skills: (items as unknown[]).map(projectEntry),
  }
}

/**
 * Private-first `skill/list` read. A validated private
 * `succeeded`+`accepted` (including empty) returns the safe carrier
 * projection with zero SDK. Every other outcome — failed (no domain
 * terminal), ambiguous, invalid, unavailable, transport, closed, timeout —
 * takes exactly one same-directory SDK `client.app.skills` fallback
 * through the existing retry wrapper; no second private attempt runs.
 * SDK results are projected to the safe shape before return so `content`
 * and file bytes never reach the post/cache layer.
 */
export async function loadSkills(client: KiloClient, dir: string, connection?: unknown): Promise<unknown> {
  const conn = connection as SkillListConnection | null | undefined
  if (typeof dir === "string" && dir.length > 0 && conn) {
    let req: SkillListContractRequest | null = null
    try {
      req = buildSkillListPrivateReq(dir)
    } catch {
      req = null
    }
    if (req) {
      const attempt = await attemptSkillListPrivate(conn, req)
      if (attempt.kind === "ok") {
        return {
          type: "skillsLoaded",
          skills: attempt.skills.map((s) => ({
            name: s.name,
            ...(s.description !== undefined ? { description: s.description } : {}),
            location: s.location,
          })),
        }
      }
    }
  }
  const result = await retry(() => (client as unknown as { app: { skills: (args: { directory: string }, opts: { throwOnError: boolean }) => Promise<{ data?: unknown }> } }).app.skills({ directory: dir }, { throwOnError: true }))
  const data = (result as { data?: unknown }).data
  return mapSkills(data)
}
