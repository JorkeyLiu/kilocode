import * as vscode from "vscode"
import { KiloProvider } from "./KiloProvider"
import { AgentManagerProvider } from "./agent-manager/AgentManagerProvider"
import { VscodeHost } from "./agent-manager/vscode-host"
import { SettingsEditorProvider } from "./SettingsEditorProvider"
import { MarketplacePanelProvider } from "./MarketplacePanelProvider"
import { MarketplaceNotifier } from "./services/marketplace/notifier"
import { EXTENSION_DISPLAY_NAME } from "./constants"
import { KiloConnectionService } from "./services/cli-backend"
import { AttentionService } from "./services/attention"
import { BrowserAutomationService } from "./services/browser-automation"
import { TelemetryEventName, TelemetryProxy } from "./services/telemetry"
import {
  registerCodeActions,
  registerTerminalActions,
  KiloCodeActionProvider,
  type ChatTarget,
} from "./services/code-actions"
import { resolveChatTarget as resolveChatTargetImpl } from "./services/code-actions/chat-target"
import { registerToggleAutoApprove } from "./commands/toggle-auto-approve"
import { registerHeapSnapshot } from "./commands/heap-snapshot"
import { RemoteStatusService } from "./services/RemoteStatusService"
import { markWorkspace } from "./util/spotlight"
import { createNotebookBridge } from "./services/notebook"
import { p0Begin, p0Stage } from "./perf/perf-instrument"
import { resolveReloadDirectory } from "./reload-directory"
import { CanonicalConfigService } from "./config/service"
import { createVscodeStateAdapter, createVscodeWatcherAdapter } from "./config/state-adapter"
import { Roots } from "./config/paths"
import { PrivateObservationService } from "./private-worker/private-observation-service"
import { createMementoCursorStore } from "./private-worker/observation-cursor-store"
import { PrivateObservationLifecycleTriggers } from "./private-worker/private-observation-lifecycle-triggers"

let agentManager: AgentManagerProvider | undefined
let shuttingDown = false

const RESTORE_KEY = "kilo.workbench.restore"

type RestoreState = {
  agentManager?: boolean
}

// Track all open tab panel providers so toolbar button commands can target
// them. Module scope so the env-gated E2E fixture bridge can snapshot tab
// panel readiness. The editor/title toolbar for tab panels intentionally
// omits Agent Manager and Marketplace buttons; too many icons causes VS Code
// to collapse them into a "..." overflow menu, hiding important buttons like
// Settings.
const tabPanels = new Map<vscode.WebviewPanel, KiloProvider>()

const panelTitleHandler = (panel: vscode.WebviewPanel) => (title: string) => {
  panel.title = title || EXTENSION_DISPLAY_NAME
}

/**
 * E2E fixture (KILO_E2E_FIXTURE only): inject a model with ≥2 reasoning
 * variants into the real served provider catalog and post a synthetic
 * providersLoaded to the Agent Manager webview, then pin that model as the
 * per-agent model for every backend agent so switching agents in the webview
 * keeps the variant-bearing model selected. The models.dev snapshot ships no
 * variant-bearing models, so without this the real ThinkingSelector is never
 * interactive in the harness. The provider/agent round trips are awaited
 * first so this synthetic state stays the last catalog/model messages the
 * webview processes.
 *
 * The synthetic catalog is then re-asserted on a short bounded schedule: the
 * extension's real providersLoaded (from the connection-init catalog fetch)
 * can complete AFTER this first synthetic post and clobber the injected
 * model, which would leave the real ThinkingSelector unrenderable mid-scenario
 * (the harness observed this as an intermittent all-mode failure). Re-posting
 * a few times over ~6s supersedes any late real catalog so the injected model
 * is the effective webview state while the harness drives the DOM. Bounded and
 * deterministic — no polling/network dependency.
 */
async function provisionVariantModelFixture(
  agentManagerProvider: AgentManagerProvider,
  connectionService: KiloConnectionService,
  providerID: string,
  modelID: string,
  variants: string[],
): Promise<void> {
  await agentManagerProvider.settleSessionsForFixture()
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const variantMap: Record<string, unknown> = {}
  for (const variant of variants) variantMap[variant] = {}
  const injected = { id: modelID, name: modelID, variants: variantMap }
  const providers: Record<string, unknown> = {}
  let connected: string[] = []
  let defaults: Record<string, string> = {}
  let selections: Record<string, { providerID: string; modelID: string }> = {}
  try {
    const client = await connectionService.getClientAsync(root)
    const { data } = await client.provider.list({ directory: root }, { throwOnError: true })
    connected = data?.connected ?? []
    defaults = data?.default ?? {}
    for (const item of data?.all ?? []) {
      const p = item as { id?: string; models?: Record<string, unknown> }
      providers[p.id ?? ""] = p.id === providerID ? { ...p, models: { ...(p.models ?? {}), [modelID]: injected } } : p
    }
    const agentResult = await client.app.agents({ directory: root }, { throwOnError: true })
    const agentNames = (agentResult.data ?? [])
      .map((agent) => (agent as { name?: string }).name ?? "")
      .filter((name) => name.length > 0)
    for (const name of agentNames) selections[name] = { providerID, modelID }
  } catch (err) {
    console.error("[Kilo New] provisionVariantModelFixture: real catalog/agents unavailable:", err)
  }
  if (!providers[providerID])
    providers[providerID] = { id: providerID, name: providerID, models: { [modelID]: injected } }
  if (!connected.includes(providerID)) connected = [...connected, providerID]

  const post = () => {
    if (Object.keys(selections).length > 0) {
      agentManagerProvider.postMessage({ type: "modelSelectionsLoaded", selections })
    }
    agentManagerProvider.postMessage({
      type: "providersLoaded",
      providers,
      connected,
      defaults,
      defaultSelection: { providerID, modelID },
      authMethods: {},
      authStates: {},
    })
  }
  post()
  // Bounded re-assertion window (see comment above): 500ms, 2s, 5s after the
  // first post. Any real catalog delivered in this window is superseded.
  for (const delayMs of [500, 1500, 3000, 5000]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    post()
  }
}

// Activated via "onStartupFinished" and "onUri" (package.json) so that commands, code actions,
// keybindings, and URI deep links all work immediately — without requiring the user to open a Kilo
// chat surface first. The CLI backend is NOT spawned here; it starts lazily when a webview connects.
export function activate(context: vscode.ExtensionContext) {
  console.log("Kilo Code extension is now active")
  shuttingDown = false

  // P0 perf: fresh correlation per activation, then the activation stage.
  p0Begin()
  p0Stage("activate.start")

  const telemetry = TelemetryProxy.getInstance()

  // Create shared connection service (one server for all webviews)
  const connectionService = new KiloConnectionService(context)
  const notebookBridge = createNotebookBridge(connectionService)

  // P4.1: Create canonical config service — lifecycle-owned singleton that owns
  // file watchers, materialization state, credential storage, and selector indexes.
  // Existing backend/SSE runtime bridge continues until P4.3; this service is additive.
  // Must initialize before consumers subscribe; initialization rehydrates
  // compatible derived indexes for immediate presentation, then reconciles
  // canonical disk state. Initialization failure is logged and does not block
  // unrelated extension functionality.
  const canonicalConfig = new CanonicalConfigService(context, {
    roots: new Roots(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    ),
    globalState: createVscodeStateAdapter(context.globalState),
    workspaceState: createVscodeStateAdapter(context.workspaceState),
    watcherAdapter: createVscodeWatcherAdapter(),
  })
  context.subscriptions.push(canonicalConfig)
  canonicalConfig.initialize().catch((err) => {
    console.error("[Kilo New] CanonicalConfigService initialization failed:", err)
  })

  // P4.2b: Additive private-worker observation service — extension-owned,
  // gated, reversible. Owns one PrivateWorkerHost and delegates observation
  // snapshot/read/ack/subscribe over private stdio via canonical leased DB
  // (ADR-0005, migration bridge remains). Gate is internal, explicit,
  // fail-closed, non-user-authored: disabled by default preserves HTTP/SSE,
  // selector readiness, and extensionDataReady. Notifications forward through
  // injectable consumer boundary; no second store, no webview operational
  // facts. Full UI convergence is a follow-up — this increment exposes only
  // the internal service callback/request API when no suitable consumer exists.
  const privateObservation = new PrivateObservationService({
    enabled: false,
    cursorStore: createMementoCursorStore(context.globalState),
  })
  context.subscriptions.push(privateObservation)
  // R9-C3: debounced singleflight lifecycle triggers (panel visibility, window
  // focus, config change, session switch, peer-closed) -> reconnect + read(persisted)
  // gap->rehydrate. Gate-off (enabled:false) so no host spawn/lease in production
  // until enabled; trailing 150ms coalescence, no polling, no Failure wiring.
  const privateObservationTriggers = PrivateObservationLifecycleTriggers.wireVscode(privateObservation, context, {
    agentManagerProvider: undefined as unknown as { onPanelVisibilityChange: (cb: (v: boolean) => void) => void } | undefined,
  })
  // Wire real AgentManagerProvider visibility when available (created below).
  // We create triggers now but re-wire after provider exists via direct adapter
  // subscription below to keep core vscode-free and avoid circular import.
  context.subscriptions.push(privateObservationTriggers)

  let restore = context.workspaceState.get<RestoreState>(RESTORE_KEY) ?? {}
  const remember = (patch: RestoreState) => {
    const next = { ...restore, ...patch }
    if (shuttingDown && patch.agentManager === false) next.agentManager = restore.agentManager
    restore = next
    void context.workspaceState.update(RESTORE_KEY, restore)
  }

  // Create browser automation service (manages Playwright MCP registration)
  const browserAutomationService = new BrowserAutomationService(connectionService)
  browserAutomationService.syncWithSettings()

  // Create remote status service (one status bar item for all webviews)
  const remoteService = new RemoteStatusService()
  context.subscriptions.push(remoteService)
  connectionService.setRemoteService(remoteService)

  // Re-register browser automation MCP server on CLI backend reconnect, configure telemetry,
  // and set remote service client.
  const unsubscribeStateChange = connectionService.onStateChange((state) => {
    if (state === "connected") {
      browserAutomationService.reregisterIfEnabled()
      const config = connectionService.getServerConfig()
      if (config) {
        telemetry.configure(config.baseUrl, config.password)
        // Sync the CLI's PostHog client with the current consent state. The
        // CLI reads KILO_TELEMETRY_LEVEL once at spawn, so without this call
        // a fresh CLI started while VS Code telemetry was off would stay
        // opted out for the rest of the session.
        telemetry.setEnabled(vscode.env.isTelemetryEnabled)
      }
      try {
        remoteService.setClient(connectionService.getClient())
        console.log("[Kilo New] CLI connected, calling remoteService.refresh()")
        remoteService.refresh().catch((err) => console.warn("[Kilo New] initial remote refresh failed:", err))
      } catch {
        remoteService.setClient(null)
      }
    } else {
      remoteService.clearState()
      remoteService.setClient(null)
    }
  })

  // Propagate runtime telemetry consent changes to the CLI subprocess so its
  // PostHog client stays in sync with the user's VS Code telemetry setting.
  context.subscriptions.push(
    vscode.env.onDidChangeTelemetryEnabled((enabled) => {
      telemetry.setEnabled(enabled)
    }),
  )

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void markWorkspace(folder.uri.fsPath, (msg) => console.warn(`[Kilo New] ${msg}`))
  }

  const activeTabProvider = () => {
    for (const [panel, p] of tabPanels) {
      if (panel.active) return p
    }
    return undefined
  }

  /**
   * P3.1 chat target resolution shared by code/terminal actions and chat
   * commands: the active Agent Manager panel is preferred, then the active
   * editor-tab KiloProvider, then the Agent Manager opened on demand when
   * nothing is focused. Returns undefined only when the chosen webview never
   * reached readiness — callers skip posting instead of dropping messages
   * into an unprepared panel. The removed sidebar provider is intentionally
   * not recreated. The decision rules live in the vscode-free chat-target
   * helper so they are executable-tested.
   */
  const resolveChatTarget = (): Promise<ChatTarget | undefined> =>
    resolveChatTargetImpl(agentManagerProvider, activeTabProvider)

  /**
   * Cold-open fallback for editor/title toolbar commands: open the Agent
   * Manager panel and deliver `msg` only after its webview reports readiness.
   * Posting before readiness drops the message into an unprepared webview
   * (P3.1 readiness race fix).
   */
  const postToAgentManager = async (msg: unknown): Promise<void> => {
    await agentManagerProvider.openPanel()
    const ok = await agentManagerProvider.waitForReady()
    if (!ok) return
    agentManagerProvider.postMessage(msg)
  }

  /**
   * Resolve an editor-tab chat surface for deep links (linked model selection):
   * the active tab, or a freshly opened "Open in Tab" panel.
   * The Agent Manager webview does not handle selectKiloModel.
   */
  const ensureChatTab = async (): Promise<KiloProvider> => {
    const tab = activeTabProvider()
    if (tab) return tab
    return openKiloInNewTab(context, connectionService, agentManagerProvider, remoteService, autoApprove, canonicalConfig)
  }

  // Ensure Agent Manager navigation keybindings work when a VS Code terminal has focus.
  // The terminal intercepts all keystrokes unless the command is listed in
  // terminal.integrated.commandsToSkipShell, which only contains built-in
  // commands by default.
  const skip = ["kilo-code.new.agentManagerOpen", "kilo-code.new.agentManager.showTerminal"]
  ensureCommandsSkipShell(skip)

  // Create Agent Manager provider for editor panel
  const agentManagerHost = new VscodeHost(context.extensionUri, connectionService, context, remoteService, canonicalConfig)
  const agentManagerProvider = new AgentManagerProvider(agentManagerHost, connectionService)
  agentManagerProvider.onPanelVisibilityChange((visible) => remember({ agentManager: visible }))
  // R9-C3: wire panel visibility trigger without altering existing remember wiring
  agentManagerProvider.onPanelVisibilityChange((visible) => {
    void privateObservationTriggers.onPanelVisibilityChanged(visible)
  })
  agentManager = agentManagerProvider
  context.subscriptions.push(agentManagerProvider)

  // Register toggle auto-approve shortcut (Ctrl+Alt+A / Cmd+Alt+A)
  const defaultDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const autoApprove = registerToggleAutoApprove(
    context,
    connectionService,
    (sessionId) => {
      if (sessionId) {
        for (const [, p] of tabPanels) {
          const dir = p.getSessionDirectories().get(sessionId)
          if (dir) return dir
        }
        const dir = agentManagerProvider.getSessionDirectories().get(sessionId)
        if (dir) return dir
      }
      return defaultDir()
    },
    () => {
      const dirs = new Set([defaultDir()])
      for (const [, p] of tabPanels) for (const dir of p.getSessionDirectories().values()) dirs.add(dir)
      for (const dir of agentManagerProvider.getSessionDirectories().values()) dirs.add(dir)
      return [...dirs]
    },
  )
  const attention = new AttentionService(connectionService, {
    approve: (event, directory) => autoApprove.approve(event, directory),
  })

  agentManagerHost.setAutoApproveController(autoApprove)

  // Register serializer so Agent Manager restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(AgentManagerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        if (restore.agentManager === false) {
          panel.dispose()
          return Promise.resolve()
        }
        const ctx = agentManagerHost.wrapExistingPanel(panel, {
          onBeforeMessage: (msg) => agentManagerProvider.handleMessage(msg),
        })
        agentManagerProvider.deserializePanel(ctx)
        return Promise.resolve()
      },
    }),
  )

  // Register serializer so "Open in Tab" restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("kilo-code.new.TabPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const tabProvider = new KiloProvider(context.extensionUri, connectionService, context, {
          tabTitle: panelTitleHandler(panel),
          canonicalConfig,
        })
        tabProvider.setRemoteService(remoteService)
        tabProvider.setAutoApproveController(autoApprove)
        tabProvider.resolveWebviewPanel(panel)
        tabPanels.set(panel, tabProvider)
        panel.onDidDispose(
          () => {
            console.log("[Kilo New] Tab panel restored from restart disposed")
            tabPanels.delete(panel)
            tabProvider.dispose()
          },
          null,
          context.subscriptions,
        )
        return Promise.resolve()
      },
    }),
  )

  // Create standalone editor providers (open in editor area, not sidebar)
  const settingsEditorProvider = new SettingsEditorProvider(context.extensionUri, connectionService, context)
  settingsEditorProvider.setCanonicalConfig(canonicalConfig)
  settingsEditorProvider.setRemoteService(remoteService)
  const marketplacePanelProvider = new MarketplacePanelProvider(context.extensionUri, connectionService, context)
  context.subscriptions.push(settingsEditorProvider, marketplacePanelProvider)

  // Surface a discardable notification when a marketplace item matches the workspace.
  const marketplaceNotifier = new MarketplaceNotifier(connectionService, context, (item) =>
    marketplacePanelProvider.openInstall(item),
  )
  context.subscriptions.push(marketplaceNotifier)
  marketplaceNotifier.start()

  // Register serializers so standalone panels restore on restart
  const settingsViews = ["settingsPanel", "profilePanel"] as const
  for (const suffix of settingsViews) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(`kilo-code.new.${suffix}`, {
        deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          settingsEditorProvider.deserializePanel(panel)
          return Promise.resolve()
        },
      }),
    )
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(MarketplacePanelProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        marketplacePanelProvider.deserializePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  // Register toolbar button command handlers. P3.1: the sidebar is gone, so
  // commands that previously fell back to the sidebar chat surface now target
  // the active editor-tab KiloProvider, or open/focus the Agent Manager panel
  // when no tab exists. No surrogate hidden sidebar provider is created.
  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.plusButtonClicked", async () => {
      const tab = activeTabProvider()
      if (tab) {
        tab.postMessage({ type: "action", action: "plusButtonClicked" })
      } else {
        await postToAgentManager({ type: "action", action: "newTab" })
      }
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManagerOpen", () => {
      agentManagerProvider.openPanel()
    }),
    vscode.commands.registerCommand("kilo-code.new.marketplaceButtonClicked", (directory?: string | null) => {
      marketplacePanelProvider.openPanel(directory)
    }),
    vscode.commands.registerCommand("kilo-code.new.historyButtonClicked", async () => {
      const tab = activeTabProvider()
      if (tab) {
        tab.postMessage({ type: "action", action: "historyButtonClicked" })
      } else {
        await postToAgentManager({ type: "navigate", view: "history" })
      }
    }),
    vscode.commands.registerCommand("kilo-code.new.cycleAgentMode", async () => {
      const tab = activeTabProvider()
      if (tab) {
        tab.postMessage({ type: "action", action: "cycleAgentMode" })
      } else {
        await postToAgentManager({ type: "action", action: "cycleAgentMode" })
      }
    }),
    vscode.commands.registerCommand("kilo-code.new.cyclePreviousAgentMode", async () => {
      const tab = activeTabProvider()
      if (tab) {
        tab.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      } else {
        await postToAgentManager({ type: "action", action: "cyclePreviousAgentMode" })
      }
    }),
    vscode.commands.registerCommand("kilo-code.new.profileButtonClicked", () => {
      settingsEditorProvider.openPanel("profile")
    }),
    vscode.commands.registerCommand("kilo-code.new.settingsButtonClicked", (tab?: string) => {
      settingsEditorProvider.openPanel("settings", tab)
    }),
    // legacy-migration start
    vscode.commands.registerCommand("kilo-code.new.openMigrationWizard", async () => {
      const tab = activeTabProvider()
      if (tab) {
        await tab.waitForReady()
        tab.postMessage({ type: "migrationState", needed: true, source: "legacy" })
        return
      }
      const tabProvider = await openKiloInNewTab(
        context,
        connectionService,
        agentManagerProvider,
        remoteService,
        autoApprove,
        canonicalConfig,
      )
      await tabProvider.waitForReady()
      tabProvider.postMessage({ type: "migrationState", needed: true, source: "legacy" })
    }),
    // legacy-migration end
    vscode.commands.registerCommand("kilo-code.new.generateTerminalCommand", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Describe the terminal command you want to generate",
        placeHolder: "e.g., find all .ts files modified in the last 24 hours",
      })
      if (!input) return
      const target = await resolveChatTarget()
      if (!target) return
      target.postMessage({ type: "triggerTask", text: `Generate a terminal command: ${input}` })
    }),
    vscode.commands.registerCommand("kilo-code.new.toggleRemote", () => {
      remoteService.toggle().catch((err) => console.error("[Kilo New] toggleRemote command failed:", err))
    }),
    vscode.commands.registerCommand("kilo-code.new.openInTab", () => {
      return openKiloInNewTab(context, connectionService, agentManagerProvider, remoteService, autoApprove, canonicalConfig)
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.previousSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionPrevious" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.nextSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionNext" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.previousTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabPrevious" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.nextTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabNext" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.search", () => {
      agentManagerProvider.postMessage({ type: "action", action: "search" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.showTerminal", () => {
      // Route through the webview so it can reach into the active session
      // state and open the VS Code integrated terminal for it.
      agentManagerProvider.postMessage({ type: "action", action: "showTerminal" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.showShortcuts", () => {
      agentManagerProvider.postMessage({ type: "action", action: "showShortcuts" })
    }),

    vscode.commands.registerCommand("kilo-code.new.agentManager.newTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newTab" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.newTerminal", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newTerminal" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManager.closeTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeTab" })
    }),
    ...Array.from({ length: 9 }, (_, i) =>
      vscode.commands.registerCommand(`kilo-code.new.agentManager.jumpTo${i + 1}`, () => {
        agentManagerProvider.postMessage({ type: "action", action: `jumpTo${i + 1}` })
      }),
    ),
  )

  // Register URI handler for extension deep links (vscode://kilocode.kilo-code/kilocode/...)
  // P3.1: deep links target an editor-tab chat (opening one via Open in Tab when
  // none exists) — the sidebar surface that previously owned these is gone.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        if (uri.path !== "/kilocode/switch" && uri.path !== "/kilocode/model") return
        const params = new URLSearchParams(uri.query)
        const modelID = params.get("model") || undefined
        const agent = params.get("agent") || undefined
        if (!modelID && !agent) return
        console.log("[Kilo New] URI handler: applying linked Kilo selection:", { modelID, agent })
        const tab = await ensureChatTab()
        tab.selectKiloModel(modelID, agent)
      },
    }),
  )

  registerHeapSnapshot(context, connectionService)

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.reload", async () => {
      // P3.1: reload is a backend instance reload, so it runs directly on the
      // shared connection instead of a (removed) sidebar webview. Target the
      // active surface's session directory — the active editor tab, else the
      // Agent Manager's active session — so directory-scoped backend state
      // reloads where the user is working; fall back to the first workspace
      // root/cwd (matching the removed sidebar provider's reload semantics).
      try {
        const client = await connectionService.getClientAsync()
        const tab = activeTabProvider()
        const dir = resolveReloadDirectory({
          tab: tab
            ? { sessionID: tab.getCurrentSessionId(), sessionDirectories: tab.getSessionDirectories() }
            : undefined,
          agentManager: {
            sessionID: agentManagerProvider.getActiveSessionId(),
            sessionDirectories: agentManagerProvider.getSessionDirectories(),
          },
          fallback: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        })
        await client.instance.reload({ directory: dir }, { throwOnError: true })
      } catch (err) {
        const status =
          err && typeof err === "object" && "response" in err
            ? (err as { response?: { status?: number } }).response?.status
            : undefined
        if (status === 409) {
          vscode.window.showWarningMessage(
            "Cannot reload while a session is running. Wait for it to finish or abort it first.",
          )
        } else {
          console.error("[Kilo New] reload command failed:", err)
          vscode.window.showErrorMessage("Reload failed. See extension logs for details.")
        }
      }
    }),
  )

  // Register code actions (editor context menus, terminal context menus, keyboard shortcuts)
  registerCodeActions(context, resolveChatTarget)
  registerTerminalActions(context, resolveChatTarget)

  // Register CodeActionProvider (lightbulb quick fixes)
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new KiloCodeActionProvider(),
      KiloCodeActionProvider.metadata,
    ),
  )

  // E2E fixture bridge (gated). Registered only when the real Extension Host
  // E2E harness (script/e2e-probe.ts) sets KILO_E2E_FIXTURE. Exposes
  // deterministic probes to the extension-host test runner: Agent Manager
  // panel readiness, typed webview posting, session-list settlement
  // (await the real backend session refresh so the runner can re-seed after
  // it), variant-model provisioning (inject a model with ≥2 reasoning
  // variants into the served provider catalog so the real ThinkingSelector is
  // interactive — the models.dev snapshot ships no variant-bearing models),
  // and a read-only snapshot of served-backend truth (session list,
  // transcripts, statuses, agent catalog, connected providers) for the
  // real-session scenario. No production effect when the env var is absent —
  // no commands are registered and no webview code runs.
  if (process.env.KILO_E2E_FIXTURE) {
    context.subscriptions.push(
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.agentManagerReady", async () => {
        await agentManagerProvider.waitForReady()
        return true
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.postToAgentManager", (msg: unknown) => {
        agentManagerProvider.postMessage(msg)
        return true
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.settleSessions", async () => {
        await agentManagerProvider.settleSessionsForFixture()
        return true
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.backendSnapshot", async () => {
        return agentManagerProvider.backendSnapshotForFixture()
      }),
      // Read-only runtime snapshot of the CanonicalConfigService materialization
      // state (roots, readiness, stamps, asset scan summary, selector index
      // sizes/ids) — lets the real-restart harness distinguish readiness-never-
      // opened from ready-but-empty-index when ModeSwitcher options=[] recurs.
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.canonicalState", async () => {
        return canonicalConfig.fixtureStateSnapshot()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.mcpDisconnect", async (name: string) => {
        return agentManagerProvider.mcpDisconnectForFixture(name)
      }),
      // LOCK-006/LOCK-008 generation-request evidence: aggregate typed records
      // of every backend `service=llm` line (provider/model/agent/small/
      // session) across all server instances and launches of this run, plus a
      // run-start reset. The real-* scenarios assert every record is the
      // run-owned e2e-local/e2e-model — any kilo/kilo-auto/* line fails.
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.llmRequests", async () => {
        return connectionService.fixtureLlmRequests()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.llmRequestsReset", async () => {
        return connectionService.fixtureLlmRequestsReset()
      }),
      // real-restart transport/process-ownership probes over the shared
      // bridge: SSE reconnect trigger + observation, exact-owned worker kill,
      // and the production reconnect flow. All are env-gated: the
      // connection-service methods throw when the fixture env is absent and
      // these commands are not registered at all. The live reconnect/kill
      // outputs carry the exact server PID facts the harness asserts on.
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.sseReconnect", async () => {
        return connectionService.fixtureSseReconnect()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.killServer", async () => {
        return connectionService.fixtureKillServer()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.reconnectServer", async () => {
        return connectionService.fixtureReconnectServer()
      }),
      vscode.commands.registerCommand(
        "kilo-code.new.e2eFixture.provisionVariantModel",
        async (opts?: { providerID?: string; modelID?: string; variants?: string[] }) => {
          await provisionVariantModelFixture(
            agentManagerProvider,
            connectionService,
            opts?.providerID ?? "kilo",
            opts?.modelID ?? "e2e-probe",
            opts?.variants ?? ["low", "medium", "high"],
          )
          return true
        },
      ),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.seedCredential", async () => {
        return canonicalConfig.seedFixtureProviderCredential("e2e-local", "e2e-fixture-key")
      }),
      // P3.1 sidebar-removal scenario: open a fresh "Open in Tab" editor panel
      // through the production openInTab path and report whether its webview
      // reached readiness. Proves the session editor survives without the
      // removed sidebar provider.
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.openInTabReady", async () => {
        await vscode.commands.executeCommand("kilo-code.new.openInTab")
        const newest = [...tabPanels.entries()].at(-1)
        if (!newest) return { count: 0, ready: false }
        const [, tabProvider] = newest
        const ready = await Promise.race([
          tabProvider.waitForReady().then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 30_000)),
        ])
        return { count: tabPanels.size, ready }
      }),
    )
  }

  // Dispose services when extension deactivates (kills the server)
  context.subscriptions.push({
    dispose: () => {
      shuttingDown = true
      unsubscribeStateChange()
      attention.dispose()
      browserAutomationService.dispose()
      notebookBridge.dispose()
      connectionService.dispose()
    },
  })

  // P0 perf: activation registration work is done (lazy spawn/connect happens
  // on first webview).
  p0Stage("activate.done")
}

export async function deactivate() {
  shuttingDown = true
  await agentManager?.shutdown()
  TelemetryProxy.getInstance().shutdown()
}

async function openKiloInNewTab(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
  agentManagerProvider: AgentManagerProvider,
  remoteService: RemoteStatusService,
  autoApprove: ReturnType<typeof registerToggleAutoApprove>,
  canonicalConfig: CanonicalConfigService,
): Promise<KiloProvider> {
  const lastCol = Math.max(...vscode.window.visibleTextEditors.map((e) => e.viewColumn || 0), 0)
  const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

  if (!hasVisibleEditors) {
    await vscode.commands.executeCommand("workbench.action.newGroupRight")
  }

  const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

  const panel = vscode.window.createWebviewPanel("kilo-code.new.TabPanel", EXTENSION_DISPLAY_NAME, targetCol, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
  })

  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-light.svg"),
    dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-dark.svg"),
  }

  const tabProvider = new KiloProvider(context.extensionUri, connectionService, context, {
    tabTitle: panelTitleHandler(panel),
    canonicalConfig,
  })
  tabProvider.setRemoteService(remoteService)
  tabProvider.setAutoApproveController(autoApprove)
  tabProvider.resolveWebviewPanel(panel)
  tabPanels.set(panel, tabProvider)

  // Wait for the new panel to become active before locking the editor group.
  // This avoids the race where VS Code hasn't switched focus yet.
  await waitForWebviewPanelToBeActive(panel)
  await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

  panel.onDidDispose(
    () => {
      console.log("[Kilo New] Tab panel disposed")
      tabPanels.delete(panel)
      tabProvider.dispose()
    },
    null,
    context.subscriptions,
  )
  return tabProvider
}

/**
 * Add extension commands to terminal.integrated.commandsToSkipShell so they
 * work when a VS Code terminal has focus. The setting only ships with built-in
 * commands; extension commands must be added explicitly.
 */
function ensureCommandsSkipShell(commands: string[]): void {
  const config = vscode.workspace.getConfiguration("terminal.integrated")
  const info = config.inspect<string[]>("commandsToSkipShell")
  // Update whichever scope already carries an override so we don't
  // shadow workspace settings or leak workspace values into global.
  const [existing, target] = info?.workspaceFolderValue
    ? [info.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    : info?.workspaceValue
      ? [info.workspaceValue, vscode.ConfigurationTarget.Workspace]
      : [info?.globalValue ?? [], vscode.ConfigurationTarget.Global]
  const missing = commands.filter((cmd) => !existing.includes(cmd))
  if (missing.length === 0) return
  config.update("commandsToSkipShell", [...existing, ...missing], target)
}

function waitForWebviewPanelToBeActive(panel: vscode.WebviewPanel): Promise<void> {
  if (panel.active) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const disposable = panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.active) {
        return
      }
      disposable.dispose()
      resolve()
    })
  })
}
