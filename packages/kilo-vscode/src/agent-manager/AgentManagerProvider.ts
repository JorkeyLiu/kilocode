import * as fs from "fs"
import * as path from "path"
import type { KiloClient, McpStatus, Message, Part, Session } from "@kilocode/sdk/v2/client"
import {
  summarizeMcp,
  summarizeMessage,
  summarizePermissions,
  summarizeQuestions,
  summarizeSession,
  summarizeStatuses,
  type BackendSnapshot,
  type McpTruth,
} from "./fixture-backend"
import type { KiloConnectionService } from "../services/cli-backend"
import type { ConnectionState } from "../services/cli-backend/connection-service"
import { getErrorMessage } from "../kilo-provider-utils"
import { observeSessionChildrenParityDetached } from "../kilo-provider/session-children-parity"
import { isAbsolutePath } from "../path-utils"
import { GitStatsPoller, type LocalStats } from "./GitStatsPoller"
import { GitOps } from "./GitOps"
import { SessionTerminalManager } from "./SessionTerminalManager"
import { createTerminalHost } from "./terminal-host"
import { TerminalRouter } from "./terminal-routing"
import { AgentManagerVisiblePresence } from "./am-visible-presence"
import { createLocalDiff, diffSummary as localDiffSummary } from "./local-diff"
import { parseToolRequest, startFromTool, type ToolRequest } from "./tool-start"
import { sandboxSessionMetadata } from "../shared/sandbox-session"
import { startSession } from "./mcp-warmup"
import { readTerminalFont, watchTerminalFont } from "./terminal-font"
import { buildKeybindingMap } from "./format-keybinding"
import { Semaphore } from "./semaphore"
import { SessionTiming } from "./session-timing"
import { PLATFORM } from "./constants"
import * as Persist from "./persistence"
import type { AgentManagerOutMessage, AgentManagerInMessage, ManagedSession } from "./types"
import type { Host, PanelContext, OutputHandle, Disposable } from "./host"
import type { PrivateObservationService } from "../private-worker/private-observation-service"
import type { TriggerResult } from "../private-worker/private-observation-lifecycle-triggers"
import { AgentManagerObservationCoordinator } from "./observation-coordinator"

export class AgentManagerProvider implements Disposable {
  public static readonly viewType = "kilo-code.new.AgentManagerPanel"
  private panel: PanelContext | undefined
  private outputChannel: OutputHandle
  private terminalManager: SessionTerminalManager
  private terminalRouter: TerminalRouter
  private stateReady: Promise<void> | undefined
  private statsPoller: GitStatsPoller
  private gitOps: GitOps
  private toolRequests = new Set<string>()
  private cachedLocalStats: { type: "agentManager.localStats"; stats: LocalStats } | undefined
  private unsubTool: (() => void) | undefined
  private unsubStatus: (() => void) | undefined
  private unsubDeleted: (() => void) | undefined
  private unsubFont: (() => void) | undefined
  private unsubConnectionState: (() => void) | undefined
  private prevConnectionState: ConnectionState
  private seenConnected = false
  private timing: SessionTiming
  private closing: Promise<void> | undefined
  private visibilityCbs: Array<(visible: boolean) => void> = []
  private activeSessionCbs: Array<(id: string) => void> = []
  // Tracks sessions owned by this panel until they are explicitly closed.
  private panelSessions = new Set<string>()
  private managedSessions = new Map<string, ManagedSession>()
  private tabOrder: Record<string, string[]> = {}
  private sessionsCollapsed = false
  private sidebarCollapsed = false

  /** Session ID most recently loaded via `loadMessages`; updated synchronously. */
  private activeSessionId: string | undefined
  private pendingSnapshot: Persist.State | null = null
  private persistInFlight: Promise<void> | null = null
  private catalogUnsub: Disposable | undefined
  private readonly LOCAL = "local"
  // In-flight real sessions not yet confirmed in the authoritative catalog.
  // Protects the first real session from a stale empty catalog race before
  // the webview's persist adds it to durable state and the next catalog includes it.
  private recentSessions = new Set<string>()
  private accumulatedCatalog: Set<string> | undefined
  private accumulatedHasMore: boolean | undefined
  // Deletion barrier within current catalog collection cycle.
  // On real session.deleted, the ID is tombstoned and filtered from subsequent
  // append pages and final effective catalog until a fresh append=false refresh.
  private catalogTombstone = new Set<string>()
  private visiblePresence = new AgentManagerVisiblePresence(
    (ids) => this.connectionService.registerVisible("agent-manager", ids),
    () => this.panel?.visible ?? false,
    (ids) => this.connectionService.registerAttached("agent-manager", ids),
  )
  private hydrated = false
  private generation = 0
  private refreshPromise: Promise<void> | null = null
  private refreshGen: number | null = null
  private refreshSessions: unknown | null = null
  private coordinator: AgentManagerObservationCoordinator | undefined
  constructor(
    private readonly host: Host,
    private readonly connectionService: KiloConnectionService,
    privateObservation?: PrivateObservationService,
  ) {
    if (privateObservation) this.coordinator = new AgentManagerObservationCoordinator(privateObservation)
    this.outputChannel = host.createOutput("Kilo Agent Manager")
    this.timing = new SessionTiming(host.workspaceStore)
    this.terminalManager = new SessionTerminalManager(
      (msg) => this.outputChannel.appendLine(`[SessionTerminal] ${msg}`),
      createTerminalHost(),
    )
    this.terminalRouter = new TerminalRouter({
      getClient: () => this.connectionService.getClient(),
      getServerConfig: () => this.connectionService.getServerConfig() ?? undefined,
      getRoot: () => this.getRoot(),
      log: (...args) => this.log("[XTerm]", ...args),
      post: (msg) => this.postToWebview(msg),
      getTerminalFont: () => readTerminalFont(),
    })
    this.unsubFont = watchTerminalFont((font) => {
      this.postToWebview({ type: "agentManager.terminal.fontChanged", font })
    })
    const semaphore = new Semaphore(3)
    this.gitOps = new GitOps({ log: (...args) => this.log(...args), semaphore })
    const local = createLocalDiff(this.gitOps, (...args) => this.log(...args))
    this.statsPoller = new GitStatsPoller({
      getWorkspaceRoot: () => this.getRoot(),
      localDiff: (dir, base) => localDiffSummary(this.gitOps, dir, base, (...args) => this.log(...args)),
      semaphore,
      onLocalStats: (stats) => {
        const msg = { type: "agentManager.localStats" as const, stats }
        this.cachedLocalStats = msg
        this.postToWebview(msg)
      },
      log: (...args) => this.log(...args),
      git: this.gitOps,
    })
    this.unsubTool = this.connectionService.onEventFiltered(
      (event) => (event as { type?: string }).type === "kilocode.agent_manager.start",
      (event, directory) => this.onToolEvent(event, directory),
    )
    this.unsubStatus = this.connectionService.onEventFiltered(
      (event) => (event as { type?: string }).type === "session.status",
      (event) => this.onSessionStatus(event),
    )
    // Prune timing state when the backend deletes a session (external delete,
    // sidebar delete, or CLI/TUI cascade). Tab close is view lifecycle only
    // and retains timing; an explicit Agent Manager forgetSession prunes.
    this.unsubDeleted = this.connectionService.onEventFiltered(
      (event) => (event as { type?: string }).type === "session.deleted",
      (event) => this.onSessionDeleted(event),
    )
    this.prevConnectionState = this.connectionService.getConnectionState()
    this.seenConnected = this.prevConnectionState === "connected"
    this.unsubConnectionState = this.connectionService.onStateChange((state) => this.onConnectionState(state))
  }

  private onConnectionState(state: ConnectionState): void {
    if (state !== "connected") {
      this.prevConnectionState = state
      return
    }
    if (!this.seenConnected) {
      this.seenConnected = true
      this.prevConnectionState = state
      return
    }
    const prev = this.prevConnectionState
    this.prevConnectionState = state
    if (prev === "connected") return
    if (!this.hydrated) return
    if (!this.panel?.visible) return
    this.triggerVisibleObservationRefresh()
  }

  private triggerVisibleObservationRefresh(): void {
    const genAtCall = this.generation
    const sessionsAtCall = this.panel?.sessions
    if (!sessionsAtCall) return
    if (!this.panel?.visible) return
    void this.waitForStateReady("observationRefreshVisible").then(() => {
      if (this.generation !== genAtCall) return
      if (this.panel?.sessions !== sessionsAtCall) return
      if (!this.panel?.visible) return
      void this.handleObservationRefresh()
    })
  }

  private onSessionStatus(event: unknown): void {
    const props = (event as { properties?: { sessionID?: string; status?: { type?: string } } }).properties
    const sid = props?.sessionID
    const type = props?.status?.type
    if (!sid || !type) return
    // Persist and push only on actual timing boundaries. Duplicate active and
    // duplicate idle events are idempotent (onStatus reports no change) and
    // must not trigger a redundant full Agent Manager state push.
    const changed = this.timing.onStatus(sid, type)
    if (!changed) return
    // Push fresh snapshots on status boundaries so the open panel renders the
    // settled cumulative value as soon as a segment ends. Posting to a closed
    // panel is a no-op; the panel bootstrap reads the full map on request.
    this.pushState()
  }

  /**
   * Prune timing state when the backend deletes a session (external delete,
   * sidebar delete, or CLI/TUI cascade). This is the reliable permanent
   * deletion boundary: the entry must survive view lifecycle (tab close,
   * panel hide, reload), so only this path forgets on a backend deletion.
   * An explicit Agent Manager forgetSession prunes directly instead.
   */
  private onSessionDeleted(event: unknown): void {
    const sid = (event as { properties?: { sessionID?: string } }).properties?.sessionID
    if (!sid) return
    this.timing.forget(sid)
    if (!this.catalogTombstone) this.catalogTombstone = new Set<string>()
    this.catalogTombstone.add(sid)
    if (!this.recentSessions) this.recentSessions = new Set<string>()
    const hadRecent = this.recentSessions.has(sid)
    if (hadRecent) this.recentSessions.delete(sid)
    if (this.accumulatedCatalog) this.accumulatedCatalog.delete(sid)
    let changed = false
    if (this.managedSessions.has(sid)) {
      this.managedSessions.delete(sid)
      changed = true
    }
    const order = this.tabOrder[this.LOCAL]
    if (order && order.includes(sid)) {
      this.tabOrder[this.LOCAL] = order.filter((id) => id !== sid)
      changed = true
    }
    if (this.activeSessionId === sid) {
      this.activeSessionId = this.tabOrder[this.LOCAL]?.[0] ?? [...this.managedSessions.keys()][0]
      changed = true
    }
    if (changed) {
      this.schedulePersist()
      this.pushState()
    }
  }

  private log(...args: unknown[]) {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
    this.outputChannel.appendLine(`${new Date().toISOString()} ${msg}`)
  }

  public openPanel(preserveFocus?: boolean): void {
    if (this.panel) {
      this.log("Panel already open, revealing")
      this.panel.reveal(preserveFocus)
      if (!preserveFocus) this.postToWebview({ type: "action", action: "focusInput" })
      return
    }
    this.log("Opening Agent Manager panel")
    this.host.capture("Agent Manager Opened", { source: PLATFORM })

    this.attachPanel(
      this.host.openPanel({
        onBeforeMessage: (msg) => this.onMessage(msg),
      }),
    )
  }

  public onPanelVisibilityChange(cb: (visible: boolean) => void): Disposable {
    this.visibilityCbs.push(cb)
    return {
      dispose: () => {
        const idx = this.visibilityCbs.indexOf(cb)
        if (idx >= 0) this.visibilityCbs.splice(idx, 1)
      },
    }
  }

  public onActiveSessionChanged(cb: (id: string) => void): Disposable {
    this.activeSessionCbs.push(cb)
    return {
      dispose: () => {
        const idx = this.activeSessionCbs.indexOf(cb)
        if (idx >= 0) this.activeSessionCbs.splice(idx, 1)
      },
    }
  }

  private emitVisibilityChanged(visible: boolean): void {
    for (const cb of [...this.visibilityCbs]) {
      try {
        cb(visible)
      } catch (e) {
        this.log("onPanelVisibilityChange callback failed:", e)
      }
    }
  }

  private emitActiveSessionChanged(id: string): void {
    for (const cb of [...this.activeSessionCbs]) {
      try {
        cb(id)
      } catch (e) {
        this.log("onActiveSessionChanged callback failed:", e)
      }
    }
  }

  /** Restore the Agent Manager panel from a previously serialized state. */
  public deserializePanel(ctx: PanelContext): void {
    if (this.panel) {
      this.log("Panel already exists during deserialization, disposing duplicate")
      ctx.dispose()
      return
    }
    this.log("Deserializing Agent Manager panel")
    this.attachPanel(ctx)
  }

  /** Message interceptor — exposed for the deserialization path in extension.ts. */
  public handleMessage(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.onMessage(msg)
  }

  /**
   * Fixture-only: targeted reload preserving same outer PanelContext, inner KiloProvider,
   * streams and listeners. Only HTML is reassigned; readiness awaits next real webviewReady.
   * No panel/catalog/visibility replacement, no synthetic state injection.
   */
  public async reloadWebviewForFixture(): Promise<void> {
    const cur = this.panel
    if (!cur) throw new Error("AgentManagerProvider: no panel to reload")
    const hostAny = this.host as unknown as { reloadAgentManagerPanelForFixture?: () => Promise<PanelContext | void> }
    if (!hostAny.reloadAgentManagerPanelForFixture) throw new Error("Host does not support AM reload")
    await hostAny.reloadAgentManagerPanelForFixture()
  }

  /** Wire up a panel context (shared by openPanel and deserializePanel). */
  private attachPanel(ctx: PanelContext): void {
    if (this.panel) {
      this.log("Disposing previous panel before attaching new one")
      const panel = this.panel
      this.panel = undefined
      panel.dispose()
    }
    this.panel = ctx

    this.statsPoller.setVisible(ctx.visible)
    this.emitVisibilityChanged(ctx.visible)
    ctx.onDidChangeVisibility((visible) => {
      this.statsPoller.setVisible(visible)
      this.visiblePresence.flush()
      this.emitVisibilityChanged(visible)
      if (visible) this.triggerVisibleObservationRefresh()
    })

    if (this.catalogUnsub) {
      this.catalogUnsub.dispose()
      this.catalogUnsub = undefined
    }
    this.accumulatedCatalog = undefined
    this.accumulatedHasMore = undefined
    if (!this.catalogTombstone) this.catalogTombstone = new Set<string>()
    this.catalogTombstone.clear()
    if (ctx.sessions.onCatalog) {
      this.catalogUnsub = ctx.sessions.onCatalog((update) => this.onCatalogUpdate(update))
    }
    this.generation++
    this.hydrated = false
    this.stateReady = this.initializeState()
    void this.sendRepoInfo()
    this.sendKeybindings()
    let panelDisposed = false
    ctx.onDidDispose(() => {
      if (panelDisposed) return
      panelDisposed = true
      if (this.panel === ctx) {
        this.log("Panel disposed")
        const ids = [...this.panelSessions]
        if (this.activeSessionId) ids.push(this.activeSessionId)
        this.panelSessions.clear()
        void ctx.sessions.abortSessions(ids).catch((err) => this.log("Failed to abort sessions on panel close:", err))
        this.statsPoller.stop()
        // Durable open-tab state survives panel dispose; only ephemeral
        // presence/streams are cleared. Keep managedSessions/tabOrder/active
        // in memory and in workspaceStore for next attach. Do not mutate
        // durable fields or schedule a cleared snapshot here.
        // this.activeSessionId = undefined // intentionally not cleared; durable survives
        this.visiblePresence.clear()
        this.panel = undefined
        this.emitVisibilityChanged(false)
        if (this.catalogUnsub) {
          this.catalogUnsub.dispose()
          this.catalogUnsub = undefined
        }
      }
      ctx.sessions.dispose()
    })
  }

  // State initialization

  private initializationOp: Promise<void> | null = null

  private async initializeState(): Promise<void> {
    if (this.initializationOp) return this.initializationOp
    const op = this.runInitialization()
    this.initializationOp = op
    try {
      await op
    } finally {
      if (this.initializationOp === op) this.initializationOp = null
    }
  }

  private async runInitialization(): Promise<void> {
    const hasDirty = this.persistInFlight !== null || this.pendingSnapshot !== null
    if (hasDirty) {
      await this.flush()
      if (this.pendingSnapshot) {
        this.log("initializeState: persist pending retained after bounded retry, preserving intended snapshot")
        const latest = this.pendingSnapshot
        this.managedSessions.clear()
        for (const id of latest.sessions) this.managedSessions.set(id, { id })
        this.tabOrder[this.LOCAL] = [...latest.order]
        this.activeSessionId = latest.active
        if (this.activeSessionId && !this.managedSessions.has(this.activeSessionId)) this.activeSessionId = undefined
        if (this.panel) this.pushState()
        return
      }
    }
    this.loadPersisted()
    if (this.panel) this.pushState()
  }

  private loadPersisted(): void {
    // Store is authoritative for durable fields at every attach.
    // Missing/malformed store clears durable fields; no merge with retained memory.
    const p = Persist.load(this.host.workspaceStore)
    this.managedSessions.clear()
    this.tabOrder = {}
    this.activeSessionId = undefined
    if (!p) return
    for (const id of p.sessions) this.managedSessions.set(id, { id })
    // Persisted order is already normalized (subset/permutation), but rebuild
    // defensively to append any omitted sessions deterministically.
    const order = p.order.length > 0 ? [...p.order] : [...p.sessions]
    this.tabOrder[this.LOCAL] = [...order]
    if (p.active && this.managedSessions.has(p.active)) this.activeSessionId = p.active
  }

  private buildPersisted(): Persist.State {
    const sessions = [...this.managedSessions.keys()]
    const order = this.tabOrder[this.LOCAL] ?? []
    return Persist.build(sessions, order, this.activeSessionId)
  }

  private schedulePersist(): void {
    if (!this.host?.workspaceStore) return
    const snapshot = this.buildPersisted()
    this.pendingSnapshot = snapshot
    if (this.persistInFlight) return
    void this.runPersistLoop()
  }

  private async runPersistLoop(): Promise<void> {
    if (this.persistInFlight) return
    const loop = (async () => {
      while (this.pendingSnapshot) {
        const toWrite = this.pendingSnapshot
        this.pendingSnapshot = null
        try {
          await this.host.workspaceStore.update(Persist.KEY, toWrite)
        } catch (err) {
          this.log("persist failed:", err)
          if (this.pendingSnapshot) {
            // Newer dirty snapshot already coalesced; keep it for next retry.
          } else {
            this.pendingSnapshot = toWrite
          }
          break
        }
      }
    })()
    this.persistInFlight = loop
    try {
      await loop
    } finally {
      this.persistInFlight = null
      // If a new mutation arrived after we broke on failure, it will be
      // retried on next mutation/flush without an unbounded timer loop.
      // On success, a newly enqueued pending will have been drained by the
      // while loop; if one arrived after the loop exited, the next
      // schedulePersist will start a new loop.
    }
  }

  public async flush(): Promise<void> {
    if (this.persistInFlight) {
      try {
        await this.persistInFlight
      } catch {}
      if (this.pendingSnapshot) {
        try {
          await this.runPersistLoop()
        } catch {}
      }
      return
    }
    if (this.pendingSnapshot) {
      try {
        await this.runPersistLoop()
      } catch {}
    }
  }

  private onCatalogUpdate(update: { ids: string[]; append?: boolean; hasMore?: boolean }): void {
    const { ids, append, hasMore } = update
    if (!this.catalogTombstone) this.catalogTombstone = new Set<string>()
    if (append !== true) this.catalogTombstone.clear()
    const filtered = ids.filter((id) => !this.catalogTombstone.has(id))
    if (append === true && this.accumulatedCatalog) {
      for (const id of filtered) this.accumulatedCatalog.add(id)
    } else if (append === true && !this.accumulatedCatalog) {
      this.accumulatedCatalog = new Set(filtered)
    } else {
      this.accumulatedCatalog = new Set(filtered)
    }
    // Ensure tombstoned IDs never linger in accumulated across appends
    for (const del of this.catalogTombstone) this.accumulatedCatalog?.delete(del)
    this.accumulatedHasMore = hasMore
    if (hasMore === true) return
    const effective = [...(this.accumulatedCatalog ?? new Set<string>())]
    this.reconcile(effective)
  }

  private reconcile(ids: string[]): void {
    const catalog = new Set(ids)
    if (!this.recentSessions) this.recentSessions = new Set<string>()
    // Consume recent in-flight IDs once the catalog includes them
    for (const id of [...this.recentSessions]) if (catalog.has(id)) this.recentSessions.delete(id)
    const effective = new Set([...catalog, ...this.recentSessions])
    let changed = false
    for (const sid of [...this.managedSessions.keys()]) {
      if (!effective.has(sid)) {
        this.managedSessions.delete(sid)
        changed = true
      }
    }
    // Order/active are subsets of the resulting managed sessions, not catalog alone.
    const remaining = new Set(this.managedSessions.keys())
    const order = this.tabOrder[this.LOCAL]
    if (order) {
      const filtered = order.filter((id) => remaining.has(id))
      if (filtered.length !== order.length) {
        this.tabOrder[this.LOCAL] = filtered
        changed = true
      }
      // Append any remaining sessions missing from order deterministically.
      const missing = [...remaining].filter((id) => !filtered.includes(id))
      if (missing.length > 0) {
        this.tabOrder[this.LOCAL] = [...filtered, ...missing]
        changed = true
      }
    } else if (remaining.size > 0) {
      this.tabOrder[this.LOCAL] = [...remaining]
      changed = true
    }
    if (this.activeSessionId && !remaining.has(this.activeSessionId)) {
      const ord = this.tabOrder[this.LOCAL] ?? [...remaining]
      this.activeSessionId = ord[0]
      changed = true
    }
    if (changed) {
      this.schedulePersist()
      this.pushState()
    }
  }

  // Message interceptor

  private async onMessage(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (msg.type === "requestFileSearch" && typeof msg.sessionID !== "string" && this.activeSessionId) {
      return { ...msg, sessionID: this.activeSessionId }
    }
    msg = await this.contextMessage(msg)
    const m = msg as unknown as AgentManagerInMessage
    if (this.shouldWaitForState(m)) await this.waitForStateReady(m.type)

    const session = this.onSessionMessage(m, msg)
    if (session !== undefined) return session
    const ui = this.onUiMessage(m, msg)
    if (ui !== undefined) return ui
    const state = this.onStateMessage(m)
    if (state !== undefined) return state
    if (this.terminalRouter.handle(m)) return null

    return msg
  }

  private async contextMessage(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (msg.type !== "requestGitChangesContext") return msg
    const ctx = typeof msg.agentManagerContext === "string" ? msg.agentManagerContext : undefined
    if (ctx === "local" || !ctx) {
      const sid = typeof msg.sessionID === "string" ? msg.sessionID : this.activeSessionId
      const next = sid && typeof msg.sessionID !== "string" ? { ...msg, sessionID: sid } : msg
      const root = this.getRoot()
      if (!root) return next
      return { ...next, contextDirectory: root }
    }
    return msg
  }

  private onSessionMessage(
    m: AgentManagerInMessage,
    msg: Record<string, unknown>,
  ): Record<string, unknown> | null | undefined {
    if (m.type === "agentManager.closeSession") {
      void this.onCloseSession(m.sessionId)
      return null
    }

    if (m.type === "agentManager.forkSession") {
      void this.onForkSession(m.sessionId, m.messageId)
      return null
    }

    if (m.type === "agentManager.persistSession" || m.type === "agentManager.forgetSession") {
      const persist = m.type === "agentManager.persistSession"
      const pendingDraft = persist && m.draftID ? m.draftID : undefined
      const isTrueCreation = !!pendingDraft && this.panelSessions.has(pendingDraft)
      if (persist && m.draftID) {
        this.panel?.sessions.acknowledgeDraft(m.draftID, m.sessionId)
        this.panelSessions.delete(m.draftID)
        this.panelSessions.add(m.sessionId)
      }
      if (persist) {
        if (!this.managedSessions.has(m.sessionId)) this.addSession(m.sessionId, { recent: isTrueCreation })
        else {
          if (isTrueCreation) {
            if (!this.recentSessions) this.recentSessions = new Set<string>()
            this.recentSessions.add(m.sessionId)
          }
          this.schedulePersist()
        }
      } else {
        // Explicit permanent forget (counterpart of persistSession): the
        // session leaves the manager's persisted registry, so its timing
        // entry goes with it. This is not the tab-close path.
        if (!this.recentSessions) this.recentSessions = new Set<string>()
        this.recentSessions.delete(m.sessionId)
        this.managedSessions.delete(m.sessionId)
        this.timing.forget(m.sessionId)
        if (this.tabOrder && this.LOCAL) {
          const ord = this.tabOrder[this.LOCAL]
          if (ord) this.tabOrder[this.LOCAL] = ord.filter((id) => id !== m.sessionId)
          if (this.activeSessionId === m.sessionId)
            this.activeSessionId = this.tabOrder[this.LOCAL]?.[0] ?? [...this.managedSessions.keys()][0]
        }
        this.schedulePersist()
        if (this.pushState) this.pushState()
      }
      return null
    }

    if (
      m.type === "requestSandboxDefault" ||
      m.type === "setSandboxDefault" ||
      ((m.type === "sendMessage" || m.type === "sendCommand" || m.type === "toggleSandbox") && !m.sessionID)
    ) {
      if (m.type === "sendMessage" || m.type === "sendCommand") {
        if (m.draftID) this.panelSessions.add(m.draftID)
      }
    }

    if (
      (m.type === "sendMessage" || m.type === "sendCommand" || m.type === "toggleSandbox") &&
      m.draftID &&
      !m.sessionID
    ) {
      // Draft/pending IDs are never durable. Keep ephemeral active separate
      // until the session is registered via persistSession; do not persist.
      // We track the draft for panel lifecycle but do not update durable active.
      return msg
    }

    if (m.type === "requestTerminalContext") {
      if (!m.sessionID || this.terminalManager.prepareContext(m.sessionID)) return msg
      this.panel?.postMessage({
        type: "terminalContextError",
        requestId: m.requestId,
        error: "No terminal is associated with this session",
      })
      return null
    }

    if (m.type === "loadMessages") {
      const prev = this.activeSessionId
      this.activeSessionId = m.sessionID
      this.terminalManager.syncOnSessionSwitch(m.sessionID)
      this.emitActiveSessionChanged(m.sessionID)
      this.schedulePersist()
      if (prev !== m.sessionID) this.triggerObservationRefresh()
      return msg
    }

    if (m.type === "clearSession") {
      this.activeSessionId = undefined
      this.visiblePresence.setDisplayed(null)
      void Promise.resolve().then(() => {
        if (!this.panel) return
        for (const id of this.managedSessions.keys()) {
          this.panel.sessions.trackSession(id)
        }
      })
      return msg
    }

    if (m.type === "abort") {
      this.host.capture("Agent Manager Session Stopped", {
        source: PLATFORM,
        sessionId: m.sessionID,
      })
      return msg
    }

    if (m.type === "agentManager.openSessions") {
      for (const id of m.sessionIDs) this.panelSessions.add(id)
    }
    if (m.type === "agentManager.openSessions" || m.type === "agentManager.visibleSession") {
      this.visiblePresence.handle(m)
      return null
    }
  }

  private onUiMessage(
    m: AgentManagerInMessage,
    msg: Record<string, unknown>,
  ): Record<string, unknown> | null | undefined {
    if (m.type === "agentManager.showTerminal") {
      this.terminalManager.showTerminal(m.sessionId)
      return null
    }
    if (m.type === "agentManager.showLocalTerminal") {
      this.terminalManager.showLocalTerminal()
      return null
    }
    if (m.type === "agentManager.copyToClipboard") {
      this.host.copyToClipboard(m.text)
      return null
    }
    if (m.type === "previewImage") return msg
    if (m.type === "saveImage") return msg
    if (m.type === "agentManager.showExistingLocalTerminal") {
      this.terminalManager.syncLocalOnSessionSwitch()
      return null
    }
    if (m.type === "agentManager.requestRepoInfo") {
      void this.sendRepoInfo()
      return null
    }
    if (m.type === "agentManager.openFile") {
      this.openFile(m.sessionId, m.filePath, m.line, m.column)
      return null
    }
  }

  private onStateMessage(m: AgentManagerInMessage): Record<string, unknown> | null | undefined {
    if (m.type === "agentManager.requestState") {
      this.onRequestState()
      return null
    }
    if (m.type === "agentManager.setTabOrder") {
      this.tabOrder[m.key] = m.order
      if (m.key === this.LOCAL) this.schedulePersist()
      return null
    }
    if (m.type === "agentManager.setSessionsCollapsed") {
      this.sessionsCollapsed = m.collapsed
      return null
    }
    if (m.type === "agentManager.setSidebarCollapsed") {
      this.sidebarCollapsed = m.collapsed
      return null
    }
  }

  private onRequestState(): void {
    // finally-equivalent without duplicating trigger; triggerObservationRefresh
    // already waits/catches stateReady internally, so call it unconditionally
    // after the pushState chain to avoid a second sequential wait.
    void this.stateReady
      ?.then(() => {
        this.pushState()
        if (this.cachedLocalStats) this.postToWebview(this.cachedLocalStats)
      })
      .catch((err) => {
        this.log("initializeState failed, pushing partial state:", err)
        this.pushState()
      })
    this.triggerObservationRefresh()
  }

  private triggerObservationRefresh(): void {
    void this.waitForStateReady("observationRefresh").then(() => {
      void this.handleObservationRefresh()
    })
  }

  private handleObservationRefresh(): Promise<void> {
    const sessions = this.panel?.sessions
    if (!sessions) return Promise.resolve()
    const gen = this.generation
    if (this.refreshPromise && this.refreshGen === gen && this.refreshSessions === sessions) return this.refreshPromise
    const p = this.doObservationRefresh(gen, sessions).finally(() => {
      if (this.refreshPromise === p) {
        this.refreshPromise = null
        this.refreshGen = null
        this.refreshSessions = null
      }
    })
    this.refreshPromise = p
    this.refreshGen = gen
    this.refreshSessions = sessions
    return p
  }

  private async doObservationRefresh(gen: number, sessions: PanelContext["sessions"]): Promise<void> {
    if (!this.hydrated) {
      let cap: number | undefined
      if (this.coordinator) {
        try {
          cap = await this.coordinator.captureSnapshotCursor()
        } catch {
          cap = undefined
        }
      }
      if (this.generation !== gen || this.panel?.sessions !== sessions) return
      const hasCap = cap !== undefined
      try {
        await sessions.refreshSessions()
      } catch {
        return
      }
      if (this.generation !== gen || this.panel?.sessions !== sessions) return
      if (hasCap && this.coordinator) {
        const ok = await this.coordinator.ack(cap!)
        if (!ok) return
      }
      if (this.generation !== gen || this.panel?.sessions !== sessions) return
      this.hydrated = true
      return
    }
    if (this.coordinator) {
      let decision: { shouldRefresh: boolean; ackCursor?: number } | null = null
      try {
        decision = await this.coordinator.decide()
      } catch {
        decision = null
      }
      if (this.generation !== gen || this.panel?.sessions !== sessions) return
      if (decision !== null) {
        if (!decision.shouldRefresh) return
        try {
          await sessions.refreshSessions()
        } catch {
          return
        }
        if (this.generation !== gen || this.panel?.sessions !== sessions) return
        if (decision.ackCursor !== undefined) await this.coordinator.ack(decision.ackCursor)
        return
      }
    }
    if (this.generation !== gen || this.panel?.sessions !== sessions) return
    try {
      await sessions.refreshSessions()
    } catch {}
  }

  /**
   * Narrow precomputed peer-close observation entry.
   * If the panel is hidden or absent, discards (next visible/requestState re-reads).
   * Waits for stateReady and enters the same singleflight key; if another refresh
   * is in flight shares it. No hydration flag corruption: when not yet hydrated,
   * falls back to normal initial hydration path via singleflight (snapshot before SDK).
   * Distinguishes failure from staleness with protocol validation first:
   * - Failure: result absent, readError present, requestedCursor absent/unusable, or
   *   readResult absent/invalid/malformed (validated via decideFromReadResultWithValidity
   *   before freshness) -> precomputed singleflight fallback with {shouldRefresh:true},
   *   exactly one SDK refresh, no second private read, no ack, even if current persisted
   *   cursor differs (advanced/lower/undefined). Only a structurally and semantically valid
   *   result may be classified as temporally stale.
   * - Staleness: valid result but current persisted cursor is undefined or not exactly
   *   equal to requestedCursor (whether current < or >) -> normal fresh
   *   handleObservationRefresh() decision which may read again. This is the only reason
   *   for a second read.
   * - Valid fresh result stays no-second-read.
   * Validation is done once before freshness; the prevalidated decision is passed into
   * doPeerCloseObservationRefresh to avoid double validation. Before acking, re-read current
   * persisted cursor; never ack if current differs from baseline or is greater than
   * requested/ackCursor — skip ack rather than recursively starting a lane to avoid deadlock.
   */
  public async handlePeerCloseObservation(result: TriggerResult | undefined): Promise<void> {
    const panelAtCall = this.panel
    const genAtCall = this.generation
    const sessionsAtCall = panelAtCall?.sessions
    if (!panelAtCall || !sessionsAtCall || !panelAtCall.visible) return
    await this.waitForStateReady("peerClosedObservation")
    const curPanel = this.panel
    const curGen = this.generation
    const curSessions = curPanel?.sessions
    if (!curPanel || !curSessions || !curPanel.visible) return
    if (curGen !== genAtCall || curSessions !== sessionsAtCall) return
    if (!this.hydrated) {
      return this.handleObservationRefresh()
    }
    let prevalidated: { shouldRefresh: boolean; ackCursor?: number } = { shouldRefresh: true }
    let valid = false
    if (result && !result.readError && result.requestedCursor !== undefined && result.readResult !== undefined && this.coordinator) {
      try {
        const r = this.coordinator.decideFromReadResultWithValidity(result.readResult, result.requestedCursor)
        valid = r.valid
        prevalidated = r.decision
      } catch {
        valid = false
        prevalidated = { shouldRefresh: true }
      }
    } else {
      valid = false
      prevalidated = { shouldRefresh: true }
    }
    if (!valid) {
      if (this.refreshPromise && this.refreshGen === curGen && this.refreshSessions === curSessions)
        return this.refreshPromise
      const p = this.doPeerCloseObservationRefresh(curGen, curSessions, result, prevalidated).finally(() => {
        if (this.refreshPromise === p) {
          this.refreshPromise = null
          this.refreshGen = null
          this.refreshSessions = null
        }
      })
      this.refreshPromise = p
      this.refreshGen = curGen
      this.refreshSessions = curSessions
      return p
    }
    const curPersisted = this.coordinator?.getPersistedCursor()
    if (curPersisted === undefined || result?.requestedCursor === undefined || curPersisted !== result.requestedCursor) {
      return this.handleObservationRefresh()
    }
    if (this.refreshPromise && this.refreshGen === curGen && this.refreshSessions === curSessions) return this.refreshPromise
    const p = this.doPeerCloseObservationRefresh(curGen, curSessions, result, prevalidated).finally(() => {
      if (this.refreshPromise === p) {
        this.refreshPromise = null
        this.refreshGen = null
        this.refreshSessions = null
      }
    })
    this.refreshPromise = p
    this.refreshGen = curGen
    this.refreshSessions = curSessions
    return p
  }

  private async doPeerCloseObservationRefresh(
    gen: number,
    sessions: PanelContext["sessions"],
    result: TriggerResult | undefined,
    prevalidated?: { shouldRefresh: boolean; ackCursor?: number },
  ): Promise<void> {
    if (this.generation !== gen || this.panel?.sessions !== sessions) return
    let decision: { shouldRefresh: boolean; ackCursor?: number } = prevalidated ?? { shouldRefresh: true }
    if (!prevalidated) {
      if (!result || result.readError || result.requestedCursor === undefined || result.readResult === undefined) {
        decision = { shouldRefresh: true }
      } else if (!this.coordinator) {
        decision = { shouldRefresh: true }
      } else {
        try {
          decision = this.coordinator.decideFromReadResult(result.readResult, result.requestedCursor)
        } catch {
          decision = { shouldRefresh: true }
        }
      }
    }
    if (this.generation !== gen || this.panel?.sessions !== sessions) return
    if (!decision.shouldRefresh) return
    try {
      await sessions.refreshSessions()
    } catch {
      return
    }
    if (this.generation !== gen || this.panel?.sessions !== sessions) return
    if (decision.ackCursor !== undefined && this.coordinator) {
      const baseline = result?.requestedCursor
      if (baseline !== undefined) {
        const curNow = this.coordinator.getPersistedCursor()
        if (curNow === undefined || curNow !== baseline || curNow > baseline || curNow > decision.ackCursor) {
          return
        }
      }
      await this.coordinator.ack(decision.ackCursor)
    }
  }

  private shouldWaitForState(m: AgentManagerInMessage): boolean {
    switch (m.type) {
      case "agentManager.persistSession":
      case "agentManager.forgetSession":
      case "agentManager.setTabOrder":
      case "agentManager.setSessionsCollapsed":
      case "agentManager.setSidebarCollapsed":
        return true
      default:
        return false
    }
  }

  private async waitForStateReady(context: string): Promise<void> {
    if (!this.stateReady) return
    await this.stateReady.catch((err) => this.log(`${context}: stateReady rejected, continuing:`, err))
  }

  private onToolEvent(event: unknown, directory?: string): void {
    const properties = (event as { properties?: unknown }).properties
    const req = parseToolRequest(properties)
    if (!req) return
    if (directory) {
      req.directory = directory
    }
    void this.startToolRequest(req)
  }

  private async startToolRequest(req: ToolRequest): Promise<void> {
    const root = this.getRoot()
    if (!root) return
    await startFromTool(
      {
        getClient: () => this.connectionService.getClient(),
        getRoot: () => root,
        getPanel: () => this.panel,
        openPanel: (preserveFocus) => this.openPanel(preserveFocus),
        waitReady: (context) => this.waitForStateReady(context),
        claimRequest: (id) => {
          if (this.toolRequests.has(id)) return false
          const oldest = this.toolRequests.size >= 100 ? this.toolRequests.values().next().value : undefined
          if (oldest) this.toolRequests.delete(oldest)
          this.toolRequests.add(id)
          return true
        },
        createLocalSession: async (task, source) => {
          let client: KiloClient
          try {
            client = this.connectionService.getClient()
          } catch {
            return false
          }
          const metadata = await sandboxSessionMetadata(this.connectionService.sandboxPreference, client, root)
          const { createSessionPrivateFirst } = await import("../kilo-provider/session-create")
          const session = await startSession(
            client,
            root,
            () =>
              createSessionPrivateFirst({
                client,
                connection: this.connectionService,
                directory: root,
                platform: PLATFORM,
                metadata: metadata as unknown as Record<string, unknown> | undefined,
                sandboxInheritanceToken: source?.sandboxInheritanceToken,
              }),
            (...args) => this.log(...args),
          )
          const sid = (session as unknown as Session).id ?? (session as unknown as { id: string }).id
          this.addSession(sid, { recent: true })
          this.push()
          this.postToWebview({ type: "agentManager.sessionAdded", sessionId: sid })
          this.panel?.sessions.registerSession(session as unknown as Session)
          const body = task.prompt?.trim()
          if (body) {
            await client.session.promptAsync(
              {
                sessionID: sid,
                directory: root,
                parts: [{ type: "text", text: body }],
                model: task.model,
                variant: task.variant,
              },
              { throwOnError: true },
            )
          }
          this.host.capture("Agent Manager Session Started", {
            source: PLATFORM,
            sessionId: sid,
            tool: true,
          })
          return true
        },
        push: () => this.pushState(),
        post: (msg) => this.postToWebview(msg as AgentManagerOutMessage),
        capture: (event, props) => this.host.capture(event, props),
        log: (...args) => this.log(...args),
        error: (msg) => this.host.showError(msg),
      },
      req,
    )
  }

  // Session actions

  /**
   * Close a session: stop backend processes and remove from managed state.
   * View lifecycle only — the backend session persists, so the cumulative
   * runtime is deliberately retained across tab close and pruned only on a
   * real backend session.deleted (or an explicit forgetSession).
   */
  private async onCloseSession(sessionId: string): Promise<void> {
    this.panelSessions.delete(sessionId)
    if (!this.recentSessions) this.recentSessions = new Set<string>()
    this.recentSessions.delete(sessionId)
    const root = this.getRoot() ?? ""
    try {
      const { stopSessionProcesses } = await import("../kilo-provider/background-process")
      await stopSessionProcesses(this.connectionService.getClient(), sessionId, root)
    } catch (err) {
      this.log(`Failed to stop session processes for ${sessionId}:`, err)
    }
    this.managedSessions.delete(sessionId)
    if (this.tabOrder && this.LOCAL) {
      const ord = this.tabOrder[this.LOCAL]
      if (ord) this.tabOrder[this.LOCAL] = ord.filter((id) => id !== sessionId)
      if (this.activeSessionId === sessionId)
        this.activeSessionId = this.tabOrder[this.LOCAL]?.[0] ?? [...this.managedSessions.keys()][0]
    } else if (this.activeSessionId === sessionId) {
      this.activeSessionId = [...this.managedSessions.keys()][0]
    }
    this.schedulePersist()
    this.pushState()
  }

  /** Fork a session via the CLI backend (local-only) — shared durable SDK-first/private-observation path. */
  private async onForkSession(sessionId: string, messageId?: string): Promise<void> {
    let client: KiloClient
    try {
      client = this.connectionService.getClient()
    } catch (err) {
      this.log("forkSession: client not available:", err)
      this.postToWebview({ type: "error", message: "Not connected to CLI backend" })
      return
    }
    const directory = this.getRoot()
    if (!directory) {
      this.postToWebview({ type: "error", message: "Workspace root not available" })
      return
    }
    const { buildForkIdentity, executeDurableFork, observeForkParity } = await import("../kilo-provider/fork-session")
    const identity = buildForkIdentity(sessionId)
    const params = { sessionId, directory, messageId, opId: identity.opId, idempotencyKey: identity.idempotencyKey, requestId: identity.requestId }
    let forked: Session | undefined
    let sdkResult: { data?: Session; error?: unknown; response?: unknown } | null = null
    try {
      const res = await executeDurableFork(client, params)
      sdkResult = { data: res.data as Session | undefined, response: res.response, error: res.error }
      if (res.error) {
        const err = getErrorMessage(res.error)
        this.postToWebview({ type: "error", message: `Failed to fork session: ${err}` })
      } else if (res.data) {
        forked = res.data as Session
      }
    } catch (error) {
      const asRec = error as Record<string, unknown>
      sdkResult = { data: (asRec?.data as Session) ?? undefined, error: (asRec?.error as unknown) ?? error, response: (asRec?.response as unknown) ?? undefined }
      const err = getErrorMessage(error)
      this.postToWebview({ type: "error", message: `Failed to fork session: ${err}` })
    }
    if (sdkResult) {
      try {
        await observeForkParity(this.connectionService, sdkResult as { data?: unknown; error?: unknown; response?: unknown }, params)
      } catch (err) {
        console.warn("[Kilo Fork] AgentManager observeForkParity failed:", String(err).slice(0, 200), { opId: params.opId, requestId: params.requestId })
      }
    }
    if (!forked) return
    this.addSession(forked.id, { recent: true })
    this.activeSessionId = forked.id
    this.schedulePersist()
    this.pushState()
    this.postToWebview({ type: "agentManager.sessionForked", sessionId: forked.id, forkedFromId: sessionId })
    this.panel?.sessions.registerSession(forked)
    this.log(`Forked session ${sessionId} → ${forked.id}`)
  }

  private sendKeybindings(): void {
    const keybindings = this.host.extensionKeybindings()
    const bindings = buildKeybindingMap(keybindings, process.platform === "darwin")
    this.postToWebview({ type: "agentManager.keybindings", bindings })
  }

  // Repo info

  private async sendRepoInfo(): Promise<void> {
    const root = this.getRoot()
    if (!root) return
    try {
      const result = await this.gitOps.listBranches(root)
      this.postToWebview({
        type: "agentManager.repoInfo",
        branch: result.defaultBranch,
        defaultBranch: result.defaultBranch,
      })
    } catch (error) {
      this.log(`Failed to get current branch: ${error}`)
    }
  }

  // State helpers

  private addSession(sessionId: string, opts?: { recent?: boolean }): void {
    if (opts?.recent) {
      if (!this.recentSessions) this.recentSessions = new Set<string>()
      this.recentSessions.add(sessionId)
    }
    this.managedSessions.set(sessionId, { id: sessionId })
    this.panel?.sessions.trackSession(sessionId)
    if (this.tabOrder && this.LOCAL) {
      const ord = this.tabOrder[this.LOCAL] ?? [...this.managedSessions.keys()].filter((id) => id !== sessionId)
      if (!ord.includes(sessionId)) ord.push(sessionId)
      this.tabOrder[this.LOCAL] = ord
    }
    if (!this.activeSessionId) this.activeSessionId = sessionId
    this.schedulePersist()
  }

  private push(): void {
    this.pushState()
  }

  private pushState(): void {
    this.postToWebview({
      type: "agentManager.state",
      sessions: [...this.managedSessions.values()],
      timing: this.timing.snapshot(),
      tabOrder: this.tabOrder,
      sessionsCollapsed: this.sessionsCollapsed,
      sidebarCollapsed: this.sidebarCollapsed,
      isGitRepo: true,
      ...(this.activeSessionId ? { activeSessionId: this.activeSessionId } : {}),
    })

    this.statsPoller.setEnabled(this.panel !== undefined)
  }

  // File helpers

  /** Open a file from a session in the VS Code editor. */
  private openFile(sessionId: string, filePath: string, line?: number, column?: number): void {
    if (isAbsolutePath(filePath)) {
      this.host.openFile(filePath, line, column)
      return
    }
    const base = this.getRoot()
    if (!base) return
    let resolved: string
    try {
      const root = fs.realpathSync(base)
      resolved = fs.realpathSync(path.resolve(base, filePath))
      if (resolved !== root && !resolved.startsWith(root + path.sep)) return
    } catch (err) {
      console.error("[Kilo New] AgentManagerProvider: Cannot resolve file path:", err)
      return
    }
    this.host.openFile(resolved, line, column)
  }

  private postToWebview(message: AgentManagerOutMessage): void {
    this.panel?.postMessage(message)
  }

  /**
   * Reveal the Agent Manager panel and focus the prompt input.
   */
  public focusPanel(): void {
    if (!this.panel) return
    this.panel.reveal(false)
    this.postToWebview({ type: "action", action: "focusInput" })
  }

  public isActive(): boolean {
    return this.panel?.active === true
  }

  private async waitForPanel(panel: PanelContext, promise: Promise<void>): Promise<boolean> {
    const done = promise.then(() => true)
    let sub: Disposable | undefined
    const disposed = new Promise<false>((resolve) => {
      sub = panel.onDidDispose(() => {
        sub?.dispose()
        resolve(false)
      })
    })
    void done.finally(() => sub?.dispose())
    const ok = await Promise.race([done, disposed])
    return ok && this.panel === panel
  }

  private waitForPanelReady(panel: PanelContext): Promise<boolean> {
    return this.waitForPanel(panel, panel.waitForReady())
  }

  private waitForPanelActive(panel: PanelContext): Promise<boolean> {
    return this.waitForPanel(panel, panel.waitForActive())
  }

  /** Wait for the current panel's webview to be ready before posting to it. */
  public waitForReady(): Promise<boolean> {
    const panel = this.panel
    if (!panel) return Promise.resolve(false)
    return this.waitForPanelReady(panel)
  }

  /** Expose session→directory mappings for the auto-approve toggle. */
  public getSessionDirectories(): ReadonlyMap<string, string> {
    return this.panel?.sessions.getSessionDirectories() ?? new Map()
  }

  /** Expose the active session id so shared commands (e.g. Show Changes) can target the focused session. */
  public getActiveSessionId(): string | undefined {
    return this.activeSessionId
  }

  public postMessage(message: unknown): void {
    this.panel?.postMessage(message)
  }

  /**
   * Deterministically wait until the Agent Manager's session list has been
   * synced from the real backend — including any deferred refresh flushed
   * when the CLI connection comes up. Used only by the env-gated E2E fixture
   * bridge (KILO_E2E_FIXTURE); the extension-host runner calls this before
   * its final re-seed so no later in-flight refresh can reconcile the
   * fixture sessions away.
   */
  public async settleSessionsForFixture(): Promise<void> {
    const panel = this.panel
    if (!panel) return
    await this.waitForStateReady("settleSessionsForFixture")
    // Ensure the CLI connection is established so the refresh performs a real
    // fetch now instead of deferring (pendingSessionRefresh). KiloProvider
    // serializes session-list loads, so this awaited refresh is the last one
    // the webview applies.
    try {
      await this.connectionService.getClientAsync(this.getRoot())
    } catch {
      // Best effort — refreshSessions still enqueues; if the client is
      // unavailable it defers and flushes on connect, which the serialized
      // load chain resolves in order.
    }
    await panel.sessions.refreshSessions()
  }

  /**
   * Read-only snapshot of served-backend truth for the real-session E2E
   * fixture (KILO_E2E_FIXTURE only, registered by extension.ts): the session
   * list, per-session transcripts (text + completed tool-part summaries),
   * session statuses, the served agent catalog, the connected provider ids,
   * MCP server statuses, pending permission/question requests, and the
   * backend-derived child session ids — all fetched through the shared client
   * against the real `kilo serve` backend. The extension-host runner writes
   * this to the scratch dir and the harness asserts on it. No production
   * effect: the command is unregistered when the env var is absent.
   */
  public async backendSnapshotForFixture(): Promise<BackendSnapshot> {
    const root = this.getRoot() ?? ""
    const client = await this.connectionService.getClientAsync(root)
    const empty = (label: string): never[] => {
      this.log(`fixture backendSnapshot: ${label} failed; returning empty`)
      return []
    }
    const sessions = await client.session
      .list({ directory: root })
      .then((r) => r.data ?? [])
      .catch((err) => {
        this.log("fixture backendSnapshot: session.list failed:", err)
        return empty("session.list")
      })
    let statusReadable = true
    const statuses = await client.session
      .status({ directory: root })
      .then((r) => r.data ?? {})
      .catch((err) => {
        this.log("fixture backendSnapshot: session.status failed:", err)
        statusReadable = false
        return {}
      })
    const agents = await client.app
      .agents({ directory: root })
      .then((r) => r.data ?? [])
      .catch(() => empty("app.agents"))
    const connected = await client.provider
      .list({ directory: root })
      .then((r) => r.data?.connected ?? [])
      .catch(() => empty("provider.list"))
    const messages: Record<string, ReturnType<typeof summarizeMessage>[]> = {}
    const children: Record<string, string[]> = {}
    const unreadableMessages: Record<string, boolean> = {}
    for (const s of sessions) {
      let messagesOk = true
      const rows = await client.session
        .messages({ sessionID: s.id, directory: root })
        .then((r) => r.data ?? [])
        .catch(() => {
          messagesOk = false
          return empty(`session.messages(${s.id})`)
        })
      if (!messagesOk) unreadableMessages[s.id] = false
      messages[s.id] = rows.map(summarizeMessage)
      // SDK-first detached warn-only children parity (B8): the SDK result
      // below stays the sole authority for the fixture snapshot. The private
      // observation never mutates state, never retries/replays the SDK, and
      // never changes this output or control flow.
      let sdkKids: { data?: unknown; error?: unknown; response?: unknown } | unknown = null
      const kids = await client.session
        .children({ sessionID: s.id, directory: root })
        .then((r) => {
          sdkKids = r as { data?: unknown; error?: unknown; response?: unknown }
          return r.data ?? []
        })
        .catch((e: unknown) => {
          sdkKids = e
          return empty(`session.children(${s.id})`)
        })
      children[s.id] = kids.map((kid) => (kid as { id?: string }).id ?? "").filter((id) => id.length > 0)
      try {
        observeSessionChildrenParityDetached(
          this.connectionService,
          sdkKids as { data?: unknown; error?: unknown; response?: unknown },
          s.id,
          root,
        )
      } catch {
        console.warn("[Kilo Children] private parity observation failed (fail-closed):", {
          op: "session/children",
          observationFailed: true,
        })
      }
    }
    const mcp = await client.mcp
      .status({ directory: root })
      .then((r) => summarizeMcp(r.data ?? {}))
      .catch((err) => {
        this.log("fixture backendSnapshot: mcp.status failed:", err)
        return undefined
      })
    const pending = await Promise.all([
      client.permission
        .list({ directory: root })
        .then((r) => summarizePermissions(r.data ?? []))
        .catch((err) => {
          this.log("fixture backendSnapshot: permission.list failed:", err)
          return [] as ReturnType<typeof summarizePermissions>
        }),
      client.question
        .list({ directory: root })
        .then((r) => summarizeQuestions(r.data ?? []))
        .catch((err) => {
          this.log("fixture backendSnapshot: question.list failed:", err)
          return [] as ReturnType<typeof summarizeQuestions>
        }),
    ]).then(([permissions, questions]) => ({ permissions, questions }))
    return {
      requestedAt: new Date().toISOString(),
      sessions: sessions.map(summarizeSession),
      messages,
      statuses: summarizeStatuses(statuses),
      ...(statusReadable ? {} : { statusReadable: false as const }),
      ...(Object.keys(unreadableMessages).length > 0 ? { messagesReadable: unreadableMessages } : {}),
      agents: agents.map((agent) => (agent as { name?: string }).name ?? "").filter((name) => name.length > 0),
      connectedProviders: connected,
      ...(mcp ? { mcp } : {}),
      ...(pending ? { pending } : {}),
      children,
    }
  }

  /**
   * Disconnect a named MCP server through the real shared client, then return
   * the served MCP status map. Env-gated E2E fixture bridge only
   * (KILO_E2E_FIXTURE): lets the harness prove the run-owned MCP stdio child
   * is cleaned up by its exact owner (disconnect through the SDK, not a
   * process-name kill). No production effect when the env var is absent.
   */
  public async mcpDisconnectForFixture(name: string): Promise<McpTruth> {
    const root = this.getRoot() ?? ""
    const client = await this.connectionService.getClientAsync(root)
    await client.mcp.disconnect({ name, directory: root }).catch((err) => {
      this.log(`fixture mcpDisconnect(${name}) failed:`, err)
    })
    const status = await client.mcp.status({ directory: root }).catch(() => ({ data: {} as Record<string, McpStatus> }))
    return summarizeMcp(status.data ?? {})
  }

  public shutdown(): Promise<void> {
    if (!this.closing) this.closing = this.disposeAsync()
    return this.closing
  }

  public dispose(): void {
    void this.shutdown()
  }

  private async disposeAsync(): Promise<void> {
    this.unsubConnectionState?.()
    this.unsubConnectionState = undefined
    await this.stateReady?.catch((err) => this.log("dispose: stateReady rejected:", err))
    // Stop accepting timing-mutating backend events before settling. If a
    // session.status/session.deleted event arrived while settle awaited its
    // durable write, it could re-open a segment (or rewrite state) after the
    // final settle and persist downtime as runtime.
    this.unsubStatus?.()
    this.unsubDeleted?.()
    // Normal extension shutdown: settle every active segment and await the
    // durable write so later downtime is never counted as session runtime.
    await this.timing.settle()
    await this.flush()
    this.unsubTool?.()
    this.unsubFont?.()
    this.visiblePresence.clear()
    this.statsPoller.stop()
    this.gitOps.dispose()
    this.terminalManager.dispose()
    await this.terminalRouter.dispose()
    const panel = this.panel
    this.panel = undefined
    panel?.dispose()
    this.outputChannel.dispose()
    this.host.dispose()
  }

  private getRoot(): string | undefined {
    return this.host.workspacePath()
  }
}
