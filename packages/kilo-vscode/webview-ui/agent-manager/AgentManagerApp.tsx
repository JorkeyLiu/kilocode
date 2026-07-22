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
  WorktreeFileDiff,
  LocalGitStats,
  RunStatus,
  SessionInfo,
  SessionCreatedMessage,
} from "../src/types/messages"
import { IndexingProvider } from "../src/context/indexing"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ThemeProvider } from "@kilocode/kilo-ui/theme"
import { DialogProvider, useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { DropdownMenu } from "@kilocode/kilo-ui/dropdown-menu"
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
import { Tooltip, TooltipKeybind } from "@kilocode/kilo-ui/tooltip"
import { Popover } from "@kilocode/kilo-ui/popover"
import { VSCodeProvider, useVSCode } from "../src/context/vscode"
import { ServerProvider } from "../src/context/server"
import { ProviderProvider } from "../src/context/provider"
import { ConfigProvider } from "../src/context/config"
import { DisplayProvider } from "../src/context/display"
import { KiloEmbeddingModelsProvider } from "../src/context/kilo-embedding-models"
import { ImageModelsProvider } from "../src/context/image-models"
import { NotificationsProvider } from "../src/context/notifications"
import { FeedbackProvider } from "../src/context/feedback"
import { MemoryProvider } from "../src/context/memory"
import { SessionProvider, useSession } from "../src/context/session"
import { AgentRequirementsProvider } from "../src/context/agent-requirements"
import { WorktreeModeProvider } from "../src/context/worktree-mode"
import { ChatView } from "../src/components/chat"
import { SpeechToTextPrewarm } from "../src/components/speech-to-text/SpeechToTextPrewarm"
import HistoryView from "../src/components/history/HistoryView"
import { SidebarSessionList } from "./SidebarSessionList"
import { DataBridge, MermaidDownloadBridge } from "../src/App"
import { LanguageBridge } from "../src/context/language-bridge"
import { useLanguage } from "../src/context/language"
import { formatRelativeDate } from "../src/utils/date"
import { createTabFocus } from "../src/utils/tab-navigation"
import { adjacentHint, focusChatSearch, LOCAL } from "./navigate"
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
import { DiffPanel } from "./DiffPanel"
import { createRevertFile } from "./revert-file"
import { FullScreenDiffView } from "../diff-viewer/FullScreenDiffView"
import type { ReviewComment } from "../diff-viewer/review-comments"
import { clearReviewComposer, createReviewComposer } from "../diff-viewer/review-annotations"
import type { SidebarSearchMenuRef } from "./SidebarSearchMenu"
import { SidebarSearchMenu } from "./SidebarSearchMenu"
import { createSidebarSearch, type SidebarSearchItem } from "./sidebar-search"
import { createNewTaskDrafts } from "./new-task-drafts"
import { mergeWorktreeDiffs } from "../diff-viewer/diff-state"
import { initialMessage, seedInitialVariant } from "./initial-message"
import { createMarkdownRender } from "./review-preferences"
import { createSidebarCollapse } from "./sidebar-collapse"
import { SidebarToggleButton } from "./SidebarToggleButton"
import { setTabWidths } from "./tab-widths"
import { buildShortcutCategories } from "./shortcuts"
import { tracker } from "./telemetry"
import { createSessionTabManager } from "./session-tab-manager"
import { openSession, type OpenSessionDeps } from "./open-session"
import "./agent-manager.css"
import "./agent-manager-review.css"
const REVIEW_TAB_ID = "review"

type SidePanel = "diff" | "pr" | null
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
  runScript: isMac ? "⌘E" : "Ctrl+E",
  toggleDiff: isMac ? "⌘D" : "Ctrl+D",
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
  const dialog = useDialog()
  let sidebarSearchMenu: SidebarSearchMenuRef | undefined

  const [kb, setKb] = createSignal<Record<string, string>>(defaultBindings)

  // Selection is always LOCAL.
  const selection = () => LOCAL
  const metrics = tracker(vscode)
  const [repoBranch, setRepoBranch] = createSignal<string | undefined>()
  const [sessionsLoaded, setSessionsLoaded] = createSignal(false)
  const [isGitRepo, setIsGitRepo] = createSignal(true)
  // worktreeId is a legacy field name from the extension message contract.
  const [managedSessions, setManagedSessions] = createSignal<{ id: string; worktreeId: string | null }[]>([])

  const DEFAULT_SIDEBAR_WIDTH = 260
  const MIN_SIDEBAR_WIDTH = 200
  const MAX_SIDEBAR_WIDTH_RATIO = 0.4

  // Load local UI state from webview state.
  const initialUI = loadLocalUIState(() => vscode.getState())
  const [localSessionIDs, setLocalSessionIDs] = createSignal<string[]>(initialUI.openTabIds)
  const [legacyImportDone, setLegacyImportDone] = createSignal(initialUI.legacyImported)
  // Phase 1B: per-context session tab registry (source of truth for tab strip).
  const tabMgr = createSessionTabManager()
  /** Remove a session ID from the local tab (no-op if absent). */
  const evictLocal = (sid: string) =>
    setLocalSessionIDs((prev) => (prev.includes(sid) ? prev.filter((id) => id !== sid) : prev))
  const handleSessionDeletedFromBackend = (msg: { type: string; sessionID: string }) => {
    const sid = msg.sessionID
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
  const handleViewChildSession = (id: string) => {
    openSession(id, openDeps)
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
  const handleToggleDiffAction = () => {
    if (reviewActive()) {
      closeReviewTab()
      setSidePanel("diff")
    } else setSidePanel((prev) => (prev === "diff" ? null : "diff"))
  }
  const [sidebarWidth, setSidebarWidth] = createSignal(initialUI.sidebarWidth)
  const [sessionsCollapsed, setSessionsCollapsed] = createSignal(true)
  const sidebar = createSidebarCollapse(vscode)
  // Phase 3B: hydrate sidebar collapsed from local UI state (not extension push)
  sidebar.hydrate(initialUI.sidebarCollapsed)
  const sidebarCollapsed = sidebar.collapsed
  const expandSidebar = sidebar.expand
  const toggleSidebar = sidebar.toggle

  // rAF coalescing for resize handlers — at most one signal write per frame
  let sidebarRaf: number | undefined
  let pendingSidebarWidth: number | undefined
  let diffRaf: number | undefined
  let pendingDiffWidth: number | undefined

  const [history, setHistory] = createSignal(false)
  const [sidePanel, setSidePanel] = createSignal<SidePanel>(null)
  const diffOpen = () => sidePanel() === "diff"
  const [diffDatas, setDiffDatas] = createSignal<Record<string, WorktreeFileDiff[]>>({})
  const [diffLoading, setDiffLoading] = createSignal(false)
  const [diffFileLoading, setDiffFileLoading] = createSignal<Record<string, Record<string, true>>>({})
  const [diffWidth, setDiffWidth] = createSignal(Math.round(window.innerWidth * 0.5))

  const [reviewOpenByContext, setReviewOpenByContext] = createSignal<Record<string, boolean>>({})
  const [reviewCommentsByContext, setReviewCommentsByContext] = createSignal<Record<string, ReviewComment[]>>({})
  const reviewComposer = createReviewComposer()
  const [reviewActive, setReviewActive] = createSignal(false)
  const [reviewDiffStyle, setReviewDiffStyle] = createSignal<"unified" | "split">(initialUI.reviewDiffStyle)
  const markdown = createMarkdownRender(vscode)

  const [runStatuses, setRunStatuses] = createSignal<Record<string, RunStatus>>({})
  const [runScriptConfigured, setRunScriptConfigured] = createSignal(false)

  // Local repo git stats (branch name, diff additions/deletions, commits)
  const [localStats, setLocalStats] = createSignal<LocalGitStats | undefined>()

  const PENDING_PREFIX = "pending:"
  const closedDrafts = new Set<string>()
  const [activePendingId, setActivePendingId] = createSignal<string | undefined>()

  // Per-sidebar-context terminal state. `terms.activeId` holds the id
  // of the focused terminal tab, if any — takes precedence over
  // session/pending/review when deriving the visible tab.
  const terms = createTerminalState(selection)

  createEffect(on(selection, () => clearReviewComposer(reviewComposer), { defer: true }))

  // Phase 3A: tabMemory removed — single LOCAL context, no per-context memory.

  const reviewOpen = createMemo(() => {
    const sel = selection()
    if (sel === null) return false
    return reviewOpenByContext()[sel] === true
  })

  const setReviewOpenForContext = (context: string, open: boolean) => {
    setReviewOpenByContext((prev) => {
      if (prev[context] === open) return prev
      return { ...prev, [context]: open }
    })
  }

  const setReviewOpenForSelection = (open: boolean) => {
    const sel = selection()
    if (sel === null) return
    setReviewOpenForContext(sel, open)
  }

  const reviewComments = createMemo(() => {
    const sel = selection()
    if (sel === null) return [] as ReviewComment[]
    return reviewCommentsByContext()[sel] ?? []
  })

  const setReviewCommentsForSelection = (comments: ReviewComment[]) => {
    const sel = selection()
    if (sel === null) return
    setReviewCommentsByContext((prev) => ({ ...prev, [sel]: comments }))
  }

  const isPending = (id: string) => id.startsWith(PENDING_PREFIX)
  reportRemoteSessions(vscode, localSessionIDs, managedSessions, isPending)

  // Drag-and-drop state for tab reordering
  const [draggingTab, setDraggingTab] = createSignal<string | undefined>()

  const freezeTabs = () => {
    const bar = document.querySelector(".am-tab-bar")
    if (bar instanceof HTMLElement && bar.matches(":hover")) setTabWidths(true)
  }

  const releaseTabs = () => setTabWidths(false)
  // Tab ordering: context key → ordered session ID array (recovered from extension state)
  const [tabOrder, setTabOrder] = createSignal<Record<string, string[]>>({})
  // Pin new tabs at the tail (see tab-order-sync); strip ephemeral ids so agent-manager.json stays clean.
  const persistTabOrder = (key: string, order: string[]) => {
    const durable = order.filter((id) => id !== REVIEW_TAB_ID && !isTerminalTabId(id))
    vscode.postMessage({ type: "agentManager.setTabOrder", key, order: durable })
  }
  const tabOrderSync = createTabOrderSync({
    LOCAL,
    REVIEW_TAB_ID,
    order: tabOrder,
    setOrder: setTabOrder,
    persist: persistTabOrder,
    localSessionIDs,
    sessions: session.sessions,
    managedSessions,
    reviewOpenByContext,
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
    const style = reviewDiffStyle()
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
          reviewDiffStyle: style,
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
    }
    tabOrderSync.append(LOCAL, id)
  }
  const openDeps: OpenSessionDeps = {
    tabMgr,
    selectSession: session.selectSession,
    setActivePendingId,
    setHistory,
    setReviewActive,
    setTermsActiveId: terms.setActiveId,
    setSelection: () => {},
    isPending,
    ensureLocal,
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
    const sel = selection()
    if (sel === null) {
      if (reviewActive()) setReviewActive(false)
      return
    }
    if (reviewActive() && !reviewOpen()) {
      setReviewActive(false)
    }
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
    if (reviewActive()) return REVIEW_TAB_ID
    return session.currentSessionID() ?? activePendingId()
  })
  const visibleSession = createMemo(() =>
    visible(session.currentSessionID(), !!terms.activeId() || reviewActive() || history() || contextEmpty()),
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
    worktrees: () => [],
    sections: () => [],
    local: localSessions,
    localBranch: repoBranch,
    selection,
    sessionId: session.currentSessionID,
    statuses: session.allStatusMap,
    permissions: session.permissions,
    questions: session.questions,
    label: () => "",
    sessions: () => [],
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
      openSession(item.sessionId, openDeps)
    }
  }

  const cycleAgent = (direction: 1 | -1) => {
    const available = session.agents().filter((a) => a.mode !== "subagent" && !a.hidden)
    if (available.length <= 1) return
    const current = session.selectedAgent()
    const idx = available.findIndex((a) => a.name === current)
    const raw = idx + direction
    const next = raw < 0 ? available.length - 1 : raw >= available.length ? 0 : raw
    const agent = available[next]
    if (agent) session.selectAgent(agent.name)
  }

  const syncRunStatuses = (items: RunStatus[] = []) => {
    const map: Record<string, RunStatus> = {}
    for (const item of items) map[item.worktreeId] = item // worktreeId is a legacy field name in RunStatus
    setRunStatuses(map)
  }

  onMount(() => {
    const actionMap: Record<string, () => void> = {
      sessionPrevious: () => {},
      sessionNext: () => {},
      tabPrevious: () => {},
      tabNext: () => {},
      search: handleSearchAction,
      showTerminal: handleShowTerminalAction,
      toggleDiff: handleToggleDiffAction,
      newTab: addPendingTab,
      closeTab: closeActiveTab,
      showShortcuts: handleShowKeyboardShortcuts,
      focusInput: () => window.dispatchEvent(new Event("focusPrompt")),
      focusSearch: () =>
        focusChatSearch({ history: setHistory, review: setReviewActive, terminal: () => terms.setActiveId(undefined) }),
      newTerminal: () => termHandlers.requestNew(),
    }
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === "navigate" && msg.view === "history") return setHistory(true)
      if (msg?.type === "viewChildSession" && msg.sessionID) {
        handleViewChildSession(msg.sessionID as string)
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
      // Prevent browser defaults for our shortcuts (new tab, close tab, new window, toggle diff, run, find)
      if (["t", "w", "n", "d", "e", "f"].includes(e.key.toLowerCase()) && !e.shiftKey) {
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

    const drafts = createNewTaskDrafts()

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
      if (!pending && localSessionIDs().includes(created.session.id)) return
      const active = activePendingId()
      const focus = !pending || pending === active
      placeLocal(created.session.id, pending, active)
      vscode.postMessage({
        type: "agentManager.persistSession",
        sessionId: created.session.id,
        draftID: created.draftID,
      })
      if (focus) session.selectSession(created.session.id)
    })

    // Mark sessions loaded as soon as the session context receives data (even if empty)
    const unsubSessions = vscode.onMessage((msg) => {
      if (msg.type === "sessionsLoaded" && !sessionsLoaded()) setSessionsLoaded(true)
    })

    const unsubRun = vscode.onMessage((msg) => {
      if (msg.type !== "agentManager.runStatus") return
      const ev = msg as RunStatus
      setRunStatuses((prev) => ({ ...prev, [ev.worktreeId]: ev })) // worktreeId is a legacy field name
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
        // Session stays in LOCAL tab context.
        const ev = msg as { type: string; sessionId: string; worktreeId: string } // worktreeId is legacy
        appendToTabOrder(LOCAL, ev.sessionId)
        tabMgr.open(LOCAL, ev.sessionId)
        drafts.apply(ev.worktreeId, ev.sessionId)
        session.selectSession(ev.sessionId)
      }

      if (msg.type === "agentManager.sessionForked") {
        // Forked session stays in LOCAL tab context.
        const ev = msg as { type: string; sessionId: string; forkedFromId: string; worktreeId?: string } // worktreeId is legacy
        tabOrderSync.insertAfter(LOCAL, ev.forkedFromId, ev.sessionId)
        setLocalSessionIDs((prev) => {
          const idx = prev.indexOf(ev.forkedFromId)
          if (idx >= 0) return [...prev.slice(0, idx + 1), ev.sessionId, ...prev.slice(idx + 1)]
          return [...prev, ev.sessionId]
        })
        tabMgr.open(LOCAL, ev.sessionId)
        vscode.postMessage({ type: "agentManager.persistSession", sessionId: ev.sessionId })
        session.selectSession(ev.sessionId)
      }

      if (msg.type === "agentManager.keybindings") {
        const ev = msg as AgentManagerKeybindingsMessage
        setKb(ev.bindings)
      }

      // Consume only local/repo/session fields from state.
      if (msg.type === "agentManager.state") {
        const state = msg as AgentManagerStateMessage
        setManagedSessions(state.sessions)
        if (state.isGitRepo !== undefined) setIsGitRepo(state.isGitRepo)
        if (!sessionsLoaded()) setSessionsLoaded(true)
        if (state.isGitRepo === false && !sessionsLoaded()) setSessionsLoaded(true)
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
        markdown.setRender(state.reviewMarkdownRender === true)
        setRunScriptConfigured(state.runScriptConfigured === true)
        syncRunStatuses(state.runStatuses)
        // One-time legacy import when no local UI state existed.
        if (!legacyImportDone() && localSessionIDs().length === 0) {
          const imported = importLegacyLocalTabs(
            {
              managedSessions: state.sessions,
              tabOrder: state.tabOrder,
              sidebarCollapsed: state.sidebarCollapsed,
              reviewDiffStyle: state.reviewDiffStyle,
            },
            LOCAL,
          )
          if (imported.openTabIds.length > 0) {
            setLocalSessionIDs(imported.openTabIds)
            tabMgr.seed(LOCAL, imported.openTabIds, imported.activeTabId)
            if (imported.activeTabId && !isPending(imported.activeTabId)) {
              session.selectSession(imported.activeTabId)
            }
          }
          if (imported.sidebarCollapsed !== undefined) sidebar.hydrate(imported.sidebarCollapsed)
          if (imported.reviewDiffStyle) setReviewDiffStyle(imported.reviewDiffStyle)
          setLegacyImportDone(true)
        }
        setRunStatuses((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id === LOCAL)))
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

      if (msg.type === "agentManager.worktreeDiff") {
        // Phase 4A: still consume diff data for the review/diff panel.
        const ev = msg as { type: string; sessionId: string; diffs: WorktreeFileDiff[] }
        let staleFiles: Set<string> | undefined
        setDiffDatas((prev) => {
          const existing = prev[ev.sessionId]
          const merged = existing
            ? mergeWorktreeDiffs(existing, ev.diffs)
            : { diffs: ev.diffs, stale: new Set<string>() }
          staleFiles = merged.stale
          const next = merged.diffs
          if (existing && existing.length === next.length && existing.every((old, i) => old === next[i])) return prev
          return { ...prev, [ev.sessionId]: next }
        })
        if (staleFiles) refreshStaleDiffs(ev.sessionId, staleFiles)
      }

      if (msg.type === "agentManager.worktreeDiffFile") {
        const ev = msg as { type: string; sessionId: string; file: string; diff?: WorktreeFileDiff }
        if (ev.diff) {
          setDiffDatas((prev) => {
            const existing = prev[ev.sessionId] ?? []
            const next = existing.map((item) => (item.file === ev.diff!.file ? ev.diff! : item))
            return { ...prev, [ev.sessionId]: next }
          })
          setDiffFilePending(ev.sessionId, ev.diff.file, false)
          return
        }
        setDiffFilePending(ev.sessionId, ev.file, false)
      }

      if (msg.type === "agentManager.worktreeDiffLoading") {
        const ev = msg as { type: string; loading: boolean }
        setDiffLoading(ev.loading)
      }

      if (msg.type === "agentManager.revertWorktreeFileResult") revertCtl.onResult(msg as never)

      if (msg.type === "agentManager.localStats") {
        const ev = msg as AgentManagerLocalStatsMessage
        setLocalStats(ev.stats)
        setRepoBranch(ev.stats.branch)
      }
    })

    const unsubDeleted = vscode.onMessage((msg) => {
      if (msg.type === "sessionDeleted") handleSessionDeletedFromBackend(msg as { type: string; sessionID: string })
    })

    onCleanup(() => {
      window.removeEventListener("message", handler)
      window.removeEventListener("keydown", preventDefaults, true)
      window.removeEventListener("focus", onWindowFocus)
      drafts.cleanup()
      unsubCreate()
      unsubSessions()
      unsubRun()
      unsubTerminals()
      unsub()
      unsubDeleted()
    })
  })

  onMount(() => {
    // Request state from extension
    vscode.postMessage({ type: "agentManager.requestState" })
    // Open a pending "New Session" tab if there are no persisted local sessions
    if (localSessionIDs().length === 0) {
      addPendingTab()
    }
    tabMgr.seed(LOCAL, localSessionIDs(), initialUI.activeTabId)
    // Phase 3B: restore active tab from local UI state
    if (initialUI.activeTabId && localSessionIDs().includes(initialUI.activeTabId)) {
      if (isPending(initialUI.activeTabId)) {
        setActivePendingId(initialUI.activeTabId)
      } else {
        session.selectSession(initialUI.activeTabId)
      }
    }
  })

  const selectedDiffSessionId = () => {
    return LOCAL
  }

  const currentDiffSessionId = createMemo(selectedDiffSessionId)

  // Start/stop diff watch when panel opens/closes, review tab opens, or session changes
  createEffect(() => {
    const panel = diffOpen()
    const review = reviewActive()

    if (panel || review) {
      const id = currentDiffSessionId()
      if (id) {
        vscode.postMessage({ type: "agentManager.startDiffWatch", sessionId: id })
        return
      }
      vscode.postMessage({ type: "agentManager.stopDiffWatch" })
      setDiffLoading(false)
      return
    }

    setDiffLoading(false)
    vscode.postMessage({ type: "agentManager.stopDiffWatch" })
  })

  onCleanup(() => {
    if (diffOpen() || reviewActive()) {
      vscode.postMessage({ type: "agentManager.stopDiffWatch" })
    }
  })

  const openReviewTab = () => {
    const sel = selection()
    if (sel === null) return
    terms.setActiveId(undefined)
    setSidePanel(null)
    setReviewOpenForContext(sel, true)
    setReviewActive(true)
  }

  const toggleReviewTab = () => {
    if (reviewActive()) {
      closeReviewTab()
      return
    }
    openReviewTab()
  }

  // Deferred close: flip signal immediately for instant UI feedback,
  // the <Show> unmount triggers heavy FileDiff cleanup but the tab bar
  // and chat view are already visible before that work runs.
  const closeReviewTab = () => {
    freezeTabs()
    setReviewActive(false)
    setReviewOpenForSelection(false)
    tabFocus.restore()
  }

  // Data for the review tab: use local diff data.
  const reviewDiffs = createMemo(() => {
    const data = diffDatas()
    const id = session.currentSessionID()
    if (id && data[id]) return data[id]!
    return data[LOCAL] ?? []
  })

  const diffSessionKey = createMemo(() => {
    return `local:${LOCAL}`
  })

  const setSharedDiffStyle = (style: "unified" | "split") => {
    if (reviewDiffStyle() === style) return
    setReviewDiffStyle(style)
    vscode.postMessage({ type: "agentManager.setReviewDiffStyle", style })
  }

  const setDiffFilePending = (sessionId: string, file: string, value: boolean) => {
    setDiffFileLoading((prev) => {
      const session = prev[sessionId] ?? {}
      if (value) {
        if (session[file]) return prev
        return {
          ...prev,
          [sessionId]: { ...session, [file]: true },
        }
      }

      if (!session[file]) return prev
      const next = { ...session }
      delete next[file]
      if (Object.keys(next).length === 0) {
        const result = { ...prev }
        delete result[sessionId]
        return result
      }
      return {
        ...prev,
        [sessionId]: next,
      }
    })
  }

  const requestDiffFile = (file: string) => {
    const sessionId = currentDiffSessionId()
    if (!sessionId) return
    if (diffFileLoading()[sessionId]?.[file]) return
    setDiffFilePending(sessionId, file, true)
    vscode.postMessage({ type: "agentManager.requestWorktreeDiffFile", sessionId, file })
  }

  const refreshStaleDiffs = (sessionId: string, files: Set<string>) => {
    const loading = diffFileLoading()[sessionId] ?? {}
    for (const file of files) {
      if (loading[file]) continue
      setDiffFilePending(sessionId, file, true)
      vscode.postMessage({ type: "agentManager.requestWorktreeDiffFile", sessionId, file })
    }
  }

  const diffFileLoadingForCurrent = createMemo(() => {
    const sessionId = currentDiffSessionId()
    if (!sessionId) return new Set<string>()
    return new Set(Object.keys(diffFileLoading()[sessionId] ?? {}))
  })

  const revertCtl = createRevertFile(currentDiffSessionId, vscode, showToast, t)

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
    expandSidebar()
    addPendingTab()
  }
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
    setReviewActive(false)
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
    selectReview: () => setReviewActive(true),
    selectSessionTab,
    clearSession: () => session.clearCurrentSession(),
    resetOthers: () => {
      setReviewActive(false)
      setActivePendingId(undefined)
      session.clearCurrentSession()
    },
    isPendingId: isPending,
    findTab: (id) => tabLookup().get(id),
    postMessage: (msg) => vscode.postMessage(msg as never),
    onRemove: freezeTabs,
    getSelection: selection,
    LOCAL,
    REVIEW_TAB_ID,
  })

  const handleReviewTabMouseDown = (e: MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    closeReviewTab()
  }

  // Drag-and-drop handlers for tab reordering
  const tabLookup = createMemo(() => new Map(activeTabs().map((s) => [s.id, s])))
  const tabIds = createMemo(() => {
    const ids = activeTabs().map((s) => s.id)
    const sel = selection()
    if (sel === null) return ids
    const withReview = reviewOpen() ? [...ids, REVIEW_TAB_ID] : ids
    const terminalIds = terms.current().map((t) => t.id)
    const base = [...withReview, ...terminalIds]
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
    // includes sessions, review, and terminals. `reorderTabs` moves
    // `from` to `to`'s position regardless of kind, so a user can slot
    // a terminal between two sessions or vice versa.
    const reordered = reorderTabs(tabIds(), from, to)
    if (!reordered) return
    setTabOrder((prev) => ({ ...prev, [key]: reordered }))
    // Keep the session-only list in sync for LOCAL so `localSessions()`
    // and membership checks stay aligned after a drag.
    if (key === LOCAL) {
      const sessionSubset = reordered.filter((id) => id !== REVIEW_TAB_ID && !isTerminalTabId(id))
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
    if (id === REVIEW_TAB_ID) return { id, title: t("session.tab.review") }
    if (isTerminalTabId(id)) {
      const term = terms.lookup().get(id)
      return term ? { id, title: term.title } : undefined
    }
    return activeTabs().find((s) => s.id === id)
  })

  const focusTab = (id: string) =>
    focusCurrentTab({
      id,
      terms,
      isTerminal: isTerminalTabId,
      isPending,
      reviewId: REVIEW_TAB_ID,
      reviewOpen,
      setReviewOpen: setReviewOpenForSelection,
      setReviewActive,
      tabLookup,
      setActivePendingId,
      clearSession: session.clearCurrentSession,
      selectSession: session.selectSession,
      activateTerminal: termHandlers.activate,
    })
  const tabFocus = createTabFocus({ ids: () => tabIds(), select: focusTab })

  // Close the currently active tab via keyboard shortcut.
  // If no tabs remain, nothing to close.
  const closeActiveTab = () => {
    if (termHandlers.closeActive()) {
      tabFocus.restore()
      return
    }
    if (reviewActive()) {
      closeReviewTab()
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
    addPendingTab()
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
        {/* Session list — worktree cards/sections removed */}
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
          <div class="am-list">
            <Show
              when={sessionsLoaded()}
              fallback={
                <div class="am-skeleton-list">
                  <div class="am-skeleton-session">
                    <div class="am-skeleton-session-title" style={{ width: "70%" }} />
                    <div class="am-skeleton-session-time" />
                  </div>
                  <div class="am-skeleton-session">
                    <div class="am-skeleton-session-title" style={{ width: "55%" }} />
                    <div class="am-skeleton-session-time" />
                  </div>
                </div>
              }
            >
              <Show when={!isGitRepo()}>
                <div class="am-not-git-notice">
                  <Icon name="warning" size="small" />
                  <span>{t("agentManager.notGitRepo")}</span>
                </div>
              </Show>
              <SidebarSessionList
                sessions={session.sessions()}
                sessionsLoaded={sessionsLoaded()}
                currentSelection={session.currentSessionID() ?? null}
                onSelectSession={(id) => {
                  openSession(id, openDeps)
                }}
                untitledLabel={t("agentManager.session.untitled")}
                t={t}
              />
            </Show>
          </div>
        </div>
      </div>

      <div class="am-detail">
        {/* Tab bar — full version with tabs renders when a section is selected
            and has tabs; otherwise a minimal version still renders so the
            sidebar toggle button stays at a fixed position. */}
        <Show
          when={selection() !== null && !contextEmpty()}
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
                            REVIEW_TAB_ID,
                            tabIds,
                            kb,
                            reviewActive,
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
                            closeReview: closeReviewTab,
                            reviewMiddleClick: handleReviewTabMouseDown,
                            selectReviewTab: () => setReviewActive(true),
                            selectSessionTab,
                            sessionMiddleClick: handleTabMouseDown,
                            sessionClose: handleCloseTab,
                            sessionCloseMessage,
                            sessionFork: handleForkSession,
                            onTabKey: tabFocus.key,
                            reviewLabel: t("session.tab.review"),
                            reviewTooltip: t("command.review.toggle"),
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
              <div class="am-tab-actions">
                {(() => {
                  const stats = () => localStats()
                  const hasChanges = () => {
                    const s = stats()
                    return s && (s.files > 0 || s.additions > 0 || s.deletions > 0)
                  }
                  return (
                    <>
                      {(() => {
                        const rs = () => runStatuses()[LOCAL]
                        const active = () => rs()?.state === "running" || rs()?.state === "stopping"
                        const configured = runScriptConfigured
                        const title = () => (configured() ? (active() ? "Stop" : "Run") : "Configure run script")
                        return (
                          <span
                            class={`am-run-group ${active() ? "am-run-active" : ""} ${!configured() ? "am-run-unconfigured" : ""}`}
                          >
                            <TooltipKeybind title={title()} keybind={kb().runScript ?? ""} placement="bottom">
                              <Button
                                size="small"
                                variant="ghost"
                                icon={active() ? "stop" : "play"}
                                disabled={rs()?.state === "stopping"}
                                onClick={metrics.click(
                                  "run_script",
                                  "tab_toolbar",
                                  () => {
                                    const state = rs()?.state ?? "idle"
                                    if (state === "running" || state === "stopping") {
                                      vscode.postMessage({ type: "agentManager.stopRunScript", worktreeId: LOCAL }) // worktreeId is legacy
                                      return
                                    }
                                    vscode.postMessage({ type: "agentManager.runScript", worktreeId: LOCAL }) // worktreeId is legacy
                                  },
                                  () => ({
                                    action: active() ? "stop" : configured() ? "run" : "configure",
                                  }),
                                )}
                              >
                                {active() ? "Stop" : "Run"}
                              </Button>
                            </TooltipKeybind>
                            <DropdownMenu gutter={4} placement="bottom-end">
                              <DropdownMenu.Trigger
                                as={(p: Record<string, unknown>) => (
                                  <IconButton
                                    {...p}
                                    icon="chevron-down"
                                    size="small"
                                    variant="ghost"
                                    label={t("agentManager.run.options")}
                                    class="am-run-group-chevron"
                                  />
                                )}
                              />
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content class="am-split-menu">
                                  <DropdownMenu.Item
                                    onSelect={metrics.click("configure_run_script", "run_menu", () =>
                                      vscode.postMessage({ type: "agentManager.configureRunScript" }),
                                    )}
                                  >
                                    <Icon name="settings-gear" size="small" />
                                    <DropdownMenu.ItemLabel>{t("agentManager.run.configure")}</DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu>
                          </span>
                        )
                      })()}
                      <TooltipKeybind
                        title={t("agentManager.diff.toggle")}
                        keybind={kb().toggleDiff ?? ""}
                        placement="bottom"
                      >
                        <button
                          class={`am-diff-toggle-btn ${diffOpen() && !reviewActive() ? "am-tab-diff-btn-active" : ""} ${hasChanges() ? "am-diff-toggle-has-changes" : ""}`}
                          onClick={() => {
                            metrics.track("side_review", "tab_toolbar", {
                              action: diffOpen() && !reviewActive() ? "close" : "open",
                            })
                            if (reviewActive()) {
                              closeReviewTab()
                              setSidePanel("diff")
                              return
                            }
                            setSidePanel((prev) => (prev === "diff" ? null : "diff"))
                          }}
                          title={t("agentManager.diff.toggle")}
                        >
                          <Icon name="layers" size="small" />
                          <Show when={hasChanges()}>
                            <span class="am-diff-toggle-stats">
                              <Show when={stats()!.files > 0}>
                                <span class="am-stat-files">{stats()!.files}f</span>
                              </Show>
                              <span class="am-stat-additions">+{stats()!.additions}</span>
                              <span class="am-stat-deletions">−{stats()!.deletions}</span>
                            </span>
                          </Show>
                        </button>
                      </TooltipKeybind>
                    </>
                  )
                })()}
                <Tooltip value={t("command.review.toggle")} placement="bottom">
                  <IconButton
                    icon="expand"
                    size="small"
                    variant="ghost"
                    label={t("command.review.toggle")}
                    class={reviewActive() ? "am-tab-diff-btn-active" : ""}
                    onClick={metrics.click("fullscreen_review", "tab_toolbar", toggleReviewTab)}
                  />
                </Tooltip>
                {/* Legacy VS Code integrated terminal shortcut. Coexists
                    with the xterm terminal tabs (accessed via the `+`
                    split-button or Cmd+Shift+T): Cmd+/ still opens the
                    integrated terminal for the active session. */}
                <TooltipKeybind
                  title={t("agentManager.tab.terminal")}
                  keybind={kb().showTerminal ?? ""}
                  placement="bottom"
                >
                  <IconButton
                    icon="console"
                    size="small"
                    variant="ghost"
                    label={t("agentManager.tab.openTerminal")}
                    onClick={() => {
                      metrics.track("vscode_terminal", "tab_toolbar")
                      const id = session.currentSessionID()
                      if (id) vscode.postMessage({ type: "agentManager.showTerminal", sessionId: id })
                      else if (selection() === LOCAL) vscode.postMessage({ type: "agentManager.showLocalTerminal" })
                    }}
                  />
                </TooltipKeybind>
              </div>
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
            <Button variant="primary" size="small" onClick={handleAddSession}>
              {t("agentManager.session.new")}
              <span class="am-shortcut-hint">{kb().newTab ?? ""}</span>
            </Button>
          </div>
        </Show>

        <Show when={history()}>
          <HistoryView
            onSelectSession={(id) => {
              if (!openSession(id, openDeps)) return
            }}
            onBack={() => setHistory(false)}
          />
        </Show>
        <Show when={!contextEmpty() && !history()}>
          {/* Terminal overlay is scoped to the main pane so it does not cover the tab bar or side panel. */}
          <div class="am-detail-stack">
            {/* Chat/terminal + side diff panel. Keep it mounted under the
                review tab so live xterm canvases never leave the paint tree. */}
            <div
              class={`am-detail-content ${sidePanel() !== null ? "am-detail-split" : ""} ${reviewActive() ? "am-detail-content-hidden" : ""}`}
            >
              <div class={`am-main-pane ${terms.activeId() ? "am-main-pane-terminal-active" : ""}`}>
                {/* Keep terminal tabs mounted so output streams across context switches. */}
                {renderTerminalLayer({ state: terms })}
                <div class="am-chat-wrapper">
                  <ChatView
                    onSelectSession={(id) => {
                      openSession(id, openDeps)
                    }}
                    onShowHistory={() => setHistory(true)}
                    onForkMessage={handleForkSession}
                    onForkSession={handleForkSession}
                    promptBoxId="agent-manager:local"
                    pendingSessionID={activePendingId()}
                  />
                </div>
              </div>
              <Show when={sidePanel() !== null}>
                <div class="am-diff-resize" style={{ width: `${diffWidth()}px` }}>
                  <ResizeHandle
                    direction="horizontal"
                    edge="start"
                    size={diffWidth()}
                    min={200}
                    max={Math.round(window.innerWidth * 0.8)}
                    onResize={(w) => {
                      pendingDiffWidth = Math.max(200, Math.min(w, window.innerWidth * 0.8))
                      if (diffRaf === undefined) {
                        diffRaf = requestAnimationFrame(() => {
                          diffRaf = undefined
                          setDiffWidth(pendingDiffWidth!)
                        })
                      }
                    }}
                  />
                  <div class="am-diff-panel-wrapper">
                    <Show when={sidePanel() === "diff"}>
                      <DiffPanel
                        diffs={reviewDiffs()}
                        loading={diffLoading()}
                        loadingFiles={diffFileLoadingForCurrent()}
                        sessionId={currentDiffSessionId()}
                        sessionKey={diffSessionKey()}
                        diffStyle={reviewDiffStyle()}
                        onDiffStyleChange={setSharedDiffStyle}
                        markdownRender={markdown.render()}
                        onMarkdownRenderChange={markdown.update}
                        comments={reviewComments()}
                        onCommentsChange={setReviewCommentsForSelection}
                        composer={reviewComposer}
                        onSendClick={() => metrics.track("send_review_comments", "side_review")}
                        onClose={metrics.click("side_review_close", "side_review", () => setSidePanel(null))}
                        onExpand={
                          selection() !== null
                            ? metrics.click("fullscreen_review", "side_review", openReviewTab, { action: "open" })
                            : undefined
                        }
                        onRequestDiff={requestDiffFile}
                        onOpenFile={(file, line) => {
                          const id = currentDiffSessionId()
                          if (id)
                            vscode.postMessage({ type: "agentManager.openFile", sessionId: id, filePath: file, line })
                          else if (selection() === LOCAL) vscode.postMessage({ type: "openFile", filePath: file, line })
                        }}
                        onRevertFile={metrics.use("revert_file", "side_review", revertCtl.revert)}
                        revertingFiles={revertCtl.reverting()}
                        activeTerminalId={terms.activeId()}
                      />
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
            {/* Full-screen review tab (lazy-mounted, stays alive once opened for fast toggle) */}
            <Show when={reviewOpen()}>
              <div class="am-review-host" style={{ display: reviewActive() && !terms.activeId() ? undefined : "none" }}>
                <FullScreenDiffView
                  diffs={reviewDiffs()}
                  loading={diffLoading()}
                  loadingFiles={diffFileLoadingForCurrent()}
                  sessionId={currentDiffSessionId()}
                  sessionKey={diffSessionKey()}
                  comments={reviewComments()}
                  onCommentsChange={setReviewCommentsForSelection}
                  composer={reviewComposer}
                  onSendAll={closeReviewTab}
                  onSendClick={() => metrics.track("send_review_comments", "fullscreen_review")}
                  diffStyle={reviewDiffStyle()}
                  onDiffStyleChange={setSharedDiffStyle}
                  markdownRender={markdown.render()}
                  onMarkdownRenderChange={markdown.update}
                  onRequestDiff={requestDiffFile}
                  onOpenFile={(file, line) => {
                    const id = currentDiffSessionId()
                    if (id) vscode.postMessage({ type: "agentManager.openFile", sessionId: id, filePath: file, line })
                    else if (selection() === LOCAL) vscode.postMessage({ type: "openFile", filePath: file, line })
                  }}
                  onRevertFile={metrics.use("revert_file", "fullscreen_review", revertCtl.revert)}
                  revertingFiles={revertCtl.reverting()}
                  activeTerminalId={terms.activeId()}
                  onClose={metrics.click("fullscreen_review", "fullscreen_review", closeReviewTab, { action: "close" })}
                />
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const AgentManagerApp: Component = () => {
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
                            <IndexingProvider>
                              <KiloEmbeddingModelsProvider>
                                <ImageModelsProvider>
                                  <NotificationsProvider>
                                    <SessionProvider>
                                      <AgentRequirementsProvider>
                                        <MemoryProvider>
                                          <FeedbackProvider>
                                            <WorktreeModeProvider>
                                              <DataBridge>
                                                <AgentManagerContent />
                                              </DataBridge>
                                            </WorktreeModeProvider>
                                          </FeedbackProvider>
                                        </MemoryProvider>
                                      </AgentRequirementsProvider>
                                    </SessionProvider>
                                  </NotificationsProvider>
                                </ImageModelsProvider>
                              </KiloEmbeddingModelsProvider>
                            </IndexingProvider>
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
