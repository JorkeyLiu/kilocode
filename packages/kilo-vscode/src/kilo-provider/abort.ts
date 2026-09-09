import type { KiloClient, SessionStatus } from "@kilocode/sdk/v2/client"
import * as crypto from "crypto"
import { sameDirectory } from "../kilo-provider-utils"
import { isE2EFixtureEnabled } from "../util/e2e-fixture"
import { canonicalAbortOpId, validateAbortContractRequest } from "../services/cli-backend/serve-private-abort-contract"
import type { AbortContractRequest } from "../services/cli-backend/serve-private-abort-contract"
import { validateAbortResult } from "../services/cli-backend/serve-private-peer"
import type { KiloConnectionService } from "../services/cli-backend"

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

  async stop(client: KiloClient, sessionID: string, dir: string, connection?: KiloConnectionService) {
    if (connection) {
      const ok = await abortSessionPrivateFirst({ client, connection, sessionID, directory: dir })
      if (ok) this.active.delete(sessionID)
      return ok
    }
    await abortSession({ client, sessionID, dir })
    return false
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

export function buildAbortIdentity(sessionId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = canonicalAbortOpId(sessionId, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

function withPrivateTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function abortTerminal(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; terminal: boolean }
  err.code = code
  err.terminal = true
  return err
}

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

type FallbackInput = { client: KiloClient; sessionID: string; directory: string }

async function fallback(input: FallbackInput): Promise<boolean> {
  await abortSession({ client: input.client, sessionID: input.sessionID, dir: input.directory })
  return true
}

function buildReq(sessionID: string, directory: string): AbortContractRequest {
  const { opId, idempotencyKey, requestId } = buildAbortIdentity(sessionID)
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "session/abort" as const,
    idempotencyKey,
    context: { directory, sessionId: sessionID },
    payload: {} as Record<string, never>,
  }
}

function valid(req: AbortContractRequest): boolean {
  try {
    validateAbortContractRequest(req)
    return true
  } catch {
    return false
  }
}

type Acquired = { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false }

function acquire(connection: KiloConnectionService, req: AbortContractRequest): Acquired {
  try {
    const factory = (
      connection as unknown as {
        privateAbortWithHandle?: (r: AbortContractRequest) => Handle
      }
    ).privateAbortWithHandle?.bind(connection) ?? null
    if (!factory) {
      const promise = (connection as unknown as { privateAbort: (r: unknown) => Promise<unknown> }).privateAbort(req)
      return { ok: true, handle: null, promise }
    }
    const got = factory(req)
    return { ok: true, handle: got, promise: got.promise }
  } catch {
    return { ok: false }
  }
}

function expired(handle: Handle | null, opId: string): void {
  if (!handle?.cancel) return
  try {
    handle.cancel(`private parity timeout opId=${opId}`)
  } catch (err) {
    console.warn("[Kilo Abort] private timeout cancel failed:", String(err).slice(0, 200), { opId })
  }
}

function failureOf(result: unknown): { code: string; message: string } {
  const failure = (result as { failure?: { code?: unknown; message?: unknown } }).failure
  const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
  const message = typeof failure?.message === "string" && failure.message ? failure.message : code
  return { code, message }
}

async function settle(input: FallbackInput & { req: AbortContractRequest; result: unknown }): Promise<boolean> {
  const kind = (input.result as { kind?: unknown }).kind
  if (kind !== "terminal" && kind !== "terminal-failure") return fallback(input)
  try {
    validateAbortResult(input.result, input.req)
  } catch {
    return fallback(input)
  }
  if (kind === "terminal") return true
  const { code, message } = failureOf(input.result)
  throw abortTerminal(code, message)
}

// Private-first abort: single-directory `session/abort` returning only after
// runtime terminal convergence. Valid `terminal` returns with zero SDK;
// `terminal-failure` with retryable false (session.not_found/scope_mismatch)
// closes terminally with zero SDK; unavailable/invalid/ambiguous/transport/
// timeout takes exactly one legacy SDK `session.abort` fallback, never retried.
export async function abortSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  sessionID: string
  directory: string
}): Promise<boolean> {
  const { client, connection, sessionID, directory } = opts
  const req = buildReq(sessionID, directory)
  const input: FallbackInput = { client, sessionID, directory }
  if (!valid(req)) return fallback(input)
  if (!connection.isPrivateAvailable()) return fallback(input)
  const acq = acquire(connection, req)
  if (!acq.ok) return fallback(input)
  let result: unknown
  try {
    result = await withPrivateTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return fallback(input)
  }
  return settle({ ...input, req, result })
}
