/**
 * Fixture-only bounded SSE timeline observer (LOCK-049/050/051).
 *
 * Pure, vscode-free redaction + bounded store for the basic real-session Stop
 * flow. Records only metadata of events actually delivered to the client, in
 * raw arrival order: arrival sequence, client-observed timestamp, event
 * name/type, resolved sessionID when available, envelope directory and
 * transaction (bounded), and session status type when available. Never
 * serializes event payload/data/properties, titles, or paths beyond the
 * bounded directory field of the existing envelope. No SSE/server protocol
 * change: the fixture is fed from the existing `connectionService.onEvent`
 * listener path by fixture commands registered under KILO_E2E_FIXTURE.
 */

import type { SSEPayload } from "./sdk-sse-adapter"
import { resolveEventSessionId } from "./connection-utils"
import { isE2EFixtureEnabled } from "../../util/e2e-fixture"

export type { SSEPayload } from "./sdk-sse-adapter"

/** Durable snapshot schema for `sse-timeline-abort-A/B.json` artifacts. */
export const SSE_TIMELINE_SCHEMA = "kilo-sse-timeline/1"

/** Hard memory bound: at most this many entries are retained per window. */
export const SSE_TIMELINE_CAP = 200

/** Bound for every retained string field (kind/status/sessionID/directory/transaction). */
export const SSE_TIMELINE_STRING_LIMIT = 500

export interface SseTimelineEntry {
  seq: number
  at: string
  kind: string
  sessionID?: string
  directory?: string
  transaction?: string
  status?: string
}

export interface SseTimelineSnapshot {
  schema: typeof SSE_TIMELINE_SCHEMA
  startedAt: string | null
  stoppedAt: string | null
  observing: boolean
  cap: number
  count: number
  dropped: number
  truncated: boolean
  entries: SseTimelineEntry[]
}

function truncate(value: string): string {
  if (value.length <= SSE_TIMELINE_STRING_LIMIT) return value
  return value.slice(0, SSE_TIMELINE_STRING_LIMIT)
}

function present(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  return truncate(value)
}

/** Redacted event identity: `sync:<name>` for sync envelopes, else the type. */
export function sseTimelineKind(event: SSEPayload): string {
  if (event.type === "sync") return `sync:${event.name}`
  return event.type
}

/**
 * Redacted status discriminator, read only from the `session.status`
 * properties shape. Every other event kind (including `session.idle` and
 * `session.error`, whose error payload must never be serialized) yields
 * undefined — callers must not fall back to payload inspection.
 */
export function sseTimelineStatus(event: SSEPayload): string | undefined {
  if (event.type !== "session.status") return undefined
  const status = (event.properties as { status?: unknown }).status
  if (!status || typeof status !== "object") return undefined
  const kind = (status as { type?: unknown }).type
  return typeof kind === "string" ? kind : undefined
}

/** Bounded in-memory arrival-order store with explicit truncation metadata. */
export class SseTimelineStore {
  private entries: SseTimelineEntry[] = []
  private dropped = 0
  private seq = 0
  private startedAt: string | null = null

  start(at: string): void {
    this.entries = []
    this.dropped = 0
    this.seq = 0
    this.startedAt = at
  }

  reset(): void {
    this.entries = []
    this.dropped = 0
    this.seq = 0
    this.startedAt = null
  }

  /**
   * Record one delivered event. Returns the retained entry, or null when the
   * cap is reached (the arrival is counted in `dropped`, never synthesized).
   */
  record(
    event: SSEPayload,
    sessionID: string | undefined,
    directory: string | undefined,
    transaction: string | undefined,
    at: string,
  ): SseTimelineEntry | null {
    if (this.entries.length >= SSE_TIMELINE_CAP) {
      this.dropped += 1
      return null
    }
    const entry: SseTimelineEntry = { seq: this.seq, at, kind: truncate(sseTimelineKind(event)) }
    const id = present(sessionID)
    if (id !== undefined) entry.sessionID = id
    const dir = present(directory)
    if (dir !== undefined) entry.directory = dir
    const tx = present(transaction)
    if (tx !== undefined) entry.transaction = tx
    const status = present(sseTimelineStatus(event))
    if (status !== undefined) entry.status = status
    this.seq += 1
    this.entries.push(entry)
    return { ...entry }
  }

  snapshot(opts: { observing: boolean; stoppedAt: string | null }): SseTimelineSnapshot {
    return {
      schema: SSE_TIMELINE_SCHEMA,
      startedAt: this.startedAt,
      stoppedAt: opts.stoppedAt,
      observing: opts.observing,
      cap: SSE_TIMELINE_CAP,
      count: this.entries.length,
      dropped: this.dropped,
      truncated: this.dropped > 0,
      entries: this.entries.map((entry) => ({ ...entry })),
    }
  }
}

export type SseTimelineListener = (event: SSEPayload, directory?: string, transaction?: string) => void
export type SseTimelineSubscribe = (listener: SseTimelineListener) => () => void
export type SseTimelineResolve = (event: SSEPayload) => string | undefined

/**
 * Side-effect-free session identity for the timeline observer (LOCK-051).
 * Reuses the existing pure `resolveEventSessionId` normalization with a
 * read-only lookup that never hits connection-service state and with no
 * `onMessageUpdated` callback, so `sync:message.updated.1` can never write
 * the connection-service message map. Transient identities resolve from event
 * fields when the allowlist carries them; unavailable identities stay
 * undefined — the observer never synthesizes an identity.
 */
export function resolveTimelineSessionId(event: SSEPayload): string | undefined {
  return resolveEventSessionId(event, () => undefined)
}

function requireFixture(name: string): void {
  if (!isE2EFixtureEnabled()) throw new Error(`fixture ${name} requires KILO_E2E_FIXTURE`)
}

/**
 * Fixture-only lifecycle owner for one bounded timeline window. The host wires
 * the existing `connectionService.onEvent` subscribe path and the passive
 * `resolveTimelineSessionId` helper above (never the state-writing
 * `connectionService.resolveEventSessionId`); this class only owns the store and the
 * explicit start/stop/read/reset transitions. Stop/reset/dispose always
 * unsubscribe. Dispatch, filtering, and webview behavior are untouched: the
 * listener only reads delivered events into redacted metadata.
 */
export class SseTimelineFixture {
  private readonly store = new SseTimelineStore()
  private unsub: (() => void) | null = null

  start(subscribe: SseTimelineSubscribe, resolve: SseTimelineResolve): { startedAt: string; observing: boolean } {
    requireFixture("sseTimelineStart")
    this.unsub?.()
    const startedAt = new Date().toISOString()
    this.store.start(startedAt)
    this.unsub = subscribe((event, directory, transaction) => {
      this.store.record(event, resolve(event), directory, transaction, new Date().toISOString())
    })
    return { startedAt, observing: true }
  }

  stop(): SseTimelineSnapshot {
    requireFixture("sseTimelineStop")
    this.unsub?.()
    this.unsub = null
    return this.store.snapshot({ observing: false, stoppedAt: new Date().toISOString() })
  }

  read(): SseTimelineSnapshot {
    requireFixture("sseTimelineRead")
    return this.store.snapshot({ observing: this.unsub !== null, stoppedAt: null })
  }

  reset(): boolean {
    requireFixture("sseTimelineReset")
    this.unsub?.()
    this.unsub = null
    this.store.reset()
    return true
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
    this.store.reset()
  }
}
