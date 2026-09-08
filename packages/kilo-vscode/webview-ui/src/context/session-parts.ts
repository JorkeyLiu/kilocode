import type { Part } from "../types/messages"

function stream(part: Part): part is Extract<Part, { type: "text" | "reasoning" }> {
  return part.type === "text" || part.type === "reasoning"
}

function newer(local: Part, snapshot: Part): Part {
  if (local.type !== snapshot.type) return snapshot
  if (!stream(local) || !stream(snapshot)) return snapshot
  if (snapshot.time?.end !== undefined) return snapshot
  if (local.text.length <= snapshot.text.length) return snapshot
  if (!local.text.startsWith(snapshot.text)) return snapshot
  return local
}

export function sameParts(local: Part[] = [], snapshot: Part[] = []): boolean {
  if (local.length !== snapshot.length) return false
  for (const [i, part] of snapshot.entries()) {
    const current = local[i]!
    if (current.id !== part.id || current.type !== part.type) return false
    if (!stream(current) || !stream(part)) continue
    if (current.text !== part.text) return false
    if (current.time?.end !== part.time?.end) return false
  }
  return true
}

/**
 * Strict snapshot application for the token-ordered path: pre-token local
 * state is replaced by the snapshot for same-ID parts (snapshot wins, no
 * prefix/newer heuristic). Local-only parts drop here; post-token absent tails
 * and authoritative fulls replay after `messagesLoaded` via the scheduler
 * capture, keeping the final state without duplication. Applies equally to
 * text and reasoning parts.
 */
export function applySnapshot(snapshot: Part[]): Part[] {
  return [...snapshot].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Reconcile snapshots may be older than in-flight streaming deltas. Legacy
 * merge (no token) preserves only appended streamed tail parts and open prefix
 * extensions while still accepting snapshots that heal older removals and
 * completed corrections. When `since` carries the opaque scheduler occurrence
 * token (never wall-clock/time.start), strict snapshot semantics apply:
 * same-ID parts resolve to the snapshot and local-only parts drop pending
 * capture replay. The token value itself is never compared against
 * `part.time.start`.
 */
export function mergeParts(local: Part[], snapshot: Part[], since?: number): Part[] {
  if (since !== undefined) return applySnapshot(snapshot)
  const by = new Map(snapshot.map((part) => [part.id, part]))
  const last = snapshot.reduce<string | undefined>((id, part) => (!id || part.id > id ? part.id : id), undefined)
  for (const part of local) {
    const current = by.get(part.id)
    if (current) {
      by.set(part.id, newer(part, current))
      continue
    }
    if (!last || !stream(part) || part.id <= last) continue
    by.set(part.id, part)
  }
  return [...by.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
