import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { createKiloClient, type KiloClient } from "@kilocode/sdk/v2/client"
import { SdkSSEAdapter, type SSEPayload } from "./sdk-sse-adapter"
import type { ServerConfig } from "./types"
import { resolveEventSessionId as resolveEventSessionIdPure } from "./connection-utils"
import { SandboxPreference } from "../sandbox-preference"
import { isP0PerfEnabled, p0Span, p0Stage } from "../../perf/perf-instrument"
import {
  ServePrivatePeer,
  type ServePrivateCancelQueuedRequest,
  type ServePrivateCancelQueuedResult,
  type ServePrivateSessionUpdateRequest,
  type ServePrivateSessionUpdateResult,
  compareUpdateParity,
} from "./serve-private-peer"
import * as crypto from "crypto"
import { buildSessionUpdateIdentity, renameSessionWithResult } from "../../kilo-provider/rename-session"
import { isE2EFixtureEnabled } from "../../util/e2e-fixture"

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error"
type SSEEventListener = (event: SSEPayload, directory?: string, transaction?: string) => void
type StateListener = (state: ConnectionState, error?: Error) => void
type SSEEventFilter = (event: SSEPayload, directory?: string) => boolean
type LanguageChangeListener = (locale: string) => void
type ProfileChangeListener = (data: unknown) => void
type FavoritesChangeListener = (favorites: Array<{ providerID: string; modelID: string }>) => void
type ModelSelectorExpandedListener = (value: boolean) => void
type DirectoryProvider = () => string[]

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

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
  private remoteService: import("../RemoteStatusService").RemoteStatusService | null = null

  private readonly eventListeners: Set<SSEEventListener> = new Set()
  private readonly stateListeners: Set<StateListener> = new Set()
  private readonly languageChangeListeners: Set<LanguageChangeListener> = new Set()
  private readonly profileChangeListeners: Set<ProfileChangeListener> = new Set()
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

  /**
   * Assistant message ids whose first `model.firstEvent` record was already
   * emitted by the P0 perf instrumentation (LOCK-PERF-7: prompt submit ->
   * first model event). One record per turn, deduplicated by the assistant
   * message id; user message updates never produce a record. Bounded by turn
   * count, cleared per connection epoch.
   */
  private readonly firstModelEventMessages = new Set<string>()

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
  private privatePeer: ServePrivatePeer | null = null
  private privateAvailable = false
  private privateEpoch: number | null = null
  private privatePid: number | undefined
  // Lazy fixture-only replay state: single active operation, recorded only
  // after successful SDK result, cleared on dispose/prune, retained across
  // child restart within same Extension Host, no production allocation.
  private lastSessionUpdateIdentities: Map<
    string,
    { opId: string; idempotencyKey: string; requestId: string; sessionId: string; title: string; directory: string }
  > | null = null

  private getReplayState(): Map<
    string,
    { opId: string; idempotencyKey: string; requestId: string; sessionId: string; title: string; directory: string }
  > | null {
    if (!isE2EFixtureEnabled()) return null
    if (!this.lastSessionUpdateIdentities) this.lastSessionUpdateIdentities = new Map()
    return this.lastSessionUpdateIdentities
  }

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
    p0Stage("connect.start")

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
    this.lastSessionUpdateIdentities?.delete(sessionId)
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
   * KiloProvider (root + session dirs). Used by getKnownDirectories() to
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
    this.sseClient?.dispose()
    this.disposePrivatePeer()
    this.serverManager.dispose()
    this.eventListeners.clear()
    this.stateListeners.clear()
    this.profileChangeListeners.clear()
    this.favoritesChangeListeners.clear()
    this.directoryProviders.clear()
    this.rootDirectory = undefined
    this.currentDirectory = undefined
    this.messageSessionIdsByMessageId.clear()
    this.permissionDirectories.clear()
    this.questionDirectories.clear()
    this.firstModelEventMessages.clear()
    this.questionRevision += 1
    this.seenConfigTransactions.clear()
    this.configRevisionListeners.clear()
    this.lastSessionUpdateIdentities?.clear()
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

  private resetConnection(): void {
    this.stopCheckin()
    this.disposePrivatePeer()
    const sse = this.sseClient
    this.sseClient = null
    sse?.disconnect()
    this.client = null
    this.config = null
    this.info = null
    this.permissionDirectories.clear()
    this.questionDirectories.clear()
    this.firstModelEventMessages.clear()
    this.questionRevision += 1
    // New connection epoch: tagged-transaction dedupe state from the previous
    // stream must not leak into the next (LOCK-004 lifecycle cleanup).
    this.seenConfigTransactions.clear()
  }

  private handleServerExit(code: number | null): void {
    console.warn("[Kilo New] ConnectionService: CLI background process exited:", code)
    this.disposePrivatePeer()
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

    void this.initPrivatePeer(server).catch((err) => console.warn("[Kilo] PrivatePeer init failed:", String(err)))

    this.startCheckin()
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

  private disposePrivatePeer(): void {
    if (!this.privatePeer) {
      this.privateAvailable = false
      this.privateEpoch = null
      this.privatePid = undefined
      return
    }
    try {
      this.privatePeer.dispose()
    } catch (err) {
      console.warn("[Kilo] PrivatePeer dispose failed:", String(err))
    }
    this.privatePeer = null
    this.privateAvailable = false
    this.privateEpoch = null
    this.privatePid = undefined
  }

  private async initPrivatePeer(server: import("./server-manager").ServerInstance): Promise<void> {
    if (this.privateEpoch !== null && this.privateEpoch === server.epoch) return
    if (this.privatePeer) {
      try {
        this.privatePeer.dispose()
      } catch (err) {
        console.warn("[Kilo] PrivatePeer prior dispose failed:", String(err))
      }
      this.privatePeer = null
    }
    this.privateAvailable = false
    this.privateEpoch = server.epoch
    this.privatePid = server.pid
    if (!server.privateReader || !server.privateWriter) {
      console.warn("[Kilo] PrivatePeer unavailable: fd3/fd4 not exposed for pid", server.pid, "epoch", server.epoch)
      return
    }
    const epochAtStart = server.epoch
    const pidAtStart = server.pid
    const peer = new ServePrivatePeer({
      reader: server.privateReader,
      writer: server.privateWriter,
      pid: server.pid,
      epoch: server.epoch,
      process: server.process,
      initializeTimeoutMs: 5000,
    })
    this.privatePeer = peer
    const ok = await peer.initialize()
    if (this.privatePeer !== peer || this.privateEpoch !== epochAtStart) {
      try {
        peer.dispose()
      } catch (err) {
        console.warn("[Kilo] PrivatePeer stale dispose failed:", String(err))
      }
      return
    }
    if (!peer.isAvailable() && ok) {
      this.privateAvailable = false
      console.warn("[Kilo] PrivatePeer negotiation failed (fail-closed) pid", pidAtStart, "epoch", epochAtStart)
      return
    }
    this.privateAvailable = ok && peer.isAvailable()
    if (!this.privateAvailable) {
      console.warn("[Kilo] PrivatePeer negotiation failed (fail-closed) pid", pidAtStart, "epoch", epochAtStart)
      return
    }
    console.log("[Kilo] PrivatePeer negotiated pid", pidAtStart, "epoch", epochAtStart)
  }

  isPrivateAvailable(): boolean {
    return this.privateAvailable && !!this.privatePeer && this.privatePeer.isAvailable()
  }

  getPrivatePeer(): ServePrivatePeer | null {
    return this.privatePeer
  }

  getPrivateEpoch(): number | null {
    return this.privateEpoch
  }

  getPrivatePid(): number | undefined {
    return this.privatePid
  }

  async privateCancelQueued(req: ServePrivateCancelQueuedRequest): Promise<ServePrivateCancelQueuedResult> {
    if (!this.privatePeer || !this.privateAvailable || !this.privatePeer.isAvailable()) {
      throw new Error("Private peer unavailable")
    }
    const epochAtCall = this.privateEpoch
    const peerAtCall = this.privatePeer
    const result = await peerAtCall.privateCancelQueued(req)
    if (epochAtCall !== null && this.privateEpoch !== epochAtCall) {
      return {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/cancelQueued",
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      } as unknown as ServePrivateCancelQueuedResult
    }
    if (this.privatePeer !== peerAtCall) {
      return {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/cancelQueued",
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      } as unknown as ServePrivateCancelQueuedResult
    }
    return result
  }

  async privateSessionUpdate(req: ServePrivateSessionUpdateRequest): Promise<ServePrivateSessionUpdateResult> {
    if (!this.privatePeer || !this.privateAvailable || !this.privatePeer.isAvailable()) {
      throw new Error("Private peer unavailable")
    }
    if (!this.privatePeer.hasCapability("session/update")) {
      throw new Error("Private peer missing session/update capability")
    }
    const epochAtCall = this.privateEpoch
    const peerAtCall = this.privatePeer
    const result = await peerAtCall.privateSessionUpdate(req)
    if (epochAtCall !== null && this.privateEpoch !== epochAtCall) {
      return {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/update",
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      } as unknown as ServePrivateSessionUpdateResult
    }
    if (this.privatePeer !== peerAtCall) {
      return {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/update",
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      } as unknown as ServePrivateSessionUpdateResult
    }
    return result
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
    // P0 (opt-in): per-event dispatch span at the extension boundary. Metadata
    // is bounded — event type, directory, transaction id — never payloads.
    const timer = p0Span("sse.event", {
      eventType: event.type === "sync" ? event.name : event.type,
      ...(directory ? { dir: directory } : {}),
      ...(transaction ? { transaction } : {}),
    })
    this.handlePermissionEvent(event, directory)
    this.handleQuestionEvent(event, directory)
    this.recordFirstModelEvent(event, directory)
    if (event.type === "global.config.updated") {
      if (transaction) this.advanceOnceForTransaction(transaction)
      else this.advanceConfigRevision()
    }
    for (const listener of this.eventListeners) {
      listener(event, directory, transaction)
    }
    timer.end()
  }

  /**
   * P0 perf: record the first assistant-message `message.updated` per turn —
   * the model-first event of a turn. User message updates (role "user") never
   * produce a record; repeated updates of the same assistant message are
   * deduplicated by message id. `parentID` (the user message id of the turn)
   * is the join key back to `prompt.submit`'s `messageID`.
   */
  private recordFirstModelEvent(event: SSEPayload, directory?: string): void {
    if (!isP0PerfEnabled()) return
    if (event.type !== "sync" || event.name !== "message.updated.1") return
    if (event.data.info.role !== "assistant") return
    const sessionId = this.resolveEventSessionId(event)
    if (!sessionId) return
    const messageId = event.data.info.id
    if (this.firstModelEventMessages.has(messageId)) return
    this.firstModelEventMessages.add(messageId)
    const extra: Record<string, unknown> = { sessionID: sessionId, messageID: messageId }
    if (event.data.info.parentID) extra.parentID = event.data.info.parentID
    if (directory) extra.dir = directory
    p0Stage("model.firstEvent", extra)
  }

  private handlePermissionEvent(event: SSEPayload, directory?: string): void {
    if (event.type === "permission.asked" && directory) {
      this.recordPermissionDirectory(event.properties.id, directory)
      p0Stage("permission.asked", { id: event.properties.id })
      return
    }
    if (event.type === "permission.replied") {
      this.clearPermissionDirectory(event.properties.requestID)
      p0Stage("permission.replied", { requestID: event.properties.requestID })
    }
  }

  private handleQuestionEvent(event: SSEPayload, directory?: string): void {
    if (event.type === "question.asked" && directory) {
      this.questionRevision += 1
      this.recordQuestionDirectory(event.properties.id, directory)
      p0Stage("question.asked", { id: event.properties.id })
      return
    }
    if (event.type === "question.replied") {
      this.clearQuestionDirectory(event.properties.requestID)
      p0Stage("question.replied", { requestID: event.properties.requestID })
      return
    }
    if (event.type === "question.rejected") {
      this.clearQuestionDirectory(event.properties.requestID)
      p0Stage("question.rejected", { requestID: event.properties.requestID })
    }
  }

  // -------------------------------------------------------------------------
  // E2E fixture bridge (KILO_E2E_FIXTURE only; commands registered in
  // extension.ts). These are the transport/process-ownership probes for the
  // real-restart scenario: an explicit SSE reconnect trigger/observation on
  // this shared service, an exact-owned worker kill through ServerManager's
  // owner path, and the production connection flow for the replacement. Every
  // method throws when the fixture env is absent so no production path can
  // reach them. `getServerPidForFixture` is internal to ServerManager and
  // remains in use by the reconnect/kill outputs below.
  // -------------------------------------------------------------------------

  public fixtureKillServer(): { pid: number; port: number; epoch: number | null } | null {
    if (!isE2EFixtureEnabled()) throw new Error("fixture killServer requires KILO_E2E_FIXTURE")
    const info = this.serverManager.getServerInfoForFixture()
    if (!info) return null
    const res = this.serverManager.killServerForFixture()
    if (!res) return null
    // authoritative epoch is the ServerManager epoch before kill (proves identity)
    return { pid: res.pid, port: res.port, epoch: info.epoch }
  }

  /**
   * Fixture read of the aggregate generation-request store (every `service=llm`
   * line observed across all server instances/launches of this run). Fail-closed
   * LOCK-006/LOCK-008 evidence: the harness asserts every record is the
   * run-owned e2e-local/e2e-model. Returns null when no server ever spawned.
   */
  public fixtureLlmRequests() {
    if (!isE2EFixtureEnabled()) throw new Error("fixture llmRequests requires KILO_E2E_FIXTURE")
    return this.serverManager.getLlmRequestsForFixture()
  }

  /** Fixture reset of the generation-request store (run start only). */
  public fixtureLlmRequestsReset(): boolean {
    if (!isE2EFixtureEnabled()) throw new Error("fixture llmRequestsReset requires KILO_E2E_FIXTURE")
    return this.serverManager.resetLlmRequestsForFixture()
  }

  /**
   * Fixture observation of one explicit SSE reconnect with the backend left
   * ALIVE (production SdkSSEAdapter.reconnect() → per-attempt abort → outer
   * consumeLoop reconnects → connection-service state listeners). Records the
   * state sequence, the (unchanged) server port/pid/epoch, and the number of
   * `server.connected` events delivered across the reconnect window as
   * evidence the stream re-established. `/global/event` emits exactly one
   * `server.connected` per new stream subscription (then heartbeats + bus
   * events); `sync` envelopes are activity-driven and never guaranteed on a
   * quiet reconnect, so this counter is the direct new-stream signal.
   */
  public async fixtureSseReconnect(): Promise<{
    before: ConnectionState
    portBefore: number | null
    pidBefore: number | null
    epochBefore: number | null
    after: ConnectionState
    portAfter: number | null
    pidAfter: number | null
    epochAfter: number | null
    states: Array<{ state: ConnectionState; at: string }>
    connectedEvents: number
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sseReconnect requires KILO_E2E_FIXTURE")
    const states: Array<{ state: ConnectionState; at: string }> = []
    const unsub = this.onStateChange((state) => states.push({ state, at: new Date().toISOString() }))
    const before = this.state
    const portBefore = this.info?.port ?? null
    const pidBefore = this.serverManager.getServerPidForFixture()?.pid ?? null
    const epochBefore = this.serverManager.getServerEpochForFixture()
    let connectedEvents = 0
    const unsubEvents = this.onEvent((event) => {
      if (event.type === "server.connected") connectedEvents += 1
    })
    try {
      const sse = this.sseClient
      if (!sse) throw new Error("fixture sseReconnect: no active SSE client")
      sse.reconnect()
      // Wait until the observed state sequence shows a non-connected dip and
      // the service is connected again (the new stream's first event flips
      // state back to connected through the production state listener).
      const deadline = Date.now() + 30_000
      for (;;) {
        if (this.state === "connected" && states.some((s) => s.state !== "connected")) break
        if (Date.now() > deadline) {
          throw new Error(
            `fixture sseReconnect: reconnect did not converge to connected. states=${JSON.stringify(states)}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return {
        before,
        portBefore,
        pidBefore,
        epochBefore,
        after: this.state,
        portAfter: this.info?.port ?? null,
        pidAfter: this.serverManager.getServerPidForFixture()?.pid ?? null,
        epochAfter: this.serverManager.getServerEpochForFixture(),
        states,
        connectedEvents,
      }
    } finally {
      unsub()
      unsubEvents()
    }
  }

  /**
   * Fixture trigger of the PRODUCTION reconnect flow after an exact worker
   * kill: `getClientAsync` observes the disconnected/error state and calls
   * `connect()`, which starts a replacement server via ServerManager (the exit
   * handler already nulled the old instance) and re-establishes the SSE stream
   * — the exact path production uses to recover when the CLI backend dies.
   * Resolves only when the connection service reaches "connected" again.
   *
   * The exact-owned kill returns before the CLI's graceful SIGTERM shutdown
   * completes, so the child's exit event (which nulls the ServerManager
   * instance and fires the production onExit reset) arrives asynchronously —
   * this fixture waits, with a bounded deadline, until the exit observation
   * has actually happened before driving `getClientAsync`. Without the wait,
   * `getServer()` would hand back the freshly-killed instance and the
   * replacement connect would fail. In production the exit event has always
   * fired by the time a recovery request arrives, so the wait only models
   * that ordering for the fixture; no production logic is changed.
   */
  public async fixtureReconnectServer(dir?: string): Promise<{
    state: ConnectionState
    port: number | null
    pid: number | null
    epoch: number | null
    states: Array<{ state: ConnectionState; at: string }>
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture reconnectServer requires KILO_E2E_FIXTURE")
    const states: Array<{ state: ConnectionState; at: string }> = []
    const unsub = this.onStateChange((state) => states.push({ state, at: new Date().toISOString() }))
    try {
      const exitDeadline = Date.now() + 30_000
      while (this.serverManager.getServerPidForFixture() !== null) {
        if (Date.now() > exitDeadline) {
          throw new Error(
            "fixture reconnectServer: killed server instance was never nulled (exit event not observed within 30s)",
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const root = dir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!root) throw new Error("fixture reconnectServer: no workspace folder")
      await this.getClientAsync(root)
      if (this.state !== "connected") {
        throw new Error(
          `fixture reconnectServer: state=${this.state} expected connected. states=${JSON.stringify(states)}`,
        )
      }
      return {
        state: this.state,
        port: this.info?.port ?? null,
        pid: this.serverManager.getServerPidForFixture()?.pid ?? null,
        epoch: this.serverManager.getServerEpochForFixture(),
        states,
      }
    } finally {
      unsub()
    }
  }

  // -------------------------------------------------------------------------
  // Gate C preparation fixtures: private peer status snapshot and durable
  // title-only session/update observation (SDK authoritative, private replay-only).
  // All env-gated, read-only or test-triggered, zero production behavior when
  // KILO_E2E_FIXTURE absent. No secrets exposed: pid/port/epoch are non-secret,
  // protocol and capabilities are public negotiation, titles/payloads are hashed.
  // -------------------------------------------------------------------------

  public fixturePrivatePeerStatus(): {
    backend: { pid: number | null; port: number | null; epoch: number | null }
    private: {
      pid: number | null | undefined
      epoch: number | null
      available: boolean
      state: string
      protocol: { name: string; major: number; minor?: number } | null
      capabilities: string[]
      hasSessionUpdate: boolean
    }
  } {
    if (!isE2EFixtureEnabled()) throw new Error("fixture privatePeerStatus requires KILO_E2E_FIXTURE")
    const info = this.serverManager.getServerInfoForFixture()
    const pid = info?.pid ?? null
    const port = info?.port ?? null
    const epoch = info?.epoch ?? this.serverManager.getServerEpochForFixture()
    const peer = this.privatePeer
    const available = this.isPrivateAvailable()
    let protocol: { name: string; major: number; minor?: number } | null = null
    let capabilities: string[] = []
    let state = "unavailable"
    if (peer) {
      try {
        protocol = peer.getProtocolForFixture()
      } catch (err) {
        console.warn("[Fixture] getProtocolForFixture failed:", String(err).slice(0, 200))
      }
      try {
        capabilities = peer.getCapabilitiesListForFixture()
      } catch (err) {
        console.warn("[Fixture] getCapabilitiesForFixture failed:", String(err).slice(0, 200))
      }
      try {
        state = peer.getPeerStateForFixture()
      } catch (err) {
        console.warn("[Fixture] getPeerStateForFixture failed:", String(err).slice(0, 200))
        state = "unknown"
      }
    } else {
      state = this.privateAvailable ? "available-no-peer" : "unavailable"
    }
    if (!peer && available) state = "available"
    if (peer && !available) {
      // peer exists but not available — keep its state
    }
    const hasSessionUpdate = capabilities.includes("session/update")
    return {
      backend: { pid, port, epoch },
      private: {
        pid: this.privatePid ?? null,
        epoch: this.privateEpoch,
        available,
        state,
        protocol,
        capabilities,
        hasSessionUpdate,
      },
    }
  }

  private hashForFixture(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)
  }

  /**
   * Fixture-only durable title operation: SDK PATCH is the sole mutation
   * authority via the same production `renameSessionWithResult` path that
   * KiloProvider uses (shared `buildSessionUpdateIdentity` token), then a
   * private same-key replay observation with `compareUpdateParity` (redacted).
   * Order is always SDK then private; private is read-only replay and never
   * replaces the SDK result. Hashes redact identities/titles; no raw secret
   * data leaves the fixture. Stores the identity for later same-key replay.
   */
  // eslint-disable-next-line complexity
  public async fixtureSessionUpdate(input: { sessionId: string; title: string; directory?: string }): Promise<{
    order: string[]
    sdk: { status: string; httpStatus: number | null; hasData: boolean; errorCode?: string }
    private: { status: string; hasData: boolean; transportUnknown?: boolean; failureCode?: string } | null
    parity: { divergence: string | null; details: Record<string, unknown> }
    redacted: {
      opIdHash: string
      idempotencyKeyHash: string
      requestIdHash: string
      titleHash: string
      sessionIdHash: string
    }
    revision: { session?: number; config?: number } | null
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionUpdate requires KILO_E2E_FIXTURE")
    if (!input.sessionId || typeof input.sessionId !== "string") throw new Error("sessionId required")
    if (!input.title || typeof input.title !== "string") throw new Error("title required")
    const rawDir =
      input.directory ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.currentDirectory ??
      this.rootDirectory
    if (!rawDir) throw new Error("fixture sessionUpdate: no directory")
    // Canonicalize via realpath to match server's canonicalRoot (/private/var vs /var)
    let dir = rawDir
    try {
      const fsSync = require("node:fs") as typeof import("node:fs")
      dir = fsSync.realpathSync(rawDir)
    } catch (err) {
      console.warn("[Fixture] realpath failed (redacted):", String(err).slice(0, 100))
    }
    const { opId, idempotencyKey, requestId } = buildSessionUpdateIdentity(input.sessionId)
    const durableContext: { directory: string; sessionId: string; parentSessionId: null } = {
      directory: dir,
      sessionId: input.sessionId,
      parentSessionId: null,
    }
    const client = this.client
    if (!client) throw new Error("fixture sessionUpdate: not connected")
    const sdkRes = (await renameSessionWithResult({
      client: client as unknown as import("@kilocode/sdk/v2/client").KiloClient,
      sessionID: input.sessionId,
      title: input.title,
      directory: dir,
      opId,
      idempotencyKey,
      requestId,
      context: durableContext,
    } as unknown as Parameters<typeof renameSessionWithResult>[0])) as unknown as {
      data?: unknown
      error?: unknown
      response?: unknown
    }
    const sdkHasData = !!sdkRes.data && !sdkRes.error
    const sdkStatus = sdkRes.error ? "failed" : "succeeded"
    // Fixture-only bounded state: single active operation, lazy, recorded
    // only after authoritative SDK success, retained across child restart,
    // cleared on dispose/prune, no production allocation. Failed SDK does
    // not call private or create state.
    if (sdkHasData) {
      const state = this.getReplayState()
      if (state) {
        state.set(input.sessionId, {
          opId,
          idempotencyKey,
          requestId,
          sessionId: input.sessionId,
          title: input.title,
          directory: dir,
        })
        // single active operation: keep at most 1 entry
        if (state.size > 1) {
          const first = state.keys().next().value as string | undefined
          if (first && first !== input.sessionId) state.delete(first)
        }
      }
    }
    let httpStatus: number | null = null
    try {
      const resp = (sdkRes as { response?: { status?: unknown } }).response
      if (resp && typeof resp.status === "number" && Number.isInteger(resp.status)) httpStatus = resp.status as number
      else if (resp && typeof resp.status === "string") {
        const n = Number(resp.status)
        if (Number.isInteger(n)) httpStatus = n
      }
      if (httpStatus === null && sdkRes.error) {
        const err = sdkRes.error as Record<string, unknown>
        for (const c of [err.status, err.statusCode, err.code]) {
          if (typeof c === "number" && c >= 100 && c < 600) {
            httpStatus = c
            break
          }
          if (typeof c === "string") {
            const n = Number(c)
            if (Number.isInteger(n) && n >= 100 && n < 600) {
              httpStatus = n
              break
            }
          }
        }
      }
    } catch (err) {
      console.warn("[Fixture] httpStatus extraction failed:", String(err).slice(0, 200))
    }
    const order: string[] = ["sdk"]
    let privRes: { status: string; hasData: boolean; transportUnknown?: boolean; failureCode?: string } | null = null
    let rawPriv: unknown = null
    let parity: { divergence: string | null; details: Record<string, unknown> } = { divergence: null, details: {} }
    if (!sdkHasData) {
      const errObj = sdkRes.error as Record<string, unknown>
      const errCode = String(errObj?.code ?? errObj?._tag ?? "").slice(0, 100)
      console.warn(
        "[Fixture] SDK failed, skipping private (redacted):",
        String(sdkStatus).slice(0, 20),
        `http=${String(httpStatus)}`,
        `code=${errCode}`,
      )
    } else if (!this.isPrivateAvailable()) {
      console.warn(
        "[Fixture] private unavailable at title update (redacted):",
        String(this.privateAvailable).slice(0, 20),
        String(this.privatePeer?.getPeerStateForFixture?.()).slice(0, 20),
      )
    }
    // SDK-then-private: only when SDK succeeded (failed does not call private)
    if (sdkHasData && this.isPrivateAvailable()) {
      order.push("private")
      const privateReq = {
        v: 1 as const,
        requestId,
        opId,
        op: "session/update" as const,
        idempotencyKey,
        context: durableContext,
        payload: { title: input.title },
      }
      try {
        const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`timeout ${ms}`)), ms)
            ;(timer as unknown as { unref?: () => void })?.unref?.()
          })
          return Promise.race([p, timeout]).finally(() => {
            if (timer) clearTimeout(timer)
          }) as Promise<T>
        }
        rawPriv = await withTimeout(
          this.privateSessionUpdate(privateReq as unknown as ServePrivateSessionUpdateRequest),
          3000,
        ).catch((e: unknown) => ({
          v: 1,
          requestId,
          opId,
          op: "session/update",
          idempotencyKey,
          status: "ambiguous",
          outcome: { type: "ambiguous", time: Date.now() },
          accepted: false,
          transportUnknown: true,
          _error: String(e),
        }))
        const r = rawPriv as Record<string, unknown>
        const status = String(r.status ?? "unknown")
        const hasData = !!r.data
        const transportUnknown = !!(r.transportUnknown as boolean)
        const failureCode = (r.failure as Record<string, unknown> | undefined)?.code as string | undefined
        privRes = {
          status,
          hasData,
          ...(transportUnknown ? { transportUnknown: true } : {}),
          ...(failureCode ? { failureCode } : {}),
        }
        try {
          parity = compareUpdateParity(
            rawPriv as unknown as ServePrivateSessionUpdateResult,
            sdkRes as unknown as { data?: unknown; error?: unknown; response?: unknown },
          )
        } catch (e) {
          console.warn("[Fixture] compareUpdateParity failed:", String(e).slice(0, 200))
          parity = { divergence: `compare-error:${String(e).slice(0, 100)}`, details: {} }
        }
      } catch (e) {
        console.warn("[Fixture] privateSessionUpdate failed:", String(e).slice(0, 200))
        privRes = { status: "ambiguous", hasData: false, transportUnknown: true }
        parity = { divergence: "transport-unknown", details: {} }
      }
    } else if (sdkHasData && !this.isPrivateAvailable()) {
      parity = { divergence: "private-unavailable", details: {} }
    } else if (!sdkHasData) {
      parity = { divergence: "sdk-failed", details: {} }
    }
    // revision: extract from private or sdk data if available
    let revision: { session?: number; config?: number } | null = null
    try {
      const src = (rawPriv as Record<string, unknown> | null)?.revision as Record<string, unknown> | undefined
      if (src && typeof src.session === "number")
        revision = {
          session: src.session as number,
          ...(typeof src.config === "number" ? { config: src.config as number } : {}),
        }
      else if (sdkHasData) {
        // SDK data doesn't carry revision; leave null
      }
    } catch (err) {
      console.warn("[Fixture] revision extraction failed:", String(err).slice(0, 200))
    }
    return {
      order,
      sdk: {
        status: sdkStatus,
        httpStatus,
        hasData: sdkHasData,
        ...(sdkRes.error
          ? {
              errorCode: String(
                (sdkRes.error as Record<string, unknown>).code ?? (sdkRes.error as Record<string, unknown>)._tag ?? "",
              ),
            }
          : {}),
      },
      private: privRes,
      parity,
      redacted: {
        opIdHash: this.hashForFixture(opId),
        idempotencyKeyHash: this.hashForFixture(idempotencyKey),
        requestIdHash: this.hashForFixture(requestId),
        titleHash: this.hashForFixture(input.title),
        sessionIdHash: this.hashForFixture(input.sessionId),
      },
      revision,
    }
  }

  /**
   * Fixture same-key private replay: replays the last stored durable identity
   * for the given sessionId without a second SDK mutation. Proves the persisted
   * snapshot/revision is returned without a second mutation and that private
   * remains replay-only after restart. Returns redacted hashes; no raw secrets.
   */
  public async fixturePrivateReplay(sessionId: string): Promise<{
    found: boolean
    private: { status: string; hasData: boolean; transportUnknown?: boolean; failureCode?: string } | null
    parity?: { divergence: string | null; details: Record<string, unknown> }
    redacted?: {
      opIdHash: string
      idempotencyKeyHash: string
      requestIdHash: string
      titleHash: string
      sessionIdHash: string
    }
    revision: { session?: number; config?: number } | null
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture privateReplay requires KILO_E2E_FIXTURE")
    const state = this.lastSessionUpdateIdentities
    if (!state) return { found: false, private: null, revision: null }
    const stored = state.get(sessionId)
    if (!stored) return { found: false, private: null, revision: null }
    if (!this.isPrivateAvailable())
      return { found: true, private: { status: "unavailable", hasData: false }, revision: null }
    const privateReq = {
      v: 1 as const,
      requestId: stored.requestId,
      opId: stored.opId,
      op: "session/update" as const,
      idempotencyKey: stored.idempotencyKey,
      context: { directory: stored.directory, sessionId: stored.sessionId, parentSessionId: null },
      payload: { title: stored.title },
    }
    let rawPriv: unknown = null
    try {
      const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`timeout ${ms}`)), ms)
          ;(timer as unknown as { unref?: () => void })?.unref?.()
        })
        return Promise.race([p, timeout]).finally(() => {
          if (timer) clearTimeout(timer)
        }) as Promise<T>
      }
      rawPriv = await withTimeout(
        this.privateSessionUpdate(privateReq as unknown as ServePrivateSessionUpdateRequest),
        3000,
      ).catch((e: unknown) => ({
        v: 1,
        requestId: stored.requestId,
        opId: stored.opId,
        op: "session/update",
        idempotencyKey: stored.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
        _error: String(e),
      }))
    } catch (err) {
      console.warn("[Fixture] privateReplay failed:", String(err).slice(0, 200))
      return { found: true, private: { status: "ambiguous", hasData: false, transportUnknown: true }, revision: null }
    }
    const r = rawPriv as Record<string, unknown>
    const status = String(r.status ?? "unknown")
    const hasData = !!r.data
    const transportUnknown = !!(r.transportUnknown as boolean)
    const failureCode = (r.failure as Record<string, unknown> | undefined)?.code as string | undefined
    let revision: { session?: number; config?: number } | null = null
    try {
      const src = r.revision as Record<string, unknown> | undefined
      if (src && typeof src.session === "number")
        revision = {
          session: src.session as number,
          ...(typeof src.config === "number" ? { config: src.config as number } : {}),
        }
    } catch (err) {
      console.warn("[Fixture] replay revision extraction failed:", String(err).slice(0, 200))
    }
    // For parity, we need sdk success shape to compare; we know SDK succeeded for this stored op, so construct succeeded
    // But for generic replay we just return private result; harness will assert status succeeded and revision same
    return {
      found: true,
      private: {
        status,
        hasData,
        ...(transportUnknown ? { transportUnknown: true } : {}),
        ...(failureCode ? { failureCode } : {}),
      },
      redacted: {
        opIdHash: this.hashForFixture(stored.opId),
        idempotencyKeyHash: this.hashForFixture(stored.idempotencyKey),
        requestIdHash: this.hashForFixture(stored.requestId),
        titleHash: this.hashForFixture(stored.title),
        sessionIdHash: this.hashForFixture(stored.sessionId),
      },
      revision,
    }
  }
}
