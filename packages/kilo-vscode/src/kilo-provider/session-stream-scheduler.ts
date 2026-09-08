/**
 * Session-aware streaming scheduler.
 *
 * Sits between SSE events and the webview `postMessage` path. Coalesces
 * repeated `partUpdated` events for the same `(sessionID, messageID, partID)`
 * tuple, prioritizes the focused session, and throttles background sessions
 * so multi-agent streaming doesn't saturate the renderer main thread.
 *
 * Ordering contract: snapshot/live-stream precedence is deterministic per
 * `(sessionID, messageID, partID)` via scheduler-owned monotonic snapshot
 * tokens. `capture` synchronously flushes that session's queued state before
 * allocating an opaque occurrence token, so pre-token updates are delivered
 * and the live queue after capture holds only post-token updates.
 * Same-session captures are latest-wins (a newer capture supersedes any prior
 * active one, different sessions stay independent). Live delivery is never
 * suspended. Post-token keyed updates accumulate per capture against the
 * capture's own prior cumulative entry (independent of live-queue merging)
 * so real authoritative fulls stay replayable and bounds stay exact even
 * across an early lane flush. At `commit` the same session's current live
 * queue plus its derived map are taken before deletion, preserving keyed
 * pending entries that have not yet lane-flushed. `commit` consumes the
 * post-token live queue without emitting it to prevent duplicate delta
 * emission, then invokes the synchronous `before` callback (which posts the
 * snapshot) and replays once with delivered/pending semantics: real
 * no-delta source fulls replay their latest cumulative capture full after
 * the snapshot regardless of early flush (corrective replace); delta-derived
 * entries replay nothing when the snapshot contains the key (strict snapshot
 * wins); delta-derived entries replay only the currently pending live-queue
 * entry when the snapshot lacks the key, and nothing when no pending entry
 * remains because the webview already received it via the early flush
 * (older paginated local bases are preserved, no duplicate appends).
 * Pending entries emit at most once and no lane timer emits them afterward;
 * a pending synthetic full uses its live derived metadata for filtering but
 * keeps its update shape. Callback call-order is the guarantee, not delivery
 * acknowledgement. Captures are bounded (max keys, byte budget, and a finite
 * scheduler-owned expiry timer); overflow/expiry invalidates the capture
 * immediately and the provider fails closed via `commit` returning false.
 * The per-session latest attempt identity is retained across expiry/overflow
 * so callers can distinguish a latest expired token from a superseded old
 * token via `isLatestAttempt`. Lineage stays internal: a real no-delta
 * source full is authoritative; a full→delta merged synthetic result stays
 * delta-derived until a later real full supersedes it.
 *
 * See the tuning comment on the default constants below for rationale.
 */

import type { PartBatch, PartUpdate } from "../shared/stream-messages"
export type { PartBatch, PartUpdate } from "../shared/stream-messages"

export type StreamSchedulerStats = {
  received: number
  emitted: number
  batches: number
  active: number
  visible: number
  background: number
}

export type StreamSchedulerOptions = {
  /** Flush cadence for the focused/active session. Defaults to 16ms. */
  activeMs?: number
  /** Base background cadence. Defaults to 150ms. */
  backgroundBaseMs?: number
  /**
   * Additional ms per background session above the first 2 (adaptive throttle).
   * 10 background sessions → base + 8 * step. Defaults to 20ms.
   */
  backgroundStepMs?: number
  /** Hard cap for the background cadence. Defaults to 400ms. */
  backgroundMaxMs?: number
  /** Flush cadence for visible inline child sessions. Defaults to 50ms. */
  visibleMs?: number
  /**
   * Internal capture bounds (test tuning only, never user config). Defaults to
   * CAPTURE_MAX_KEYS / CAPTURE_MAX_BYTES / CAPTURE_TTL_MS below.
   */
  captureMaxKeys?: number
  /** Max retained merged text payload estimate per capture. */
  captureMaxBytes?: number
  /** Finite capture lifetime; expiry invalidates the capture. */
  captureTTLms?: number
}

// Scheduler tuning — rationale:
//
// These defaults balance perceived streaming smoothness against renderer pressure.
// The scheduler sits between SSE (dozens to hundreds of deltas per second per session)
// and the webview message loop, which applies updates through Solid `batch()` and
// triggers DOM / style / layout work on the renderer main thread.
//
// - DEFAULT_ACTIVE_MS = 16
//   One 60Hz animation frame. The focused session should feel indistinguishable
//   from immediate streaming, so we coalesce within a single paint window but no
//   longer. Raising this to 32ms visibly stutters live text; lowering below ~8ms
//   stops coalescing meaningfully because SSE delta arrival is already ~10-20ms
//   apart at typical model rates.
//
// - DEFAULT_BG_BASE_MS = 150
//   Background (non-focused) sessions don't need frame-perfect updates — the user
//   can't see their content. 150ms keeps tab-status signals (spinner motion,
//   token counts via related events) feeling alive while collapsing most
//   per-token deltas into a single batched emission. Under 100ms the coalescing
//   win shrinks; over ~250ms users start perceiving lag when switching tabs
//   mid-stream (though `focus()` also immediately flushes, so this is mostly a
//   concern for users watching tab-level indicators).
//
// - DEFAULT_BG_STEP_MS = 20
//   Per-extra-background-session backoff beyond the first 2. Each additional
//   streaming agent adds ~20ms to the background interval so total background
//   message throughput stays roughly flat as the agent count grows. Without this,
//   10 concurrent agents would put the same ~7 msg/sec pressure per-session on
//   the renderer as 1 agent does (~70 msg/sec total background).
//
// - DEFAULT_BG_MAX_MS = 400
//   Ceiling for the adaptive backoff. Even with 20+ agents streaming we never
//   stall background emissions longer than 400ms, which keeps tab indicators
//   recognizably "live" and keeps the `drop()`-on-delete path timely. Above
//   ~500ms the UI starts feeling disconnected; below 300ms the many-agent
//   backoff stops providing meaningful throttling.
const DEFAULT_ACTIVE_MS = 16
const DEFAULT_VISIBLE_MS = 50
const DEFAULT_BG_BASE_MS = 150
const DEFAULT_BG_STEP_MS = 20
const DEFAULT_BG_MAX_MS = 400

// Capture bounds — rationale:
//
// Message loads hold a capture open across one fetch: paged loads (80
// messages) typically resolve in ~100ms–2s, full-history child-sync reads in
// ~1–5s, with a ~10s tail under contention or cold worker start. The fetch
// itself never extends capture lifetime; the scheduler-owned TTL below is the
// only owner, so a hung fetch cannot pin memory.
//
// - CAPTURE_MAX_KEYS = 200: distinct (message,part) keys updated mid-load.
//   Normal streaming touches 1–2 live parts; 200 is ~100x headroom while
//   bounding per-capture map growth. Coalescing stays per key.
// - CAPTURE_MAX_BYTES = 512KiB retained complete update payload estimate per
//   capture (deterministic JSON/UTF-8 size of each retained merged update,
//   measured once per new entry). ~200 keys × ~2.5KB average streaming text;
//   prevents a pathological tool-output stream from pinning megabytes across
//   a slow load.
// - CAPTURE_TTL_MS = 30000: ~3x the tail load duration. Long enough that a
//   healthy load never expires mid-flight; short enough that an orphaned
//   capture (fetch hung, provider never committed) frees without waiting for
//   fetch settlement.
//
// On overflow or expiry the capture is invalidated immediately (deleted +
// timer cleared). The provider uses `commit` as the authoritative validation
// and fails closed without a snapshot that lacks complete replay.
const CAPTURE_MAX_KEYS = 200
const CAPTURE_MAX_BYTES = 524288
const CAPTURE_TTL_MS = 30000

function partField(part: unknown, key: string): unknown {
  if (!part || typeof part !== "object") return undefined
  return (part as Record<string, unknown>)[key]
}

function appendPart(part: unknown, text: string): unknown {
  if (!part || typeof part !== "object") return part
  const item = part as Record<string, unknown>
  if ((item.type !== "text" && item.type !== "reasoning") || typeof item.text !== "string") return part
  return { ...item, text: item.text + text }
}

function partUpdateKey(msg: PartUpdate): string | undefined {
  const id = partField(msg.part, "id")
  const mid = msg.messageID || partField(msg.part, "messageID")
  if (typeof id !== "string" || !id) return undefined
  if (typeof mid !== "string" || !mid) return undefined
  return `${msg.sessionID}:${mid}:${id}`
}

/**
 * Snapshot key grammar shared with the provider drain predicate.
 *
 * Scheduler queue keys are session-scoped (`session:message:part`); snapshot
 * membership compares only the `(messageID, partID)` suffix so a fetched page
 * can veto ambiguous deltas without importing SDK message types.
 */
export function snapshotPartKey(messageID: string, partID: string): string {
  return `${messageID}:${partID}`
}

/** Extract the `(messageID, partID)` snapshot key for a queued update, if keyable. */
export function updateSnapshotKey(msg: PartUpdate): string | undefined {
  const id = partField(msg.part, "id")
  const mid = msg.messageID || partField(msg.part, "messageID")
  if (typeof id !== "string" || !id) return undefined
  if (typeof mid !== "string" || !mid) return undefined
  return snapshotPartKey(mid, id)
}

function hasDeltaText(msg: PartUpdate): boolean {
  return typeof msg.delta?.textDelta === "string" && msg.delta.textDelta.length > 0
}

function mergePartUpdate(prev: PartUpdate | undefined, msg: PartUpdate): PartUpdate {
  if (!prev) return msg
  const text = msg.delta?.textDelta
  if (!text) return msg.delta ? prev : msg
  if (!prev.delta) return { ...prev, part: appendPart(prev.part, text) }
  return {
    ...prev,
    part: appendPart(prev.part, text),
    delta: { type: "text-delta", textDelta: `${prev.delta.textDelta}${text}` },
  }
}

type CaptureEntry = {
  update: PartUpdate
  derived: boolean
  skey: string | undefined
  size: number
}

type CaptureState = {
  entries: Map<string, CaptureEntry>
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
}

function measureUpdateSize(update: PartUpdate): number | undefined {
  try {
    const json = JSON.stringify(update)
    if (typeof json !== "string") return undefined
    const Encoder = globalThis.TextEncoder
    if (typeof Encoder === "undefined") return undefined
    return new Encoder().encode(json).length
  } catch {
    return undefined
  }
}

function captureLineage(
  prevEntry: CaptureEntry | undefined,
  capPrev: PartUpdate | undefined,
  msg: PartUpdate,
): boolean {
  if (!capPrev) return !!msg.delta
  if (hasDeltaText(msg)) return true
  if (msg.delta) return prevEntry?.derived ?? !!capPrev.delta
  return false
}

export class SessionStreamScheduler {
  private active: string | undefined
  private atimer: ReturnType<typeof setTimeout> | null = null
  private vtimer: ReturnType<typeof setTimeout> | null = null
  private btimer: ReturnType<typeof setTimeout> | null = null
  private bgFirstQueuedAt = 0
  private visibleFirstQueuedAt = 0
  private readonly queues = new Map<string, Map<string, PartUpdate>>()
  /** Per-key lineage for queued entries: true = delta-derived synthetic, false = real full. */
  private readonly derived = new Map<string, Map<string, boolean>>()
  /**
   * Post-token capture history: session -> token -> bounded capture state.
   * Same-session captures are latest-wins: at most one active token per
   * session; `capture` flushes pre-token queue state then supersedes
   * (discards + clears timer) any prior active capture for that session.
   * Different sessions stay independent. Populated on every post-token keyed
   * push from the merged queue value so `commit` can replay post-token state
   * once after consuming the live queue. Non-keyable updates bypass the queue
   * (immediate emit in `push`) and are outside the capture/replay guarantee;
   * the production part mapper always emits IDs.
   */
  private readonly captures = new Map<string, Map<number, CaptureState>>()
  /**
   * Latest capture attempt per session, retained even when its capture
   * expires/overflows. `capture` advances it; `drop`/`dispose` clear it.
   * Commit/discard/expiry never touch it so a latest expired token stays
   * distinguishable from a superseded old token.
   */
  private readonly latest = new Map<string, number>()
  /** Scheduler-owned monotonic sequence. Every keyed push and every capture advances it. */
  private seq = 0
  private readonly visible = new Set<string>()
  private readonly activeMs: number
  private readonly visibleMs: number
  private readonly bgBase: number
  private readonly bgStep: number
  private readonly bgMax: number
  private readonly capKeys: number
  private readonly capBytes: number
  private readonly capTTL: number
  private readonly counters: StreamSchedulerStats = {
    received: 0,
    emitted: 0,
    batches: 0,
    active: 0,
    visible: 0,
    background: 0,
  }

  constructor(
    private readonly send: (msg: PartUpdate | PartBatch) => void,
    opts?: StreamSchedulerOptions,
  ) {
    this.activeMs = opts?.activeMs ?? DEFAULT_ACTIVE_MS
    this.visibleMs = opts?.visibleMs ?? DEFAULT_VISIBLE_MS
    this.bgBase = opts?.backgroundBaseMs ?? DEFAULT_BG_BASE_MS
    this.bgStep = opts?.backgroundStepMs ?? DEFAULT_BG_STEP_MS
    this.bgMax = opts?.backgroundMaxMs ?? DEFAULT_BG_MAX_MS
    this.capKeys = opts?.captureMaxKeys ?? CAPTURE_MAX_KEYS
    this.capBytes = opts?.captureMaxBytes ?? CAPTURE_MAX_BYTES
    this.capTTL = opts?.captureTTLms ?? CAPTURE_TTL_MS
  }

  focus(sessionID?: string): void {
    if (this.active === sessionID) return
    const prev = this.active
    if (this.atimer) {
      clearTimeout(this.atimer)
      this.atimer = null
    }
    this.active = sessionID
    if (prev && this.queues.get(prev)?.size) this.schedule(prev)
    if (sessionID) this.flush(sessionID)
  }

  /** Currently focused (active-lane) session ID, if any. */
  get focused(): string | undefined {
    return this.active
  }

  setVisible(sessionID: string, visible: boolean): void {
    const changed = visible ? !this.visible.has(sessionID) : this.visible.has(sessionID)
    if (!changed) return
    if (visible) this.visible.add(sessionID)
    else this.visible.delete(sessionID)
    if (this.queues.get(sessionID)?.size) this.schedule(sessionID)
    if (this.vtimer && !this.hasVisible()) {
      clearTimeout(this.vtimer)
      this.vtimer = null
    }
    if (this.btimer && !this.hasBackground()) {
      clearTimeout(this.btimer)
      this.btimer = null
    }
  }

  /**
   * Acquire an opaque monotonic occurrence token for a session. Synchronously
   * flushes that session's queued updates first so all pre-token state is
   * delivered and the live queue after capture holds only post-token updates.
   * Other-session lane queues and timers are preserved. Must be called before
   * the message fetch; every later keyed push is logically after the token.
   * Never uses wall-clock time. Same-session latest-wins: supersedes
   * (discards + clears timer) any prior active capture for the session so an
   * old fetch can never replay after a newer capture. Different sessions stay
   * independent. Starts the finite scheduler-owned expiry timer; expiry
   * invalidates the capture without waiting for fetch settlement.
   */
  capture(sessionID: string): number {
    this.flush(sessionID)
    this.seq += 1
    const token = this.seq
    let bySid = this.captures.get(sessionID)
    if (!bySid) {
      bySid = new Map()
      this.captures.set(sessionID, bySid)
    } else {
      for (const [, old] of bySid) this.clearCaptureTimer(old)
      bySid.clear()
    }
    const state: CaptureState = { entries: new Map(), bytes: 0, timer: null }
    bySid.set(token, state)
    this.latest.set(sessionID, token)
    if (this.capTTL > 0) {
      state.timer = setTimeout(() => this.expire(sessionID, token), this.capTTL)
      const t = state.timer as unknown as { unref?: () => void }
      if (typeof t.unref === "function") t.unref()
    }
    return token
  }

  /**
   * Atomically validate `token`, post the snapshot via `before`, and replay
   * once with delivered/pending semantics. Algorithm: if `token` is unknown,
   * superseded, expired, or overflowed, return false without invoking `before`
   * and without touching the current token's capture or queue. Otherwise
   * remove and clear the capture plus its TTL ownership first, take the same
   * session's current live queue plus its derived map before deleting them
   * without emitting (preserving keyed pending entries that have not yet
   * lane-flushed and preventing duplicate delta emission), clear only the
   * relevant lane timer state safely, invoke the synchronous `before`
   * callback (the provider posts `sessionUpdated`/`messagesLoaded` inside, in
   * required order), then emit once per capture key: real no-delta source
   * fulls (`derived=false`) replay the latest cumulative capture full after
   * the snapshot regardless of early flush; delta-derived entries replay
   * nothing when the snapshot contains the key; delta-derived entries replay
   * only the currently pending live-queue entry when the snapshot lacks the
   * key (nothing when already flushed, since the webview already has it). A
   * pending synthetic full is filtered by its live derived metadata but keeps
   * its update shape. Pending entries emit at most once and no lane timer
   * emits them afterward. If `before` throws, no replay is emitted and the
   * error is rethrown with state already released. `before` call-order is the
   * guarantee, not delivery acknowledgement.
   */
  commit(sessionID: string, token: number, snapshot: Set<string> | undefined, before: () => void): boolean {
    const bySid = this.captures.get(sessionID)
    const cap = bySid?.get(token)
    if (!cap) return false
    this.clearCaptureTimer(cap)
    bySid!.delete(token)
    if (bySid!.size === 0) this.captures.delete(sessionID)
    const live = this.queues.get(sessionID)
    const pending = live ? new Map(live) : new Map<string, PartUpdate>()
    this.queues.delete(sessionID)
    this.derived.delete(sessionID)
    if (this.active === sessionID && this.atimer) {
      clearTimeout(this.atimer)
      this.atimer = null
    }
    if (this.vtimer && !this.hasVisible()) {
      clearTimeout(this.vtimer)
      this.vtimer = null
    }
    if (this.btimer && !this.hasBackground()) {
      clearTimeout(this.btimer)
      this.btimer = null
    }
    before()
    const keep: PartUpdate[] = []
    for (const [key, entry] of cap.entries) {
      if (!entry.derived) {
        keep.push(entry.update)
        continue
      }
      if (snapshot && entry.skey && snapshot.has(entry.skey)) continue
      const livePending = pending.get(key)
      if (livePending) keep.push(livePending)
    }
    this.emit(keep)
    return true
  }

  /** Discard `token` for a session without replaying (stale/abort/error). Clears its timer. */
  discard(sessionID: string, token: number): void {
    const bySid = this.captures.get(sessionID)
    const cap = bySid?.get(token)
    if (!cap) return
    this.clearCaptureTimer(cap)
    bySid!.delete(token)
    if (bySid!.size === 0) this.captures.delete(sessionID)
  }

  /**
   * Whether `token` is the latest capture attempt for the session, even when
   * its capture already expired/overflowed. Never touches newer state.
   */
  isLatestAttempt(sessionID: string, token: number): boolean {
    return this.latest.get(sessionID) === token
  }

  private expire(sessionID: string, token: number): void {
    const bySid = this.captures.get(sessionID)
    const cap = bySid?.get(token)
    if (!cap) return
    this.clearCaptureTimer(cap)
    bySid!.delete(token)
    if (bySid!.size === 0) this.captures.delete(sessionID)
  }

  private invalidate(sessionID: string, token: number): void {
    this.expire(sessionID, token)
  }

  private clearCaptureTimer(cap: CaptureState): void {
    if (cap.timer) {
      clearTimeout(cap.timer)
      cap.timer = null
    }
  }

  push(msg: PartUpdate): void {
    this.counters.received++
    const key = partUpdateKey(msg)
    if (!key) {
      // Non-keyable updates can't be merged. Flush pending first to preserve order.
      this.flush(msg.sessionID)
      this.emitOne(msg)
      return
    }

    // Monotonic receipt sequence; never wall-clock. Capture tokens advance the
    // same sequence so a capture sorts strictly between earlier and later pushes.
    this.seq += 1
    const queue = this.ensureQueue(msg.sessionID)
    const prev = queue.get(key)
    const merged = mergePartUpdate(prev, msg)
    let lineage: boolean
    if (!prev) {
      lineage = !!msg.delta
    } else if (hasDeltaText(msg)) {
      // Delta after anything (full or delta) stays delta-derived. A full→delta
      // synthetic result carries no wire delta but retains delta lineage until
      // a later real full supersedes it.
      lineage = true
    } else if (msg.delta) {
      // Degenerate delta without payload: keep previous content and lineage.
      lineage = this.ensureDerived(msg.sessionID).get(key) ?? !!prev.delta
    } else {
      // Real no-delta source full is authoritative and supersedes lineage.
      lineage = false
    }
    // Degenerate delta without payload keeps the previous merged value.
    const next = !prev || hasDeltaText(msg) || !msg.delta ? merged : prev
    queue.set(key, next)
    this.ensureDerived(msg.sessionID).set(key, lineage)
    this.schedule(msg.sessionID)
    this.trackCapture(msg.sessionID, key, msg)
  }

  /**
   * Accumulate `msg` into every active capture for the session against that
   * capture's own prior cumulative entry, independent of live-queue merging
   * so real authoritative fulls stay correctively replayable and byte
   * replacement accounting stays exact across an early lane flush (which
   * clears the live queue but leaves captures). Delta-derived replay does
   * not use this cumulative text: snapshot-absent deltas replay only the
   * unflushed pending live-queue entry while already flushed deltas stay in
   * the projection. Lineage and byte replacement accounting likewise derive
   * from the capture predecessor.
   */
  private trackCapture(sid: string, key: string, msg: PartUpdate): void {
    const bySid = this.captures.get(sid)
    if (!bySid) return
    for (const [token, cap] of [...bySid]) this.trackOneCapture(sid, key, msg, token, cap)
  }

  private trackOneCapture(sid: string, key: string, msg: PartUpdate, token: number, cap: CaptureState): void {
    const prevEntry = cap.entries.get(key)
    const capPrev = prevEntry?.update
    const capMerged = mergePartUpdate(capPrev, msg)
    const capLineage = captureLineage(prevEntry, capPrev, msg)
    const capNext = !capPrev || hasDeltaText(msg) || !msg.delta ? capMerged : capPrev
    if (capNext === capPrev) return
    const prevSize = prevEntry ? prevEntry.size : 0
    const nextSize = measureUpdateSize(capNext)
    if (nextSize === undefined) {
      // Unmeasurable payload fails closed: invalidate immediately (freed now,
      // never held until fetch settlement). The provider's `commit` then
      // returns false without a snapshot lacking complete replay.
      this.invalidate(sid, token)
      return
    }
    const grownBytes = cap.bytes - prevSize + nextSize
    const grownKeys = prevEntry ? cap.entries.size : cap.entries.size + 1
    if (grownKeys > this.capKeys || grownBytes > this.capBytes) {
      // Bound the capture: overflow invalidates immediately (freed now,
      // never held until fetch settlement). The provider's `commit`
      // check then fails closed without a snapshot lacking complete replay.
      this.invalidate(sid, token)
      return
    }
    cap.bytes = grownBytes
    cap.entries.set(key, { update: capNext, derived: capLineage, skey: updateSnapshotKey(capNext), size: nextSize })
  }

  flush(sessionID?: string): void {
    if (!sessionID) {
      this.clearTimers()
      this.emit(this.takeAll())
      return
    }

    if (this.active === sessionID && this.atimer) {
      clearTimeout(this.atimer)
      this.atimer = null
    }

    this.emit(this.take(sessionID))

    if (this.vtimer && !this.hasVisible()) {
      clearTimeout(this.vtimer)
      this.vtimer = null
    }

    if (this.btimer && !this.hasBackground()) {
      clearTimeout(this.btimer)
      this.btimer = null
    }
  }

  /**
   * Discard any queued updates and captures for a session without emitting them.
   *
   * Called when a session is deleted. Does NOT alter focus
   * state — callers that also want to clear focus should call `focus(undefined)`
   * themselves. A pending active-lane timer is left to fire harmlessly
   * (`take()` returns `[]` for the emptied queue).
   *
   * Note: non-keyable updates bypass the queue (immediate emit in `push`),
   * so they are outside the capture/replay guarantee for keyed production
   * updates. The production part mapper always emits IDs.
   */
  drop(sessionID: string): void {
    this.queues.delete(sessionID)
    this.derived.delete(sessionID)
    this.latest.delete(sessionID)
    const bySid = this.captures.get(sessionID)
    if (bySid) {
      for (const [, cap] of bySid) this.clearCaptureTimer(cap)
      this.captures.delete(sessionID)
    }
    if (this.vtimer && !this.hasVisible()) {
      clearTimeout(this.vtimer)
      this.vtimer = null
    }
    if (this.btimer && !this.hasBackground()) {
      clearTimeout(this.btimer)
      this.btimer = null
    }
  }

  dispose(): void {
    this.clearTimers()
    this.queues.clear()
    this.derived.clear()
    for (const [, bySid] of this.captures) for (const [, cap] of bySid) this.clearCaptureTimer(cap)
    this.captures.clear()
    this.latest.clear()
    this.visible.clear()
  }

  stats(): Readonly<StreamSchedulerStats> {
    return this.counters
  }

  private ensureQueue(sid: string): Map<string, PartUpdate> {
    const existing = this.queues.get(sid)
    if (existing) return existing
    const queue = new Map<string, PartUpdate>()
    this.queues.set(sid, queue)
    return queue
  }

  private ensureDerived(sid: string): Map<string, boolean> {
    const existing = this.derived.get(sid)
    if (existing) return existing
    const map = new Map<string, boolean>()
    this.derived.set(sid, map)
    return map
  }

  private schedule(sessionID: string): void {
    if (!this.queues.get(sessionID)?.size) return
    if (this.active === sessionID) {
      if (this.atimer) return
      this.atimer = setTimeout(() => this.flushActive(), this.activeMs)
      return
    }
    if (this.visible.has(sessionID)) {
      this.scheduleVisible()
      return
    }
    this.scheduleBackground()
  }

  private scheduleVisible(): void {
    if (!this.hasVisible()) return
    const now = Date.now()
    if (!this.vtimer) this.visibleFirstQueuedAt = now
    const elapsed = now - this.visibleFirstQueuedAt
    const remaining = Math.max(0, this.visibleMs - elapsed)
    if (this.vtimer) clearTimeout(this.vtimer)
    this.vtimer = setTimeout(() => this.flushVisible(), remaining)
  }

  private scheduleBackground(): void {
    const count = this.backgroundCount()
    if (count === 0) return
    const now = Date.now()
    if (!this.btimer) this.bgFirstQueuedAt = now
    const elapsed = now - this.bgFirstQueuedAt
    const extra = Math.max(0, count - 2) * this.bgStep
    const target = Math.min(this.bgMax, this.bgBase + extra)
    // Never defer past backgroundMaxMs from when the first update landed.
    // Each push can extend the timer up to that hard cap as the session count grows.
    const remaining = Math.max(0, Math.min(target - elapsed, this.bgMax - elapsed))
    if (this.btimer) clearTimeout(this.btimer)
    this.btimer = setTimeout(() => this.flushBackground(), remaining)
  }

  private flushActive(): void {
    this.atimer = null
    if (this.active) this.emit(this.take(this.active))
  }

  private flushBackground(): void {
    this.btimer = null
    this.bgFirstQueuedAt = 0
    this.emit(this.takeBackground())
  }

  private flushVisible(): void {
    this.vtimer = null
    this.visibleFirstQueuedAt = 0
    this.emit(this.takeVisible())
  }

  private take(sessionID: string): PartUpdate[] {
    const queue = this.queues.get(sessionID)
    if (!queue) return []
    this.queues.delete(sessionID)
    this.derived.delete(sessionID)
    return [...queue.values()]
  }

  private takeAll(): PartUpdate[] {
    const updates = [...this.queues.values()].flatMap((queue) => [...queue.values()])
    this.queues.clear()
    this.derived.clear()
    return updates
  }

  private takeBackground(): PartUpdate[] {
    const updates: PartUpdate[] = []
    for (const [sid, queue] of this.queues) {
      if (sid === this.active) continue
      if (this.visible.has(sid)) continue
      updates.push(...queue.values())
      this.queues.delete(sid)
      this.derived.delete(sid)
    }
    return updates
  }

  private takeVisible(): PartUpdate[] {
    const updates: PartUpdate[] = []
    for (const [sid, queue] of this.queues) {
      if (sid === this.active || !this.visible.has(sid)) continue
      updates.push(...queue.values())
      this.queues.delete(sid)
      this.derived.delete(sid)
    }
    return updates
  }

  private visibleCount(): number {
    let n = 0
    for (const [sid, queue] of this.queues) {
      if (sid !== this.active && this.visible.has(sid) && queue.size > 0) n++
    }
    return n
  }

  private backgroundCount(): number {
    let n = 0
    for (const [sid, queue] of this.queues) {
      if (sid !== this.active && !this.visible.has(sid) && queue.size > 0) n++
    }
    return n
  }

  private hasVisible(): boolean {
    return this.visibleCount() > 0
  }

  private hasBackground(): boolean {
    return this.backgroundCount() > 0
  }

  private emit(updates: PartUpdate[]): void {
    if (updates.length === 0) return
    if (updates.length === 1) {
      this.emitOne(updates[0]!)
      return
    }
    this.counters.emitted += updates.length
    this.counters.batches++
    this.countLane(updates[0]!.sessionID)
    this.send({ type: "partsUpdated", updates })
  }

  private emitOne(msg: PartUpdate): void {
    this.counters.emitted++
    this.counters.batches++
    this.countLane(msg.sessionID)
    this.send(msg)
  }

  private countLane(sessionID: string): void {
    if (sessionID === this.active) this.counters.active++
    else if (this.visible.has(sessionID)) this.counters.visible++
    else this.counters.background++
  }

  private clearTimers(): void {
    if (this.atimer) clearTimeout(this.atimer)
    this.atimer = null
    if (this.vtimer) clearTimeout(this.vtimer)
    this.vtimer = null
    if (this.btimer) clearTimeout(this.btimer)
    this.btimer = null
  }
}
