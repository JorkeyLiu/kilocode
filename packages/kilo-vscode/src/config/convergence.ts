/**
 * Canonical GUI disk-write convergence adapter (first unit) plus external
 * canonical config observe hints (second unit).
 *
 * CanonicalConfigService-controlled GUI writes acquire a CLI runtime fence
 * first (`config/convergence/acquire`) and best-effort resolve after
 * (`config/convergence/resolve`). The runtime re-reads disk and decides
 * noop/hot/cold — the client outcome/hash is never trusted. Acquire failure
 * blocks the write (zero bytes persisted, zero secret side-effects). Resolve
 * loss never rewrites files and never falls back to SDK: the write stays
 * persisted with a structured `runtime convergence pending` diagnostic and the
 * backend auto-resolves after a bounded grace. MarketplaceInstaller canonical
 * config writes use the same fence through the activation-owned adapter and
 * fail closed without one (no mutation, no resolve). Intentionally unfenced:
 * agent/skill markdown/asset file writes, legacy mcp.json/mcp_settings.json
 * cleanup, and external watcher edits.
 *
 * External canonical config edits (VS Code watcher, not own writes) are
 * observed via a descriptor-only private hint (`config/convergence/observe`)
 * after successful local materialization. The hint always requests fail-safe
 * cold convergence (no hot/noop, no baseline); hint failure leaves local
 * state intact with a pending diagnostic and never rewrites disk. Asset
 * watcher events never send observe hints.
 */

export type ConvergenceDescriptor =
  | { readonly kind: "config"; readonly scope: "global" }
  | { readonly kind: "config"; readonly scope: "project"; readonly directory: string }
  | {
      readonly kind: "asset"
      readonly asset: "agent" | "command" | "skill" | "tool" | "plugin" | "rules"
      readonly scope: "global" | "project"
      readonly directory?: string
      readonly id: string
    }

export type ConvergenceState =
  | { readonly status: "converged"; readonly outcome: "noop" | "hot" | "cold" }
  | { readonly status: "pending"; readonly message: string }

export type AcquireResult =
  | { readonly ok: true; readonly leaseId: string }
  | { readonly ok: false; readonly kind: "unavailable" | "rejected" | "resolved"; readonly message: string }

export interface ConfigConvergenceAdapter {
  acquire(descriptors: readonly ConvergenceDescriptor[]): Promise<AcquireResult>
  resolve(leaseId: string): Promise<ConvergenceState>
  observe?(descriptors: readonly ConvergenceDescriptor[]): Promise<ConvergenceState>
}

export interface ConvergencePeer {
  request(method: string, params: unknown): Promise<unknown>
  hasCapability?(cap: string): boolean
  getEpoch?(): number
}

function token(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `gui-${Date.now().toString(36)}-${rand}`
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isValidScope(v: unknown): v is "global" | { readonly directory: string } {
  if (v === "global") return true
  if (!isRecord(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === "directory" && typeof v.directory === "string" && v.directory.length > 0
}

function isValidOutcome(v: unknown): v is "noop" | "hot" | "cold" | "failed" {
  return v === "noop" || v === "hot" || v === "cold" || v === "failed"
}

/**
 * Pure acquire-wire parser shared by the adapter and tests (F3/F-05). Strict
 * fail-closed validation: v, leaseId, kind/outcome, scope and required fields
 * must match exactly; unknown fields are rejected. A resolved replay
 * (including failed) never returns fresh-acquired so the caller never
 * executes a write. Malformed/mismatch fails closed as unavailable.
 */
export function parseAcquireResponse(raw: unknown, leaseId: string): AcquireResult {
  if (!isRecord(raw)) return { ok: false, kind: "unavailable", message: "acquire response malformed; write blocked" }
  if (raw.v !== 1) return { ok: false, kind: "unavailable", message: "acquire response version mismatch; write blocked" }
  if (raw.leaseId !== leaseId)
    return { ok: false, kind: "unavailable", message: "acquire response lease mismatch; write blocked" }
  if (raw.resolved === true) {
    const allowed = new Set(["v", "leaseId", "resolved", "outcome", "scope", "reason", "retryable"])
    for (const k of Object.keys(raw))
      if (!allowed.has(k)) return { ok: false, kind: "unavailable", message: "acquire response unknown field; write blocked" }
    if (!isValidOutcome(raw.outcome) || !isValidScope(raw.scope))
      return { ok: false, kind: "unavailable", message: "acquire response malformed; write blocked" }
    if (raw.outcome === "failed") {
      if (typeof raw.reason !== "string" || typeof raw.retryable !== "boolean")
        return { ok: false, kind: "unavailable", message: "acquire response malformed; write blocked" }
      return { ok: false, kind: "resolved", message: `lease already resolved (failed); write blocked` }
    }
    if (raw.reason !== undefined || raw.retryable !== undefined)
      return { ok: false, kind: "unavailable", message: "acquire response unknown field; write blocked" }
    return { ok: false, kind: "resolved", message: `lease already resolved (${String(raw.outcome)}); write blocked` }
  }
  if (raw.acquired === true) {
    const allowed = new Set(["v", "leaseId", "acquired"])
    for (const k of Object.keys(raw))
      if (!allowed.has(k)) return { ok: false, kind: "unavailable", message: "acquire response unknown field; write blocked" }
    return { ok: true, leaseId }
  }
  return { ok: false, kind: "unavailable", message: "acquire not granted; write blocked" }
}

/**
 * Pure resolve-wire parser (F-05/F-06). Strict fail-closed validation of
 * v/leaseId/outcome/scope (+reason/retryable for failed); unknown fields are
 * rejected. noop/hot/cold converge; failed and malformed resolve to a
 * persisted `pending` diagnostic — the write stays on disk, never rewritten,
 * and the backend auto-converges from disk.
 */
export function parseResolveResponse(raw: unknown, leaseId: string): ConvergenceState {
  if (!isRecord(raw)) return { status: "pending", message: "resolve response malformed; runtime convergence pending" }
  if (raw.v !== 1) return { status: "pending", message: "resolve response version mismatch; runtime convergence pending" }
  if (raw.leaseId !== leaseId)
    return { status: "pending", message: "resolve response lease mismatch; runtime convergence pending" }
  const outcome = raw.outcome
  if (!isValidOutcome(outcome) || !isValidScope(raw.scope))
    return { status: "pending", message: "resolve response ambiguous; runtime convergence pending" }
  if (outcome === "failed") {
    const allowed = new Set(["v", "leaseId", "outcome", "scope", "reason", "retryable"])
    for (const k of Object.keys(raw))
      if (!allowed.has(k)) return { status: "pending", message: "resolve response unknown field; runtime convergence pending" }
    if (typeof raw.reason !== "string")
      return { status: "pending", message: "resolve response ambiguous; runtime convergence pending" }
    return { status: "pending", message: `runtime convergence failed (${raw.reason}); write persisted` }
  }
  const allowed = new Set(["v", "leaseId", "outcome", "scope"])
  for (const k of Object.keys(raw))
    if (!allowed.has(k)) return { status: "pending", message: "resolve response unknown field; runtime convergence pending" }
  if (outcome === "noop" || outcome === "hot" || outcome === "cold") return { status: "converged", outcome }
  return { status: "pending", message: "resolve response ambiguous; runtime convergence pending" }
}

/**
 * Pure observe-wire parser. Strict fail-closed validation of
 * v/observeId/outcome/scope (+reason/retryable for failed); unknown fields
 * are rejected. Only `cold` converges; `failed` and malformed resolve to a
 * persisted `pending` diagnostic — local materialization stays intact, never
 * rewritten, no SDK fallback. `noop`/`hot` are never produced by the server
 * and are treated as ambiguous pending (no false ready claim).
 */
export function parseObserveResponse(raw: unknown, observeId: string): ConvergenceState {
  if (!isRecord(raw)) return { status: "pending", message: "observe response malformed; runtime convergence pending" }
  if (raw.v !== 1) return { status: "pending", message: "observe response version mismatch; runtime convergence pending" }
  if (raw.observeId !== observeId)
    return { status: "pending", message: "observe response id mismatch; runtime convergence pending" }
  const outcome = raw.outcome
  if (!isValidOutcome(outcome) || !isValidScope(raw.scope))
    return { status: "pending", message: "observe response ambiguous; runtime convergence pending" }
  if (outcome === "failed") {
    const allowed = new Set(["v", "observeId", "outcome", "scope", "reason", "retryable"])
    for (const k of Object.keys(raw))
      if (!allowed.has(k)) return { status: "pending", message: "observe response unknown field; runtime convergence pending" }
    if (typeof raw.reason !== "string")
      return { status: "pending", message: "observe response ambiguous; runtime convergence pending" }
    return { status: "pending", message: `runtime convergence failed (${raw.reason}); local state intact` }
  }
  const allowed = new Set(["v", "observeId", "outcome", "scope"])
  for (const k of Object.keys(raw))
    if (!allowed.has(k)) return { status: "pending", message: "observe response unknown field; runtime convergence pending" }
  if (outcome === "cold") return { status: "converged", outcome }
  return { status: "pending", message: "observe response ambiguous; runtime convergence pending" }
}

/**
 * Production private-transport adapter. Capability/epoch checked fail-closed
 * at acquire time with exact epoch pinning. Resolve uses the peer captured
 * at acquire — never the current replacement: a new runtime only yields
 * pending (its peer-close auto-resolve converges from disk), never fallback,
 * never rewrite (F11).
 */
export class PrivateConvergenceAdapter implements ConfigConvergenceAdapter {
  private readonly peer: () => ConvergencePeer | null
  private readonly timeoutMs: number
  private peerByLease = new Map<string, ConvergencePeer>()
  private epochByLease = new Map<string, number | undefined>()

  constructor(peer: () => ConvergencePeer | null, timeoutMs = 5000) {
    this.peer = peer
    this.timeoutMs = timeoutMs
  }

  private current(): ConvergencePeer | null {
    try {
      return this.peer()
    } catch {
      return null
    }
  }

  async acquire(descriptors: readonly ConvergenceDescriptor[]): Promise<AcquireResult> {
    const peer = this.current()
    if (!peer) return { ok: false, kind: "unavailable", message: "private transport unavailable; write blocked" }
    try {
      if (typeof peer.hasCapability === "function") {
        const hasAcquire = peer.hasCapability("config/convergence/acquire")
        const hasResolve = peer.hasCapability("config/convergence/resolve")
        if (!hasAcquire || !hasResolve)
          return { ok: false, kind: "unavailable", message: "runtime convergence capability missing; write blocked" }
      }
    } catch {
      return { ok: false, kind: "unavailable", message: "capability negotiation failed; write blocked" }
    }
    const id = token()
    const params = {
      v: 1,
      leaseId: id,
      opId: id,
      requestId: id,
      idempotencyKey: id,
      descriptors: [...descriptors],
    }
    try {
      const raw = await withTimeout(peer.request("config/convergence/acquire", params), this.timeoutMs, "acquire timed out")
      const parsed = parseAcquireResponse(raw, id)
      if (!parsed.ok) return parsed
      let epoch: number | undefined
      try {
        epoch = typeof peer.getEpoch === "function" ? peer.getEpoch() : undefined
      } catch {
        epoch = undefined
      }
      // Capture the exact peer for resolve (F11): replacements never serve
      // this lease.
      this.peerByLease.set(id, peer)
      this.epochByLease.set(id, epoch)
      return { ok: true, leaseId: id }
    } catch (err) {
      return { ok: false, kind: "unavailable", message: `convergence acquire failed: ${String(err)}` }
    }
  }

  async resolve(leaseId: string): Promise<ConvergenceState> {
    const captured = this.peerByLease.get(leaseId)
    const finish = (): void => {
      this.peerByLease.delete(leaseId)
      this.epochByLease.delete(leaseId)
    }
    if (!captured) return { status: "pending", message: "unknown lease peer after persist; runtime convergence pending" }
    try {
      // Epoch replacement: the new runtime owns new leases only. Never send
      // this lease to the replacement; its peer-close auto-resolve converges.
      const pinned = this.epochByLease.get(leaseId)
      let now: ConvergencePeer | null = null
      try {
        now = this.current()
      } catch {
        now = null
      }
      const nowEpoch = (() => {
        try {
          return now && typeof now.getEpoch === "function" ? now.getEpoch() : undefined
        } catch {
          return undefined
        }
      })()
      if (pinned !== undefined && nowEpoch !== undefined && pinned !== nowEpoch) {
        finish()
        return { status: "pending", message: "epoch changed after persist; runtime convergence pending" }
      }
      if (now !== null && now !== captured) {
        finish()
        return { status: "pending", message: "runtime replaced after persist; runtime convergence pending" }
      }
    } catch {
      finish()
      return { status: "pending", message: "epoch check failed after persist; runtime convergence pending" }
    }
    const params = { v: 1, leaseId, opId: leaseId, requestId: leaseId, idempotencyKey: leaseId }
    try {
      // Captured peer only — never the current replacement (F11). Strict
      // wire validation (F-05); failed terminals surface as persisted pending
      // diagnostics without rewrite (F-06).
      const raw = await withTimeout(
        captured.request("config/convergence/resolve", params),
        this.timeoutMs,
        "resolve timed out",
      )
      return parseResolveResponse(raw, leaseId)
    } catch {
      return { status: "pending", message: "resolve unreachable after persist; runtime convergence pending" }
    } finally {
      finish()
    }
  }

  /**
   * External observe hint: descriptor-only, no SDK fallback. Config
   * descriptors only; asset descriptors are rejected locally without a
   * transport call. Every call sends one hint — burst bounding lives in the
   * per-scope trailing-edge coalescer (`external-observe.ts`), so the latest
   * edit is never dropped here. Failure/unavailable returns pending with
   * local materialization intact and no rewrite.
   */
  async observe(descriptors: readonly ConvergenceDescriptor[]): Promise<ConvergenceState> {
    for (const d of descriptors) {
      if (d.kind !== "config") return { status: "pending", message: "asset observe not supported; local state intact" }
    }
    if (descriptors.length === 0) return { status: "pending", message: "observe requires descriptors; local state intact" }
    return this.observeOnce(descriptors)
  }

  private async observeOnce(descriptors: readonly ConvergenceDescriptor[]): Promise<ConvergenceState> {
    const peer = this.current()
    if (!peer) return { status: "pending", message: "private transport unavailable; runtime convergence pending" }
    try {
      if (typeof peer.hasCapability === "function") {
        if (!peer.hasCapability("config/convergence/observe"))
          return { status: "pending", message: "runtime observe capability missing; runtime convergence pending" }
      }
    } catch {
      return { status: "pending", message: "capability negotiation failed; runtime convergence pending" }
    }
    const id = token().replace("gui-", "obs-")
    const params = {
      v: 1,
      observeId: id,
      opId: id,
      requestId: id,
      idempotencyKey: id,
      descriptors: [...descriptors],
    }
    try {
      const raw = await withTimeout(peer.request("config/convergence/observe", params), this.timeoutMs, "observe timed out")
      return parseObserveResponse(raw, id)
    } catch {
      return { status: "pending", message: "observe unreachable; runtime convergence pending" }
    }
  }
}

/** Explicit test fake: records acquire-before-write and resolve-finally ordering. */
export class FakeConvergenceAdapter implements ConfigConvergenceAdapter {
  readonly acquires: ConvergenceDescriptor[][] = []
  readonly resolves: string[] = []
  readonly observes: ConvergenceDescriptor[][] = []
  writes = 0
  acquireResult: AcquireResult = { ok: true, leaseId: "fake-lease" }
  resolveResult: ConvergenceState = { status: "converged", outcome: "cold" }
  observeResult: ConvergenceState = { status: "converged", outcome: "cold" }
  resolveThrows = false
  observeThrows = false

  async acquire(descriptors: readonly ConvergenceDescriptor[]): Promise<AcquireResult> {
    this.acquires.push([...descriptors])
    if (this.acquireResult.ok) return { ok: true, leaseId: this.acquireResult.leaseId }
    return this.acquireResult
  }

  async resolve(leaseId: string): Promise<ConvergenceState> {
    this.resolves.push(leaseId)
    if (this.resolveThrows) throw new Error("fake resolve transport loss")
    return this.resolveResult
  }

  async observe(descriptors: readonly ConvergenceDescriptor[]): Promise<ConvergenceState> {
    this.observes.push([...descriptors])
    if (this.observeThrows) throw new Error("fake observe transport loss")
    return this.observeResult
  }

  markWrite(): void {
    this.writes += 1
  }
}
