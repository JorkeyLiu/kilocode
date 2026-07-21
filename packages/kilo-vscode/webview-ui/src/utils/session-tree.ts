/**
 * Shared session tree-building logic.
 *
 * Used by both the history list (SessionList.tsx) and the Agent Manager
 * sidebar session list to render parent-child hierarchies with date grouping.
 */

/** Minimal session shape required by tree utilities. */
export interface SessionLike {
  id: string
  parentID?: string | null
  createdAt: string
  updatedAt: string
}

/** A flat display item that carries tree metadata for rendering. */
export interface DisplayItem<T extends SessionLike = SessionLike> {
  session: T
  depth: number
  seq?: number
  hasChildren: boolean
}

export const DATE_GROUP_KEYS = [
  "time.today",
  "time.yesterday",
  "time.thisWeek",
  "time.thisMonth",
  "time.older",
] as const

export function dateGroupKey(iso: string): (typeof DATE_GROUP_KEYS)[number] {
  const now = new Date()
  const then = new Date(iso)

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const weekAgo = new Date(today.getTime() - 7 * 86400000)
  const monthAgo = new Date(today.getTime() - 30 * 86400000)

  if (then >= today) return DATE_GROUP_KEYS[0]
  if (then >= yesterday) return DATE_GROUP_KEYS[1]
  if (then >= weekAgo) return DATE_GROUP_KEYS[2]
  if (then >= monthAgo) return DATE_GROUP_KEYS[3]
  return DATE_GROUP_KEYS[4]
}

/** Build a lookup: parentID -> children sorted by createdAt ascending. */
function buildGroups<T extends SessionLike>(sessions: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const s of sessions) {
    if (!s.parentID) continue
    const list = map.get(s.parentID) ?? []
    list.push(s)
    map.set(s.parentID, list)
  }
  for (const [, kids] of map) {
    kids.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  return map
}

/** Build a one-time session lookup map. */
export function buildByID<T extends SessionLike>(sessions: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const s of sessions) map.set(s.id, s)
  return map
}

/**
 * Compute the flat display list from sessions + expanded state.
 *
 * Returns root sessions at depth 0, recursively adding children when their
 * parent is expanded. Orphaned children (whose parent is absent) are rendered
 * at depth 0. Cycle-safe: any re-visited node is skipped.
 */
export function buildDisplayList<T extends SessionLike>(sessions: T[], expanded: Set<string>): DisplayItem<T>[] {
  const kids = buildGroups(sessions)
  const byID = buildByID(sessions)
  const items: DisplayItem<T>[] = []
  const visited = new Set<string>()

  function flatten(node: T, depth: number, seq?: number) {
    if (visited.has(node.id)) return
    visited.add(node.id)
    const nodeKids = kids.get(node.id)
    const leaf = (nodeKids?.length ?? 0) === 0
    items.push({ session: node, depth, seq, hasChildren: !leaf })
    if (!leaf && expanded.has(node.id)) {
      for (let i = nodeKids!.length - 1; i >= 0; i--) {
        flatten(nodeKids![i], depth + 1, i + 1)
      }
    }
  }

  for (const s of sessions) {
    if (s.parentID) continue
    flatten(s, 0)
  }
  // Orphaned sessions whose parent is absent from the list
  for (const s of sessions) {
    if (!s.parentID) continue
    if (visited.has(s.id)) continue
    if (!byID.has(s.parentID)) flatten(s, 0)
  }
  // Cycle-only component fallback: sessions whose parent exists in the session set
  // but was never visited (i.e., part of a cycle with no reachable root).
  // Collapsed children of visited parents are intentionally skipped.
  const cycleQueue: T[] = []
  for (const s of sessions) {
    if (visited.has(s.id)) continue
    if (s.parentID && visited.has(s.parentID)) continue // collapsed child
    cycleQueue.push(s)
  }
  for (const s of cycleQueue) flatten(s, 0)
  return items
}

/**
 * Resolve the date-group key for an item.
 * All descendants inherit their root ancestor's group.
 * Cycle-safe: stops if a visited ancestor is re-encountered.
 */
export function resolveGroupKey<T extends SessionLike>(item: DisplayItem<T>, byID: Map<string, T>): string {
  if (!item.session.parentID) return dateGroupKey(item.session.updatedAt)
  const seen = new Set<string>([item.session.id])
  let walk: T | undefined = byID.get(item.session.parentID)
  while (walk) {
    if (!walk.parentID) return dateGroupKey(walk.updatedAt)
    if (seen.has(walk.id)) break // cycle detected
    seen.add(walk.id)
    walk = byID.get(walk.parentID)
  }
  // Fallback: use the last reachable ancestor's date or the item's own
  return dateGroupKey(walk ? walk.updatedAt : item.session.updatedAt)
}

/**
 * Resolve ancestor IDs for a session, used for auto-expanding the tree.
 * Returns the list of ancestor IDs from the session's parent up to the root.
 * Cycle-safe: stops if a visited ancestor is re-encountered.
 */
export function ancestorIDs<T extends SessionLike>(session: T, byID: Map<string, T>): string[] {
  const ids: string[] = []
  const seen = new Set<string>([session.id])
  let walk: T | undefined = session
  while (walk?.parentID) {
    if (seen.has(walk.parentID)) break
    seen.add(walk.parentID)
    ids.push(walk.parentID)
    walk = byID.get(walk.parentID)
  }
  return ids
}

/**
 * Given a set of root session IDs, return the full descendant closure
 * from the complete session set. Roots are determined externally (e.g.
 * ownership classification). Children inherit the root's ownership;
 * they are not independent owners.
 *
 * The returned array contains root sessions first (in input order),
 * followed by each root's descendants in depth-first createdAt order.
 */
export function buildDescendantsClosure<T extends SessionLike>(rootIDs: Set<string>, allSessions: T[]): T[] {
  const byID = buildByID(allSessions)
  const kids = buildGroups(allSessions)
  const result: T[] = []
  const visited = new Set<string>()

  function collect(node: T) {
    if (visited.has(node.id)) return
    visited.add(node.id)
    result.push(node)
    const nodeKids = kids.get(node.id)
    if (nodeKids) {
      for (const child of nodeKids) collect(child)
    }
  }

  // Add roots in the order they appear in rootIDs iteration
  for (const id of rootIDs) {
    const root = byID.get(id)
    if (root) collect(root)
  }
  return result
}
