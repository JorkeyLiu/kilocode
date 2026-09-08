import * as vscode from "vscode"
import { AgentManagerProvider } from "./agent-manager/AgentManagerProvider"
import { VscodeHost } from "./agent-manager/vscode-host"
import { SettingsEditorProvider } from "./SettingsEditorProvider"
import { MarketplacePanelProvider } from "./MarketplacePanelProvider"
import { MarketplaceNotifier } from "./services/marketplace/notifier"
import { KiloConnectionService } from "./services/cli-backend"
import { AttentionService } from "./services/attention"
import { BrowserAutomationService } from "./services/browser-automation"
import { TelemetryProxy } from "./services/telemetry"
import {
  registerCodeActions,
  registerTerminalActions,
  KiloCodeActionProvider,
  type ChatTarget,
} from "./services/code-actions"
import { resolveChatTarget as resolveSharedChatTarget } from "./services/code-actions/chat-target"
import { registerToggleAutoApprove } from "./commands/toggle-auto-approve"
import { registerHeapSnapshot } from "./commands/heap-snapshot"
import { RemoteStatusService } from "./services/RemoteStatusService"
import { setPathParityConnection } from "./kilo-provider/model-state"
import { setCommandListParityConnection } from "./kilo-provider/commands"
import { setConfigWarningsParityConnection } from "./kilo-provider/config-warnings"
import { setProjectCurrentParityConnection } from "./kilo-provider/git-status"
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
import { resolveCanonicalDbPath } from "./private-worker/canonical-db-path"
import { wirePeerCloseObservation } from "./agent-manager/peer-close-wiring"
import { isE2EFixtureEnabled } from "./util/e2e-fixture"
import { SseTimelineFixture, resolveTimelineSessionId } from "./services/cli-backend/sse-timeline"

let agentManager: AgentManagerProvider | undefined
let shuttingDown = false

const RESTORE_KEY = "kilo.workbench.restore"

type RestoreState = {
  agentManager?: boolean
}

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
  for (const delayMs of [500, 1500, 3000, 5000]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    post()
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Kilo Code extension is now active")
  shuttingDown = false

  p0Begin()
  p0Stage("activate.start")

  const telemetry = TelemetryProxy.getInstance()

  const connectionService = new KiloConnectionService(context)
  const notebookBridge = createNotebookBridge(connectionService)
  // Fixture-only bounded SSE timeline observer (LOCK-049/050/051): redacted
  // arrival-order metadata of delivered events for the basic real-session Stop
  // flow. Wired to the existing onEvent path; commands registered below under
  // KILO_E2E_FIXTURE only.
  const sseTimeline = new SseTimelineFixture()

  const canonicalConfig = new CanonicalConfigService(context, {
    roots: new Roots(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
    globalState: createVscodeStateAdapter(context.globalState),
    workspaceState: createVscodeStateAdapter(context.workspaceState),
    watcherAdapter: createVscodeWatcherAdapter(),
  })
  context.subscriptions.push(canonicalConfig)
  canonicalConfig.initialize().catch((err) => {
    console.error("[Kilo New] CanonicalConfigService initialization failed:", err)
  })

  let privateObservation: PrivateObservationService
  try {
    const dbPath = resolveCanonicalDbPath()
    const isFixture = isE2EFixtureEnabled()
    privateObservation = new PrivateObservationService({
      enabled: true,
      dbPath,
      cursorStore: createMementoCursorStore(context.globalState),
      ...(isFixture ? { testBridge: true } : {}),
    })
    if (isFixture) {
      console.log("[Kilo] PrivateObservationService testBridge enabled for KILO_E2E_FIXTURE")
    }
  } catch (err) {
    console.warn("[Kilo] PrivateObservationService canonical DB path resolution failed, fail-closed:", err)
    let fallback: PrivateObservationService | null = null
    try {
      fallback = new PrivateObservationService({
        enabled: false,
        cursorStore: createMementoCursorStore(context.globalState),
      })
    } catch (e) {
      console.warn("[Kilo] PrivateObservationService fallback construction failed:", e)
      fallback = new PrivateObservationService({ enabled: false })
    }
    privateObservation = fallback
  }
  context.subscriptions.push(privateObservation)
  const privateObservationTriggers = PrivateObservationLifecycleTriggers.wireVscode(privateObservation, context)
  context.subscriptions.push(privateObservationTriggers)

  let restore = context.workspaceState.get<RestoreState>(RESTORE_KEY) ?? {}
  const remember = (patch: RestoreState) => {
    const next = { ...restore, ...patch }
    if (shuttingDown && patch.agentManager === false) next.agentManager = restore.agentManager
    restore = next
    void context.workspaceState.update(RESTORE_KEY, restore)
  }

  const browserAutomationService = new BrowserAutomationService(connectionService)
  browserAutomationService.syncWithSettings()

  const remoteService = new RemoteStatusService()
  context.subscriptions.push(remoteService)
  connectionService.setRemoteService(remoteService)
  remoteService.setParityConnection(connectionService)
  // Detached SDK-first `path/get` parity boundary for the narrowest existing
  // SDK consumer (`model-state.ts` resolve). SDK stays the sole authority;
  // the observer is non-blocking, warn-only, and never mutates SDK state.
  setPathParityConnection(connectionService)
  // Detached SDK-first `command/list` parity boundary for the narrowest
  // existing SDK consumer (`kilo-provider/commands.ts` loadCommands). Same
  // authority/observer contract as the path boundary.
  setCommandListParityConnection(connectionService)
  // Detached SDK-first `config/warnings` parity boundary for the narrowest
  // existing SDK consumer (`KiloProvider.checkConfigWarnings`). Same
  // authority/observer contract: SDK stays the sole user-visible authority
  // and the private path is warn-only observation of safe categories.
  setConfigWarningsParityConnection(connectionService)
  // Detached SDK-first `project/current` vcs-only parity boundary for the
  // narrowest existing SDK consumer (`kilo-provider/git-status.ts` hasGit).
  // Same authority/observer contract: SDK stays the sole user-visible
  // authority and the private path is warn-only observation of `vcs`.
  setProjectCurrentParityConnection(connectionService)

  const unsubscribeStateChange = connectionService.onStateChange((state) => {
    if (state === "connected") {
      browserAutomationService.reregisterIfEnabled()
      const config = connectionService.getServerConfig()
      if (config) {
        telemetry.configure(config.baseUrl, config.password)
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

  context.subscriptions.push(
    vscode.env.onDidChangeTelemetryEnabled((enabled) => {
      telemetry.setEnabled(enabled)
    }),
  )

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void markWorkspace(folder.uri.fsPath, (msg) => console.warn(`[Kilo New] ${msg}`))
  }

  const resolveChatTarget = (): Promise<ChatTarget | undefined> => resolveSharedChatTarget(agentManagerProvider)

  const postToAgentManager = async (msg: unknown): Promise<void> => {
    await agentManagerProvider.openPanel()
    const ok = await agentManagerProvider.waitForReady()
    if (!ok) return
    agentManagerProvider.postMessage(msg)
  }

  const skip = ["kilo-code.new.agentManagerOpen", "kilo-code.new.agentManager.showTerminal"]
  ensureCommandsSkipShell(skip)

  const privateSessionReader = {
    isEnabled: () => privateObservation.isEnabled(),
    isStarted: () => privateObservation.isStarted(),
    list: (input: { directory: string; archived?: boolean; cursor?: string; limit?: number }) => privateObservation.list(input) as Promise<unknown>,
    get: (input: { directory: string; sessionId: string }) => privateObservation.get(input) as Promise<unknown>,
  }
  const agentManagerHost = new VscodeHost(
    context.extensionUri,
    connectionService,
    context,
    remoteService,
    canonicalConfig,
    privateSessionReader,
  )
  const agentManagerProvider = new AgentManagerProvider(agentManagerHost, connectionService, privateObservation)
  context.subscriptions.push(
    agentManagerProvider.onPanelVisibilityChange((visible) => remember({ agentManager: visible })),
  )
  agentManager = agentManagerProvider
  context.subscriptions.push(agentManagerProvider)

  // Bounded worker-restart convergence: peer-close lifecycle performs one reconnect+read(persistedCursor)
  // and that exact read result drives the provider's refresh decision without a second private read.
  // Failure (result absent/readError/missing cursor/readResult or invalid wire) -> one SDK fallback
  // with no second read; temporal staleness (current persisted undefined or != requestedCursor,
  // whether < or >) -> normal fresh decision which may read again. Window/config remain
  // observation-only and are not routed to UI.
  wirePeerCloseObservation(privateObservation, privateObservationTriggers, agentManagerProvider)

  privateObservation.initialize().catch((err) => {
    console.warn("[Kilo] PrivateObservationService initialize failed (fail-closed):", err)
  })

  const defaultDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const autoApprove = registerToggleAutoApprove(
    context,
    connectionService,
    (sessionId) => {
      if (sessionId) {
        const dir = agentManagerProvider.getSessionDirectories().get(sessionId)
        if (dir) return dir
      }
      return defaultDir()
    },
    () => {
      const dirs = new Set([defaultDir()])
      for (const dir of agentManagerProvider.getSessionDirectories().values()) dirs.add(dir)
      return [...dirs]
    },
  )
  const attention = new AttentionService(connectionService, {
    approve: (event, directory) => autoApprove.approve(event, directory),
  })

  agentManagerHost.setAutoApproveController(autoApprove)

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

  const settingsEditorProvider = new SettingsEditorProvider(context.extensionUri, connectionService, context)
  settingsEditorProvider.setCanonicalConfig(canonicalConfig)
  settingsEditorProvider.setRemoteService(remoteService)
  const marketplacePanelProvider = new MarketplacePanelProvider(context.extensionUri, connectionService, context)
  context.subscriptions.push(settingsEditorProvider, marketplacePanelProvider)

  const marketplaceNotifier = new MarketplaceNotifier(connectionService, context, (item) =>
    marketplacePanelProvider.openInstall(item),
  )
  context.subscriptions.push(marketplaceNotifier)
  marketplaceNotifier.start()

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

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.plusButtonClicked", async () => {
      await postToAgentManager({ type: "action", action: "newTab" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManagerOpen", () => {
      agentManagerProvider.openPanel()
    }),
    vscode.commands.registerCommand("kilo-code.new.marketplaceButtonClicked", (directory?: string | null) => {
      marketplacePanelProvider.openPanel(directory)
    }),
    vscode.commands.registerCommand("kilo-code.new.historyButtonClicked", async () => {
      await postToAgentManager({ type: "navigate", view: "history" })
    }),
    vscode.commands.registerCommand("kilo-code.new.cycleAgentMode", async () => {
      await postToAgentManager({ type: "action", action: "cycleAgentMode" })
    }),
    vscode.commands.registerCommand("kilo-code.new.cyclePreviousAgentMode", async () => {
      await postToAgentManager({ type: "action", action: "cyclePreviousAgentMode" })
    }),
    vscode.commands.registerCommand("kilo-code.new.profileButtonClicked", () => {
      settingsEditorProvider.openPanel("profile")
    }),
    vscode.commands.registerCommand("kilo-code.new.settingsButtonClicked", (tab?: string) => {
      settingsEditorProvider.openPanel("settings", tab)
    }),
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

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        if (uri.path !== "/kilocode/switch" && uri.path !== "/kilocode/model") return
        const params = new URLSearchParams(uri.query)
        const modelID = params.get("model") || undefined
        const agent = params.get("agent") || undefined
        if (!modelID && !agent) return
        console.log("[Kilo New] URI handler: applying linked Kilo selection:", { modelID, agent })
        await postToAgentManager({ type: "selectKiloModel", modelID, agent })
      },
    }),
  )

  registerHeapSnapshot(context, connectionService)

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.reload", async () => {
      try {
        const client = await connectionService.getClientAsync()
        const dir = resolveReloadDirectory({
          tab: undefined,
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

  registerCodeActions(context, resolveChatTarget)
  registerTerminalActions(context, resolveChatTarget)

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new KiloCodeActionProvider(),
      KiloCodeActionProvider.metadata,
    ),
  )

  if (isE2EFixtureEnabled()) {
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
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.reloadAgentManagerWebview", async () => {
        await agentManagerProvider.reloadWebviewForFixture()
        return true
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.backendSnapshot", async () => {
        return agentManagerProvider.backendSnapshotForFixture()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.canonicalState", async () => {
        return canonicalConfig.fixtureStateSnapshot()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.mcpDisconnect", async (name: string) => {
        return agentManagerProvider.mcpDisconnectForFixture(name)
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.llmRequests", async () => {
        return connectionService.fixtureLlmRequests()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.llmRequestsReset", async () => {
        return connectionService.fixtureLlmRequestsReset()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.abortAttempts", async () => {
        const { fixtureAbortAttempts, fixtureAbortAttemptCount } = await import("./kilo-provider/abort")
        return { entries: fixtureAbortAttempts(), total: fixtureAbortAttemptCount() }
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.abortAttemptsReset", async () => {
        const { fixtureAbortAttemptsReset } = await import("./kilo-provider/abort")
        return fixtureAbortAttemptsReset()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.sseReconnect", async () => {
        return connectionService.fixtureSseReconnect()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.sseTimelineStart", async () => {
        return sseTimeline.start(connectionService.onEvent.bind(connectionService), resolveTimelineSessionId)
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.sseTimelineStop", async () => {
        return sseTimeline.stop()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.sseTimelineRead", async () => {
        return sseTimeline.read()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.sseTimelineReset", async () => {
        return sseTimeline.reset()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.killServer", async () => {
        return connectionService.fixtureKillServer()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.reconnectServer", async () => {
        return connectionService.fixtureReconnectServer()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privatePeerStatus", async () => {
        return connectionService.fixturePrivatePeerStatus()
      }),
      vscode.commands.registerCommand(
        "kilo-code.new.e2eFixture.sessionUpdate",
        async (opts?: { sessionId?: string; title?: string; directory?: string }) => {
          if (!opts?.sessionId || !opts?.title) throw new Error("sessionId and title required")
          return connectionService.fixtureSessionUpdate({
            sessionId: opts.sessionId,
            title: opts.title,
            directory: opts.directory,
          })
        },
      ),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateReplay", async (sessionId?: string) => {
        if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId required")
        return connectionService.fixturePrivateReplay(sessionId)
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
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationStatus", async () => {
        const dbPath = (() => {
          try {
            return resolveCanonicalDbPath()
          } catch (e) {
            return `error:${String(e)}`
          }
        })()
        const host = privateObservation.getHost()
        return {
          enabled: privateObservation.isEnabled(),
          hostState: privateObservation.getHostState(),
          pid: host?.getPid(),
          isStarted: privateObservation.isStarted(),
          persistedCursor: privateObservation.getPersistedCursor(),
          dbPath,
          testBridge: isE2EFixtureEnabled(),
          envDb: process.env.KILO_DB ?? null,
        }
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationSnapshot", async () => {
        return privateObservation.snapshot({})
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationRead", async (cursor: number) => {
        return privateObservation.read(cursor)
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationAck", async (cursor: number) => {
        return privateObservation.ack(cursor)
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationSubscribe", async () => {
        return privateObservation.subscribe({})
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationReconnect", async () => {
        return privateObservation.reconnect()
      }),
      vscode.commands.registerCommand(
        "kilo-code.new.e2eFixture.privateObservationWaitReady",
        async (timeoutMs?: number) => {
          const t = typeof timeoutMs === "number" ? timeoutMs : 10_000
          await privateObservation.waitReady(t)
          const host = privateObservation.getHost()
          return {
            hostState: privateObservation.getHostState(),
            isStarted: privateObservation.isStarted(),
            pid: host?.getPid(),
            persistedCursor: privateObservation.getPersistedCursor(),
          }
        },
      ),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationOnPeerClosed", async () => {
        const before = {
          hostState: privateObservation.getHostState(),
          isStarted: privateObservation.isStarted(),
          pid: privateObservation.getHost()?.getPid(),
          pendingPid: privateObservation.getPendingShutdownHost()?.getPid(),
        }
        const triggerResult = await privateObservationTriggers.onPeerClosed()
        const after = {
          hostState: privateObservation.getHostState(),
          isStarted: privateObservation.isStarted(),
          pid: privateObservation.getHost()?.getPid(),
          pendingPid: privateObservation.getPendingShutdownHost()?.getPid(),
          pendingAlive: (() => {
            const h = privateObservation.getPendingShutdownHost()
            return h ? h.isAlive() : false
          })(),
        }
        return { before, after, trigger: triggerResult }
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationClosePeer", async () => {
        const before = {
          hostState: privateObservation.getHostState(),
          isStarted: privateObservation.isStarted(),
          pid: privateObservation.getHost()?.getPid(),
          pendingPid: privateObservation.getPendingShutdownHost()?.getPid(),
        }
        const beforeAlive = (() => {
          const h = privateObservation.getHost()
          return h ? h.isAlive() : false
        })()
        const closeRes = privateObservation.closePeerTransport()
        const afterClose = {
          hostState: privateObservation.getHostState(),
          pid: privateObservation.getHost()?.getPid(),
          closeAlive: closeRes.aliveBefore,
          closeAliveAfter: closeRes.aliveAfter,
          closed: closeRes.closed,
          beforeAlive,
          beforePid: closeRes.beforePid,
          afterPid: closeRes.afterPid,
          afterHostState: closeRes.afterHostState,
        }
        let triggerResult: unknown = undefined
        try {
          triggerResult = await privateObservationTriggers.onPeerClosed()
        } catch (e) {
          triggerResult = { error: String(e) }
        }
        const after = {
          hostState: privateObservation.getHostState(),
          isStarted: privateObservation.isStarted(),
          pid: privateObservation.getHost()?.getPid(),
          pendingPid: privateObservation.getPendingShutdownHost()?.getPid(),
          pendingAlive: (() => {
            const h = privateObservation.getPendingShutdownHost()
            return h ? h.isAlive() : false
          })(),
        }
        return { before, afterClose, after, trigger: triggerResult, close: closeRes }
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationKillWorker", async () => {
        const host = privateObservation.getHost()
        const beforePid = host?.getPid()
        const proc = host?.getProc() ?? null
        if (!proc || !beforePid) throw new Error("no active private worker to kill")
        const exitedBefore = proc.exitCode !== null || proc.signalCode !== null
        if (exitedBefore) throw new Error(`private worker pid ${beforePid} already exited`)
        try {
          proc.kill()
        } catch (e) {
          throw new Error(`kill exact pid ${beforePid} failed: ${String(e)}`)
        }
        const ok = await (host?.waitForExit(5000) ?? Promise.resolve(false))
        if (!ok) throw new Error(`exact pid ${beforePid} did not exit after kill`)
        const afterKillPid = privateObservation.getHost()?.getPid()
        const reconnectResult = await privateObservation.reconnect()
        const after = {
          hostState: privateObservation.getHostState(),
          isStarted: privateObservation.isStarted(),
          pid: privateObservation.getHost()?.getPid(),
          pendingPid: privateObservation.getPendingShutdownHost()?.getPid() ?? null,
          pendingAlive: (() => {
            const h = privateObservation.getPendingShutdownHost()
            return h ? h.isAlive() : false
          })(),
        }
        return { beforePid, afterKillPid, after, reconnectResult }
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationMutate", async (params: unknown) => {
        return privateObservation.request("test/mutateChangefeed", params)
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationNotifications", async () => {
        return privateObservation.getNotificationSnapshot()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationNotificationsRaw", async () => {
        return privateObservation.getNotificationLog()
      }),
      vscode.commands.registerCommand("kilo-code.new.e2eFixture.privateObservationClearNotifications", async () => {
        privateObservation.clearNotificationLog()
        return true
      }),
    )
  }

  context.subscriptions.push({
    dispose: () => {
      shuttingDown = true
      unsubscribeStateChange()
      attention.dispose()
      browserAutomationService.dispose()
      notebookBridge.dispose()
      sseTimeline.dispose()
      connectionService.dispose()
    },
  })

  p0Stage("activate.done")
}

export async function deactivate() {
  shuttingDown = true
  setPathParityConnection(null)
  setCommandListParityConnection(null)
  setConfigWarningsParityConnection(null)
  setProjectCurrentParityConnection(null)
  await agentManager?.shutdown()
  TelemetryProxy.getInstance().shutdown()
}

function ensureCommandsSkipShell(commands: string[]): void {
  const config = vscode.workspace.getConfiguration("terminal.integrated")
  const info = config.inspect<string[]>("commandsToSkipShell")
  const [existing, target] = info?.workspaceFolderValue
    ? [info.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    : info?.workspaceValue
      ? [info.workspaceValue, vscode.ConfigurationTarget.Workspace]
      : [info?.globalValue ?? [], vscode.ConfigurationTarget.Global]
  const missing = commands.filter((cmd) => !existing.includes(cmd))
  if (missing.length === 0) return
  config.update("commandsToSkipShell", [...existing, ...missing], target)
}
