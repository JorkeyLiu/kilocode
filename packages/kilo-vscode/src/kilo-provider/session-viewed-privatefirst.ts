import * as crypto from "crypto"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import { sessionViewedHandle } from "../services/cli-backend/serve-private-session-viewed-connection"
import {
  isSessionViewedValidationError,
  validateSessionViewedResult,
} from "../services/cli-backend/serve-private-session-viewed-contract"
import type { SessionViewedContractRequest } from "../services/cli-backend/serve-private-session-viewed-contract"

/**
 * Private-first `session/viewed` presence write (process-global idempotent
 * full-snapshot to the canonical `KiloViewers.Service.update` owner).
 *
 * One private attempt plus at most one same-snapshot SDK fallback per logical
 * emission, never retried and never a second private request. Valid private
 * `succeeded`+`accepted` is authoritative with zero SDK; validated terminal
 * `failed` (`retryable === false`) closes with zero SDK;
 * unavailable/capability-missing/invalid/ambiguous/transport/closed/timeout/
 * retryable takes exactly one SDK `client.session.viewed` fallback with the
 * exact same frozen snapshot bytes (same viewer id, sequence, active,
 * attached order/content, visible order/content). The server monotonic
 * sequence makes an ambiguous repeat harmless with no TTL refresh.
 *
 * Request identity is `requestId` only; there is no `opId`/`idempotencyKey`
 * on this op so no second semantic identity can be created. The sequence is
 * allocated once per logical emission before dispatch and the snapshot
 * arrays are frozen so private and fallback cannot diverge.
 */

export interface SessionViewedSnapshot {
  viewer: { id: string; active: boolean; sequence: number }
  attached: readonly string[]
  visible: readonly string[]
}

export interface SessionViewedPrivateConnection {
  isPrivateAvailable(): boolean
  getPrivatePeer?: () => ServePrivatePeer | null
  getPrivateEpoch?: () => number | null
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateSessionViewedOutcomeWithHandle?: (req: SessionViewedContractRequest) => {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export function buildSessionViewedReq(dir: string, snap: SessionViewedSnapshot, workspace?: string): SessionViewedContractRequest {
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    op: "session/viewed" as const,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: {
      viewer: { id: snap.viewer.id, active: snap.viewer.active, sequence: snap.viewer.sequence },
      attached: [...snap.attached],
      visible: [...snap.visible],
    },
  }
}

export function freezeSnapshot(snap: SessionViewedSnapshot): SessionViewedSnapshot {
  return {
    viewer: Object.freeze({ ...snap.viewer }),
    attached: Object.freeze([...snap.attached]),
    visible: Object.freeze([...snap.visible]),
  }
}

export type SessionViewedAttempt =
  | { kind: "ok" }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseSessionViewedResult(result: unknown, req: SessionViewedContractRequest): SessionViewedAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateSessionViewedResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateSessionViewedResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private session-viewed timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function ownerDeps(conn: SessionViewedPrivateConnection): {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
} | null {
  const typed = conn as unknown as {
    getPrivatePeer?: () => ServePrivatePeer | null
    getPrivateEpoch?: () => number | null
    invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  }
  if (typeof typed.getPrivatePeer !== "function" || typeof typed.getPrivateEpoch !== "function") return null
  const peer = typed.getPrivatePeer()
  const epoch = typed.getPrivateEpoch() ?? null
  const invalidate = (reason: string) => typed.invalidatePrivatePeerOnObserverTimeout?.(reason)
  return { peer, live: true, epoch, invalidate }
}

export async function attemptSessionViewedPrivate(
  connection: SessionViewedPrivateConnection | null | undefined,
  req: SessionViewedContractRequest,
  ms = 3000,
): Promise<SessionViewedAttempt> {
  const conn = connection
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    const direct = conn.privateSessionViewedOutcomeWithHandle?.bind(conn) ?? null
    if (direct) {
      handle = direct(req)
    } else {
      const deps = ownerDeps(conn)
      if (!deps || !deps.peer) return { kind: "fallback", reason: "missing-capability" }
      handle = sessionViewedHandle(
        { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
        req,
      )
    }
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseSessionViewedResult(outcome.result, req)
  } catch (e) {
    if (isSessionViewedValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private session-viewed timeout") && handle) {
      try {
        handle.cancel?.(`private session-viewed timeout requestId=${req.requestId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  session: {
    viewed: (body: { viewer: { id: string; active: boolean; sequence: number }; attached: string[]; visible: string[] }) => Promise<unknown>
  }
}

export type SessionViewedPrivateFirstOutcome =
  | { kind: "ok"; via: "private" | "sdk" }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable" }

// Shared private-first viewed emission: the caller allocates `sequence` once
// and freezes `snap` before dispatch; this helper reuses the exact same
// snapshot bytes across the one private attempt and the at-most-one SDK
// fallback. No retry, no second private request.
export async function sendViewedPrivateFirst(opts: {
  connection?: SessionViewedPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
  workspace?: string
  snap: SessionViewedSnapshot
}): Promise<SessionViewedPrivateFirstOutcome> {
  const req = buildSessionViewedReq(opts.directory, opts.snap, opts.workspace)
  const attempt = await attemptSessionViewedPrivate(opts.connection ?? null, req)
  if (attempt.kind === "ok") return { kind: "ok", via: "private" }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.client
  if (!client?.session?.viewed) return { kind: "unavailable" }
  try {
    await client.session.viewed({
      viewer: { id: opts.snap.viewer.id, active: opts.snap.viewer.active, sequence: opts.snap.viewer.sequence },
      attached: [...opts.snap.attached],
      visible: [...opts.snap.visible],
    })
    return { kind: "ok", via: "sdk" }
  } catch {
    return { kind: "unavailable" }
  }
}

// Connection-service owned emission helpers (kept here so the service file
// stays under its line cap; the service remains the sole owner of debounce,
// singleflight/trailing, sequence allocation, and disposal ordering).
export function collectViewedSnapshot(
  viewerId: string,
  active: boolean,
  seq: number,
  attached: Map<string, Set<string>>,
  visible: Map<string, Set<string>>,
): SessionViewedSnapshot {
  const seen = new Set<string>()
  for (const ids of visible.values()) for (const id of ids) seen.add(id)
  const union = new Set<string>(seen)
  for (const ids of attached.values()) for (const id of ids) union.add(id)
  return freezeSnapshot({ viewer: { id: viewerId, active, sequence: seq }, attached: [...union], visible: [...seen] })
}

export async function emitViewedOnce(input: {
  connection: SessionViewedPrivateConnection | null | undefined
  client: SdkClient | null | undefined
  directory?: string
  snap: SessionViewedSnapshot
}): Promise<void> {
  if (input.directory) {
    const out = await sendViewedPrivateFirst({ connection: input.connection, client: input.client, directory: input.directory, snap: input.snap })
    if (out.kind === "unavailable") console.warn("[Kilo New] ConnectionService: viewed flush failed: unavailable")
    return
  }
  try {
    await input.client?.session.viewed({
      viewer: { ...input.snap.viewer },
      attached: [...input.snap.attached],
      visible: [...input.snap.visible],
    })
  } catch (err) {
    console.warn("[Kilo New] ConnectionService: viewed flush failed:", err)
  }
}

// Best-effort dispose detach: one frozen higher-sequence empty snapshot
// (`active:false`, empty attached/visible, next sequence allocated once by the
// caller). Bounded and fail-soft: one private attempt with the existing 3 s
// timeout/exact-cancel plus at most one same-snapshot SDK fallback, never
// retried, no new owner, no unbounded wait. The caller awaits this before
// peer teardown so teardown happens only after the detach settles or falls
// back; no delivery after process death is claimed.
export async function emitDisposeDetach(input: {
  viewerId: string
  seq: number
  directory?: string
  peer: ServePrivatePeer | null
  live: boolean
  client: SdkClient | null | undefined
}): Promise<SessionViewedSnapshot> {
  const snap = freezeSnapshot({ viewer: { id: input.viewerId, active: false, sequence: input.seq }, attached: [], visible: [] })
  try {
    if (input.directory) {
      const peer = input.peer
      const live = input.live
      const connection =
        peer === null
          ? null
          : {
              isPrivateAvailable: () => {
                try {
                  return live && peer.isAvailable()
                } catch {
                  return false
                }
              },
              privateSessionViewedOutcomeWithHandle: (r: SessionViewedContractRequest) =>
                (
                  peer as unknown as {
                    privateSessionViewedOutcomeWithHandle: (
                      r: SessionViewedContractRequest,
                    ) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" }
                  }
                ).privateSessionViewedOutcomeWithHandle(r),
            }
      await sendViewedPrivateFirst({ connection: connection as never, client: input.client, directory: input.directory, snap })
    } else if (input.client?.session?.viewed) {
      try {
        await input.client.session.viewed({ viewer: { ...snap.viewer }, attached: [], visible: [] })
      } catch {}
    }
  } catch {}
  return snap
}
