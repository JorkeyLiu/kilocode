import type { PrivateObservationService } from "../private-worker/private-observation-service"

function isSafeNonNegativeCursor(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}

function isValidObservationEntry(e: unknown, cursor: number, prevSeq: number): { ok: boolean; seq: number } {
  if (!e || typeof e !== "object") return { ok: false, seq: -1 }
  const o = e as Record<string, unknown>
  const seq = o.seq
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0 || seq > cursor) return { ok: false, seq: -1 }
  if (seq <= prevSeq) return { ok: false, seq: -1 }
  if (typeof o.session_id !== "string" || o.session_id.length === 0) return { ok: false, seq: -1 }
  if (typeof o.revision !== "number" || !Number.isSafeInteger(o.revision) || o.revision < 0) return { ok: false, seq: -1 }
  const kind = o.kind
  if (kind !== "changed" && kind !== "deleted") return { ok: false, seq: -1 }
  const time = o.time
  if (typeof time !== "number" || !Number.isFinite(time)) return { ok: false, seq: -1 }
  return { ok: true, seq }
}

const REHYDRATE_REASON_MAX = 256

function isValidRehydrateReason(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.length <= REHYDRATE_REASON_MAX && v.trim().length > 0
}

export class AgentManagerObservationCoordinator {
  constructor(private readonly svc: PrivateObservationService) {}

  getPersistedCursor(): number | undefined {
    try {
      return this.svc.getPersistedCursor()
    } catch {
      return undefined
    }
  }

  async captureSnapshotCursor(): Promise<number | undefined> {
    if (!this.svc.isEnabled()) return undefined
    try {
      const res = (await this.svc.snapshot({})) as { v?: unknown; cursor?: unknown }
      if (!res || res.v !== "1.0") return undefined
      if (!isSafeNonNegativeCursor(res.cursor)) return undefined
      return res.cursor
    } catch {
      return undefined
    }
  }

  decideFromReadResultWithValidity(
    raw: unknown,
    requestedCursor: number | undefined,
  ): { valid: boolean; decision: { shouldRefresh: boolean; ackCursor?: number } } {
    if (requestedCursor === undefined) return { valid: false, decision: { shouldRefresh: true } }
    if (!isSafeNonNegativeCursor(requestedCursor)) return { valid: false, decision: { shouldRefresh: true } }
    const o = raw as { v?: unknown; cursor?: unknown; rehydrate?: unknown; entries?: unknown; reason?: unknown }
    if (!o || o.v !== "1.0" || !isSafeNonNegativeCursor(o.cursor) || o.cursor < requestedCursor || typeof o.rehydrate !== "boolean" || !Array.isArray(o.entries)) {
      return { valid: false, decision: { shouldRefresh: true } }
    }
    if (o.rehydrate) {
      if ((o.entries as unknown[]).length !== 0) return { valid: false, decision: { shouldRefresh: true } }
      if (!isValidRehydrateReason((o as { reason?: unknown }).reason)) return { valid: false, decision: { shouldRefresh: true } }
      return { valid: true, decision: { shouldRefresh: true, ackCursor: o.cursor } }
    }
    const entries = o.entries as unknown[]
    if (entries.length === 0) {
      if (o.cursor !== requestedCursor) return { valid: false, decision: { shouldRefresh: true } }
      return { valid: true, decision: { shouldRefresh: false } }
    }
    let prevSeq = requestedCursor
    for (const e of entries) {
      const r = isValidObservationEntry(e, o.cursor, prevSeq)
      if (!r.ok) return { valid: false, decision: { shouldRefresh: true } }
      if (r.seq !== prevSeq + 1) return { valid: false, decision: { shouldRefresh: true } }
      prevSeq = r.seq
    }
    if (prevSeq !== o.cursor) return { valid: false, decision: { shouldRefresh: true } }
    return { valid: true, decision: { shouldRefresh: true, ackCursor: o.cursor } }
  }

  decideFromReadResult(raw: unknown, requestedCursor: number | undefined): { shouldRefresh: boolean; ackCursor?: number } {
    return this.decideFromReadResultWithValidity(raw, requestedCursor).decision
  }

  async decide(): Promise<{ shouldRefresh: boolean; ackCursor?: number }> {
    if (!this.svc.isEnabled()) return { shouldRefresh: true }
    let cur: number | undefined
    try {
      cur = this.svc.getPersistedCursor()
    } catch {
      return { shouldRefresh: true }
    }
    if (cur === undefined) return { shouldRefresh: true }
    let raw: unknown
    try {
      raw = await this.svc.read(cur)
    } catch {
      return { shouldRefresh: true }
    }
    return this.decideFromReadResult(raw, cur)
  }

  async ack(cursor: number): Promise<boolean> {
    try {
      await this.svc.ack(cursor)
      return true
    } catch {
      return false
    }
  }
}
