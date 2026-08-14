/**
 * Derived Topic model for the Agent Manager sidebar (P1 orchestration-first
 * navigation).
 *
 * Pure, deterministic derivation from runtime session facts only:
 * - Each root session (no parentID, or whose parent is absent from the set)
 *   defines one Topic. Topic ID is the root session ID; label is the root
 *   title.
 * - Descendants belong via the existing parentID edges.
 * - Topic activity is the max member updatedAt.
 * - Topics order by activity descending with a deterministic ID tie-break.
 * - Orphans, missing-parent components, and cycles degrade to independent
 *   Topics with no runtime mutation.
 *
 * Presentation state (selection, expansion) is owned by the caller. Nothing
 * here persists, mutates, or sends messages: Topic is a derived view over the
 * session inventory, not a domain model.
 */

import { buildByID, type SessionLike } from "../src/utils/session-tree"

/** Minimal session shape the topic derivation needs (title is optional). */
export interface TopicLike extends SessionLike {
  title?: string
}

/** A derived Topic: root session plus its descendant closure. */
export interface TopicView<T extends TopicLike = TopicLike> {
  /** Topic ID = root session ID. */
  id: string
  /** Root session defining the topic. */
  root: T
  /** Root title (may be empty; UI falls back to the untitled label). */
  label: string
  /** Root + all descendants reachable via parentID edges, deterministic order. */
  members: T[]
  /** Max member updatedAt (ISO string) — the topic's activity. */
  activity: string
  /** True when the root session has at least one child. */
  hasChildren: boolean
}

/** parentID -> direct children, each list sorted createdAt ascending. */
function childGroups<T extends TopicLike>(sessions: T[]): Map<string, T[]> {
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

function topicFrom<T extends TopicLike>(root: T, members: T[]): TopicView<T> {
  let activity = new Date(root.updatedAt).getTime()
  for (const m of members) {
    const t = new Date(m.updatedAt).getTime()
    if (t > activity) activity = t
  }
  return {
    id: root.id,
    root,
    label: root.title ?? "",
    members,
    activity: new Date(activity).toISOString(),
    hasChildren: members.length > 1,
  }
}

/**
 * Derive the Topic-first view from a complete session inventory.
 *
 * Deterministic: the same session set always produces the same topic list and
 * order regardless of input order (cycles aside, which degrade to independent
 * single-member Topics).
 */
export function deriveTopics<T extends TopicLike>(sessions: T[]): TopicView<T>[] {
  const byID = buildByID(sessions)
  const kids = childGroups(sessions)
  const topics: TopicView<T>[] = []
  const claimed = new Set<string>()

  const collect = (node: T, out: T[]) => {
    if (claimed.has(node.id)) return
    claimed.add(node.id)
    out.push(node)
    const nodeKids = kids.get(node.id)
    if (nodeKids) {
      for (const child of nodeKids) collect(child, out)
    }
  }

  // Roots: sessions whose parent is absent from the set (no parentID or a
  // missing parent). Each defines one Topic with its descendant closure.
  for (const s of sessions) {
    if (s.parentID && byID.has(s.parentID)) continue // descendant of a root
    if (claimed.has(s.id)) continue
    const members: T[] = []
    collect(s, members)
    topics.push(topicFrom(s, members))
  }

  // Cycles: sessions whose parent exists in the set but whose parent chain
  // never reaches a root. Degrade each member to an independent Topic.
  for (const s of sessions) {
    if (claimed.has(s.id)) continue
    topics.push(topicFrom(s, [s]))
    claimed.add(s.id)
  }

  // Order: activity descending, deterministic ID ascending tie-break.
  topics.sort((a, b) => {
    const byActivity = new Date(b.activity).getTime() - new Date(a.activity).getTime()
    if (byActivity !== 0) return byActivity
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return topics
}

/**
 * Resolve the Topic containing the active session, or undefined when the
 * active session is not part of any derived Topic (or no session is active).
 */
export function activeTopicID<T extends TopicLike>(
  topics: TopicView<T>[],
  activeSessionID: string | undefined,
): string | undefined {
  if (!activeSessionID) return undefined
  for (const tp of topics) {
    if (tp.members.some((m) => m.id === activeSessionID)) return tp.id
  }
  return undefined
}
