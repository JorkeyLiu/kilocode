import type { KiloClient, SessionStatus } from "@kilocode/sdk/v2/client"
import { sameDirectory } from "../kilo-provider-utils"
import { isE2EFixtureEnabled } from "../util/e2e-fixture"

export type AbortAttemptRecord = {
  sessionID: string
  directory: string
  startedAt: number
  endedAt: number
  durationMs: number
  ok: boolean
  attempt: number
  error?: string
  status?: number
  data?: boolean
}

const ABORT_ATTEMPT_LIMIT = 50
const ABORT_STRING_LIMIT = 500
// Retention policy (LOCK-055): fixture observer keeps only the most recent
// ABORT_ATTEMPT_LIMIT records in memory. Per-session counts and per-session
// attempt numbers are derived from retained records only (retained contract):
// total = retained records length, per-session count = retained records for
// that session, next attempt = max retained attempt for that session + 1
// (or 1 when no retained record exists). No separate cumulative map exists,
// so stored session identities are bounded by the retained record limit and
// records/counts cannot diverge.
const attempts: AbortAttemptRecord[] = []

function truncate(value: string): string {
  if (value.length <= ABORT_STRING_LIMIT) return value
  return value.slice(0, ABORT_STRING_LIMIT)
}

// Deterministic bounded discriminator: two independent 32-bit hashes
// (FNV-1a + DJB2) encoded as fixed 16 hex chars for long identities. It
// never exposes raw tail data beyond the already-stored truncated prefix;
// only the 64-bit combined hash of the full value is appended to the
// internal key. Stored sessionID/directory remain plain truncate() output.
// Two hashes materially reduce the demonstrated 32-bit collision class
// without claiming mathematical collision impossibility.
function hashFNV(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function hashDJB(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(hash, 33) + value.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function hashIdentity(value: string): string {
  return `${hashFNV(value)}${hashDJB(value)}`
}

function identityKey(value: string): string {
  if (value.length <= ABORT_STRING_LIMIT) return value
  return `${truncate(value)}#${hashIdentity(value)}`
}

function finiteStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  return undefined
}

function extractStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const root = value as Record<string, unknown>
  const direct = finiteStatus(root.status)
  if (direct !== undefined) return direct
  const response = root.response
  if (response && typeof response === "object") {
    const status = finiteStatus((response as Record<string, unknown>).status)
    if (status !== undefined) return status
  }
  // Generated SDK non-2xx wrapper puts HTTP status under Error.cause.status.
  // Read only that numeric field; never traverse or serialize cause.body.
  const cause = (value as { cause?: unknown }).cause
  if (cause && typeof cause === "object") {
    const status = finiteStatus((cause as Record<string, unknown>).status)
    if (status !== undefined) return status
  }
  return undefined
}

function extractData(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined
  const data = (value as Record<string, unknown>).data
  if (typeof data === "boolean") return data
  return undefined
}

function extractError(value: unknown): { message: string; status?: number } {
  const status = extractStatus(value)
  // Bound each part before concatenation so no unbounded intermediate string
  // is allocated; the final truncate keeps observable output bounded.
  if (value instanceof Error) {
    const name = truncate(typeof value.name === "string" && value.name.length > 0 ? value.name : "Error")
    const msg = truncate(
      typeof value.message === "string" && value.message.length > 0 ? value.message : "abort failed",
    )
    return { message: truncate(`${name}: ${msg}`), status }
  }
  if (typeof value === "string") return { message: truncate(value.length > 0 ? value : "abort failed"), status }
  // Safe representation only: never serialize arbitrary SDK payloads. Ignore
  // all object fields except string name/message, plus numeric status above.
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>
    const name = truncate(typeof rec.name === "string" && rec.name.length > 0 ? rec.name : "Error")
    const msg = truncate(typeof rec.message === "string" && rec.message.length > 0 ? rec.message : "abort failed")
    return { message: truncate(`${name}: ${msg}`), status }
  }
  return { message: "abort failed", status }
}

// Parallel internal isolation keys: stored records keep plain truncate()
// output (externally readable, bounded), while counts/numbering use the
// discriminated identityKey so long common-prefix sessionIDs cannot collide.
// Both arrays are spliced together, preserving the retained-only contract.
const sessionKeys: string[] = []

function recordAttempt(entry: AbortAttemptRecord, key: string): void {
  if (!isE2EFixtureEnabled()) return
  attempts.push(entry)
  sessionKeys.push(key)
  if (attempts.length > ABORT_ATTEMPT_LIMIT) {
    const drop = attempts.length - ABORT_ATTEMPT_LIMIT
    attempts.splice(0, drop)
    sessionKeys.splice(0, drop)
  }
}

function retainedCount(sessionID: string): number {
  const key = identityKey(sessionID)
  let count = 0
  for (const entry of sessionKeys) {
    if (entry === key) count += 1
  }
  return count
}

function nextAttempt(sessionID: string): number {
  const key = identityKey(sessionID)
  let max = 0
  for (let i = 0; i < attempts.length; i++) {
    if (sessionKeys[i] === key && attempts[i]!.attempt > max) max = attempts[i]!.attempt
  }
  return max + 1
}

function requireFixture(name: string): void {
  if (!isE2EFixtureEnabled()) throw new Error(`fixture ${name} requires KILO_E2E_FIXTURE`)
}

export function fixtureAbortAttempts(): AbortAttemptRecord[] {
  requireFixture("abortAttempts")
  try {
    return JSON.parse(JSON.stringify(attempts)) as AbortAttemptRecord[]
  } catch {
    return [...attempts]
  }
}

export function fixtureAbortAttemptCount(sessionID?: string): number {
  requireFixture("abortAttemptCount")
  if (sessionID === undefined) return attempts.length
  return retainedCount(sessionID)
}

export function fixtureAbortAttemptsReset(): boolean {
  requireFixture("abortAttemptsReset")
  attempts.length = 0
  sessionKeys.length = 0
  return true
}

export class SessionAbort {
  private active = new Map<string, Set<string>>()

  observe(sessionID: string, status: SessionStatus["type"], dir?: string) {
    if (!dir) return
    const dirs = this.active.get(sessionID)
    if (status === "idle") {
      if (!dirs) return
      for (const entry of dirs) {
        if (sameDirectory(entry, dir)) dirs.delete(entry)
      }
      if (dirs.size === 0) this.active.delete(sessionID)
      return
    }
    if (!dirs) {
      this.active.set(sessionID, new Set([dir]))
      return
    }
    if (![...dirs].some((entry) => sameDirectory(entry, dir))) dirs.add(dir)
  }

  async stop(client: KiloClient, sessionID: string, fallback: string) {
    const known = this.active.has(sessionID)
    const dirs = [...(this.active.get(sessionID) ?? [])]
    if (!dirs.some((dir) => sameDirectory(dir, fallback))) dirs.push(fallback)
    const results = await Promise.allSettled(dirs.map((dir) => abortSession({ client, sessionID, dir })))
    const failures = results.flatMap((result, index) =>
      result.status === "rejected" ? [{ dir: dirs[index], error: result.reason }] : [],
    )
    if (failures.length > 0) {
      console.error("[Kilo New] KiloProvider: Failed to abort session in one or more directories:", failures)
      return false
    }
    if (known) this.active.delete(sessionID)
    return known
  }

  dispose(dir: string) {
    const idle: string[] = []
    for (const [sessionID, dirs] of this.active) {
      for (const entry of dirs) {
        if (sameDirectory(entry, dir)) dirs.delete(entry)
      }
      if (dirs.size > 0) continue
      this.active.delete(sessionID)
      idle.push(sessionID)
    }
    return idle
  }

  delete(sessionID: string) {
    this.active.delete(sessionID)
  }

  clear() {
    this.active.clear()
  }
}

export async function abortSession(input: { client: KiloClient; sessionID: string; dir: string }) {
  const startedAt = Date.now()
  try {
    const result = await input.client.session.abort(
      { sessionID: input.sessionID, directory: input.dir },
      { throwOnError: true },
    )
    if (isE2EFixtureEnabled()) {
      const endedAt = Date.now()
      recordAttempt(
        {
          sessionID: truncate(input.sessionID),
          directory: truncate(input.dir),
          startedAt,
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          ok: true,
          attempt: nextAttempt(input.sessionID),
          status: extractStatus(result),
          data: extractData(result),
        },
        identityKey(input.sessionID),
      )
    }
  } catch (err) {
    if (isE2EFixtureEnabled()) {
      const endedAt = Date.now()
      const info = extractError(err)
      const entry: AbortAttemptRecord = {
        sessionID: truncate(input.sessionID),
        directory: truncate(input.dir),
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        ok: false,
        attempt: nextAttempt(input.sessionID),
        error: info.message,
      }
      if (info.status !== undefined) entry.status = info.status
      recordAttempt(entry, identityKey(input.sessionID))
    }
    throw err
  }
}
