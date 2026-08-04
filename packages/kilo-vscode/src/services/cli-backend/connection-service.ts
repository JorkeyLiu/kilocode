import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { createKiloClient, type KiloClient } from "@kilocode/sdk/v2/client"
import { SdkSSEAdapter, type SSEPayload } from "./sdk-sse-adapter"
import type { ServerConfig } from "./types"
import { resolveEventSessionId as resolveEventSessionIdPure } from "./connection-utils"
import { SandboxPreference } from "../sandbox-preference"

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error"
type SSEEventListener = (event: SSEPayload, directory?: string, transaction?: string) => void
type StateListener = (state: ConnectionState, error?: Error) => void
type SSEEventFilter = (event: SSEPayload, directory?: string) => boolean
type LanguageChangeListener = (locale: string) => void
type ProfileChangeListener = (data: unknown) => void
type MigrationCompleteListener = () => void
type FavoritesChangeListener = (favorites: Array<{ providerID: string; modelID: string }>) => void
type ModelSelectorExpandedListener = (value: boolean) => void
type DirectoryProvider = () => string[]

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

// Poll /global/health every 10 seconds.
// This provides a second detection channel for server death independent of the SSE heartbeat.
const HEALTH_POLL_INTERVAL_MS = 10_000

/**
 * Shared connection service that owns the single ServerManager, KiloClient (SDK), and SdkSSEAdapter.
 * Multiple KiloProvider instances subscribe to it for SSE events and state changes.
 */
export class KiloConnectionService {
  readonly sandboxPreference: SandboxPreference
  private readonly serverManager: ServerManager
  private client: KiloClient | null = null
  private sseClient: SdkSSEAdapter | null = null
  private info: { port: number } | null = null
  private config: ServerConfig | null = null
  private state: ConnectionState = "disconnected"
  private error: Error | null = null
  private connectPromise: Promise<void> | null = null
  private healthPollTimer: ReturnType<typeof setInterval> | null = null
  private remoteService: import("../RemoteStatusService").RemoteStatusService | null = null

  private readonly eventListeners: Set<SSEEventListener> = new Set()
  private readonly stateListeners: Set<StateListener> = new Set()
  private readonly languageChangeListeners: Set<LanguageChangeListener> = new Set()
  private readonly profileChangeListeners: Set<ProfileChangeListener> = new Set()
  private readonly migrationCompleteListeners: Set<MigrationCompleteListener> = new Set()
  private readonly favoritesChangeListeners: Set<FavoritesChangeListener> = new Set()
  private readonly modelSelectorExpandedListeners: Set<ModelSelectorExpandedListener> = new Set()
  private readonly directoryProviders: Set<DirectoryProvider> = new Set()
  private rootDirectory: string | undefined = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  private currentDirectory: string | undefined
  private readonly permissionDirectories: Map<string, string> = new Map()
  private readonly questionDirectories: Map<string, string> = new Map()
  private questionRevision = 0
  /**
   * Shared config revision — the single counter that orders config mutations.
   * LOCK-001: this connection service's SSE dispatch is the SOLE owner of
   * revision advancement for backend config events; a local successful
   * transaction never advances on its own (its canonical global.config.updated
   * echo does so exactly once after tagged coalescing, LOCK-004). KiloProvider
   * instances subscribe so stale reconciliation results are dropped and every
   * window converges (LOCK-005).
   */
  private configRevision = 0
  /**
   * LOCK-004: dedupe state for tagged config transactions. One backend
   * transaction emits one `global.config.updated` per changed scope, all
   * carrying the same transaction id; the first sighting advances exactly once
   * and later echoes are absorbed even when they arrive in a separate delivery
   * turn (SSE frame split across tasks). Untagged events never touch this set —
   * each is an independent revision. Bounded FIFO: transaction ids are fresh
   * UUIDs, so evicting the oldest entry can never collide with a new
   * transaction, and the set cannot grow unboundedly.
   */
  private static readonly MAX_SEEN_CONFIG_TRANSACTIONS = 1024
  private readonly seenConfigTransactions = new Set<string>()
  private readonly configRevisionListeners: Set<() => void> = new Set()

  /**
   * Shared mapping used to resolve session scope for events that don't reliably include a sessionID.
   * Used primarily for message.part.updated where only messageID may be present.
   */
  private readonly messageSessionIdsByMessageId: Map<string, string> = new Map()

  private readonly viewerId = crypto.randomUUID()
  private active = true
  private windowStateDisposable: vscode.Disposable | null = null
  private checkinTimer: ReturnType<typeof setInterval> | null = null
  /** Provider key → attached (retained for remote control) session IDs. */
  private readonly attached: Map<string, Set<string>> = new Map()
  /** Provider key → visibly rendered session IDs. */
  private readonly visible: Map<string, Set<string>> = new Map()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private viewedSending = false
  private viewedDirty = false
  private unsubRemote: (() => void) | null = null

  constructor(context: vscode.ExtensionContext) {
    const state =
      context.workspaceState ??
      ({
        get: <T>(_key: string, fallback?: T) => fallback,
        update: async () => undefined,
      } satisfies Pick<vscode.Memento, "get" | "update">)
    this.sandboxPreference = new SandboxPreference(state)
    this.serverManager = new ServerManager(context, (code) => this.handleServerExit(code))
    this.active = vscode.window.state.focused
    this.windowStateDisposable = vscode.window.onDidChangeWindowState((ws) => {
      this.active = ws.focused
      this.flushViewed()
    })
  }

  /**
   * Lazily start server + SSE. Multiple callers share the same promise.
   */
  async connect(workspaceDir: string): Promise<void> {
    this.trackDirectory(workspaceDir)
    if (this.connectPromise) {
      return this.connectPromise
    }
    if (this.state === "connected") {
      return
    }

    // Mark as connecting early so concurrent callers won't start another connection attempt.
    this.setState("connecting")

    this.connectPromise = this.doConnect(workspaceDir)
    try {
      await this.connectPromise
    } catch (error) {
      // If doConnect() fails before SSE can emit a state transition, avoid leaving consumers stuck in "connecting".
      this.setState("error", this.error ?? (error instanceof Error ? error : new Error(String(error))))
      throw error
    } finally {
      this.connectPromise = null
    }
  }

  /**
   * Get the shared SDK client. Throws if not connected.
   */
  getClient(): KiloClient {
    if (!this.client || this.state !== "connected") {
      throw new Error("Not connected — call connect() first")
    }
    return this.client
  }

  /**
   * Get the shared SDK client, auto-connecting if not yet started.
   * Accepts an optional directory to use as the workspace root; falls back
   * to the first VS Code workspace folder. Throws if neither is available
   * or if the connection fails.
   */
  async getClientAsync(dir?: string): Promise<KiloClient> {
    if (dir) this.trackDirectory(dir)
    if (this.client && this.state === "connected") return this.client
    const root = dir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) throw new Error("No workspace folder open")
    this.trackDirectory(root)
    await this.connect(root)
    return this.getClient()
  }

  /** Directories that may own directory-scoped requests on the shared backend. */
  getKnownDirectories(): string[] {
    const dirs = new Set<string>()
    if (this.rootDirectory) dirs.add(this.rootDirectory)
    if (this.currentDirectory) dirs.add(this.currentDirectory)
    for (const provider of this.directoryProviders) {
      for (const dir of provider()) {
        if (dir) dirs.add(dir)
      }
    }
    return [...dirs]
  }

  /**
   * Get server info (port). Returns null if not connected.
   */
  getServerInfo(): { port: number } | null {
    return this.info
  }

  /**
   * Get server config (baseUrl + password). Returns null if not connected.
   * Used by TelemetryProxy to POST events to the CLI server.
   */
  getServerConfig(): ServerConfig | null {
    return this.config
  }

  /**
   * Set the remote status service. When remote is disabled, flushViewed()
   * is a no-op. When remote becomes enabled (startup refresh, user toggle,
   * or SSE event), the accumulated focused/opened state is automatically
   * flushed so the server is never left unaware of already-open sessions.
   */
  setRemoteService(service: import("../RemoteStatusService").RemoteStatusService | null): void {
    this.unsubRemote?.()
    this.unsubRemote = null
    this.remoteService = service
    if (service) {
      this.unsubRemote = service.onChange((state) => {
        if (state.enabled) this.flushViewed()
      })
    }
  }

  private isRemoteEnabled(): boolean {
    return this.remoteService?.getState().enabled ?? false
  }

  /**
   * Current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.state
  }

  /**
   * Last connection error. Cleared when a new connection attempt begins.
   */
  getConnectionError(): Error | null {
    return this.error
  }

  /**
   * Subscribe to SSE events. Returns unsubscribe function.
   */
  onEvent(listener: SSEEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /**
   * Subscribe to SSE events with a filter. The filter runs for every incoming
   * SSE event. LOCK-004: the listener receives exactly `(event, directory,
   * transaction)` — the full envelope forwarded from handleSseEvent, so
   * filtered subscribers see the same transaction id as onEvent subscribers.
   */
  onEventFiltered(filter: SSEEventFilter, listener: SSEEventListener): () => void {
    const wrapped: SSEEventListener = (event, directory, transaction) => {
      if (!filter(event, directory)) {
        return
      }
      listener(event, directory, transaction)
    }
    return this.onEvent(wrapped)
  }

  /**
   * Record a messageID -> sessionID mapping, typically from message.updated or from HTTP message history.
   */
  recordMessageSessionId(messageId: string, sessionId: string): void {
    if (!messageId || !sessionId) {
      return
    }
    this.messageSessionIdsByMessageId.set(messageId, sessionId)
  }

  /**
   * Remove all messageID → sessionID entries for a given session.
   * Called when a session is deleted or otherwise pruned so the map
   * does not grow unbounded over the extension lifetime.
   *
   * Also drops the session from any provider's focused or opened set
   * so the server's `viewed` notification stops advertising a deleted
   * id after external (CLI/TUI/cascade) deletes arrive via SSE.
   */
  pruneSession(sessionId: string): void {
    for (const [mid, sid] of this.messageSessionIdsByMessageId) {
      if (sid === sessionId) this.messageSessionIdsByMessageId.delete(mid)
    }
    for (const [key, ids] of this.attached) {
      if (!ids.has(sessionId)) continue
      ids.delete(sessionId)
      if (ids.size === 0) this.attached.delete(key)
    }
    for (const [key, ids] of this.visible) {
      if (!ids.has(sessionId)) continue
      ids.delete(sessionId)
      if (ids.size === 0) this.visible.delete(key)
    }
    this.flushViewed()
  }

  /**
   * Best-effort sessionID extraction for an SSE event.
   * Returns undefined for global events.
   */
  resolveEventSessionId(event: SSEPayload): string | undefined {
    return resolveEventSessionIdPure(
      event,
      (messageId) => this.messageSessionIdsByMessageId.get(messageId),
      (messageId, sessionId) => this.recordMessageSessionId(messageId, sessionId),
    )
  }

  recordPermissionDirectory(requestID: string, directory: string): void {
    if (!requestID || !directory) {
      return
    }
    this.permissionDirectories.set(requestID, directory)
  }

  getPermissionDirectory(requestID: string): string | undefined {
    return this.permissionDirectories.get(requestID)
  }

  clearPermissionDirectory(requestID: string): void {
    this.permissionDirectories.delete(requestID)
  }

  prunePermissionDirectories(active: Set<string>, dirs?: Set<string>): void {
    for (const [id, dir] of this.permissionDirectories) {
      if (active.has(id)) {
        continue
      }
      if (dirs && !dirs.has(dir)) {
        continue
      }
      this.permissionDirectories.delete(id)
    }
  }

  recordQuestionDirectory(requestID: string, directory: string): void {
    if (!requestID || !directory) {
      return
    }
    this.questionDirectories.set(requestID, directory)
  }

  getQuestionDirectory(requestID: string): string | undefined {
    return this.questionDirectories.get(requestID)
  }

  clearQuestionDirectory(requestID: string): void {
    this.questionDirectories.delete(requestID)
    // A resolved request must invalidate an in-flight recovery scan so stale list data cannot repost it.
    this.questionRevision += 1
  }

  getQuestionRevision(): number {
    return this.questionRevision
  }

  pruneQuestionDirectories(active: Set<string>, dirs: Set<string>): void {
    const size = this.questionDirectories.size
    for (const [id, dir] of this.questionDirectories) {
      if (active.has(id) || !dirs.has(dir)) continue
      this.questionDirectories.delete(id)
    }
    if (this.questionDirectories.size !== size) this.questionRevision += 1
  }

  /**
   * Subscribe to language change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onLanguageChanged(listener: LanguageChangeListener): () => void {
    this.languageChangeListeners.add(listener)
    return () => {
      this.languageChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a language change event to all subscribed KiloProvider instances.
   */
  notifyLanguageChanged(locale: string): void {
    for (const listener of this.languageChangeListeners) {
      listener(locale)
    }
  }

  /**
   * Subscribe to profile change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onProfileChanged(listener: ProfileChangeListener): () => void {
    this.profileChangeListeners.add(listener)
    return () => {
      this.profileChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a profile change event to all subscribed KiloProvider instances.
   */
  notifyProfileChanged(data: unknown): void {
    for (const listener of this.profileChangeListeners) {
      listener(data)
    }
  }

  /**
   * Subscribe to migration-complete events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onMigrationComplete(listener: MigrationCompleteListener): () => void {
    this.migrationCompleteListeners.add(listener)
    return () => {
      this.migrationCompleteListeners.delete(listener)
    }
  }

  /**
   * Broadcast a migration-complete event to all subscribed KiloProvider instances.
   */
  notifyMigrationComplete(): void {
    for (const listener of this.migrationCompleteListeners) {
      listener()
    }
  }

  /**
   * Subscribe to favorites change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onFavoritesChanged(listener: FavoritesChangeListener): () => void {
    this.favoritesChangeListeners.add(listener)
    return () => {
      this.favoritesChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a favorites change event to all subscribed KiloProvider instances.
   */
  notifyFavoritesChanged(favorites: Array<{ providerID: string; modelID: string }>): void {
    for (const listener of this.favoritesChangeListeners) {
      listener(favorites)
    }
  }

  /**
   * Subscribe to model-selector expand/collapse changes broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onModelSelectorExpandedChanged(listener: ModelSelectorExpandedListener): () => void {
    this.modelSelectorExpandedListeners.add(listener)
    return () => {
      this.modelSelectorExpandedListeners.delete(listener)
    }
  }

  /**
   * Broadcast a model-selector expand/collapse change to all subscribed KiloProvider instances.
   */
  notifyModelSelectorExpandedChanged(value: boolean): void {
    for (const listener of this.modelSelectorExpandedListeners) {
      listener(value)
    }
  }

  /**
   * Register a callback that returns workspace directories tracked by a
   * KiloProvider (root + worktree dirs). Used by getKnownDirectories() to
   * cover all active Instance directories across every provider.
   */
  registerDirectoryProvider(provider: DirectoryProvider): () => void {
    this.directoryProviders.add(provider)
    return () => {
      this.directoryProviders.delete(provider)
    }
  }

  private trackDirectory(dir: string): void {
    if (!dir) return
    this.rootDirectory ??= dir
    this.currentDirectory = dir
  }

  /**
   * Current shared config revision.
   */
  getConfigRevision(): number {
    return this.configRevision
  }

  /**
   * Advance the shared config revision and notify subscribers. The immediate
   * save ack stays independent (LOCK-001): this is called by the SSE dispatch
   * (tagged transaction dedupe or per untagged event, LOCK-004) — never by a
   * provider's own successful save, whose canonical echo owns the advance.
   * Listener failures never propagate to the caller.
   */
  advanceConfigRevision(): void {
    this.configRevision += 1
    for (const listener of this.configRevisionListeners) {
      try {
        listener()
      } catch (error) {
        console.error("[Kilo New] ConnectionService: config revision listener failed:", error)
      }
    }
  }

  /**
   * LOCK-004: advance the config revision exactly once per logical tagged
   * transaction, across any number of delivery turns, and never merge
   * unrelated untagged edits (those advance per event in handleSseEvent).
   * Listener failures never propagate to the caller.
   */
  private advanceOnceForTransaction(transaction: string): void {
    if (this.seenConfigTransactions.has(transaction)) return
    if (this.seenConfigTransactions.size >= KiloConnectionService.MAX_SEEN_CONFIG_TRANSACTIONS) {
      const oldest = this.seenConfigTransactions.values().next().value
      if (oldest !== undefined) this.seenConfigTransactions.delete(oldest)
    }
    this.seenConfigTransactions.add(transaction)
    this.advanceConfigRevision()
  }

  /**
   * Subscribe to config revision advances. Returns an unsubscribe function.
   */
  onConfigRevision(listener: () => void): () => void {
    this.configRevisionListeners.add(listener)
    return () => {
      this.configRevisionListeners.delete(listener)
    }
  }

  /**
   * Subscribe to connection state changes. Returns unsubscribe function.
   */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  /**
   * Register the sessions a provider retains for remote control (attached).
   * Sent to the server (debounced) regardless of remote-control enablement.
   */
  registerAttached(key: string, ids: string[]): void {
    const next = new Set(ids)
    const prev = this.attached.get(key)
    if (prev && sameSet(prev, next)) return
    this.attached.set(key, next)
    this.flushViewed()
  }

  /**
   * Unregister a provider's attached sessions (e.g. on dispose or clear).
   */
  unregisterAttached(key: string): void {
    if (!this.attached.has(key)) return
    this.attached.delete(key)
    this.flushViewed()
  }

  /**
   * Register the sessions a provider visibly renders (visible).
   * Visible sessions are also reported as attached.
   */
  registerVisible(key: string, ids: string[]): void {
    const next = new Set(ids)
    const prev = this.visible.get(key)
    if (prev && sameSet(prev, next)) return
    this.visible.set(key, next)
    this.flushViewed()
  }

  /**
   * Unregister a provider's visible sessions (e.g. on hide, clear, or dispose).
   */
  unregisterVisible(key: string): void {
    if (!this.visible.has(key)) return
    this.visible.delete(key)
    this.flushViewed()
  }

  /** Debounced: send the aggregated attached + visible snapshot to the server. Works even when remote control is disabled. */
  flushViewed(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.sendViewed()
    }, 150)
  }

  private sendViewed(): void {
    if (this.viewedSending) {
      this.viewedDirty = true
      return
    }
    if (!this.client) return

    const visible = new Set<string>()
    for (const ids of this.visible.values()) for (const id of ids) visible.add(id)
    const attached = new Set<string>(visible)
    for (const ids of this.attached.values()) for (const id of ids) attached.add(id)

    this.viewedSending = true
    this.viewedDirty = false
    void this.client.session
      .viewed({ viewer: { id: this.viewerId, active: this.active }, attached: [...attached], visible: [...visible] })
      .catch((err) => console.warn("[Kilo New] ConnectionService: viewed flush failed:", err))
      .finally(() => {
        this.viewedSending = false
        if (this.viewedDirty) this.sendViewed()
      })
  }

  /**
   * Clean up everything: kill server, close SSE, clear listeners.
   */
  dispose(): void {
    this.stopHealthPoll()
    this.sseClient?.dispose()
    this.serverManager.dispose()
    this.eventListeners.clear()
    this.stateListeners.clear()
    this.profileChangeListeners.clear()
    this.migrationCompleteListeners.clear()
    this.favoritesChangeListeners.clear()
    this.directoryProviders.clear()
    this.rootDirectory = undefined
    this.currentDirectory = undefined
    this.messageSessionIdsByMessageId.clear()
    this.permissionDirectories.clear()
    this.questionDirectories.clear()
    this.questionRevision += 1
    this.seenConfigTransactions.clear()
    this.configRevisionListeners.clear()
    if (this.client?.session?.viewed) {
      void this.client.session
        .viewed({ viewer: { id: this.viewerId, active: false }, attached: [], visible: [] })
        .catch(() => {})
    }
    this.attached.clear()
    this.visible.clear()
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.checkinTimer) {
      clearInterval(this.checkinTimer)
      this.checkinTimer = null
    }
    this.windowStateDisposable?.dispose()
    this.windowStateDisposable = null
    this.viewedDirty = false
    this.unsubRemote?.()
    this.unsubRemote = null
    this.client = null
    this.sseClient = null
    this.config = null
    this.info = null
    this.state = "disconnected"
    this.error = null
  }

  private setState(state: ConnectionState, error?: Error): void {
    this.state = state
    this.error = state === "error" ? (error ?? this.error) : null
    for (const listener of this.stateListeners) {
      listener(state, this.error ?? undefined)
    }
  }

  /**
   * Start polling GET /global/health every 10 seconds.
   * Provides a second detection channel for server death independent of the SSE heartbeat.
   * If the health check fails while we believe we are connected, the SSE client is
   * disconnected so its reconnect loop kicks in immediately.
   */
  private startHealthPoll(baseUrl: string, password: string): void {
    this.stopHealthPoll()

    this.healthPollTimer = setInterval(async () => {
      if (this.state !== "connected") {
        return
      }
      const healthy = await this.checkHealth(baseUrl, password)
      if (!healthy && this.state === "connected") {
        console.warn("[Kilo New] ConnectionService: ❤️‍🩹 Health check failed — forcing SSE reconnect")
        this.sseClient?.reconnect()
      }
    }, HEALTH_POLL_INTERVAL_MS)

    // Don't keep the extension host alive just for the health poll
    this.healthPollTimer.unref?.()
  }

  private stopHealthPoll(): void {
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer)
      this.healthPollTimer = null
    }
  }

  private async checkHealth(baseUrl: string, password: string): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  private resetConnection(): void {
    this.stopHealthPoll()
    this.stopCheckin()
    const sse = this.sseClient
    this.sseClient = null
    sse?.disconnect()
    this.client = null
    this.config = null
    this.info = null
    this.permissionDirectories.clear()
    this.questionDirectories.clear()
    this.questionRevision += 1
    // New connection epoch: tagged-transaction dedupe state from the previous
    // stream must not leak into the next (LOCK-004 lifecycle cleanup).
    this.seenConfigTransactions.clear()
  }

  private handleServerExit(code: number | null): void {
    console.warn("[Kilo New] ConnectionService: CLI background process exited:", code)
    this.resetConnection()
    this.setState(
      "error",
      new Error(`CLI background process exited with code ${code ?? "unknown"}. Retry to reconnect.`),
    )
  }

  private async doConnect(workspaceDir: string): Promise<void> {
    // Never expose a stale SDK client while its replacement server is starting.
    this.resetConnection()

    const server = await this.serverManager.getServer()
    this.info = { port: server.port }

    const config: ServerConfig = {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: server.password,
    }

    this.config = config

    // Create SDK client with Basic Auth header
    const authHeader = `Basic ${Buffer.from(`kilo:${server.password}`).toString("base64")}`
    const client = createKiloClient({
      baseUrl: config.baseUrl,
      headers: {
        Authorization: authHeader,
      },
    })
    const sse = new SdkSSEAdapter(client)
    this.client = client
    this.sseClient = sse

    // Wait until SSE yields its first server event before resolving connect().
    // Initial stream failures are handled by the adapter reconnect loop.
    let resolveConnected: (() => void) | null = null
    let rejectConnected: ((error: Error) => void) | null = null
    const connectedPromise = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve
      rejectConnected = reject
    })

    let didConnect = false

    // Wire SSE events → broadcast to all registered listeners
    sse.onEvent((event, directory, transaction) => {
      if (this.sseClient !== sse) return
      this.handleSseEvent(event, directory, transaction)
    })

    sse.onError((error) => {
      if (this.sseClient !== sse) return
      this.setState("error", error)
    })

    // Wire SSE state → broadcast to all registered state listeners
    sse.onStateChange((sseState) => {
      if (this.sseClient !== sse) {
        if (!didConnect && sseState === "disconnected") {
          rejectConnected?.(new Error(`SSE connection ended in state: ${sseState}`))
          resolveConnected = null
          rejectConnected = null
        }
        return
      }

      this.setState(sseState)

      if (sseState === "connected") {
        didConnect = true
        resolveConnected?.()
        resolveConnected = null
        rejectConnected = null
        this.flushViewed()
        return
      }

      if (!didConnect && sseState === "disconnected") {
        rejectConnected?.(new Error(`SSE connection ended in state: ${sseState}`))
        resolveConnected = null
        rejectConnected = null
      }
    })

    sse.connect()

    await connectedPromise

    this.startCheckin()
    // Start the independent health poll once we are confirmed connected.
    this.startHealthPoll(config.baseUrl, config.password)
  }

  private startCheckin(): void {
    this.stopCheckin()
    this.checkinTimer = setInterval(() => this.flushViewed(), 60_000)
    this.checkinTimer.unref?.()
  }

  private stopCheckin(): void {
    if (this.checkinTimer) {
      clearInterval(this.checkinTimer)
      this.checkinTimer = null
    }
  }

  /**
   * Handle a single SSE event: permission/question routing, the sole config
   * revision advance for backend config events (LOCK-001/004), and broadcast
   * to all registered event listeners. This is the exact internal dispatch
   * wired into the SSE adapter in doConnect; tests drive it directly so the
   * production revision/coalescing path is exercised rather than a mock.
   *
   * LOCK-004: a `global.config.updated` event tagged with a transaction id is
   * one scope echo of one logical save — the first sighting of that id
   * advances exactly once and later echoes (same or later delivery turn) are
   * absorbed. An untagged event is an independent external revision and
   * advances immediately; the microtask fallback must never merge unrelated
   * untagged edits.
   */
  handleSseEvent(event: SSEPayload, directory?: string, transaction?: string): void {
    this.handlePermissionEvent(event, directory)
    this.handleQuestionEvent(event, directory)
    if (event.type === "global.config.updated") {
      if (transaction) this.advanceOnceForTransaction(transaction)
      else this.advanceConfigRevision()
    }
    for (const listener of this.eventListeners) {
      listener(event, directory, transaction)
    }
  }

  private handlePermissionEvent(event: SSEPayload, directory?: string): void {
    if (event.type === "permission.asked" && directory) {
      this.recordPermissionDirectory(event.properties.id, directory)
      return
    }
    if (event.type === "permission.replied") {
      this.clearPermissionDirectory(event.properties.requestID)
    }
  }

  private handleQuestionEvent(event: SSEPayload, directory?: string): void {
    if (event.type === "question.asked" && directory) {
      this.questionRevision += 1
      this.recordQuestionDirectory(event.properties.id, directory)
      return
    }
    if (event.type === "question.replied" || event.type === "question.rejected") {
      this.clearQuestionDirectory(event.properties.requestID)
    }
  }
}
