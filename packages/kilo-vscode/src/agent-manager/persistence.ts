/**
 * Versioned durable state for Agent Manager open tabs / order / active.
 *
 * vscode-free module. Owns the closed schema persisted in `Store`
 * (VS Code workspaceState via Host). Fail-closed on unknown/malformed.
 */

import type { Store } from "./host"

export const KEY = "kilo.agentManager.persistence.v1"

const MAX = 100
const ID_RE = /^[a-zA-Z0-9._\-:]+$/
const ID_MAX = 128

export interface State {
  v: 1
  sessions: string[]
  order: string[]
  active?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function idOk(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= ID_MAX && ID_RE.test(id)
}

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (value.length > MAX) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of value) {
    if (!idOk(id)) return null
    if (seen.has(id)) return null
    seen.add(id)
    out.push(id)
  }
  return out
}

export function parse(raw: unknown): State | null {
  if (!isRecord(raw)) return null
  const keys = Object.keys(raw)
  const allowed = new Set(["v", "sessions", "order", "active"])
  for (const k of keys) if (!allowed.has(k)) return null
  if (raw.v !== 1) return null
  const s = idList(raw.sessions)
  const o = idList(raw.order)
  if (!s || !o) return null
  let active: string | undefined
  if (raw.active !== undefined) {
    if (!idOk(raw.active)) return null
    active = raw.active
  }
  const set = new Set(s)
  for (const id of o) if (!set.has(id)) return null
  if (active !== undefined && !set.has(active)) return null
  const filtered = o.filter((id) => set.has(id))
  const missing = s.filter((id) => !filtered.includes(id))
  const order = [...filtered, ...missing].slice(0, MAX)
  return { v: 1, sessions: s, order, ...(active !== undefined ? { active } : {}) }
}

export function build(sessions: string[], order: string[], active?: string): State {
  const dedupS = [...new Set(sessions.filter(idOk))].slice(0, MAX)
  const set = new Set(dedupS)
  const dedupO = [...new Set(order.filter(idOk))].filter((id) => set.has(id)).slice(0, MAX)
  const missing = dedupS.filter((id) => !dedupO.includes(id))
  const finalOrder = [...dedupO, ...missing].slice(0, MAX)
  const a = active !== undefined && idOk(active) && set.has(active) ? active : undefined
  return { v: 1, sessions: dedupS, order: finalOrder, ...(a !== undefined ? { active: a } : {}) }
}

export function load(store: Store): State | null {
  const raw = store.get<unknown>(KEY)
  if (raw === undefined) return null
  return parse(raw)
}
