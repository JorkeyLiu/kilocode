/**
 * Local-only UI state model for Agent Manager webview persistence.
 *
 * Source of truth for presentation state (open tabs, active tab, sidebar).
 *
 * Uses VS Code webview state API (getState/setState) for persistence.
 * Schema-versioned; one-time migration from legacy extension state
 * (agentManager.state push) is guarded by a migration marker so repeated
 * imports do not occur.
 */

export const LOCAL_UI_STATE_VERSION = 1

export interface LocalUIState {
  /** Schema version for future migration. */
  version: number
  /** Ordered open session tab IDs (excluding pending/terminal). */
  openTabIds: string[]
  /** Active session tab ID (may be a pending ID). */
  activeTabId: string | undefined
  /** Sidebar collapsed state. */
  sidebarCollapsed: boolean
  /** Sidebar width in pixels. */
  sidebarWidth: number
  /** True after one-time migration from legacy extension state. */
  legacyImported: boolean
}

const DEFAULT_SIDEBAR_WIDTH = 260
const STATE_KEY = "localUIState"

export function defaultLocalUIState(): LocalUIState {
  return {
    version: LOCAL_UI_STATE_VERSION,
    openTabIds: [],
    activeTabId: undefined,
    sidebarCollapsed: false,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    legacyImported: false,
  }
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

interface RawWebviewState {
  [STATE_KEY]?: Partial<LocalUIState>
  /** Legacy key coexisting in webview state. */
  localSessionIDs?: string[]
  /** Legacy key coexisting in webview state. */
  sidebarWidth?: number
}

/**
 * Load local UI state from webview state.
 *
 * Migration path:
 *  1. If `localUIState` key exists → use it (current format).
 *  2. If legacy `localSessionIDs` key exists → migrate to new format.
 *  3. Neither → return defaults (first launch or cleared state).
 */
function sanitizeTabIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of raw) {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

export function loadLocalUIState(getState: () => unknown): LocalUIState {
  const raw = (getState() ?? {}) as RawWebviewState
  const defaults = defaultLocalUIState()

  // Current format
  const s = raw[STATE_KEY]
  if (s && typeof s === "object") {
    const ids = sanitizeTabIds(s.openTabIds)
    const rawActive = typeof s.activeTabId === "string" && s.activeTabId.length > 0 ? s.activeTabId : undefined
    const active = rawActive !== undefined && ids.includes(rawActive) ? rawActive : undefined
    return {
      version: typeof s.version === "number" ? s.version : 0,
      openTabIds: ids,
      activeTabId: active,
      sidebarCollapsed: s.sidebarCollapsed === true,
      sidebarWidth: typeof s.sidebarWidth === "number" ? s.sidebarWidth : defaults.sidebarWidth,
      legacyImported: s.legacyImported === true,
    }
  }

  // Legacy migration
  if (Array.isArray(raw.localSessionIDs) || typeof raw.sidebarWidth === "number") {
    return {
      ...defaults,
      openTabIds: sanitizeTabIds(raw.localSessionIDs),
      sidebarWidth: typeof raw.sidebarWidth === "number" ? raw.sidebarWidth : defaults.sidebarWidth,
    }
  }

  return defaults
}

/**
 * Persist local UI state to webview state (debounced by caller).
 * Preserves other keys that coexist in the state object.
 */
export function saveLocalUIState(
  getState: () => unknown,
  setState: (state: Record<string, unknown>) => void,
  ui: LocalUIState,
): void {
  const prev = (getState() as Record<string, unknown>) ?? {}
  setState({
    ...prev,
    [STATE_KEY]: ui,
    // Keep legacy keys in sync for any other consumers
    localSessionIDs: ui.openTabIds,
    sidebarWidth: ui.sidebarWidth,
  })
}

// ---------------------------------------------------------------------------
// Legacy import (one-time migration from extension state)
// ---------------------------------------------------------------------------

export interface LegacyImportSource {
  /** Managed sessions from extension state. */
  managedSessions: { id: string }[]
  /** Tab order from extension state. */
  tabOrder?: Record<string, string[]>
  /** Sidebar collapsed from extension state. */
  sidebarCollapsed?: boolean
}

/**
 * Import LOCAL tab data from legacy extension state.
 *
 * Rules:
 *  - Imports the managed local sessions.
 *  - Uses `tabOrder[LOCAL]` for ordering when available.
 *  - Does NOT delete or rename any state files.
 */
export function importLegacyLocalTabs(
  source: LegacyImportSource,
  LOCAL: string,
): Pick<LocalUIState, "openTabIds" | "activeTabId" | "sidebarCollapsed"> {
  const localIds = new Set(source.managedSessions.map((s) => s.id))

  // Use extension tab order for LOCAL when available, filtering to local sessions only
  const extOrder = source.tabOrder?.[LOCAL]
  let ordered: string[]
  if (extOrder && extOrder.length > 0) {
    ordered = extOrder.filter((id) => localIds.has(id))
    // Append any local sessions not in the tab order
    for (const id of localIds) {
      if (!ordered.includes(id)) ordered.push(id)
    }
  } else {
    ordered = [...localIds]
  }

  return {
    openTabIds: ordered,
    activeTabId: ordered[0],
    sidebarCollapsed: source.sidebarCollapsed ?? false,
  }
}
