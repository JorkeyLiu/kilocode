// kilocode_change - new file
/**
 * Private serve realtime event transport (CLI -> host `event/notify`).
 *
 * Closed forwarder from the in-process `GlobalBus` to the single installed
 * private peer. It is the only `GlobalBus.on("event")` listener owned by the
 * canonical `AppLayer`; the `/global/event` SSE handler keeps its own
 * per-stream listener for other dev clients and is unchanged.
 *
 * Guarantees:
 * - No monkey-patch of `GlobalBus.emit` and no per-producer migration.
 * - Non-blocking producer path: the bus callback only validates, enqueues,
 *   and schedules an async drain. It never throws and never awaits.
 * - Bounded FIFO: at most `MAX_QUEUE` envelopes are retained in observed
 *   order. On overflow the oldest entry is dropped so the newest survives;
 *   dropped frames are never authoritative — consumers rebuild via existing
 *   readable authorities (session/get, messages, status, lists).
 * - Strict envelope validation preserves `directory`/`transaction`/payload
 *   and drops oversize or malformed frames. `observation/changed` never
 *   flows through this path (separate reverse method, separate validator).
 * - Synthetic `server.connected`/`server.heartbeat` are HTTP SSE concerns
 *   and are never forwarded; the extension synthesizes an equivalent
 *   connection-state trigger from private peer readiness.
 * - Transport notification is not a fact owner: `Unavailable`/`Unsupported`
 *   (uninitialized, unnegotiated, unoffered, closed) drops the failed
 *   epoch's queued frames with a throttled warn (no per-event storm), so a
 *   replacement peer never replays stale frames out of order. Bounded
 *   consecutive *real* write faults (negotiated + offered yet notify
 *   reports `Unavailable`) additionally invalidate the exact peer via the
 *   registry, so the extension observes close/EOF (`onClosed` → SSE
 *   fallback) instead of a half-open FD silently dropping frames.
 *   Pre-negotiation/uninitialized/`Unsupported` failures never invalidate,
 *   so early `GlobalBus` events during startup cannot kill the handshake.
 *   The extension peer-close path still owns the private→SSE fallback;
 *   this layer adds no new coordination channel.
 */

import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Effect, Layer } from "effect"
import { Service as PrivatePeerService } from "./private-peer-registry"
import { EVENT_NOTIFY_REVERSE_CAPABILITY } from "./fd-carrier-protocol"

export const EVENT_NOTIFY_METHOD = EVENT_NOTIFY_REVERSE_CAPABILITY
export const MAX_QUEUE = 256
export const MAX_ENVELOPE_BYTES = 256 * 1024
export const MAX_STRING_FIELD = 1024
/** Bounded failure-signal throttle: at most one warn per window, no per-event storm. */
export const NOTIFY_WARN_THROTTLE_MS = 5_000
/**
 * Bounded half-open guard: consecutive real write faults (negotiated and
 * offered, yet notify fails `Unavailable`) before the exact peer is
 * invalidated. Tolerates single-frame jitter without unbounded drops.
 */
export const NOTIFY_INVALIDATE_AFTER = 3

const SKIP_TYPES = new Set(["server.connected", "server.heartbeat"])

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

const isBoundedString = (v: unknown, max = MAX_STRING_FIELD): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0")

export interface PrivateEventEnvelope {
  readonly directory?: string
  readonly project?: string
  readonly workspace?: string
  readonly transaction?: string
  readonly payload: Record<string, unknown> & { type: string }
}

/**
 * Strict envelope validation. Returns a trimmed copy or null when the frame
 * must be dropped. Never throws.
 */
export function toEnvelope(event: unknown): PrivateEventEnvelope | null {
  try {
    if (!isPlainRecord(event)) return null
    const allowed = new Set(["directory", "project", "workspace", "transaction", "payload"])
    for (const k of Object.keys(event)) if (!allowed.has(k)) return null
    const out: Record<string, unknown> = {}
    if (event.directory !== undefined) {
      if (!isBoundedString(event.directory)) return null
      out.directory = event.directory
    }
    if (event.project !== undefined) {
      if (!isBoundedString(event.project)) return null
      out.project = event.project
    }
    if (event.workspace !== undefined) {
      if (!isBoundedString(event.workspace)) return null
      out.workspace = event.workspace
    }
    if (event.transaction !== undefined) {
      if (!isBoundedString(event.transaction)) return null
      out.transaction = event.transaction
    }
    const payload = event.payload
    if (!isPlainRecord(payload)) return null
    if (typeof payload.type !== "string" || payload.type.length === 0 || payload.type.length > 256) return null
    if (payload.type.includes("\0")) return null
    if (SKIP_TYPES.has(payload.type)) return null
    // Keep payload by reference; size gate below prevents oversize frames.
    // `observation/changed` is a distinct reverse method and never appears as
    // a GlobalBus payload type; no special-case needed beyond strict typing.
    out.payload = payload as PrivateEventEnvelope["payload"]
    const envelope = out as unknown as PrivateEventEnvelope
    let size = 0
    try {
      size = JSON.stringify(envelope)?.length ?? 0
    } catch {
      return null
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_ENVELOPE_BYTES) return null
    return envelope
  } catch {
    return null
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const peer = yield* PrivatePeerService
    let queue: PrivateEventEnvelope[] = []
    let scheduled = false
    let flushing = false
    let closed = false

    let failures = 0
    let lastWarnAt = 0
    let realFailures = 0
    let invalidated = false
    const isReady = (): boolean => {
      try {
        return Effect.runSync(peer.supports(EVENT_NOTIFY_METHOD))
      } catch {
        return false
      }
    }
    const tryNotify = (params: unknown): { ok: true } | { ok: false; tag: string } => {
      try {
        Effect.runSync(peer.notify(EVENT_NOTIFY_METHOD, params).pipe(Effect.asVoid))
        return { ok: true }
      } catch (e) {
        const tag = (e as { _tag?: unknown })?._tag
        return { ok: false, tag: typeof tag === "string" ? tag : "Unknown" }
      }
    }
    const tryInvalidate = (): void => {
      try {
        Effect.runSync(peer.invalidate().pipe(Effect.asVoid))
      } catch {}
    }
    const warnThrottled = (dropped: number, failuresSeen: number): void => {
      const now = Date.now()
      if (failuresSeen !== 1 && now - lastWarnAt < NOTIFY_WARN_THROTTLE_MS) return
      lastWarnAt = now
      try {
        console.warn(
          `[kilo private-event-forwarder] notify failed (${failuresSeen} consecutive), dropped ${dropped} frame(s); consumers rebuild via readable authorities`,
        )
      } catch {}
    }

    const drain = (): void => {
      scheduled = false
      if (flushing || closed) return
      flushing = true
      try {
        // Synchronous FIFO: one ordered notify attempt per frame. A failed
        // attempt means the peer cannot deliver this epoch (uninstalled,
        // unnegotiated, unoffered, closed): drop the failed epoch's queued
        // frames so a later peer never replays stale frames out of order
        // over readable authorities. Success resets the failure streak.
        // Readiness is sampled before the attempt: a negotiated peer whose
        // notify then fails `Unavailable` is a real write fault and counts
        // toward bounded exact-peer invalidation; anything not ready (or
        // `Unsupported`) only drops.
        while (queue.length > 0) {
          if (closed) {
            queue = []
            return
          }
          const next = queue[0]!
          const params = {
            directory: next.directory,
            project: next.project,
            workspace: next.workspace,
            transaction: next.transaction,
            payload: next.payload,
          }
          const readyBefore = isReady()
          const out = tryNotify(params)
          if (out.ok) {
            queue.shift()
            failures = 0
            realFailures = 0
            invalidated = false
            continue
          }
          failures += 1
          if (out.tag === "PrivatePeerUnsupported" || !readyBefore) {
            // Pre-negotiation, uninitialized, or unoffered: never a reason
            // to kill the peer (startup EventBus bursts included).
            realFailures = 0
          } else if (!invalidated) {
            realFailures += 1
            if (realFailures >= NOTIFY_INVALIDATE_AFTER) {
              invalidated = true
              realFailures = 0
              tryInvalidate()
              try {
                console.warn(
                  `[kilo private-event-forwarder] notify failed (${failures} consecutive), exact peer invalidated; extension falls back to SSE`,
                )
              } catch {}
            }
          }
          const dropped = queue.length
          queue = []
          warnThrottled(dropped, failures)
          return
        }
      } finally {
        flushing = false
        // A producer may have enqueued while flushing; schedule again.
        if (queue.length > 0 && !closed && !scheduled) {
          scheduled = true
          setImmediate(drain)
        }
      }
    }

    const schedule = (): void => {
      if (scheduled || closed) return
      scheduled = true
      setImmediate(drain)
    }

    const handler = (event: GlobalEvent): void => {
      try {
        if (closed) return
        const envelope = toEnvelope(event)
        if (!envelope) return
        if (queue.length >= MAX_QUEUE) queue.shift()
        queue.push(envelope)
        schedule()
      } catch {
        // Never break the producer.
      }
    }

    GlobalBus.on("event", handler)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
        try {
          GlobalBus.off("event", handler)
        } catch {}
        queue = []
        scheduled = false
      }),
    )
  }),
)

export const defaultLayer = layer
export * as PrivateEventForwarder from "./private-event-forwarder"
