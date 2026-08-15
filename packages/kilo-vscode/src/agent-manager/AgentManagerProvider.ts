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
import { getErrorMessage } from "../kilo-provider-utils"
import { isAbsolutePath } from "../path-utils"
import { GitStatsPoller, type LocalStats } from "./GitStatsPoller"
import { GitOps } from "./GitOps"
import { SessionTerminalManager } from "./SessionTerminalManager"
import { createTerminalHost } from "./terminal-host"
import { TerminalRouter } from "./terminal-routing"
import { startVscodeRunTask } from "./run/task"
import { RunController } from "./run/controller"
import { handleRunMessage } from "./run/message"
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
import type { AgentManagerOutMessage, AgentManagerInMessage, ManagedSession } from "./types"
import type { Host, PanelContext, OutputHandle, Disposable } from "./host"

export class AgentManagerProvider implements Disposable {
  public static readonly viewType = "kilo-code.new.AgentManagerPanel"
  private panel: PanelContext | undefined
  private outputChannel: OutputHandle
  private terminalManager: SessionTerminalManager
  private terminalRouter: TerminalRouter
  private run: RunController
  private stateReady: Promise<void> | undefined
  private statsPoller: GitStatsPoller
  private gitOps: GitOps
  private toolRequests = new Set<string>()
  private cachedLocalStats: { type: "agentManager.localStats"; stats: LocalStats } | undefined
  private unsubTool: (() => void) | undefined
  private unsubStatus: (() => void) | undefined
  private unsubDeleted: (() => void) | undefined
  private unsubFont: (() => void) | undefined
  private timing: SessionTiming
  private closing: Promise<void> | undefined
  private onVisibilityChange: ((visible: boolean) => void) | undefined
  // Tracks sessions owned by this panel until they are explicitly closed.
  private panelSessions = new Set<string>()
  private managedSessions = new Map<string, ManagedSession>()
  private tabOrder: Record<string, string[]> = {}
  private sessionsCollapsed = false
  private sidebarCollapsed = false

  /** Session ID most recently loaded via `loadMessages`; updated synchronously. */
  private activeSessionId: string | undefined
  private visiblePresence = new AgentManagerVisiblePresence(
    (ids) => this.connectionService.registerVisible("agent-manager", ids),
    () => this.panel?.visible ?? false,
    (ids) => this.connectionService.registerAttached("agent-manager", ids),
  )
  constructor(
    private readonly host: Host,
    private readonly connectionService: KiloConnectionService,
  ) {
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
    this.run = new RunController({
      root: () => this.getRoot(),
      open: (file) => this.host.openDocument(file),
      start: startVscodeRunTask,
      post: (status) => this.postToWebview({ type: "agentManager.runStatus", ...status }),
      error: (message) => this.postToWebview({ type: "error", message }),
      log: (msg) => this.outputChannel.appendLine(`[RunScript] ${msg}`),
      refresh: () => this.pushState(),
    })
    const semaphore = new Semaphore(3)
    this.gitOps = new GitOps({ log: (...args) => this.log(...args), semaphore })
    const local = createLocalDiff(this.gitOps, (...args) => this.log(...args))
    this.statsPoller = new GitStatsPoller({
      getWorktrees: () => [],
      getWorkspaceRoot: () => this.getRoot(),
      localDiff: (dir, base) => localDiffSummary(this.gitOps, dir, base, (...args) => this.log(...args)),
      semaphore,
      onStats: () => {},
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
    if (sid) this.timing.forget(sid)
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
        worktreeDirectories: () => [],
      }),
    )
  }

  public onPanelVisibilityChange(cb: (visible: boolean) => void): void {
    this.onVisibilityChange = cb
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
    this.onVisibilityChange?.(ctx.visible)
    ctx.onDidChangeVisibility((visible) => {
      this.statsPoller.setVisible(visible)
      this.visiblePresence.flush()
    })

    this.stateReady = this.initializeState()
    void this.sendRepoInfo()
    this.sendKeybindings()
    ctx.onDidDispose(() => {
      if (this.panel === ctx) {
        this.log("Panel disposed")
        const ids = [...this.panelSessions]
        if (this.activeSessionId) ids.push(this.activeSessionId)
        this.panelSessions.clear()
        void ctx.sessions.abortSessions(ids).catch((err) => this.log("Failed to abort sessions on panel close:", err))
        this.statsPoller.stop()
        this.activeSessionId = undefined
        this.visiblePresence.clear()
        this.panel = undefined
        this.onVisibilityChange?.(false)
      }
      ctx.sessions.dispose()
    })
  }

  // State initialization

  private async initializeState(): Promise<void> {
    this.pushState()
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
      if (persist && m.draftID) {
        this.panel?.sessions.acknowledgeDraft(m.draftID, m.sessionId)
        this.panelSessions.delete(m.draftID)
        this.panelSessions.add(m.sessionId)
      }
      if (persist) {
        if (!this.managedSessions.has(m.sessionId)) this.addSession(m.sessionId)
      } else {
        // Explicit permanent forget (counterpart of persistSession): the
        // session leaves the manager's persisted registry, so its timing
        // entry goes with it. This is not the tab-close path.
        this.managedSessions.delete(m.sessionId)
        this.timing.forget(m.sessionId)
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
      this.activeSessionId = m.draftID
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
      this.activeSessionId = m.sessionID
      this.terminalManager.syncOnSessionSwitch(m.sessionID)
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
    if (handleRunMessage(this.run, m)) return null
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
    void this.stateReady
      ?.then(() => {
        this.pushState()
        if (this.cachedLocalStats) this.postToWebview(this.cachedLocalStats)
        // Intentionally fire-and-forget: the refresh enqueues through the
        // serialized session-load chain and its internal error handling is
        // preserved inside KiloProvider. Explicit void marks the intent.
        void this.panel?.sessions.refreshSessions()
      })
      .catch((err) => {
        this.log("initializeState failed, pushing partial state:", err)
        this.pushState()
      })
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
          const { data: session } = await startSession(
            client,
            root,
            () =>
              client.session.create(
                {
                  directory: root,
                  platform: PLATFORM,
                  metadata,
                  ...(source?.sandboxInheritanceToken
                    ? { sandboxInheritanceToken: source.sandboxInheritanceToken }
                    : {}),
                },
                { throwOnError: true },
              ),
            (...args) => this.log(...args),
          )
          this.addSession(session.id)
          this.push()
          this.panel?.sessions.registerSession(session)
          const body = task.prompt?.trim()
          if (body) {
            await client.session.promptAsync(
              {
                sessionID: session.id,
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
            sessionId: session.id,
            tool: true,
            mode: "local",
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
    const root = this.getRoot() ?? ""
    try {
      const { stopSessionProcesses } = await import("../kilo-provider/background-process")
      await stopSessionProcesses(this.connectionService.getClient(), sessionId, root)
    } catch (err) {
      this.log(`Failed to stop session processes for ${sessionId}:`, err)
    }
    this.managedSessions.delete(sessionId)
    this.pushState()
  }

  /** Fork a session via the CLI backend (local-only, no worktree). */
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
    let forked: Session
    try {
      const input = { sessionID: sessionId, directory, ...(messageId ? { messageID: messageId } : {}) }
      const { data } = await client.session.fork(input, { throwOnError: true })
      forked = data
    } catch (error) {
      const err = getErrorMessage(error)
      this.postToWebview({ type: "error", message: `Failed to fork session: ${err}` })
      return
    }

    this.addSession(forked.id)
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

  private addSession(sessionId: string): void {
    this.managedSessions.set(sessionId, { id: sessionId })
    this.panel?.sessions.trackSession(sessionId)
  }

  private push(): void {
    this.pushState()
  }

  private pushState(): void {
    const run = this.run.state()
    this.postToWebview({
      type: "agentManager.state",
      worktrees: [],
      sessions: [...this.managedSessions.values()],
      timing: this.timing.snapshot(),
      tabOrder: this.tabOrder,
      sessionsCollapsed: this.sessionsCollapsed,
      sidebarCollapsed: this.sidebarCollapsed,
      isGitRepo: true,
      ...run,
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

  public async showMemory(): Promise<void> {
    const panel = this.panel
    const sid = this.activeSessionId
    if (!panel || !sid) {
      this.host.showError("No active Agent Manager session")
      return
    }
    if (!(await this.waitForPanelReady(panel))) return
    if (this.activeSessionId !== sid) return
    try {
      await panel.sessions.showMemory(sid)
    } catch (error) {
      this.host.showError(getErrorMessage(error) || "Failed to show memory")
    }
  }

  public async toggleMemory(): Promise<void> {
    const panel = this.panel
    const sid = this.activeSessionId
    if (!panel || !sid) {
      this.host.showError("No active Agent Manager session")
      return
    }
    if (!(await this.waitForPanelReady(panel))) return
    if (this.activeSessionId !== sid) return
    try {
      await panel.sessions.toggleMemory(sid)
    } catch (error) {
      this.host.showError(getErrorMessage(error) || "Failed to toggle memory")
    }
  }

  /** Expose session→directory mappings for the auto-approve toggle. */
  public getSessionDirectories(): ReadonlyMap<string, string> {
    return this.panel?.sessions.getSessionDirectories() ?? new Map()
  }

  public getWorktreeDirectories(): string[] {
    return []
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
    const statuses = await client.session
      .status({ directory: root })
      .then((r) => r.data ?? {})
      .catch((err) => {
        this.log("fixture backendSnapshot: session.status failed:", err)
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
    for (const s of sessions) {
      const rows = await client.session
        .messages({ sessionID: s.id, directory: root })
        .then((r) => r.data ?? [])
        .catch(() => empty(`session.messages(${s.id})`))
      messages[s.id] = rows.map(summarizeMessage)
      const kids = await client.session
        .children({ sessionID: s.id, directory: root })
        .then((r) => r.data ?? [])
        .catch(() => empty(`session.children(${s.id})`))
      children[s.id] = kids.map((kid) => (kid as { id?: string }).id ?? "").filter((id) => id.length > 0)
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
    this.unsubTool?.()
    this.unsubFont?.()
    this.visiblePresence.clear()
    this.statsPoller.stop()
    this.gitOps.dispose()
    this.run.dispose()
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
