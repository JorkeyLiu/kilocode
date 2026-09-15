/**
 * Pure hydration reconciliation for Agent Manager webview.
 *
 * Order-independent: retain latest durable catalog and backend catalog,
 * intersect whenever both are available. Pending IDs stay in-memory but
 * never enter durable order.
 */

export const PENDING_PREFIX = "pending:"

export function isPending(id: string): boolean {
  return id.startsWith(PENDING_PREFIX)
}

export function isTerminal(id: string): boolean {
  return id.startsWith("terminal:")
}

export function pruneIds(ids: string[], catalog: Set<string>): string[] {
  return ids.filter((id) => isPending(id) || catalog.has(id))
}

export function pruneOrder(order: string[] | undefined, catalog: Set<string>): string[] | undefined {
  if (!order) return undefined
  const next = order.filter((id) => isPending(id) || isTerminal(id) || catalog.has(id))
  return next.length === order.length ? undefined : next
}

export function durableFilteredOrder(order: string[] | undefined): string[] | undefined {
  if (!order) return undefined
  const next = order.filter((id) => !isPending(id) && !isTerminal(id))
  return next
}

export interface DurableState {
  sessions: { id: string }[]
  tabOrder?: Record<string, string[]>
  activeSessionId?: string
  sidebarCollapsed?: boolean
}

/**
 * Derive ordered durable IDs like importLegacyLocalTabs but vscode-free.
 * Mirrors local-ui-state.ts importLegacyLocalTabs.
 */
export function deriveDurableIds(durable: DurableState, LOCAL: string): { ids: string[]; active: string | undefined } {
  const localIds = new Set(durable.sessions.map((s) => s.id))
  const extOrder = durable.tabOrder?.[LOCAL]
  let ordered: string[]
  if (extOrder && extOrder.length > 0) {
    ordered = extOrder.filter((id) => localIds.has(id))
    for (const id of localIds) if (!ordered.includes(id)) ordered.push(id)
  } else {
    ordered = [...localIds]
  }
  let active: string | undefined = ordered[0]
  const extActive = durable.activeSessionId
  if (extActive && ordered.includes(extActive)) active = extActive
  else if (extActive && durable.sessions.some((s) => s.id === extActive) && !ordered.includes(extActive)) {
    ordered = [...ordered, extActive]
    active = extActive
  }
  return { ids: ordered, active }
}

/**
 * Build the catalog set from a complete session inventory snapshot.
 * The deprecated append flag is ignored: every snapshot replaces.
 */
export function accumulateCatalog(
  _prev: Set<string> | undefined,
  sessions: { id: string }[],
  _append?: boolean,
): Set<string> {
  return new Set(sessions.map((s) => s.id))
}

function buildEffective(catalog: Set<string> | undefined, preserve?: string[]): Set<string> | undefined {
  if (!catalog) return undefined
  if (!preserve || preserve.length === 0) return catalog
  const next = new Set(catalog)
  for (const id of preserve) next.add(id)
  return next
}

function pickActive(active: string | undefined, pruned: string[]): string | undefined {
  if (active !== undefined && pruned.includes(active)) return active
  if (active !== undefined) return pruned.find((id) => !isPending(id)) ?? pruned[0]
  return active
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)]
}

export interface ReconcileInput {
  localIds: string[]
  tabOrder: string[] | undefined
  active: string | undefined
  durable: DurableState | undefined
  catalog: Set<string> | undefined
  /** Deprecated: complete inventory is always authoritative, ignored. */
  hasMore?: boolean
  preserveSessionIds?: string[]
  LOCAL: string
  isFresh: boolean
  durableHydrated: boolean
}

export interface ReconcileOutput {
  nextIds: string[] | undefined
  nextActive: string | undefined
  nextOrder: string[] | undefined
  needsPending: boolean
  markHydrated: boolean
  applyActive: boolean
}

function reconcileFresh(input: ReconcileInput): ReconcileOutput {
  const { localIds, active, durable, catalog, preserveSessionIds, LOCAL } = input
  if (!durable || !catalog) return noChange()
  const effective = buildEffective(catalog, preserveSessionIds)!
  const pendingIds = dedupe(localIds.filter(isPending))
  if (durable.sessions.length > 0) {
    const derived = deriveDurableIds(durable, LOCAL)
    const filtered = dedupe(derived.ids.filter((id) => effective.has(id)))
    const merged = dedupe([...pendingIds, ...filtered])
    if (merged.length > 0) {
      let nextActive: string | undefined
      if (active !== undefined && pendingIds.includes(active)) nextActive = active
      else if (derived.active && filtered.includes(derived.active)) nextActive = derived.active
      else if (filtered.length > 0) nextActive = filtered[0]
      else if (pendingIds.length > 0) nextActive = pendingIds[0]
      const applyActive = nextActive !== active
      return { nextIds: merged, nextActive, nextOrder: merged, needsPending: false, markHydrated: true, applyActive }
    }
    return {
      nextIds: [],
      nextActive: undefined,
      nextOrder: [],
      needsPending: true,
      markHydrated: true,
      applyActive: active !== undefined,
    }
  }
  if (pendingIds.length > 0) {
    const nextActive = active !== undefined && pendingIds.includes(active) ? active : pendingIds[0]
    const applyActive = nextActive !== active
    return { nextIds: pendingIds, nextActive, nextOrder: pendingIds, needsPending: false, markHydrated: true, applyActive }
  }
  return {
    nextIds: [],
    nextActive: undefined,
    nextOrder: [],
    needsPending: true,
    markHydrated: true,
    applyActive: active !== undefined,
  }
}

function reconcileExisting(input: ReconcileInput): ReconcileOutput {
  const { localIds, tabOrder, active, catalog, preserveSessionIds } = input
  if (!catalog) return noChange()
  const effective = buildEffective(catalog, preserveSessionIds)!
  const pruned = pruneIds(localIds, effective)
  const orderPruned = pruneOrder(tabOrder, effective)
  const nextActive = pickActive(active, pruned)
  const changedIds = pruned.length !== localIds.length
  const changedOrder = orderPruned !== undefined
  const changedActive = nextActive !== active
  const needsPending = pruned.length === 0
  if (!changedIds && !changedOrder && !changedActive && !needsPending) return noChange()
  if (!changedIds && !changedOrder && !changedActive && needsPending) {
    return {
      nextIds: undefined,
      nextActive: undefined,
      nextOrder: undefined,
      needsPending: true,
      markHydrated: false,
      applyActive: false,
    }
  }
  return {
    nextIds: changedIds ? pruned : undefined,
    nextActive: changedActive ? nextActive : undefined,
    nextOrder: orderPruned,
    needsPending,
    markHydrated: false,
    applyActive: changedActive,
  }
}

function noChange(): ReconcileOutput {
  return {
    nextIds: undefined,
    nextActive: undefined,
    nextOrder: undefined,
    needsPending: false,
    markHydrated: false,
    applyActive: false,
  }
}

/**
 * Pure reconcile: decides next ids/order/active and whether a pending tab is needed.
 * Does not mutate. Caller applies nextIds/nextOrder/nextActive to signals/tabMgr.
 * `needsPending` means create a pending tab after reconciliation (fresh empty case).
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  if (input.isFresh) return reconcileFresh(input)
  return reconcileExisting(input)
}
