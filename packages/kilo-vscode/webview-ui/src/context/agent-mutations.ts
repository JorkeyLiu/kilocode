/**
 * Canonical agent mutation coordinator (pure, vscode-free, Solid-free).
 *
 * Single ownership for file-backed custom agent writes:
 * - Every mutation carries requestId/owner(action)/name and settles ONLY on
 *   the matching agentMutationApplied/Error with the same requestId.
 *   Unrelated request events never clear another mutation's pending state.
 * - Same-agent edits serialize. A later edit is built AFTER the prior
 *   Applied, using the returned stamp.assetHash plus the latest synthesized
 *   frontmatter/body (optimistic draft), never a stale prebuilt payload.
 * - Rapid typing coalesces: scheduleEdit merges patches into a per-agent
 *   draft and debounces the send; the UI shows its local draft immediately.
 * - Different agents are independent; same-name create/import races are
 *   resolved by the server CAS.
 * - An inflight host error settles the ENTIRE queued batch of that chain
 *   with the same structured error: no replay, no new send, pending
 *   cleared; the draft is retained for an explicit retry. Late Applied/Error
 *   for a settled requestId settles nothing.
 * - dispose() cancels local waits (settles them as cancelled) without
 *   resending already-accepted operations.
 */

import { isUnsafeKey } from "../../../src/shared/agent-credentials"

export type AgentMutationAction = "create" | "edit" | "import"

export interface AgentMutationInput {
  action: AgentMutationAction
  name: string
  frontmatter: Record<string, unknown>
  body: string
}

export interface AgentMutationIdentity {
  scope: "global" | "project"
  assetHash: string
  native?: boolean
  frontmatter?: Record<string, unknown>
  body?: string
}

export interface AgentMutationStamp {
  readonly globalHash: string | null
  readonly projectHash: string | null
  readonly materializationVersion: number
  assetHash: string | null
}

export interface AgentMutationWire {
  action: AgentMutationAction
  name: string
  frontmatter: Record<string, unknown>
  body: string
  scope: "global" | "project"
  expectedHash: string
  stamp: AgentMutationStamp
  requestId: string
}

export type AgentMutationResult =
  | { ok: true; requestId: string; name: string; action: AgentMutationAction; contentHash: string }
  | { ok: false; requestId: string | undefined; name: string; action: AgentMutationAction; kind: string; message: string }

export interface AgentMutationCoordinatorOptions {
  post: (msg: AgentMutationWire) => void
  getStamp: () => AgentMutationStamp | undefined
  getIdentity: (name: string) => AgentMutationIdentity | undefined
  exists: (name: string) => boolean
  makeId?: () => string
  editDelay?: number
  schedule?: (fn: () => void, delay: number) => () => void
  onSend?: (info: { requestId: string; name: string; action: AgentMutationAction }) => void
  onSettle?: (info: { requestId: string; name: string; action: AgentMutationAction; ok: boolean }) => void
}

interface Waiter {
  action: AgentMutationAction
  name: string
  resolve: (r: AgentMutationResult) => void
}

interface EditChain {
  inflight: { requestId: string; sentFrontmatter: Record<string, unknown>; sentBody: string } | null
  chainBase: string | undefined
  draftFrontmatter: Record<string, unknown> | undefined
  draftBody: string | undefined
  draftDirty: boolean
  // Keys (and body) with unsent local changes. A full-snapshot submit
  // synthesizes per key: dirty keys keep the draft, all other input keys
  // apply — so pending typing is never silently dropped by a concurrent
  // full submit, while genuinely new keys still land.
  dirtyKeys: Set<string>
  bodyDirty: boolean
  batch: Array<(r: AgentMutationResult) => void>
  timer: (() => void) | undefined
  cancelTimer: (() => void) | undefined
}

let counter = 0

export function createAgentMutationCoordinator(opts: AgentMutationCoordinatorOptions) {
  const makeId = opts.makeId ?? (() => `agent-mut-${Date.now()}-${(counter += 1)}`)
  const delay = opts.editDelay ?? 350
  const schedule = opts.schedule ?? ((fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  })
  const waiters = new Map<string, Waiter & { extra: Array<(r: AgentMutationResult) => void> }>()
  const chains = new Map<string, EditChain>()
  let disposed = false

  const chainFor = (name: string): EditChain => {
    const found = chains.get(name)
    if (found) return found
    const fresh: EditChain = {
      inflight: null,
      chainBase: undefined,
      draftFrontmatter: undefined,
      draftBody: undefined,
      draftDirty: false,
      dirtyKeys: new Set<string>(),
      bodyDirty: false,
      batch: [],
      timer: undefined,
      cancelTimer: undefined,
    }
    chains.set(name, fresh)
    return fresh
  }

  const fail = (
    name: string,
    action: AgentMutationAction,
    kind: string,
    message: string,
  ): Promise<AgentMutationResult> => Promise.resolve({ ok: false, requestId: undefined, name, action, kind, message })

  const currentHash = (name: string, chain: EditChain): string | undefined => {
    if (chain.chainBase !== undefined) return chain.chainBase
    return opts.getIdentity(name)?.assetHash
  }

  const ensureDraft = (name: string, chain: EditChain): void => {
    if (chain.draftFrontmatter !== undefined) return
    const id = opts.getIdentity(name)
    chain.draftFrontmatter = { ...(id?.frontmatter ?? {}) }
    chain.draftBody = id?.body ?? ""
  }

  const mergePatch = (
    chain: EditChain,
    patch: { frontmatter?: Record<string, unknown>; body?: string },
  ): void => {
    if (patch.frontmatter) {
      for (const [key, val] of Object.entries(patch.frontmatter)) {
        // Never merge prototype-polluting keys into the live draft;
        // validation rejects them at the trust boundary instead.
        if (isUnsafeKey(key)) continue
        if (val === undefined) delete chain.draftFrontmatter![key]
        else chain.draftFrontmatter![key] = val
        chain.dirtyKeys.add(key)
      }
    }
    if (patch.body !== undefined) {
      chain.draftBody = patch.body
      chain.bodyDirty = true
    }
    chain.draftDirty = true
  }

  // Full-snapshot reconciliation for submit(): every input frontmatter key
  // lands unless that key holds unsent local changes (dirty wins); draft
  // keys absent from the snapshot are deleted unless dirty — a full snapshot
  // asserts full content. Body lands unless the draft body is unsent-dirty.
  // The merged result is always sent as one payload built from the latest
  // draft — never a stale prebuilt one.
  const mergeSnapshot = (
    chain: EditChain,
    frontmatter: Record<string, unknown>,
    body: string,
  ): void => {
    for (const key of Object.keys(chain.draftFrontmatter ?? {})) {
      if (key in frontmatter || chain.dirtyKeys.has(key)) continue
      delete chain.draftFrontmatter![key]
    }
    for (const [key, val] of Object.entries(frontmatter)) {
      if (chain.dirtyKeys.has(key) || isUnsafeKey(key)) continue
      if (val === undefined) delete chain.draftFrontmatter![key]
      else chain.draftFrontmatter![key] = val
    }
    if (!chain.bodyDirty) chain.draftBody = body
    chain.draftDirty = true
  }

  const sendEdit = (name: string, chain: EditChain): void => {
    if (disposed || chain.inflight || !chain.draftDirty) return
    const stamp = opts.getStamp()
    if (!stamp) {
      const batch = chain.batch.splice(0)
      chain.draftDirty = false
      chain.dirtyKeys.clear()
      chain.bodyDirty = false
      for (const resolve of batch) {
        resolve({ ok: false, requestId: undefined, name, action: "edit", kind: "not-ready", message: "Canonical agent authority is not ready" })
      }
      return
    }
    const id = opts.getIdentity(name)
    if (!id || id.native) {
      const batch = chain.batch.splice(0)
      chain.draftDirty = false
      chain.dirtyKeys.clear()
      chain.bodyDirty = false
      for (const resolve of batch) {
        resolve({ ok: false, requestId: undefined, name, action: "edit", kind: "invalid", message: id?.native ? `Agent "${name}" is native and cannot be edited` : `Agent "${name}" has no file identity` })
      }
      return
    }
    const hash = currentHash(name, chain)
    if (!hash || hash === "absent") {
      const batch = chain.batch.splice(0)
      chain.draftDirty = false
      chain.dirtyKeys.clear()
      chain.bodyDirty = false
      for (const resolve of batch) {
        resolve({ ok: false, requestId: undefined, name, action: "edit", kind: "invalid", message: `Agent "${name}" is missing scope or asset hash` })
      }
      return
    }
    const requestId = makeId()
    const frontmatter = { ...(chain.draftFrontmatter ?? {}) }
    delete frontmatter.prompt
    const body = chain.draftBody ?? ""
    chain.inflight = { requestId, sentFrontmatter: frontmatter, sentBody: body }
    chain.chainBase = hash
    chain.draftDirty = false
    chain.dirtyKeys.clear()
    chain.bodyDirty = false
    const batch = chain.batch.splice(0)
    waiters.set(requestId, {
      action: "edit",
      name,
      resolve: (r) => {
        for (const resolve of batch) resolve(r)
      },
      extra: [],
    })
    opts.onSend?.({ requestId, name, action: "edit" })
    opts.post({ action: "edit", name, frontmatter, body, scope: id.scope, expectedHash: hash, stamp: { ...stamp, assetHash: hash }, requestId })
  }

  const armTimer = (name: string, chain: EditChain): void => {
    chain.cancelTimer?.()
    chain.cancelTimer = schedule(() => {
      chain.timer = undefined
      chain.cancelTimer = undefined
      sendEdit(name, chain)
    }, delay)
  }

  const submit = (input: AgentMutationInput): Promise<AgentMutationResult> => {
    if (disposed) return fail(input.name, input.action, "cancelled", "Agent mutation coordinator is disposed")
    if (input.action === "edit") {
      const chain = chainFor(input.name)
      ensureDraft(input.name, chain)
      // Full-snapshot edit: synthesize per key with the existing latest
      // draft instead of replacing it. Keys holding unsent local changes
      // keep the draft; all other input keys apply — so pending typing is
      // never silently dropped by a concurrent full submit.
      mergeSnapshot(chain, input.frontmatter ?? {}, input.body)
      return new Promise<AgentMutationResult>((resolve) => {
        chain.batch.push(resolve)
        chain.cancelTimer?.()
        chain.cancelTimer = undefined
        sendEdit(input.name, chain)
        // If blocked synchronously (not-ready/identity), sendEdit settled the batch already.
      })
    }
    if (!opts.getStamp()) return fail(input.name, input.action, "not-ready", "Canonical agent authority is not ready")
    if (opts.exists(input.name)) {
      return fail(input.name, input.action, "invalid", `Agent "${input.name}" already exists`)
    }
    const stamp = opts.getStamp()!
    const requestId = makeId()
    const promise = new Promise<AgentMutationResult>((resolve) => {
      waiters.set(requestId, { action: input.action, name: input.name, resolve, extra: [] })
    })
    opts.onSend?.({ requestId, name: input.name, action: input.action })
    opts.post({
      action: input.action,
      name: input.name,
      frontmatter: { ...input.frontmatter },
      body: input.body,
      scope: "project",
      expectedHash: "absent",
      stamp: { ...stamp, assetHash: "absent" },
      requestId,
    })
    return promise
  }

  const scheduleEdit = (
    name: string,
    patch: { frontmatter?: Record<string, unknown>; body?: string },
  ): Promise<AgentMutationResult> => {
    if (disposed) return fail(name, "edit", "cancelled", "Agent mutation coordinator is disposed")
    const chain = chainFor(name)
    ensureDraft(name, chain)
    mergePatch(chain, patch)
    return new Promise<AgentMutationResult>((resolve) => {
      chain.batch.push(resolve)
      armTimer(name, chain)
    })
  }

  const flush = (name?: string): void => {
    if (disposed) return
    if (name !== undefined) {
      const chain = chains.get(name)
      if (!chain) return
      chain.cancelTimer?.()
      chain.cancelTimer = undefined
      sendEdit(name, chain)
      return
    }
    for (const [key, chain] of chains) {
      chain.cancelTimer?.()
      chain.cancelTimer = undefined
      sendEdit(key, chain)
    }
  }

  const cancelAll = (): void => {
    for (const [, chain] of chains) {
      chain.cancelTimer?.()
      chain.cancelTimer = undefined
      const batch = chain.batch.splice(0)
      for (const resolve of batch) {
        resolve({ ok: false, requestId: undefined, name: "", action: "edit", kind: "cancelled", message: "Agent mutation cancelled" })
      }
      chain.inflight = null
      chain.draftDirty = false
      chain.dirtyKeys.clear()
      chain.bodyDirty = false
    }
    for (const [id, waiter] of waiters) {
      opts.onSettle?.({ requestId: id, name: waiter.name, action: waiter.action, ok: false })
      waiter.resolve({ ok: false, requestId: id, name: waiter.name, action: waiter.action, kind: "cancelled", message: "Agent mutation cancelled" })
    }
    waiters.clear()
  }

  const dispose = (): void => {
    disposed = true
    cancelAll()
    chains.clear()
  }

  const handleMessage = (msg: {
    type: string
    requestId?: unknown
    name?: unknown
    contentHash?: unknown
    message?: unknown
    kind?: unknown
  }): boolean => {
    if (msg.type !== "agentMutationApplied" && msg.type !== "agentMutationError") return false
    if (typeof msg.requestId !== "string") return false
    const waiter = waiters.get(msg.requestId)
    if (!waiter) return false
    waiters.delete(msg.requestId)
    opts.onSettle?.({ requestId: msg.requestId, name: waiter.name, action: waiter.action, ok: msg.type === "agentMutationApplied" })
    const name = waiter.name
    if (msg.type === "agentMutationApplied") {
      const contentHash = typeof msg.contentHash === "string" ? msg.contentHash : ""
      const chain = chains.get(name)
      if (chain) {
        chain.inflight = null
        if (contentHash) chain.chainBase = contentHash
        // A later coalesced edit built on the latest draft goes next, using
        // the returned hash — never a stale prebuilt payload.
        if (chain.draftDirty) sendEdit(name, chain)
        else if (chain.batch.length > 0) {
          // Draft unchanged since send but callers still wait (e.g. duplicate
          // schedule of identical content): settle them with the applied hash.
          const batch = chain.batch.splice(0)
          for (const resolve of batch) {
            resolve({ ok: true, requestId: msg.requestId, name, action: waiter.action, contentHash })
          }
          chain.chainBase = undefined
        } else {
          chain.chainBase = undefined
        }
      }
      waiter.resolve({ ok: true, requestId: msg.requestId, name, action: waiter.action, contentHash })
    } else {
      const chain = chains.get(name)
      if (chain && chain.inflight?.requestId === msg.requestId) chain.inflight = null
      const message = typeof msg.message === "string" ? msg.message : "Agent mutation failed"
      const kind = typeof msg.kind === "string" ? msg.kind : "io"
      const failure: AgentMutationResult = { ok: false, requestId: msg.requestId, name, action: waiter.action, kind, message }
      // Settle the whole queued batch with the SAME structured error: every
      // waiter coalesced behind the failed send resolves, nothing is
      // replayed, and no new send starts. The draft (content + dirty marks)
      // is retained so the next explicit edit retries with full content and
      // a fresh identity hash. Late Applied/Error for this requestId finds no
      // waiter and settles nothing.
      if (chain) {
        chain.chainBase = undefined
        const queued = chain.batch.splice(0)
        for (const resolve of queued) resolve(failure)
      }
      waiter.resolve(failure)
    }
    return true
  }

  return { submit, scheduleEdit, flush, cancelAll, dispose, handleMessage }
}

export type AgentMutationCoordinator = ReturnType<typeof createAgentMutationCoordinator>

/**
 * Session-level diagnostic text for a settled mutation. Success and
 * cancellation produce no diagnostic (success relies on the following
 * agentsLoaded refresh). This decision is deliberately owner-independent:
 * the SessionProvider outlives every edit view, so a flush triggered by
 * unmount/agent-switch still surfaces its failure here. Views guard only
 * their own signals (navigation, local error state) with an OwnerGuard.
 */
export function agentMutationDiagnostic(result: AgentMutationResult): string | null {
  if (result.ok || result.kind === "cancelled") return null
  return `${result.message} [${result.kind}]`
}

/**
 * Owner guard for async view settlements (create submit, import chain,
 * debounced edit commits). The owning view disposes the guard on unmount;
 * guarded callbacks after disposal are ignored — no second navigation, no
 * signal writes. Complements coordinator cancel (which settles `cancelled`
 * without resending): callers ignore by owner/alive either way.
 */
export function createOwnerGuard() {
  let alive = true
  const dispose = (): void => {
    alive = false
  }
  const isAlive = (): boolean => alive
  const guard =
    <T extends unknown[]>(fn: (...args: T) => void) =>
    (...args: T): void => {
      if (alive) fn(...args)
    }
  return { dispose, isAlive, guard }
}

export type OwnerGuard = ReturnType<typeof createOwnerGuard>
