/** @jsxImportSource solid-js */

import {
  For,
  Show,
  createSignal,
  createMemo,
  createEffect,
  on,
  onMount,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js"
import type {
  ExtensionMessage,
  AgentManagerRepoInfoMessage,
  AgentManagerStateMessage,
  AgentManagerKeybindingsMessage,
  AgentManagerSendInitialMessage,
  AgentManagerLocalStatsMessage,
  SessionInfo,
  SessionCreatedMessage,
} from "../src/types/messages"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ThemeProvider } from "@kilocode/kilo-ui/theme"
import { DialogProvider, useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { ContextMenu } from "@kilocode/kilo-ui/context-menu"
import { MarkedProvider } from "@kilocode/kilo-ui/context/marked"
import { CodeComponentProvider } from "@kilocode/kilo-ui/context/code"
import { DiffComponentProvider } from "@kilocode/kilo-ui/context/diff"
import { FileComponentProvider } from "@kilocode/kilo-ui/context/file"
import { Code } from "@kilocode/kilo-ui/code"
import { Diff } from "@kilocode/kilo-ui/diff"
import { File } from "@kilocode/kilo-ui/file"
import { Toast, showToast } from "@kilocode/kilo-ui/toast"
import { ResizeHandle } from "@kilocode/kilo-ui/resize-handle"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { TooltipKeybind } from "@kilocode/kilo-ui/tooltip"
import { p0WebviewStage } from "../src/utils/perf"
import { Popover } from "@kilocode/kilo-ui/popover"
import { VSCodeProvider, useVSCode } from "../src/context/vscode"
import { ServerProvider, useServer } from "../src/context/server"
import { ProviderProvider } from "../src/context/provider"
import { ConfigProvider } from "../src/context/config"
import { DisplayProvider } from "../src/context/display"
import { ImageModelsProvider } from "../src/context/image-models"
import { FeedbackProvider } from "../src/context/feedback"
import { SessionProvider, useSession } from "../src/context/session"
import { AgentRequirementsProvider } from "../src/context/agent-requirements"
import { AgentManagerProvider } from "../src/context/agent-manager"
import { ChatView } from "../src/components/chat"
import { SpeechToTextPrewarm } from "../src/components/speech-to-text/SpeechToTextPrewarm"
import HistoryView from "../src/components/history/HistoryView"
import { SidebarSessionList } from "./SidebarSessionList"
import { WorkStyleEmptyPicker } from "./WorkStyleEmptyPicker"
import { DataBridge, MermaidDownloadBridge } from "../src/AppBridge"
import { registerExpandedTaskTool } from "../src/components/chat/TaskToolExpanded"
import { registerVscodeToolOverrides } from "../src/components/chat/VscodeToolOverrides"
import { LanguageBridge } from "../src/context/language-bridge"
import { useLanguage } from "../src/context/language"
import { formatRelativeDate } from "../src/utils/date"
import { createTabFocus } from "../src/utils/tab-navigation"
import {
  adjacentHint,
  focusChatSearch,
  LOCAL,
  resolveNavigation,
  resolveTabNavigation,
  visibleSidebarIds,
} from "./navigate"
import {
  addPendingTab as addLocalPendingTab,
  nextTabAfterClose,
  openSessionTab,
  replacePendingTab,
} from "../src/utils/local-tabs"
import { loadLocalUIState, saveLocalUIState, importLegacyLocalTabs, LOCAL_UI_STATE_VERSION } from "./local-ui-state"
import {
  deletePendingDraft,
  discardPendingDraft,
  isPendingSend,
  promotePendingDraftDiscard,
} from "../src/utils/draft-store"
import { reorderTabs, applyTabOrder, firstOrderedTitle } from "./tab-order"
import { createTabOrderSync } from "./tab-order-sync"
import { reportRemoteSessions, reportVisibleSession, visible } from "./remote-sessions"
import { ConstrainDragYAxis } from "../src/components/chat/TabDnd"
import { isTerminalTabId, createTerminalState, createTerminalHandlers, createTerminalMessageHandler } from "./terminal"
import { focusCurrentTab, renderTab, renderTerminalLayer, renderNewTabButton } from "./tab-rendering"
import { useTabScroll } from "./tab-scroll"
import type { SidebarSearchMenuRef } from "./SidebarSearchMenu"
import { SidebarSearchMenu } from "./SidebarSearchMenu"
import { createSidebarSearch, type SidebarSearchItem } from "./sidebar-search"
import { initialMessage, seedInitialVariant } from "./initial-message"
import { createSidebarCollapse } from "./sidebar-collapse"
import { SidebarToggleButton } from "./SidebarToggleButton"
import { setTabWidths } from "./tab-widths"
import { buildShortcutCategories } from "./shortcuts"
import { tracker } from "./telemetry"
import { createSessionTabManager } from "./session-tab-manager"
import { openSession, openChildSession, type OpenChildSessionDeps, type OpenSessionDeps } from "./open-session"
import { accumulateCatalog, reconcile } from "./hydration"
import { mergePreview } from "./SidebarSessionList"
import { resolveCoverBottomPage, shouldClearBottomPage } from "./cover-bottom-page"
import "./agent-manager.css"

// Explicit tool registration at the Agent Manager boundary. The task renderer
// (TaskToolExpanded) and VS Code chat UI tool overrides were previously active
// in this webview only as an accidental side effect of importing DataBridge
// from ../src/App (whose module scope called these). DataBridge now lives in
// the side-effect-free ../src/AppBridge, so Agent Manager must register the
// renderers it owns explicitly — this is the Agent Manager-owned boundary for
// that registration. ToolRegistry.register is idempotent, so this is safe to
// run alongside the editor-tab App.tsx registration.
registerExpandedTaskTool()
registerVscodeToolOverrides()
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)
// Fallback keybindings before extension sends resolved ones
const MAX_JUMP_INDEX = 9

const defaultBindings: Record<string, string> = {
  previousSession: isMac ? "⌘⌥↑" : "Ctrl+Alt+↑",
  nextSession: isMac ? "⌘⌥↓" : "Ctrl+Alt+↓",
  previousTab: isMac ? "⌘⌥←" : "Ctrl+Alt+←",
  nextTab: isMac ? "⌘⌥→" : "Ctrl+Alt+→",
  search: isMac ? "⌘F" : "Ctrl+F",
  showTerminal: isMac ? "⌘/" : "Ctrl+/",
  newTerminal: isMac ? "⌘⇧T" : "Ctrl+Shift+T",
  showShortcuts: isMac ? "⌘⇧/" : "Ctrl+Shift+/",
  newTab: isMac ? "⌘T" : "Ctrl+T",
  closeTab: isMac ? "⌘W" : "Ctrl+W",
  agentManagerOpen: isMac ? "⌘⇧M" : "Ctrl+Shift+M",
  cycleAgentMode: isMac ? "⌘." : "Ctrl+.",
  cyclePreviousAgentMode: isMac ? "⌘⇧." : "Ctrl+Shift+.",
  ...Object.fromEntries(
    Array.from({ length: MAX_JUMP_INDEX }, (_, i) => [`jumpTo${i + 1}`, isMac ? `⌘${i + 1}` : `Ctrl+${i + 1}`]),
  ),
}

import { parseBindingTokens } from "./keybind-tokens"

const AgentManagerContent: Component = () => {
  const { t } = useLanguage()
  const session = useSession()
  const vscode = useVSCode()
  const server = useServer()
  const dialog = useDialog()
  let sidebarSearchMenu: SidebarSearchMenuRef | undefined

  const [kb, setKb] = createSignal<Record<string, string>>(defaultBindings)

  // Selection is always LOCAL.
  const selection = () => LOCAL
  const metrics = tracker(vscode)
  const [repoBranch, setRepoBranch] = createSignal<string | undefined>()
  const [sessionsLoaded, setSessionsLoaded] = createSignal(false)
  const [isGitRepo, setIsGitRepo] = createSignal(true)
  const [managedSessions, setManagedSessions] = createSignal<{ id: string }[]>([])
  // Non-authoritative preview: flat read-only rows from page deltas. Never
  // enters the session store, Topics, pruning, tombstones, or readiness.
  const [preview, setPreview] = createSignal<SessionInfo[]>([])
  const [previewId, setPreviewId] = createSignal<number | undefined>(undefined)
  const [catalogFailed, setCatalogFailed] = createSignal(false)
  let catalogFailId: number | undefined
  const retryCatalog = () => {
    catalogFailId = undefined
    setCatalogFailed(false)
    vscode.postMessage({ type: "loadSessions" })
  }

  const DEFAULT_SIDEBAR_WIDTH = 260
  const MIN_SIDEBAR_WIDTH = 200
  const MAX_SIDEBAR_WIDTH_RATIO = 0.4

  // Load local UI state from webview state.
  const initialUI = loadLocalUIState(() => vscode.getState())
  const [localSessionIDs, setLocalSessionIDs] = createSignal<string[]>(initialUI.openTabIds)
  const [legacyImportDone, setLegacyImportDone] = createSignal(initialUI.legacyImported)
  const [durableHydrated, setDurableHydrated] = createSignal(false)
  let latestCatalog: Set<string> | undefined
  let latestDurable: AgentManagerStateMessage | undefined
  let catalogPreserve: string[] | undefined
  // Real sessionCreated IDs that have not yet appeared in the authoritative catalog.
  // Protects the first real session from a stale empty catalog that races after creation.
  // Bounded lifecycle: consumed once the catalog includes the ID or the session is deleted.
  const recentRealIds = new Set<string>()
  // AgentManager-owned fork/tool creation-origin marker.
  // Populated by the actual ownership action (sessionForked/sessionAdded) that
  // adds a local tab before an undrafted sessionCreated. When that later
  // sessionCreated arrives for an already-local ID, we promote exactly that
  // ID to recentRealIds — strict existing replay remains unprotected.
  const creationOrigin = new Set<string>()
  // Deletion barrier for races between a complete snapshot drain and a
  // backend delete. Tombstoned IDs are filtered from the snapshot.
  const deletedIds = new Set<string>()
  // Phase 1B: per-context session tab registry (source of truth for tab strip).
  const tabMgr = createSessionTabManager()
  /** Remove a session ID from the local tab (no-op if absent). */
  const evictLocal = (sid: string) =>
    setLocalSessionIDs((prev) => (prev.includes(sid) ? prev.filter((id) => id !== sid) : prev))
  const handleSessionDeletedFromBackend = (msg: { type: string; sessionID: string }) => {
    const sid = msg.sessionID
    deletedIds.add(sid)
    recentRealIds.delete(sid)
    creationOrigin.delete(sid)
    if (latestCatalog) latestCatalog.delete(sid)
    // Phase 3A: single LOCAL context — registry active is the source of truth.
    const wasActive = tabMgr.active(LOCAL) === sid
    tabMgr.remove(LOCAL, sid)
    evictLocal(sid)
    if (!wasActive) return
    const fallback = tabMgr.active(LOCAL)
    if (fallback && !isPending(fallback)) session.selectSession(fallback)
    else if (fallback && isPending(fallback)) {
      setActivePendingId(fallback)
      session.clearCurrentSession()
    } else {
      setActivePendingId(undefined)
      session.clearCurrentSession()
    }
  }
  const handleSearchAction = () => {
    if (!sidebarCollapsed()) sidebarSearchMenu?.open()
    else {
      expandSidebar()
      requestAnimationFrame(() => sidebarSearchMenu?.open())
    }
  }
  const handleShowTerminalAction = () => {
    const id = session.currentSessionID()
    if (id) vscode.postMessage({ type: "agentManager.showTerminal", sessionId: id })
    else if (selection() === LOCAL) vscode.postMessage({ type: "agentManager.showLocalTerminal" })
  }
  const [sidebarWidth, setSidebarWidth] = createSignal(initialUI.sidebarWidth)
  const [sessionsCollapsed, setSessionsCollapsed] = createSignal(true)
  const sidebar = createSidebarCollapse(vscode)
  // Phase 3B: hydrate sidebar collapsed from local UI state (not extension push)
  sidebar.hydrate(initialUI.sidebarCollapsed)
  const sidebarCollapsed = sidebar.collapsed
  const expandSidebar = sidebar.expand
  const toggleSidebar = sidebar.toggle
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

  // rAF coalescing for resize handlers — at most one signal write per frame
  let sidebarRaf: number | undefined
  let pendingSidebarWidth: number | undefined

  const [history, setHistory] = createSignal(false)

  const PENDING_PREFIX = "pending:"
  const closedDrafts = new Set<string>()
  const [activePendingId, setActivePendingId] = createSignal<string | undefined>()
  const [isBottomPage, setIsBottomPage] = createSignal(false)
  // Stable ref for the .am-list scroll container, passed to SidebarSessionList
  // so it can own scroll-preservation without querying the DOM.
  let listEl: HTMLDivElement | undefined

  // Per-sidebar-context terminal state. `terms.activeId` holds the id
  // of the focused terminal tab, if any — takes precedence over
  // session/pending when deriving the visible tab.
  const terms = createTerminalState(selection)

  // Phase 3A: tabMemory removed — single LOCAL context, no per-context memory.

  const isPending = (id: string) => id.startsWith(PENDING_PREFIX)
  reportRemoteSessions(vscode, localSessionIDs, managedSessions, isPending)

  // P0 startup: first operable render (opt-in KILO_P0_PERF, no-op when off).
  // Operable = the global prompt-disabled condition lifted
  // (server.isConnected(), same gate PromptInput uses for isDisabled).
  // Reported only after the enabled state has painted (double rAF), never on
  // message receipt alone. Exactly once per webview load.
  let operableReported = false
  createEffect(
    on(server.isConnected, (connected) => {
      if (!connected || operableReported) return
      operableReported = true
      const report = () => p0WebviewStage("agentManager.operable.first")
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(report))
      else setTimeout(report, 0)
    }),
  )

  // Drag-and-drop state for tab reordering
  const [draggingTab, setDraggingTab] = createSignal<string | undefined>()

  const freezeTabs = () => {
    const bar = document.querySelector(".am-tab-bar")
    if (bar instanceof HTMLElement && bar.matches(":hover")) setTabWidths(true)
  }

  const releaseTabs = () => setTabWidths(false)
  // Tab ordering: context key → ordered session ID array (recovered from extension state)
  const [tabOrder, setTabOrder] = createSignal<Record<string, string[]>>({})
  // Pin new tabs at the tail (see tab-order-sync); strip ephemeral terminal+pending ids so the durable tab order stays clean.
  const persistTabOrder = (key: string, order: string[]) => {
    const durable = order.filter((id) => !isTerminalTabId(id) && !isPending(id))
    vscode.postMessage({ type: "agentManager.setTabOrder", key, order: durable })
  }
  const tabOrderSync = createTabOrderSync({
    LOCAL,
    order: tabOrder,
    setOrder: setTabOrder,
    persist: persistTabOrder,
    localSessionIDs,
    terminalIdsFor: (key) => terms.forSelection(key).map((t) => t.id),
  })
  const appendToTabOrder = tabOrderSync.append

  const addPendingTab = () => {
    const id = `${PENDING_PREFIX}${crypto.randomUUID()}`
    const next = addLocalPendingTab({ ids: localSessionIDs(), active: activePendingId() }, id)
    setLocalSessionIDs(next.ids)
    tabMgr.open(LOCAL, id)
    appendToTabOrder(LOCAL, id)
    // Deactivate any focused terminal so the new pending session is visible.
    terms.setActiveId(undefined)
    setActivePendingId(id)
    session.clearCurrentSession()
    return id
  }

  const applyReconciliation = () => {
    const isFresh = !durableHydrated()
    const combinedPreserve = (() => {
      const fromCatalog = (catalogPreserve ?? []).filter((id) => !deletedIds.has(id))
      const recentFiltered = [...recentRealIds].filter((id) => !deletedIds.has(id))
      if (recentFiltered.length === 0) return fromCatalog.length > 0 ? fromCatalog : undefined
      const merged = [...fromCatalog, ...recentFiltered]
      const deduped = [...new Set(merged)].filter((id) => !deletedIds.has(id))
      return deduped.length > 0 ? deduped : undefined
    })()
    const out = reconcile({
      localIds: localSessionIDs(),
      tabOrder: tabOrder()[LOCAL],
      active: tabMgr.active(LOCAL),
      durable: latestDurable as unknown as
        | {
            sessions: { id: string }[]
            tabOrder?: Record<string, string[]>
            activeSessionId?: string
            sidebarCollapsed?: boolean
          }
        | undefined,
      catalog: latestCatalog,
      preserveSessionIds: combinedPreserve,
      LOCAL,
      isFresh,
      durableHydrated: durableHydrated(),
    })
    // Avoid no-op write loop: suppress identical authoritative replacements
    const equalIds = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])
    let effNextIds = out.nextIds
    let effNextOrder = out.nextOrder
    if (effNextIds !== undefined && equalIds(effNextIds, localSessionIDs())) effNextIds = undefined
    if (effNextOrder !== undefined) {
      const curOrder = tabOrder()[LOCAL]
      const bothUndef = curOrder === undefined && effNextOrder === undefined
      const bothDefinedEqual = curOrder !== undefined && equalIds(effNextOrder, curOrder)
      if (bothUndef || bothDefinedEqual) effNextOrder = undefined
      else if (curOrder === undefined && effNextOrder.length === 0) {
        // [] vs undefined is not equal — keep authoritative empty to clear stale undefined
      }
    }
    const curActive = tabMgr.active(LOCAL)
    let shouldApplyActive = false
    let effNextActive: string | undefined
    if (out.applyActive) {
      const desired = out.nextActive
      if (desired !== curActive) {
        shouldApplyActive = true
        effNextActive = desired
      }
    }
    if (effNextIds !== undefined) setLocalSessionIDs(effNextIds)
    if (effNextOrder !== undefined) setTabOrder((prev) => ({ ...prev, [LOCAL]: effNextOrder! }))
    const shouldSeed = effNextIds !== undefined || shouldApplyActive
    if (shouldSeed) {
      const ids = effNextIds ?? localSessionIDs()
      const act = shouldApplyActive ? effNextActive : tabMgr.active(LOCAL)
      tabMgr.seed(LOCAL, ids, act)
      if (act && isPending(act)) {
        setActivePendingId(act)
        session.clearCurrentSession()
      } else if (act) {
        setActivePendingId(undefined)
        session.selectSession(act)
      } else {
        setActivePendingId(undefined)
        session.clearCurrentSession()
      }
    }
    // Consume recentRealIds once authoritative catalog includes them (bounded convergence)
    if (latestCatalog) {
      for (const id of [...recentRealIds]) if (latestCatalog.has(id)) recentRealIds.delete(id)
    }
    if (out.needsPending) {
      const ids = effNextIds ?? localSessionIDs()
      const hasPending = ids.some((id) => isPending(id))
      if (ids.length === 0 && terms.current().length === 0 && !hasPending) {
        addPendingTab()
        // Derive bottom-page from final reconciled state: pending created by
        // reconciliation represents fresh-empty hydration, not a user close-last.
        // Keep tab bar visible (bottom false) so the pending tab is counted.
        // Close-last's gated bottom state is set only via handleCloseTab.
        setIsBottomPage(false)
      }
    }
    if (out.markHydrated) {
      setDurableHydrated(true)
      setLegacyImportDone(true)
      // Derive bottom-page from final state: after hydration, bottom is false
      // when tabs exist or empty state is shown; contradicts hidden gated state.
      const finalIds = tabMgr.ids(LOCAL)
      const finalHasPending = finalIds.some((id) => isPending(id))
      const finalEmpty = finalIds.length === 0 && terms.current().length === 0
      if (finalEmpty && !finalHasPending) setIsBottomPage(false)
      else setIsBottomPage(false)
      if (latestDurable) {
        const imported = importLegacyLocalTabs(
          {
            managedSessions: latestDurable.sessions,
            tabOrder: latestDurable.tabOrder,
            sidebarCollapsed: latestDurable.sidebarCollapsed,
          },
          LOCAL,
        )
        if (imported.sidebarCollapsed !== undefined) sidebar.hydrate(imported.sidebarCollapsed)
      }
    }
    // Final invariant: bottom stays while only an internal pending draft (or
    // nothing) exists with no terminals. Lone pending is hidden by the
    // bottom-page tab-bar gate, not real content. Any non-pending real tab
    // or terminal content clears bottom as before.
    if (isBottomPage()) {
      const finalIds = tabMgr.ids(LOCAL)
      if (shouldClearBottomPage(finalIds, terms.current().length, isPending)) setIsBottomPage(false)
    }
  }

  const placeLocal = (id: string, pending: string | undefined, active: string | undefined) => {
    const next = pending
      ? replacePendingTab({ ids: localSessionIDs(), active }, pending, id)
      : openSessionTab({ ids: localSessionIDs(), active }, id)
    setLocalSessionIDs(next.ids)
    if (pending) tabMgr.replace(LOCAL, pending, id)
    else tabMgr.open(LOCAL, id)
    if (pending) tabOrderSync.replaceOrAppend(LOCAL, pending, id)
    if (!pending) tabOrderSync.append(LOCAL, id)
    if (pending && pending === active) setActivePendingId(undefined)
  }

  // Persist local UI state to webview state.
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const ids = localSessionIDs().filter((id) => !isPending(id))
    const width = sidebarWidth()
    const active = tabMgr.active(LOCAL)
    const collapsed = sidebarCollapsed()
    const imported = legacyImportDone()
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      saveLocalUIState(
        () => vscode.getState(),
        (s) => vscode.setState(s),
        {
          version: LOCAL_UI_STATE_VERSION,
          openTabIds: ids,
          activeTabId: active,
          sidebarCollapsed: collapsed,
          sidebarWidth: width,
          legacyImported: imported,
        },
      )
    }, 300)
  })
  onCleanup(() => clearTimeout(persistTimer))

  // --- Canonical open-session transaction ---
  // Phase 2: ensure a session is in localSessionIDs + tab order.
  const ensureLocal = (id: string) => {
    if (!localSessionIDs().includes(id)) {
      setLocalSessionIDs((prev) => [...prev, id])
      tabOrderSync.append(LOCAL, id)
    }
  }
  const coverBottomPage = () => {
    const decision = resolveCoverBottomPage(tabMgr.ids(LOCAL), isBottomPage(), isPending)
    if (!decision) return
    if (decision.coverId !== undefined) {
      const cover = decision.coverId
      setLocalSessionIDs((prev) => prev.filter((x) => x !== cover))
      tabMgr.remove(LOCAL, cover)
      setTabOrder((prev) => ({ ...prev, [LOCAL]: (prev[LOCAL] ?? []).filter((x) => x !== cover) }))
      deletePendingDraft(cover)
      if (activePendingId() === cover) setActivePendingId(undefined)
    }
    if (decision.clearBottom) setIsBottomPage(false)
  }
  const openDeps: OpenSessionDeps = {
    tabMgr,
    selectSession: session.selectSession,
    setActivePendingId,
    setHistory,
    setTermsActiveId: terms.setActiveId,
    setSelection: () => {},
    isPending,
    ensureLocal,
  }
  const handleOpenSession = (id: string) => {
    coverBottomPage()
    return openSession(id, openDeps)
  }

  // Source-relative child-open (Agent Manager task/tool-call open action):
  // keeps the local inventory and persisted tab order consistent with the tab
  // registry before openChildSession selects the child. Mirrors the fork
  // transaction's three-store insertAfter pattern. Already-open children are
  // focused without mutating any store (see tabOrderSync.insertLocalAfter).
  const insertLocalAfter = (source: string | undefined, id: string) => {
    tabOrderSync.insertLocalAfter(source, id, setLocalSessionIDs)
  }
  const childOpenDeps: OpenChildSessionDeps = {
    ...openDeps,
    insertLocalAfter,
  }
  const handleViewChildSession = (id: string, source: string | undefined) => {
    coverBottomPage()
    return openChildSession(id, source, childOpenDeps)
  }

  const localSet = createMemo(() => new Set(localSessionIDs()))

  // Local sessions (resolved from session list + pending tabs, in insertion order)
  const localSessions = createMemo((): SessionInfo[] => {
    const ids = localSessionIDs()
    const all = session.sessions()
    const lookup = new Map(all.map((s) => [s.id, s]))
    const result: SessionInfo[] = []
    const now = new Date().toISOString()
    for (const id of ids) {
      const real = lookup.get(id)
      if (real) {
        result.push(real)
      } else if (isPending(id)) {
        result.push({ id, title: t("agentManager.session.newSession"), createdAt: now, updatedAt: now })
      }
    }
    return result
  })

  // Phase 3A: activeTabs always derives from LOCAL tab registry.
  const activeTabs = createMemo((): SessionInfo[] => {
    const ids = tabMgr.ids(LOCAL)
    const all = session.sessions()
    const lookup = new Map(all.map((s) => [s.id, s]))
    const now = new Date().toISOString()
    const result: SessionInfo[] = []
    for (const id of ids) {
      const real = lookup.get(id)
      if (real) {
        result.push(real)
      } else if (isPending(id)) {
        result.push({ id, title: t("agentManager.session.newSession"), createdAt: now, updatedAt: now })
      } else {
        result.push({ id, title: id.slice(0, 16), createdAt: now, updatedAt: now })
      }
    }
    return result
  })

  // Phase 3A: contextEmpty checks only LOCAL.
  const contextEmpty = createMemo(() => {
    if (terms.current().length > 0) return false
    return tabMgr.ids(LOCAL).length === 0
  })

  createEffect(() => {
    const id = selection() ?? session.currentSessionID()
    if (!id) return
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-sidebar-id="${id}"]`)
      if (el instanceof HTMLElement) scrollIntoView(el)
    })
  })

  const visibleTabId = createMemo(() => {
    const term = terms.activeId()
    if (term) return term
    return session.currentSessionID() ?? activePendingId()
  })
  const visibleSession = createMemo(() =>
    visible(session.currentSessionID(), !!terms.activeId() || history() || contextEmpty()),
  )
  reportVisibleSession(vscode, visibleSession)

  const isAnySessionBusy = (ids: string[]): boolean => {
    if (ids.length === 0) return false
    const statuses = session.allStatusMap()
    const perms = session.permissions()
    const qs = session.questions()
    for (const id of ids) {
      const info = statuses[id]
      if (!info || info.type === "idle") continue
      const blocked = perms.some((p) => p.sessionID === id) || qs.some((q) => q.sessionID === id)
      if (!blocked) return true
    }
    return false
  }

  /** True when a local session is actively working. */
  const isLocalBusy = (): boolean => isAnySessionBusy(localSessionIDs())

  const isSessionBusy = (id: string): boolean => isAnySessionBusy([id])

  const scrollIntoView = (el: HTMLElement) => el.scrollIntoView({ block: "nearest", behavior: "smooth" })

  const sidebarSearch = createSidebarSearch({
    local: localSessions,
    localBranch: repoBranch,
    selection,
    sessionId: session.currentSessionID,
    statuses: session.allStatusMap,
    permissions: session.permissions,
    questions: session.questions,
    pending: isPending,
    busy: () => false,
    localBusy: isLocalBusy,
    t,
  })
  const focusSidebarSearchItem = (item: SidebarSearchItem) => {
    if (item.kind === "local") {
      setHistory(false)
      return
    }
    if (item.kind === "session") {
      handleOpenSession(item.sessionId)
    }
  }

  const cycleAgent = (direction: 1 | -1) => {
    const available = session.agents().filter((a) => a.mode !== "subagent" && !a.hidden)
    if (available.length <= 1) return
    const current = session.selectedAgent()
    // Fixed-agent sessions (e.g. child sessions with a delegated subagent that
    // is not in the visible list) must not cycle.
    if (!available.some((a) => a.name === current)) return
    const idx = available.findIndex((a) => a.name === current)
    const raw = idx + direction
    const next = raw < 0 ? available.length - 1 : raw >= available.length ? 0 : raw
    const agent = available[next]
    if (agent) session.selectAgent(agent.name)
  }

  onMount(() => {
    const actionMap: Record<string, () => void> = {
      sessionPrevious: () => {
        const ids = visibleSidebarIds(
          session.sessions() as unknown as Parameters<typeof visibleSidebarIds>[0],
          expanded(),
        )
        const cur = session.currentSessionID()
        const res = resolveNavigation("up", cur, ids)
        if (res.action === "select") handleOpenSession(res.id)
        else if (res.action === LOCAL) {
          terms.setActiveId(undefined)
          setHistory(false)
          setActivePendingId(undefined)
          session.clearCurrentSession()
        }
      },
      sessionNext: () => {
        const ids = visibleSidebarIds(
          session.sessions() as unknown as Parameters<typeof visibleSidebarIds>[0],
          expanded(),
        )
        const cur = session.currentSessionID()
        const res = resolveNavigation("down", cur, ids)
        if (res.action === "select") handleOpenSession(res.id)
        else if (res.action === LOCAL) {
          terms.setActiveId(undefined)
          setHistory(false)
          setActivePendingId(undefined)
          session.clearCurrentSession()
        }
      },
      tabPrevious: () => {
        const ids = tabIds()
        const cur = visibleTabId()
        const next = resolveTabNavigation("prev", cur, ids)
        if (next) focusTab(next)
      },
      tabNext: () => {
        const ids = tabIds()
        const cur = visibleTabId()
        const next = resolveTabNavigation("next", cur, ids)
        if (next) focusTab(next)
      },
      search: handleSearchAction,
      showTerminal: handleShowTerminalAction,
      newTab: handleAddSession,
      closeTab: closeActiveTab,
      showShortcuts: handleShowKeyboardShortcuts,
      focusInput: () => window.dispatchEvent(new Event("focusPrompt")),
      focusSearch: () => focusChatSearch({ history: setHistory, terminal: () => terms.setActiveId(undefined) }),
      newTerminal: () => termHandlers.requestNew(),
    }
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === "navigate" && msg.view === "history") return setHistory(true)
      if (msg?.type === "viewChildSession" && msg.sessionID) {
        handleViewChildSession(msg.sessionID as string, msg.sourceSessionID as string | undefined)
        return
      }
      if (msg?.type !== "action") return
      const fn = actionMap[msg.action as string]
      if (fn) {
        fn()
        return
      }
      if (msg.action === "cycleAgentMode" && document.hasFocus()) cycleAgent(1)
      else if (msg.action === "cyclePreviousAgentMode" && document.hasFocus()) cycleAgent(-1)
    }
    window.addEventListener("message", handler)

    // Prevent Cmd/Ctrl shortcuts from triggering native browser actions
    const preventDefaults = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const target = e.target as HTMLElement | null
      if (target?.closest("[data-agent-manager-native-text-shortcuts]")) return
      // Arrow navigation requires Alt modifier (Cmd+Alt+Arrow for tabs/sessions)
      if (e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault()
      }
      // Prevent browser defaults for our shortcuts (new tab, close tab, run, find)
      if (["t", "w", "n", "e", "f"].includes(e.key.toLowerCase()) && !e.shiftKey) {
        e.preventDefault()
      }
      // Prevent defaults for shift variants (close, advanced/new/open, open PR)
      if (["w", "n", "o", "r"].includes(e.key.toLowerCase()) && e.shiftKey) {
        e.preventDefault()
      }
      // Prevent browser defaults for shortcuts help (Cmd/Ctrl+Shift+/)
      if (["/", "?"].includes(e.key) && e.shiftKey) {
        e.preventDefault()
      }
      // Prevent defaults for jump-to shortcuts (Cmd/Ctrl+1-9)
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault()
      }
    }
    window.addEventListener("keydown", preventDefaults, true)

    // When the panel regains focus (e.g. returning from terminal), focus the prompt
    // and clear any stale body styles left by Kobalte modal overlays (dropdowns/dialogs
    // set pointer-events:none and overflow:hidden on body, but cleanup never runs if
    // focus leaves the webview before the overlay closes).
    const onWindowFocus = () => {
      document.body.style.pointerEvents = ""
      document.body.style.overflow = ""
      window.dispatchEvent(new Event("focusPrompt"))
    }
    window.addEventListener("focus", onWindowFocus)

    // Add created sessions as local tabs (both direct from the prompt and
    // backend follow-ups). Dedups HTTP + SSE firing together.
    const createdSessions = new Set<string>()
    const unsubCreate = vscode.onMessage((msg) => {
      if (msg.type !== "sessionCreated") return
      const created = msg as SessionCreatedMessage
      if (!created.draftID && createdSessions.delete(created.session.id)) return
      if (created.draftID) createdSessions.add(created.session.id)
      if (created.draftID && closedDrafts.delete(created.draftID)) return
      if (created.draftID && promotePendingDraftDiscard(created.draftID, created.session.id)) return
      const pending = created.draftID && localSessionIDs().includes(created.draftID) ? created.draftID : undefined
      if (!pending && localSessionIDs().includes(created.session.id)) {
        if (creationOrigin.has(created.session.id)) {
          recentRealIds.add(created.session.id)
          creationOrigin.delete(created.session.id)
        }
        return
      }
      const active = activePendingId()
      const focus = !pending || pending === active
      placeLocal(created.session.id, pending, active)
      if (pending) recentRealIds.add(created.session.id)
      else if (creationOrigin.has(created.session.id)) {
        recentRealIds.add(created.session.id)
        creationOrigin.delete(created.session.id)
      }
      setIsBottomPage(false)
      vscode.postMessage({
        type: "agentManager.persistSession",
        sessionId: created.session.id,
        draftID: created.draftID,
      })
      if (focus) session.selectSession(created.session.id)
    })

    // Catalog readiness: complete inventory snapshot replaces the catalog.
    // Tombstoned deletes filter stale drain races; converged omissions drop
    // their tombstone so the set stays bounded. sessionsLoaded (with optional
    // backward-compatible missing refreshId) is the sole authoritative event.
    const unsubSessions = vscode.onMessage((msg) => {
      if (msg.type === "sessionsProgress") {
        // Non-authoritative preview only before the first complete catalog.
        // Later background refreshes keep existing Topics visible.
        if (sessionsLoaded()) return
        const m = msg as { refreshId?: unknown; sessions?: SessionInfo[] }
        if (typeof m.refreshId !== "number" || !Array.isArray(m.sessions)) return
        const cur = previewId()
        if (cur !== undefined && m.refreshId < cur) return
        if (cur === undefined || m.refreshId > cur) {
          setPreviewId(m.refreshId)
          setPreview(mergePreview([], m.sessions ?? []))
          if (catalogFailId !== undefined && m.refreshId > catalogFailId) {
            catalogFailId = undefined
            setCatalogFailed(false)
          }
        } else {
          setPreview((prev) => mergePreview(prev, m.sessions ?? []))
        }
        return
      }
      if (msg.type === "sessionsLoaded") {
        const m = msg as {
          sessions?: Array<{ id: string }>
          preserveSessionIds?: string[]
          refreshId?: unknown
        }
        // Drop stale finals from superseded refreshes; missing id stays
        // authoritative for backward-compatible fixtures/manual messages.
        const cur = previewId()
        if (typeof m.refreshId === "number" && cur !== undefined && m.refreshId < cur && !sessionsLoaded()) return
        if (!sessionsLoaded()) setSessionsLoaded(true)
        setPreview([])
        setPreviewId(undefined)
        catalogFailId = undefined
        setCatalogFailed(false)
        const rawIds = new Set((m.sessions ?? []).map((s) => s.id))
        for (const del of [...deletedIds]) if (!rawIds.has(del)) deletedIds.delete(del)
        const filtered = (m.sessions ?? []).filter((s) => !deletedIds.has(s.id))
        latestCatalog = accumulateCatalog(latestCatalog, filtered)
        catalogPreserve = m.preserveSessionIds?.filter((id) => !deletedIds.has(id))
        applyReconciliation()
        return
      }
      if (msg.type === "error") {
        // Scoped catalog retry state only; generic errors never arm Retry.
        const m = msg as { code?: unknown; refreshId?: unknown }
        if (m.code !== "sessionCatalogLoadFailed" || typeof m.refreshId !== "number") return
        if (sessionsLoaded()) return
        const cur = previewId()
        if (cur !== undefined && m.refreshId < cur) return
        if (catalogFailId !== undefined && m.refreshId <= catalogFailId) return
        catalogFailId = m.refreshId
        setCatalogFailed(true)
      }
    })

    // Terminal messages have their own subscription to keep main-handler complexity in check.
    const terminalDispatch = createTerminalMessageHandler({
      state: terms,
      activate: termHandlers.activate,
      setSelection: () => {},
      showError: (message) =>
        showToast({ variant: "error", title: t("agentManager.terminal.errorTitle"), description: message }),
      onCreated: (contextKey, terminalId) => appendToTabOrder(contextKey, terminalId),
    })
    const unsubTerminals = vscode.onMessage((msg) => {
      terminalDispatch(msg)
    })

    const unsub = vscode.onMessage((msg) => {
      if (msg.type === "agentManager.repoInfo") {
        const info = msg as AgentManagerRepoInfoMessage
        setRepoBranch(info.branch)
      }

      if (msg.type === "agentManager.sessionAdded") {
        // Session stays in LOCAL tab context. This is an AgentManager-owned creation
        // that adds the local tab before any undrafted sessionCreated. Mark origin
        // and protect against stale catalog pruning.
        const ev = msg as { type: string; sessionId: string }
        coverBottomPage()
        if (!localSessionIDs().includes(ev.sessionId)) appendToTabOrder(LOCAL, ev.sessionId)
        tabMgr.open(LOCAL, ev.sessionId)
        creationOrigin.add(ev.sessionId)
        recentRealIds.add(ev.sessionId)
        session.selectSession(ev.sessionId)
      }

      if (msg.type === "agentManager.sessionForked") {
        // Forked session stays in LOCAL tab context.
        const ev = msg as { type: string; sessionId: string; forkedFromId: string }
        tabOrderSync.insertAfter(LOCAL, ev.forkedFromId, ev.sessionId)
        setLocalSessionIDs((prev) => {
          const idx = prev.indexOf(ev.forkedFromId)
          if (idx >= 0) return [...prev.slice(0, idx + 1), ev.sessionId, ...prev.slice(idx + 1)]
          return [...prev, ev.sessionId]
        })
        tabMgr.open(LOCAL, ev.sessionId)
        creationOrigin.add(ev.sessionId)
        recentRealIds.add(ev.sessionId)
        vscode.postMessage({ type: "agentManager.persistSession", sessionId: ev.sessionId })
        session.selectSession(ev.sessionId)
      }

      if (msg.type === "agentManager.keybindings") {
        const ev = msg as AgentManagerKeybindingsMessage
        setKb(ev.bindings)
      }

      if (msg.type === "agentManager.localStats") {
        const ev = msg as AgentManagerLocalStatsMessage
        setRepoBranch(ev.stats.branch)
      }

      // Consume only local/repo/session fields from state.
      if (msg.type === "agentManager.state") {
        const state = msg as AgentManagerStateMessage
        setManagedSessions(state.sessions)
        if (state.timing) session.setTimingSnapshots(state.timing)
        if (state.isGitRepo !== undefined) setIsGitRepo(state.isGitRepo)
        // Only update non-LOCAL tab order keys from extension state.
        if (state.tabOrder) {
          setTabOrder((prev) => {
            const next = { ...prev }
            for (const [key, value] of Object.entries(state.tabOrder!)) {
              if (key !== LOCAL) next[key] = value
            }
            return next
          })
        }
        latestDurable = state
        applyReconciliation()
        // One-time legacy sidebarCollapsed hydration when no durable hydrated yet and local empty (fallback for empty durable)
        if (
          !durableHydrated() &&
          !latestCatalog &&
          !legacyImportDone() &&
          localSessionIDs().length === 0 &&
          state.sessions.length === 0
        ) {
          const imported = importLegacyLocalTabs(
            {
              managedSessions: state.sessions,
              tabOrder: state.tabOrder,
              sidebarCollapsed: state.sidebarCollapsed,
            },
            LOCAL,
          )
          if (imported.sidebarCollapsed !== undefined) sidebar.hydrate(imported.sidebarCollapsed)
          setLegacyImportDone(true)
        }
      }

      // Set per-session model selection (used by sendInitialMessage path).
      if ((msg as { type: string }).type === "agentManager.setSessionModel") {
        const ev = msg as { type: string; sessionId: string; providerID: string; modelID: string }
        session.setSessionModel(ev.sessionId, ev.providerID, ev.modelID)
      }

      // Handle initial message send for sessions created by the extension.
      if ((msg as { type: string }).type === "agentManager.sendInitialMessage") {
        const ev = msg as unknown as AgentManagerSendInitialMessage
        if (ev.agent) {
          session.setSessionAgent(ev.sessionId, ev.agent)
        }
        if (ev.providerID && ev.modelID) {
          session.setSessionModel(ev.sessionId, ev.providerID, ev.modelID)
        }
        seedInitialVariant(session, ev)
        const init = initialMessage(ev)
        if (init) {
          vscode.postMessage(init)
        }
      }
    })

    const unsubDeleted = vscode.onMessage((msg) => {
      if (msg.type === "sessionDeleted") handleSessionDeletedFromBackend(msg as { type: string; sessionID: string })
    })

    // Fixture-only per-seed delivery barrier: registered after all Agent
    // Manager session/catalog/state/deleted handlers above, so FIFO handler
    // order proves prior synchronous seed handlers ran before this handler
    // observes the barrier. Acks after at most one requestAnimationFrame
    // (queueMicrotask fallback where rAF is unavailable). Production never
    // sends this message, so the handler stays inert.
    const unsubBarrier = vscode.onMessage((msg) => {
      if (msg.type !== "agentManager.fixtureBarrier") return
      const token = (msg as { type: string; token?: unknown }).token
      if (typeof token !== "string" || token.length === 0) return
      const send = () => vscode.postMessage({ type: "agentManager.fixtureBarrierAck", token } as never)
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => send())
      else queueMicrotask(() => send())
    })

    // Fixture-only content-readiness ack: emitted only after all Agent Manager
    // content subscriptions above (sessionCreated/sessionsLoaded/terminal/
    // repo/state/model/initial-message/sessionDeleted) are installed, so the
    // extension fixture bridge can wait for it before posting seed messages.
    // A single extra webview→extension message; ignored in production.
    vscode.postMessage({ type: "agentManager.contentReady" })

    onCleanup(() => {
      window.removeEventListener("message", handler)
      window.removeEventListener("keydown", preventDefaults, true)
      window.removeEventListener("focus", onWindowFocus)
      unsubCreate()
      unsubSessions()
      unsubTerminals()
      unsub()
      unsubDeleted()
      unsubBarrier()
    })
  })

  onMount(() => {
    // Request state from extension
    vscode.postMessage({ type: "agentManager.requestState" })
    tabMgr.seed(LOCAL, localSessionIDs(), initialUI.activeTabId)
    // Phase 3B: restore active tab from local UI state
    if (initialUI.activeTabId && localSessionIDs().includes(initialUI.activeTabId)) {
      if (isPending(initialUI.activeTabId)) {
        setActivePendingId(initialUI.activeTabId)
      } else {
        session.selectSession(initialUI.activeTabId)
      }
    }
    // Pending creation is deferred until reconciliation of durable state + catalog (fresh empty case)
  })

  const handleShowKeyboardShortcuts = () => {
    const categories = buildShortcutCategories(kb(), t)
    dialog.show(() => (
      <Dialog title={t("agentManager.shortcuts.title")} fit>
        <div class="am-shortcuts">
          <For each={categories}>
            {(category) => (
              <div class="am-shortcuts-category">
                <div class="am-shortcuts-category-title">{category.title}</div>
                <div class="am-shortcuts-list">
                  <For each={category.shortcuts}>
                    {(shortcut) => (
                      <div class="am-shortcuts-row">
                        <span class="am-shortcuts-label">{shortcut.label}</span>
                        <span class="am-shortcuts-keys">
                          <For each={parseBindingTokens(shortcut.binding)}>
                            {(token) => <kbd class="am-kbd">{token}</kbd>}
                          </For>
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </Dialog>
    ))
  }

  const handleAddSession = () => {
    coverBottomPage()
    addPendingTab()
    setIsBottomPage(false)
  }
  const onNewTaskRequest = () => {
    handleAddSession()
  }
  window.addEventListener("newTaskRequest", onNewTaskRequest)
  onCleanup(() => window.removeEventListener("newTaskRequest", onNewTaskRequest))
  // Phase 3A: fork always happens in LOCAL context.
  const handleForkSession = (sessionId: string, messageId?: string) => {
    const msg = { type: "agentManager.forkSession" as const, sessionId, ...(messageId ? { messageId } : {}) }
    vscode.postMessage(msg)
  }
  const handleCloseTab = (sessionId: string) => {
    freezeTabs()
    const pending = isPending(sessionId)
    const isActive = pending ? sessionId === activePendingId() : session.currentSessionID() === sessionId
    if (isActive) {
      const id = nextTabAfterClose(
        activeTabs().map((tab) => tab.id),
        sessionId,
      )
      if (id && isPending(id)) {
        setActivePendingId(id)
        session.clearCurrentSession()
      }
      if (id && !isPending(id)) {
        setActivePendingId(undefined)
        session.selectSession(id)
      }
      if (!id) {
        setActivePendingId(undefined)
        session.clearCurrentSession()
      }
    }
    if (pending || localSet().has(sessionId)) {
      setLocalSessionIDs((prev) => prev.filter((id) => id !== sessionId))
    }
    tabMgr.close(LOCAL, sessionId)
    if (pending) {
      closedDrafts.add(sessionId)
      if (session.isSubmitting(sessionId) || isPendingSend(sessionId)) discardPendingDraft(sessionId)
      queueMicrotask(() => deletePendingDraft(sessionId))
    }
    vscode.postMessage({ type: "agentManager.closeSession", sessionId })
    tabFocus.restore()
    if (tabMgr.ids(LOCAL).length === 0 && terms.current().length === 0) {
      addPendingTab()
      setIsBottomPage(true)
    }
  }

  /** Lightweight close: sends backend close message without registry mutation. */
  const sessionCloseMessage = (sessionId: string) => {
    if (isPending(sessionId)) {
      closedDrafts.add(sessionId)
      if (session.isSubmitting(sessionId) || isPendingSend(sessionId)) discardPendingDraft(sessionId)
      queueMicrotask(() => deletePendingDraft(sessionId))
    }
    if (isPending(sessionId) || localSet().has(sessionId))
      setLocalSessionIDs((prev) => prev.filter((id) => id !== sessionId))
    vscode.postMessage({ type: "agentManager.closeSession", sessionId })
  }
  // ctx always returns LOCAL — single context for all session tabs.
  const ctx = () => LOCAL
  const tabMgrCloseOthers = (c: string, target: string) => tabMgr.closeOthers(c, target)

  const handleTabMouseDown = (sessionId: string, e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      e.stopPropagation()
      handleCloseTab(sessionId)
    }
  }

  const selectSessionTab = (id: string, pending: boolean) => {
    tabMgr.select(LOCAL, id)
    if (pending) {
      setActivePendingId(id)
      session.clearCurrentSession()
    } else {
      setActivePendingId(undefined)
      session.selectSession(id)
    }
  }
  const termHandlers = createTerminalHandlers({
    state: terms,
    tabIds: () => tabIds(),
    selectSessionTab,
    clearSession: () => session.clearCurrentSession(),
    resetOthers: () => {
      setActivePendingId(undefined)
      session.clearCurrentSession()
    },
    isPendingId: isPending,
    findTab: (id) => tabLookup().get(id),
    postMessage: (msg) => vscode.postMessage(msg as never),
    onRemove: freezeTabs,
    getSelection: selection,
    LOCAL,
  })

  // Drag-and-drop handlers for tab reordering
  const tabLookup = createMemo(() => new Map(activeTabs().map((s) => [s.id, s])))
  const tabIds = createMemo(() => {
    const ids = activeTabs().map((s) => s.id)
    const sel = selection()
    if (sel === null) return ids
    const terminalIds = terms.current().map((t) => t.id)
    const base = [...ids, ...terminalIds]
    // Phase 3A: always use LOCAL as the tab-order key regardless of selection.
    return applyTabOrder(
      base.map((id) => ({ id })),
      tabOrder()[LOCAL],
    ).map((item) => item.id)
  })
  const tabScroll = useTabScroll(tabIds, visibleTabId)
  const handleDragStart = (event: DragEvent) => {
    const id = event.draggable?.id
    if (typeof id === "string") setDraggingTab(id)
  }

  const handleDragOver = (event: DragEvent) => {
    const from = event.draggable?.id
    const to = event.droppable?.id
    if (typeof from !== "string" || typeof to !== "string") return
    const sel = selection()
    if (sel === null) return
    // Phase 3A: always use LOCAL as the tab-order key regardless of selection.
    const key = LOCAL
    // Unified mixed-drag: the current visible order is `tabIds()` and
    // includes sessions and terminals. `reorderTabs` moves
    // `from` to `to`'s position regardless of kind, so a user can slot
    // a terminal between two sessions or vice versa.
    const reordered = reorderTabs(tabIds(), from, to)
    if (!reordered) return
    setTabOrder((prev) => ({ ...prev, [key]: reordered }))
    // Keep the session-only list in sync for LOCAL so `localSessions()`
    // and membership checks stay aligned after a drag.
    if (key === LOCAL) {
      const sessionSubset = reordered.filter((id) => !isTerminalTabId(id))
      setLocalSessionIDs(sessionSubset)
      tabMgr.setOrder(LOCAL, sessionSubset)
    }
    // Mirror the order into the terminal state so `terms.current()`
    // (the source for renderTerminalLayer's slot order) matches.
    const terminalSubset = reordered.filter(isTerminalTabId)
    if (terminalSubset.length > 0) terms.reorder(key, terminalSubset)
  }

  const handleDragEnd = () => {
    setDraggingTab(undefined)
    const sel = selection()
    if (sel === null) return
    // Phase 3A: always use LOCAL as the tab-order key regardless of selection.
    const key = LOCAL
    const order = tabOrder()[key]
    if (order && order.length > 0) persistTabOrder(key, order)
  }

  const draggedTab = createMemo(() => {
    const id = draggingTab()
    if (!id) return undefined
    if (isTerminalTabId(id)) {
      const term = terms.lookup().get(id)
      return term ? { id, title: term.title } : undefined
    }
    return activeTabs().find((s) => s.id === id)
  })

  const focusTab = (id: string) => {
    if (!isTerminalTabId(id)) tabMgr.select(LOCAL, id)
    return focusCurrentTab({
      id,
      terms,
      isTerminal: isTerminalTabId,
      isPending,
      tabLookup,
      setActivePendingId,
      clearSession: session.clearCurrentSession,
      selectSession: session.selectSession,
      activateTerminal: termHandlers.activate,
    })
  }
  const tabFocus = createTabFocus({ ids: () => tabIds(), select: focusTab })

  // Close the currently active tab via keyboard shortcut.
  // If no tabs remain, nothing to close.
  const closeActiveTab = () => {
    if (termHandlers.closeActive()) {
      tabFocus.restore()
      return
    }
    const tabs = activeTabs()
    if (tabs.length === 0) {
      return
    }
    const current = session.currentSessionID()
    const pending = activePendingId()
    const target = current
      ? tabs.find((s) => s.id === current)
      : pending
        ? tabs.find((s) => s.id === pending)
        : undefined
    if (!target) return
    handleCloseTab(target.id)
  }

  // Cmd+T: add a new tab
  const handleNewTabForCurrentSelection = () => {
    handleAddSession()
  }

  return (
    <div
      class="am-layout"
      classList={{ "am-layout-hydrated": sidebar.hydrated() }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        class="am-sidebar"
        classList={{ "am-sidebar-collapsed": sidebarCollapsed() }}
        style={{ width: sidebarCollapsed() ? "0px" : `${sidebarWidth()}px` }}
        inert={sidebarCollapsed() || undefined}
      >
        <ResizeHandle
          direction="horizontal"
          size={sidebarWidth()}
          min={MIN_SIDEBAR_WIDTH}
          max={9999}
          onResize={(width) => {
            pendingSidebarWidth = Math.min(width, window.innerWidth * MAX_SIDEBAR_WIDTH_RATIO)
            if (sidebarRaf === undefined) {
              sidebarRaf = requestAnimationFrame(() => {
                sidebarRaf = undefined
                setSidebarWidth(pendingSidebarWidth!)
              })
            }
          }}
        />
        {/* Session list — root-local concurrent sessions */}
        <div class="am-section am-section-grow">
          <div class="am-section-header">
            <span class="am-section-label">{t("agentManager.section.sessions")}</span>
            <div class="am-section-actions">
              <SidebarSearchMenu
                ref={(value) => (sidebarSearchMenu = value)}
                items={sidebarSearch.items}
                current={sidebarSearch.current}
                keybind={kb().search ?? ""}
                labels={{
                  search: t("agentManager.sidebarSearch.label"),
                  scope: t("agentManager.sidebarSearch.scope"),
                  sessions: t("agentManager.section.sessions"),
                  contexts: t("agentManager.sidebarSearch.contexts"),
                  waiting: t("agentManager.tabsMenu.status.waiting"),
                  retry: t("agentManager.tabsMenu.status.retry"),
                }}
                onSelect={focusSidebarSearchItem}
              />
              <TooltipKeybind
                title={t("agentManager.shortcuts.title")}
                keybind={kb().showShortcuts ?? ""}
                placement="bottom"
              >
                <IconButton
                  icon="keyboard"
                  size="small"
                  variant="ghost"
                  label={t("agentManager.shortcuts.title")}
                  onClick={metrics.click("keyboard_shortcuts", "session_header", handleShowKeyboardShortcuts)}
                />
              </TooltipKeybind>
            </div>
          </div>
          <div class="am-list" ref={listEl}>
            <Show when={sessionsLoaded() && !isGitRepo()}>
              <div class="am-not-git-notice">
                <Icon name="warning" size="small" />
                <span>{t("agentManager.notGitRepo")}</span>
              </div>
            </Show>
            <SidebarSessionList
              listContainer={() => listEl}
              sessions={session.sessions()}
              sessionsLoaded={sessionsLoaded()}
              preview={preview()}
              previewFailed={catalogFailed()}
              onRetryPreview={retryCatalog}
              currentSelection={session.currentSessionID() ?? null}
              onSelectSession={(id) => {
                handleOpenSession(id)
              }}
              untitledLabel={t("agentManager.session.untitled")}
              t={t}
              expanded={expanded}
              setExpanded={setExpanded}
            />
          </div>
        </div>
      </div>

      <div class="am-detail">
        {/* Tab bar — full version with tabs renders when a section is selected
            and has tabs; otherwise a minimal version still renders so the
            sidebar toggle button stays at a fixed position. */}
        <Show
          when={selection() !== null && !contextEmpty() && !isBottomPage()}
          fallback={
            <div class="am-tab-bar am-tab-bar-empty">
              <div class="am-tab-leading">
                <SidebarToggleButton collapsed={sidebarCollapsed()} onClick={toggleSidebar} />
              </div>
            </div>
          }
        >
          <DragDropProvider
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragYAxis />
            <div class="am-tab-bar" onPointerLeave={releaseTabs}>
              <div class="am-tab-leading">
                <SidebarToggleButton collapsed={sidebarCollapsed()} onClick={toggleSidebar} />
              </div>
              <div class="am-tab-scroll-area">
                <div class={`am-tab-fade am-tab-fade-left ${tabScroll.showLeft() ? "am-tab-fade-visible" : ""}`} />
                <div class="am-tab-list-wrap">
                  <div
                    class="am-tab-list"
                    ref={tabScroll.setRef}
                    role="tablist"
                    aria-label={t("agentManager.shortcuts.category.tabs")}
                    style={{ "--tab-count": `${tabIds().length}` } as JSX.CSSProperties}
                  >
                    <SortableProvider ids={tabIds()}>
                      <For each={tabIds()}>
                        {(id) =>
                          renderTab(id, {
                            terms,
                            tabIds,
                            kb,
                            currentSessionID: () => session.currentSessionID(),
                            activePendingId,
                            visibleTabId,
                            isPending,
                            isBusy: isSessionBusy,
                            tabLookup,
                            adjacentHint,
                            ctx,
                            tabMgrCloseOthers,
                            activateTerminal: termHandlers.activate,
                            deactivateTerminal: termHandlers.deactivate,
                            closeTerminal: (id) => tabFocus.run(() => termHandlers.closeTerminal(id)),
                            terminalMiddleClick: (id, event) =>
                              tabFocus.middle(event, () => termHandlers.middleClick(id, event)),
                            selectSessionTab,
                            sessionMiddleClick: handleTabMouseDown,
                            sessionClose: handleCloseTab,
                            sessionCloseMessage,
                            sessionFork: handleForkSession,
                            onTabKey: tabFocus.key,
                          })
                        }
                      </For>
                    </SortableProvider>
                  </div>
                </div>
                <div class={`am-tab-fade am-tab-fade-right ${tabScroll.showRight() ? "am-tab-fade-visible" : ""}`} />
              </div>
              <Show when={selection() !== null}>
                <div class="am-tab-add-wrap">
                  <div class="am-tab-add-separator" />
                  {renderNewTabButton({
                    contextSelected: () => selection() !== null,
                    kb,
                    newSessionLabel: t("agentManager.session.new"),
                    newTerminalLabel: t("agentManager.terminal.new"),
                    newSessionMenuLabel: t("agentManager.session.newSession"),
                    moreOptionsLabel: t("agentManager.tab.newOptions"),
                    onNewSession: metrics.click("new_session", "tab_bar", handleAddSession),
                    onNewTerminal: metrics.click("embedded_terminal", "new_tab_menu", () => termHandlers.requestNew()),
                  })}
                </div>
              </Show>
            </div>
            <DragOverlay>
              <Show when={draggedTab()}>
                {(tab) => (
                  <div class="am-tab am-tab-overlay">
                    <span class="am-tab-label">{tab().title || t("agentManager.session.untitled")}</span>
                  </div>
                )}
              </Show>
            </DragOverlay>
          </DragDropProvider>
        </Show>

        {/* Empty state */}
        <Show when={contextEmpty()}>
          <div class="am-empty-state">
            <div class="am-empty-state-icon">
              <Icon name="branch" size="large" />
            </div>
            <div class="am-empty-state-text">{t("agentManager.session.noSessions")}</div>
            <WorkStyleEmptyPicker />
            <Button variant="primary" size="small" onClick={handleAddSession}>
              {t("agentManager.session.new")}
              <span class="am-shortcut-hint">{kb().newTab ?? ""}</span>
            </Button>
          </div>
        </Show>

        <Show when={history()}>
          <HistoryView
            onSelectSession={(id) => {
              if (!handleOpenSession(id)) return
            }}
            onBack={() => setHistory(false)}
          />
        </Show>
        <Show when={!contextEmpty() && !history()}>
          {/* Terminal overlay is scoped to the main pane so it does not cover the tab bar. */}
          <div class="am-detail-stack">
            <div class="am-detail-content">
              <div class={`am-main-pane ${terms.activeId() ? "am-main-pane-terminal-active" : ""}`}>
                {/* Keep terminal tabs mounted so output streams across context switches. */}
                {renderTerminalLayer({ state: terms })}
                <div class="am-chat-wrapper">
                  <ChatView
                    onSelectSession={(id) => {
                      handleOpenSession(id)
                    }}
                    onShowHistory={() => setHistory(true)}
                    onForkMessage={handleForkSession}
                    onForkSession={handleForkSession}
                    promptBoxId="agent-manager:local"
                    pendingSessionID={activePendingId()}
                  />
                </div>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const AgentManagerApp: Component = () => {
  onMount(() => {
    // P0 perf: first DOM mount of the Agent Manager app (opt-in KILO_P0_PERF).
    p0WebviewStage("webview.mount")
  })
  return (
    <ThemeProvider defaultTheme="kilo-vscode">
      <DialogProvider>
        <VSCodeProvider>
          <MermaidDownloadBridge />
          <ServerProvider>
            <LanguageBridge>
              <MarkedProvider>
                <DiffComponentProvider component={Diff}>
                  <CodeComponentProvider component={Code}>
                    <FileComponentProvider component={File}>
                      <ProviderProvider>
                        <ConfigProvider>
                          <SpeechToTextPrewarm />
                          <DisplayProvider>
                            <ImageModelsProvider>
                              <SessionProvider>
                                <AgentRequirementsProvider>
                                  <FeedbackProvider>
                                    <AgentManagerProvider>
                                      <DataBridge>
                                        <AgentManagerContent />
                                      </DataBridge>
                                    </AgentManagerProvider>
                                  </FeedbackProvider>
                                </AgentRequirementsProvider>
                              </SessionProvider>
                            </ImageModelsProvider>
                          </DisplayProvider>
                        </ConfigProvider>
                      </ProviderProvider>
                    </FileComponentProvider>
                  </CodeComponentProvider>
                </DiffComponentProvider>
              </MarkedProvider>
            </LanguageBridge>
          </ServerProvider>
        </VSCodeProvider>
        <Toast.Region />
      </DialogProvider>
    </ThemeProvider>
  )
}
