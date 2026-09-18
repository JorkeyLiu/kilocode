import * as vscode from "vscode"
import { AgentManagerProvider } from "./agent-manager/AgentManagerProvider"
import { VscodeHost } from "./agent-manager/vscode-host"
import { SettingsEditorProvider } from "./SettingsEditorProvider"
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
import { registerHeapSnapshot } from "./commands/heap-snapshot"
import { RemoteStatusService } from "./services/RemoteStatusService"
import { setPathPrivateConnection } from "./kilo-provider/model-state"
import { setProjectCurrentPrivateConnection } from "./kilo-provider/git-status"
import { markWorkspace } from "./util/spotlight"
import { createNotebookBridge } from "./services/notebook"
import { p0Begin, p0Stage } from "./perf/perf-instrument"
import { resolveReloadDirectory } from "./reload-directory"
import {
  RELOAD_CONFLICT_WARNING,
  RELOAD_FAILED_ERROR,
  requestInstanceReload,
} from "./kilo-provider/instance-reload"
import { CanonicalConfigService } from "./config/service"
import { PrivateConvergenceAdapter } from "./config/convergence"
import { createVscodeStateAdapter, createVscodeWatcherAdapter } from "./config/state-adapter"
import { Roots } from "./config/paths"
import { PrivateObservationService } from "./private-worker/private-observation-service"
import { createMementoCursorStore } from "./private-worker/observation-cursor-store"
import { PrivateObservationLifecycleTriggers } from "./private-worker/private-observation-lifecycle-triggers"
import { resolveCanonicalDbPath } from "./private-worker/canonical-db-path"
import { wirePeerCloseObservation } from "./agent-manager/peer-close-wiring"
import { isE2EFixtureEnabled } from "./util/e2e-fixture"
import { SseTimelineFixture, resolveTimelineSessionId } from "./services/cli-backend/sse-timeline"
import { fetchFixtureVariantRealPrivateFirst } from "./kilo-provider/fixture-variant-real-privatefirst"

let agentManager: AgentManagerProvider | undefined
let shuttingDown = false

const RESTORE_KEY = "kilo.workbench.restore"

type RestoreState = {
  agentManager?: boolean
}

type FixtureRawProvider = { id?: unknown; name?: unknown; hasCredential?: unknown; models?: unknown }
type FixtureCanonicalModel = { id: string; name: string; variants?: Record<string, unknown> }
type FixtureCanonicalProvider = { id: string; name: string; hasCredential: boolean; models: Record<string, FixtureCanonicalModel> }

function fixtureModelView(mid: string, m: unknown): FixtureCanonicalModel {
  const view = m as { id?: unknown; name?: unknown; variants?: unknown }
  const modelVariants =
    view.variants && typeof view.variants === "object" && !Array.isArray(view.variants)
      ? (view.variants as Record<string, unknown>)
      : undefined
  const name = typeof view.name === "string" && view.name.length > 0 ? view.name : mid
  const id = typeof view.id === "string" && view.id.length > 0 ? view.id : mid
  return modelVariants ? { id, name, variants: modelVariants } : { id, name }
}

// Fixture-only canonical view: preserve every real catalog entry, inject only
// the synthetic model. Narrowed to {id,name,hasCredential,models}; no
// credentials, no extra catalog fields.
function fixtureCanonicalProviders(
  raw: Record<string, FixtureRawProvider>,
  connected: string[],
  providerID: string,
): Record<string, FixtureCanonicalProvider> {
  const out: Record<string, FixtureCanonicalProvider> = {}
  for (const [key, entry] of Object.entries(raw)) {
    const pid = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : key
    const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : pid
    const cred = typeof entry.hasCredential === "boolean" ? entry.hasCredential : connected.includes(pid)
    const modelsRaw = (entry.models as Record<string, unknown> | undefined) ?? {}
    const models: Record<string, FixtureCanonicalModel> = {}
    for (const [mid, m] of Object.entries(modelsRaw)) models[mid] = fixtureModelView(mid, m)
    out[pid] = { id: pid, name, hasCredential: pid === providerID ? true : cred, models }
  }
  return out
}

function fixtureCurrentVersion(canonicalConfig: CanonicalConfigService): number {
  return Math.max(
    canonicalConfig.stamp?.materializationVersion ?? 0,
    canonicalConfig.providerIndex?.materializationVersion ?? 0,
    canonicalConfig.snapshot?.generation ?? 0,
    canonicalConfig.lastReadyStamp?.materializationVersion ?? 0,
  )
}

type FixtureCanonicalAgentView = {
  name: string
  displayName: string
  description: string
  mode: "primary" | "subagent" | "all"
  hidden: boolean
  frontmatter?: Record<string, unknown>
  color?: string
  body?: string
}

type FixtureFrozenAgents = {
  agents: FixtureCanonicalAgentView[]
  allAgents: FixtureCanonicalAgentView[]
  defaultAgent: string
}

function fixtureSyntheticAgents(providerID: string, modelID: string): FixtureCanonicalAgentView[] {
  const binding = `${providerID}/${modelID}`
  return [
    {
      name: "code",
      displayName: "Code",
      description: "E2E fixture code agent",
      mode: "primary",
      hidden: false,
      frontmatter: { model: binding },
    },
    {
      name: "search",
      displayName: "Search",
      description: "E2E fixture search agent",
      mode: "primary",
      hidden: false,
      frontmatter: { model: binding },
    },
  ]
}

function fixtureAgentView(entry: Record<string, unknown>): FixtureCanonicalAgentView | null {
  const name = typeof entry.name === "string" ? entry.name : ""
  if (name.length === 0) return null
  const displayName =
    typeof entry.displayName === "string" && entry.displayName.length > 0 ? entry.displayName : name
  const description = typeof entry.description === "string" ? entry.description : ""
  const mode = entry.mode === "subagent" || entry.mode === "all" ? entry.mode : "primary"
  const hidden = entry.hidden === true
  const view: FixtureCanonicalAgentView = { name, displayName, description, mode, hidden }
  if (entry.frontmatter && typeof entry.frontmatter === "object" && !Array.isArray(entry.frontmatter))
    view.frontmatter = entry.frontmatter as Record<string, unknown>
  if (typeof entry.color === "string") view.color = entry.color
  if (typeof entry.body === "string") view.body = entry.body
  return view
}

// Fixture-only canonical agent union: deterministic synthetic pair first
// (`code`, then `search`), real entries deduped by name (synthetic wins) and
// sorted by name. `agents` mirrors the canonical visible contract
// (non-hidden only); `allAgents` preserves every entry including hidden.
// Default prefers `code` so the seeded transcript `agent:"code"` stays valid.
function fixtureCanonicalAgents(
  realAgents: Array<Record<string, unknown>>,
  providerID: string,
  modelID: string,
): FixtureFrozenAgents {
  const synthetic = fixtureSyntheticAgents(providerID, modelID)
  const seen = new Set(synthetic.map((a) => a.name))
  const real: FixtureCanonicalAgentView[] = []
  for (const entry of realAgents) {
    const view = fixtureAgentView(entry)
    if (!view) continue
    if (seen.has(view.name)) continue
    seen.add(view.name)
    real.push(view)
  }
  real.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const allAgents = [...synthetic, ...real]
  const agents = allAgents.filter((a) => !a.hidden)
  const hasCode = allAgents.some((a) => a.name === "code")
  const defaultAgent = hasCode ? "code" : (agents[0]?.name ?? allAgents[0]?.name ?? "code")
  return { agents, allAgents, defaultAgent }
}

function fixturePostVariant(
  agentManagerProvider: AgentManagerProvider,
  canonicalConfig: CanonicalConfigService,
  providers: Record<string, FixtureCanonicalProvider>,
  connected: string[],
  defaults: Record<string, string>,
  selections: Record<string, { providerID: string; modelID: string }>,
  providerID: string,
  modelID: string,
  fixtureVersion: number,
  frozen: { stamp: Record<string, unknown>; contentHash: string; agents: FixtureFrozenAgents },
): boolean {
  if (fixtureCurrentVersion(canonicalConfig) > fixtureVersion) return false
  const stamp = frozen.stamp
  const contentHash = frozen.contentHash
  if (Object.keys(selections).length > 0) {
    agentManagerProvider.postMessage({
      type: "modelSelectionsLoaded",
      selections,
      canonical: true,
      materializationVersion: fixtureVersion,
      stamp,
    })
  }
  agentManagerProvider.postMessage({
    type: "providersLoaded",
    providers,
    connected,
    defaults,
    defaultSelection: { providerID, modelID },
    canonical: true,
    ready: true,
    materializationVersion: fixtureVersion,
    contentHash,
    diagnostics: {},
    stamp,
  })
  agentManagerProvider.postMessage({
    type: "agentsLoaded",
    agents: frozen.agents.agents,
    allAgents: frozen.agents.allAgents,
    defaultAgent: frozen.agents.defaultAgent,
    canonical: true,
    ready: true,
    materializationVersion: fixtureVersion,
    contentHash,
    diagnostics: {},
    stamp,
  })
  return true
}

type FixtureRealState = {
  raw: Record<string, FixtureRawProvider>
  connected: string[]
  defaults: Record<string, string>
  selections: Record<string, { providerID: string; modelID: string }>
  realAgents: Array<Record<string, unknown>>
}

// Fixture-only real catalog/agents read: preserves every real entry, injects
// only the synthetic model, builds per-agent selections. No persistence.
// Private-first via the shared production projections; the SDK lives only in
// the helpers' exactly-once same-directory fallback.
async function fixtureLoadReal(
  connectionService: KiloConnectionService,
  root: string | undefined,
  providerID: string,
  modelID: string,
  injected: { id: string; name: string; variants: Record<string, unknown> },
): Promise<FixtureRealState> {
  try {
    const client = await connectionService.getClientAsync(root)
    const dir = root ?? ""
    return await fetchFixtureVariantRealPrivateFirst({
      connection: connectionService as never,
      client: client as never,
      directory: dir,
      providerID,
      modelID,
      injected,
    })
  } catch (err) {
    console.error("[Kilo New] provisionVariantModelFixture: real catalog/agents unavailable:", err)
    return { raw: {}, connected: [], defaults: {}, selections: {}, realAgents: [] }
  }
}

function fixtureEnsureSynthetic(
  state: FixtureRealState,
  providerID: string,
  modelID: string,
  injected: { id: string; name: string; variants: Record<string, unknown> },
): void {
  const existing = state.raw[providerID]
  if (!existing) {
    state.raw[providerID] = { id: providerID, name: providerID, hasCredential: true, models: { [modelID]: injected } }
  } else {
    const models = { ...((existing.models as Record<string, unknown> | undefined) ?? {}), [modelID]: injected }
    state.raw[providerID] = { ...existing, id: providerID, models, hasCredential: true }
  }
  if (!state.connected.includes(providerID)) state.connected = [...state.connected, providerID]
}

async function provisionVariantModelFixture(
  agentManagerProvider: AgentManagerProvider,
  connectionService: KiloConnectionService,
  canonicalConfig: CanonicalConfigService,
  providerID: string,
  modelID: string,
  variants: string[],
): Promise<void> {
  if (!isE2EFixtureEnabled()) throw new Error("provisionVariantModelFixture requires KILO_E2E_FIXTURE")
  await agentManagerProvider.settleSessionsForFixture()
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const variantMap: Record<string, unknown> = {}
  for (const variant of variants) variantMap[variant] = {}
  const injected = { id: modelID, name: modelID, variants: variantMap }
  const state = await fixtureLoadReal(connectionService, root, providerID, modelID, injected)
  fixtureEnsureSynthetic(state, providerID, modelID, injected)
  state.selections["code"] = { providerID, modelID }
  state.selections["search"] = { providerID, modelID }

  // Fixture materialization version: one past the current canonical state so
  // the webview stale guard cannot reject it. Frozen for the provision;
  // delayed republishes reuse the exact same version/stamp/hash/agents
  // objects (byte-stable, idempotent) and stop atomically for all three
  // surfaces when a newer real materialization exists (no split versions).
  const fixtureVersion = Math.max(fixtureCurrentVersion(canonicalConfig), 0) + 1
  const providers = fixtureCanonicalProviders(state.raw, state.connected, providerID)
  const frozen = {
    stamp: { ...canonicalConfig.stamp, materializationVersion: fixtureVersion },
    contentHash: canonicalConfig.snapshot?.contentHash ?? "e2e-fixture",
    agents: fixtureCanonicalAgents(state.realAgents, providerID, modelID),
  }
  const post = (): boolean =>
    fixturePostVariant(
      agentManagerProvider,
      canonicalConfig,
      providers,
      state.connected,
      state.defaults,
      state.selections,
      providerID,
      modelID,
      fixtureVersion,
      frozen,
    )
  if (!post()) return
  for (const delayMs of [500, 1500, 3000, 5000]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (!post()) return
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
    convergence: new PrivateConvergenceAdapter(() => {
      const peer = connectionService.getPrivatePeer()
      if (!peer || !connectionService.isPrivateAvailable()) return null
      const epoch = connectionService.getPrivateEpoch()
      return {
        request: (method: string, params: unknown) => {
          if (method !== "config/convergence/acquire" && method !== "config/convergence/resolve" && method !== "config/convergence/observe")
            return Promise.reject(new Error(`unsupported convergence method ${method}`))
          if (connectionService.getPrivatePeer() !== peer || connectionService.getPrivateEpoch() !== epoch)
            return Promise.reject(new Error("convergence epoch changed"))
          return connectionService.privateConvergenceRequest(method, params)
        },
        hasCapability: (cap: string) => peer.hasCapability(cap),
        getEpoch: () => epoch ?? 0,
      }
    }),
  })
  context.subscriptions.push(canonicalConfig)
  connectionService.setCanonicalConfigService(canonicalConfig)
  context.subscriptions.push({ dispose: () => connectionService.setCanonicalConfigService(null) })
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
  remoteService.setPrivateConnection(connectionService)
  // Private-first `path/get` connection for `model-state.ts` resolve.
  // Only `Path.state` is consumed; no new isolation contract.
  setPathPrivateConnection(connectionService)
  // Private-first `config/warnings` read for `KiloProvider.checkConfigWarnings`.
  // `KiloProvider` passes `connectionService` directly to the shared helper;
  // no global parity connection is retained. `compareConfigWarningsParity`
  // stays as pure diagnostic/test evidence only with no third request.
  // Private-first `project/current` narrow projection for the `hasGit`
  // production boolean consumer (`kilo-provider/git-status.ts` hasGit).
  // Only the derived `vcs === "git"` boolean is consumed; full
  // `Project.Info` stays SDK-only and is never a private contract.
  setProjectCurrentPrivateConnection(connectionService)

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
    messages: (input: { directory: string; sessionId: string; limit: number; cursor?: string }) =>
      privateObservation.messages(input) as Promise<unknown>,
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

  const attention = new AttentionService(connectionService)

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

  const settingsEditorProvider = new SettingsEditorProvider(
    context.extensionUri,
    connectionService,
    context,
    canonicalConfig,
  )
  settingsEditorProvider.setRemoteService(remoteService)
  context.subscriptions.push(settingsEditorProvider)

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
    vscode.commands.registerCommand("kilo-code.new.plusButtonClicked", async () => {
      await postToAgentManager({ type: "action", action: "newTab" })
    }),
    vscode.commands.registerCommand("kilo-code.new.agentManagerOpen", () => {
      agentManagerProvider.openPanel()
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
        const outcome = await requestInstanceReload({ connection: connectionService as never, client, directory: dir })
        if (outcome.kind === "conflict") {
          vscode.window.showWarningMessage(RELOAD_CONFLICT_WARNING)
        } else if (outcome.kind === "failed") {
          console.error("[Kilo New] reload command failed:", outcome.cause)
          vscode.window.showErrorMessage(RELOAD_FAILED_ERROR)
        }
      } catch (err) {
        console.error("[Kilo New] reload command failed:", err)
        vscode.window.showErrorMessage(RELOAD_FAILED_ERROR)
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
      vscode.commands.registerCommand(
        "kilo-code.new.e2eFixture.agentManagerContentReady",
        async (timeoutMs?: number) => {
          const t = typeof timeoutMs === "number" ? timeoutMs : 15_000
          await agentManagerProvider.waitForContentReadyForFixture(t)
          return true
        },
      ),
      vscode.commands.registerCommand(
        "kilo-code.new.e2eFixture.agentManagerBarrier",
        async (token?: string, timeoutMs?: number) => {
          const t = typeof timeoutMs === "number" ? timeoutMs : 15_000
          await agentManagerProvider.waitForFixtureBarrierForFixture(token as string, t)
          return true
        },
      ),
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
            canonicalConfig,
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
      void connectionService.dispose()
    },
  })

  p0Stage("activate.done")
}

export async function deactivate() {
  shuttingDown = true
  setPathPrivateConnection(null)
  setProjectCurrentPrivateConnection(null)
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
