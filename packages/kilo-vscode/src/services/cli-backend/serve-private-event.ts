/**
 * Private `event/notify` envelope validation (extension side).
 *
 * Mirrors `packages/opencode/src/kilocode/server/private-event-forwarder.ts`:
 * strict, bounded, directory/transaction-preserving. `observation/changed`
 * never flows through this path. Oversize or malformed frames are dropped;
 * lost frames are never authoritative (consumers rebuild via readable APIs).
 */

export const PRIVATE_EVENT_NOTIFY_METHOD = "event/notify" as const
export const PRIVATE_EVENT_MAX_BYTES = 256 * 1024
const PRIVATE_EVENT_MAX_STRING = 1024

export interface PrivateEventEnvelope {
  directory?: string
  project?: string
  workspace?: string
  transaction?: string
  payload: Record<string, unknown> & { type: string }
}

function bounded(v: unknown): v is string {
  return (
    typeof v === "string" && v.length > 0 && v.length <= PRIVATE_EVENT_MAX_STRING && !(v as string).includes("\0")
  )
}

// eslint-disable-next-line complexity
export function normalizePrivateEventEnvelope(raw: unknown): PrivateEventEnvelope | null {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    const allowed = new Set(["directory", "project", "workspace", "transaction", "payload"])
    for (const k of Object.keys(o)) if (!allowed.has(k)) return null
    if (o.directory !== undefined && !bounded(o.directory)) return null
    if (o.project !== undefined && !bounded(o.project)) return null
    if (o.workspace !== undefined && !bounded(o.workspace)) return null
    if (o.transaction !== undefined && !bounded(o.transaction)) return null
    const payload = o.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
    const p = payload as Record<string, unknown>
    if (typeof p.type !== "string" || p.type.length === 0 || p.type.length > 256) return null
    if ((p.type as string).includes("\0")) return null
    if (p.type === "server.connected" || p.type === "server.heartbeat") return null
    let size = 0
    try {
      size = JSON.stringify(raw)?.length ?? 0
    } catch {
      return null
    }
    if (!Number.isFinite(size) || size <= 0 || size > PRIVATE_EVENT_MAX_BYTES) return null
    const out: PrivateEventEnvelope = { payload: p as PrivateEventEnvelope["payload"] }
    if (typeof o.directory === "string") out.directory = o.directory as string
    if (typeof o.project === "string") out.project = o.project as string
    if (typeof o.workspace === "string") out.workspace = o.workspace as string
    if (typeof o.transaction === "string") out.transaction = o.transaction as string
    return out
  } catch {
    return null
  }
}
