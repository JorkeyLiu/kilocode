import type { SessionInfo } from "../src/types/messages"

function rank(s: SessionInfo): number {
  const n = Date.parse(s.updatedAt)
  return Number.isFinite(n) ? n : 0
}

/** Sort a preview snapshot updatedAt-desc with deterministic id tie-break. */
export function sortPreview(list: SessionInfo[]): SessionInfo[] {
  return [...list].sort((a, b) => rank(b) - rank(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Accumulate/deduplicate preview deltas by id (delta wins), sorted for rendering. */
export function mergePreview(prev: SessionInfo[], delta: SessionInfo[]): SessionInfo[] {
  const map = new Map<string, SessionInfo>()
  for (const s of prev) map.set(s.id, s)
  for (const s of delta) map.set(s.id, s)
  return sortPreview([...map.values()])
}

/** True when an incoming refresh id is older than the tracked preview refresh. */
export function isStalePreview(cur: number | undefined, msg: number): boolean {
  return cur !== undefined && msg < cur
}
