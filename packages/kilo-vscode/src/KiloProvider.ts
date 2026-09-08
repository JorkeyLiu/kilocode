import * as path from "path"
import * as vscode from "vscode"
import type {
  KiloClient,
  Session,
  SessionStatus,
  Event,
  TextPartInput,
  FilePartInput,
  Config,
} from "@kilocode/sdk/v2/client"
import { MaxCostNudge, type MaxCostChoice } from "@opencode-ai/core/kilocode/cost/max-cost-nudge"
import { type KiloConnectionService, ServerStartupError } from "./services/cli-backend"
import { previewSound } from "./services/attention"
import type { EditorContext } from "./services/cli-backend/types"
import { FileIgnoreController } from "./services/notebook/file-ignore"
import { notebookUri } from "./services/notebook"
import { buildWebviewHtml, getWebviewFontSize } from "./utils"
import { saveImage } from "./kilo-provider/save-image"
import { handleEditorAction } from "./kilo-provider/editor-actions"
import { exportTranscript } from "./kilo-provider/export-transcript"
import {
  TelemetryProxy,
  type TelemetryPropertiesProvider,
  pushTelemetryState,
  watchTelemetryState,
} from "./services/telemetry"
import {
  indexProvidersById,
  filterVisibleAgents,
  resolveServedDefaultAgent,
  mapSSEEventToWebviewMessage,
  getErrorMessage,
  getConfigErrorDetails,
  isEventFromForeignProject,
  MessageConfirmation,
  runWithMessageConfirmation,
  loadSessions as loadSessionsUtil,
  flushPendingSessionRefresh as flushPendingSessionRefreshUtil,
  normalizeSessionListNextCursor,
  resolveContextDirectory,
  resolveNewSessionDirectory,
  resolveWorkspaceDirectory,
  sameDirectory,
  SessionStreamScheduler,
  buildSettingPath,
  buildSnapshotPartKeys,
  type SessionRefreshContext,
} from "./kilo-provider-utils"
import { updateSnapshotKey } from "./kilo-provider/session-stream-scheduler"
import {
  sdkSessionToDetail,
  observationSessionToDetail,
  detailToWebview,
  validatePrivateGetResult,
  SessionNotFoundError,
  SessionScopeMismatchError,
  type SessionDetail,
} from "./kilo-provider/session-detail"
import { ErrorCode } from "./private-worker/json-rpc"
import { createMarketplaceRemover, removeMcp } from "./kilo-provider/remove-config-item"
import { AgentRequirementsController } from "./kilo-provider/agent-requirements-controller"
import type { RemoteStatusService } from "./services/RemoteStatusService"
import { resolveProjectDirectory } from "./project-directory"
import { seedSessionStatuses } from "./session-status"
import { normalizeEnhancePromptErrorMessage } from "./enhance-prompt-error"
import { retry } from "./services/cli-backend/retry"
import { normalize, type SSEPayload, type SyncPayload, type WirePayload } from "./services/cli-backend/sdk-sse-adapter"
import { isP0PerfEnabled, p0Stage, p0Webview } from "./perf/perf-instrument"
import { slimInfo, slimPart, slimParts } from "./kilo-provider/slim-metadata"
import { parseMessageFiles, type MessageFile } from "./kilo-provider/message-files"
import {
  renameSessionWithResult,
  buildSessionUpdateIdentity,
  buildSessionCreateIdentity,
} from "./kilo-provider/rename-session"
import { observeSessionGetParityDetached } from "./kilo-provider/session-get-parity"
import { observeSessionMessagesParityDetached } from "./kilo-provider/session-messages-parity"
import { observeSessionListParityDetached } from "./kilo-provider/session-list-parity"
import { parseSessionTitle } from "./shared/session-title"
import { handleFileSearch } from "./kilo-provider/file-search"
import { handleFilePicker } from "./kilo-provider/file-picker"
import { watchFontSizeConfig } from "./kilo-provider/font-size"
import { getTerminalContents } from "./services/terminal/context"
import { disposeGitChangesTarget } from "./kilo-provider/git-changes-target"
import { interceptMessage } from "./kilo-provider/git-changes-request"
import { matchFollowup, recordFollowup, type Followup } from "./kilo-provider/followup-session"
import { clearCommandsCache, loadCommands } from "./kilo-provider/commands"
import { observeConfigWarningsParity } from "./kilo-provider/config-warnings"
import { fetchMessagePage, MESSAGE_PAGE_LIMIT } from "./kilo-provider/message-page"
import { childID } from "./kilo-provider/task-session"
import { VisibleTaskStreams } from "./kilo-provider/visible-task-streams"
import { handleNetworkEvent, clearNetworkWaits } from "./kilo-provider/network"
import { SessionAbort } from "./kilo-provider/abort"
import { routeEarlyMessage } from "./kilo-provider/early-message"
import * as ModelState from "./kilo-provider/model-state"
import { handleForkSession } from "./kilo-provider/fork-session"
import { openConfig } from "./kilo-provider/open-config"
import {
  getWorkStylePayload,
  handleWorkStyleMessage,
  isWorkStyleSetting,
  watchWorkStyleConfig,
} from "./kilo-provider/work-style"
import * as McpOAuth from "./kilo-provider/mcp-oauth"
import { retryable, backoff, MAX_RETRIES } from "./util/retry"
import { canonicalDirectory } from "./private-worker/canonical-directory"
import { decodeGlobalListCursor } from "./private-worker/session-cursor"
import { hasGit } from "./kilo-provider/git-status"
import {
  handleLogin,
  handleLogout,
  handleSetOrganization,
  handleRefreshProfile,
  type AuthContext,
} from "./kilo-provider/handlers/auth"
import {
  handlePermissionResponse,
  fetchAndSendPendingPermissions,
  type PermissionContext,
} from "./kilo-provider/handlers/permission-handler"
import {
  handleQuestionReply,
  handleQuestionReject,
  fetchAndSendPendingQuestions,
} from "./kilo-provider/handlers/question"
import { fetchAndSendPendingSuggestions } from "./kilo-provider/handlers/suggestion"
import { nativeTitle } from "./kilo-provider/native-tab-title"
import { parseReview, reviewMetadata, type ReviewMessageData } from "./shared/review-comments"

import {
  authorizeCredentialRead,
  buildActionContext,
  computeDefaultSelection,
  fetchProviderData,
  validateRecents,
  validateFavorites,
  connectProvider as connectProviderAction,
  authorizeProviderOAuth as authorizeOAuthAction,
  completeProviderOAuth as completeOAuthAction,
  disconnectProvider as disconnectProviderAction,
  deleteCustomProvider as deleteCustomProviderAction,
  saveCustomProvider as saveCustomProviderAction,
  resolveStoredKey,
} from "./provider-actions"
import type { StoredProviderKey } from "./provider-actions"
import { AnacondaDesktopBridge } from "./anaconda-desktop/bridge"
import { fetchOpenAIModels, FetchModelsError } from "./shared/fetch-models"
import type { Agent } from "@kilocode/sdk/v2/client"
import { configFeatures } from "./features"
import { createAutoApproveBridge } from "./kilo-provider/auto-approve"
import type { KiloProviderOptions } from "./kilo-provider/options"
import { fetchImageModels } from "./image-generation/models"
import { stopSessionProcesses } from "./kilo-provider/background-process"
import { sandboxDefault, sandboxSessionMetadata } from "./shared/sandbox-session"
import type { CanonicalConfigService, CanonicalConfigEvent, CanonicalConfigError } from "./config/service"
import { sameStamp } from "./config/types"
import {
  toCanonicalPayload,
  type CanonicalConfigPayload,
  type CanonicalMcpPayload,
  type CanonicalProviderPayload,
  type CanonicalStamp,
  type CleanupRetryRecord,
  parseCanonicalProviderRecord,
  narrowProviderEntry,
  isValidCanonicalProviderEntry,
} from "./config/types"
import { parseSecretKey } from "./config/secret-adapter"
import { CLOSED_JSONC_FIELDS, isGuiField } from "./config/registry"
import { mapProviderIndexToWebviewProviders } from "./config/selectors"

let maxCost = 0

type MessageLoadMode = "replace" | "prepend" | "focus" | "reconcile"
type ContextMessage = { contextDirectory?: unknown }
type TypedWebviewMessage = {
  type: string
  value?: unknown
}
type SandboxSupportClient = {
  support: (
    parameters: { directory?: string },
    options: { throwOnError: true },
  ) => Promise<{ data: { available: boolean; reason?: string } }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function redactCanonical(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("secret:")) return undefined
  if (Array.isArray(value)) return value.map(redactCanonical)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      continue
    }
    const clean = redactCanonical(child)
    if (clean !== undefined) result[key] = clean
  }
  return result
}

function canonicalConfigPayload(value: Record<string, unknown>): CanonicalConfigPayload {
  const redacted = redactCanonical(value)
  const raw = filterCanonicalScope(isRecord(redacted) ? redacted : {})
  if (isRecord(raw.provider))
    raw.provider = Object.fromEntries(
      Object.entries(raw.provider).map(([id, item]) => [id, canonicalProviderValue(item)]),
    )
  if (isRecord(raw.mcp))
    raw.mcp = Object.fromEntries(Object.entries(raw.mcp).map(([id, item]) => [id, canonicalMcpValue(item)]))
  const payload = toCanonicalPayload(raw)
  return payload ?? {}
}

function canonicalProviderValue(value: unknown): unknown {
  if (!isRecord(value)) return {}
  const next: Record<string, unknown> = {}
  if (typeof value.name === "string") next.name = value.name
  if (typeof value.endpoint === "string") next.endpoint = value.endpoint
  if (typeof value.protocol === "string") next.protocol = value.protocol
  if (isRecord(value.models)) next.models = value.models
  return next
}

function canonicalMcpValue(value: unknown): CanonicalMcpPayload {
  if (!isRecord(value)) return {}
  const next: { type?: "local" | "remote"; command?: string; args?: string[]; url?: string; enabled?: boolean } = {}
  if (value.type === "local" || value.type === "remote") next.type = value.type
  if (typeof value.command === "string") next.command = value.command
  if (Array.isArray(value.command) && value.command.every((item) => typeof item === "string")) {
    next.command = value.command[0]
    next.args = value.command.slice(1)
  }
  if (Array.isArray(value.args) && value.args.every((item) => typeof item === "string")) next.args = value.args
  if (typeof value.url === "string") next.url = value.url
  if (typeof value.enabled === "boolean") next.enabled = value.enabled
  return next
}

function filterCanonicalScope(value: Record<string, unknown>): Record<string, unknown> {
  // Meta keys ($schema) are validation-only backend metadata: excluded from
  // the GUI payload so toCanonicalPayload never sees them.
  return Object.fromEntries(Object.entries(value).filter(([key]) => isGuiField(key)))
}

const CREDENTIAL_KEY = /^(?:api[_-]?key|authorization|token|password|secret|cookie|credential|headers?)$/i

/**
 * Sanitize a value tree for credential-bearing keys. Returns true only when
 * the entire tree is free of credential-bearing field names. Used to gate
 * inbound webview payloads and custom-provider metadata.
 */
function isCredentialFreeMetadata(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isCredentialFreeMetadata)
  if (!isRecord(value)) return true
  return Object.entries(value).every(([key, child]) => !CREDENTIAL_KEY.test(key) && isCredentialFreeMetadata(child))
}

function isCanonicalStamp(value: unknown): value is CanonicalStamp {
  if (!isRecord(value)) return false
  if (
    (typeof value.globalHash !== "string" && value.globalHash !== null) ||
    (typeof value.projectHash !== "string" && value.projectHash !== null) ||
    typeof value.materializationVersion !== "number" ||
    (typeof value.assetHash !== "string" && value.assetHash !== null)
  )
    return false
  return true
}

function sandboxClient(client: KiloClient | null) {
  const sandbox = client?.sandbox
  return sandbox as (typeof sandbox & SandboxSupportClient) | undefined
}

// Helper to map agent data to the subset of fields sent to the webview
const mapAgent = (a: Agent) => ({
  name: a.name,
  displayName: a.displayName,
  description: a.description,
  mode: a.mode,
  native: a.native,
  hidden: a.hidden,
  color: a.color,
  deprecated: a.deprecated,
  permission: a.permission,
  model: a.model,
})

// message.part.* events are always session-scoped; drop them when the session is unknown.
const SESSION_SCOPED_PART_EVENTS = new Set(["message.part.updated", "message.part.delta", "message.part.removed"])
const isSessionScopedPartEvent = (type: string) => SESSION_SCOPED_PART_EVENTS.has(type)

type RawSyncPayload = Extract<WirePayload, { type: "sync" }>
type LegacySyncEvent =
  | {
      id: string
      type: "message.updated"
      properties: Extract<SyncPayload, { name: "message.updated.1" }>["data"]
    }
  | {
      id: string
      type: "message.removed"
      properties: Extract<SyncPayload, { name: "message.removed.1" }>["data"]
    }
  | {
      id: string
      type: "message.part.updated"
      properties: Extract<SyncPayload, { name: "message.part.updated.1" }>["data"]
    }
  | {
      id: string
      type: "message.part.removed"
      properties: Extract<SyncPayload, { name: "message.part.removed.1" }>["data"]
    }
  | {
      id: string
      type: "session.created"
      properties: Extract<SyncPayload, { name: "session.created.1" }>["data"]
    }
  | {
      source: "sync"
      id: string
      seq: number
      type: "session.updated"
      properties: Extract<SyncPayload, { name: "session.updated.1" }>["data"]
    }
  | {
      id: string
      type: "session.deleted"
      properties: Extract<SyncPayload, { name: "session.deleted.1" }>["data"]
    }

type ProviderEvent = Event | LegacySyncEvent

function isLegacySyncEvent(event: ProviderEvent): event is LegacySyncEvent {
  if (event.type === "session.updated") return "source" in event && event.source === "sync"
  return (
    event.type === "message.updated" ||
    event.type === "message.removed" ||
    event.type === "message.part.updated" ||
    event.type === "message.part.removed" ||
    event.type === "session.created" ||
    event.type === "session.deleted"
  )
}

export function unwrapSyncEvent(event: SSEPayload | RawSyncPayload): ProviderEvent | undefined {
  if (event.type !== "sync") return event
  const payload = "syncEvent" in event ? normalize(event) : event

  switch (payload.name) {
    case "message.updated.1":
      return { id: payload.id, type: "message.updated", properties: payload.data }
    case "message.removed.1":
      return { id: payload.id, type: "message.removed", properties: payload.data }
    case "message.part.updated.1":
      return { id: payload.id, type: "message.part.updated", properties: payload.data }
    case "message.part.removed.1":
      return { id: payload.id, type: "message.part.removed", properties: payload.data }
    case "session.created.1":
      return { id: payload.id, type: "session.created", properties: payload.data }
    case "session.updated.1":
      return { source: "sync", id: payload.id, seq: payload.seq, type: "session.updated", properties: payload.data }
    case "session.deleted.1":
      return { id: payload.id, type: "session.deleted", properties: payload.data }
    default:
      return undefined
  }
}

export class KiloProvider implements TelemetryPropertiesProvider {
  private readonly instanceId = crypto.randomUUID()

  private webview: vscode.Webview | null = null
  private currentSession: SessionDetail | null = null
  /** Remembers the last selected session so /new stays in the same session context after clearSession. */
  private contextSessionID: string | undefined
  private connectionState: "connecting" | "connected" | "disconnected" | "error" = "connecting"
  private connectionGeneration = 0
  private loginAttempt = 0
  private isWebviewReady = false
  private readonly extensionVersion =
    vscode.extensions.getExtension("kilocode.kilo-code")?.packageJSON?.version ?? "unknown"
  private cachedProvidersMessage: unknown = null
  /**
   * Provider API keys retained extension-side for authenticated model
   * fetches (#10139). Keys are stripped before provider data reaches the
   * webview, so fetch requests for an existing provider carry a providerID
   * and the key is resolved here. Refreshed on every provider fetch.
   */
  private storedProviderKeys: Record<string, StoredProviderKey> = {}
  /** Coalesce provider refreshes — at most one follow-up rerun when a request lands mid-flight. */
  private providersRefresh: Promise<void> | null = null
  private providersQueued = false
  private providersGeneration = 0
  private sandboxRevision = 0
  private cachedAgentsMessage: unknown = null
  /** Cached skillsLoaded payload so requestSkills can be served before client is ready */
  private cachedSkillsMessage: unknown = null
  /** Cached commandsLoaded payload so requestCommands can be served before client is ready */
  private cachedCommandsMessage: unknown = null
  /** Cached configLoaded payload so requestConfig can be served before client is ready */
  private cachedConfigMessage: unknown = null
  private cachedCanonicalError: unknown = null
  /** Cached imageModelsLoaded payload so requestImageModels is resilient offline. */
  private cachedImageModelsMessage: unknown = null
  /** Cached mcpStatusLoaded payload so requestMcpStatus can be served before client is ready */
  private cachedMcpStatusMessage: unknown = null
  /** Ref-count of in-flight handleUpdateConfig mutations; prevents fetchAndSendConfig from sending stale data */
  private pending = 0
  /** Newest reconciliation attempt; supersedes older in-flight reconciliation fetches (LOCK-003/004/005). */
  private reconcileSeq = 0
  private reconcileInFlight: { seq: number } | null = null
  /** True once dispose() runs; queueReconcile becomes a no-op (LOCK-004). */
  private disposed = false
  /** Revision the last successful reconciliation covered — the dedupe key that prevents a local save from double-fetching its own canonical echo (LOCK-001/002). */
  private lastReconcileRevision = -1
  private configWarningsShown = false
  private pendingKiloModel: { modelID?: string; agent?: string } | null = null
  private readyResolvers: (() => void)[] = []
  private reloadInFlight: Promise<void> | null = null
  private promptRecoveryQueued = false
  private promptRecovery: Promise<void> | null = null
  private trackedSessionIds: Set<string> = new Set()
  private modelUsageSessionIds: Set<string> = new Set()
  private syncedChildSessions: Set<string> = new Set()
  private readonly checkpoints = new Map<string, Promise<void>>()
  private readonly sessionCreations = new Map<string, Promise<{ sid: string; dir: string } | undefined>>()
  private readonly draftSessions = new Map<string, { sid: string; dir: string; expires: number }>()
  private readonly sandboxTransitions = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, { id: string; seq: number }>()
  private readonly refreshes = new Map<string, number>()
  private readonly anacondaDesktop = new AnacondaDesktopBridge()
  private sessionStatusMap = new Map<string, SessionStatus["type"]>() // Latest status used for destructive config warnings.
  private sessionDirectories = new Map<string, string>() // Per-session directory resolution for permission/question/reload routing.
  private readonly aborts = new SessionAbort()
  private projectID: string | undefined // Current workspace project ID used to filter sessions.
  private loadMessagesAbort: AbortController | null = null // Current load request cancellation.
  private detailGeneration = 0 // Monotonic detail/load generation; superseding transitions bump to invalidate pending detail/message loads.
  private lastReconciledAt = new Map<string, number>() // Per-session focus-mode reconcile timestamp.
  private pendingSessionRefresh = false // Refresh requested before the client is ready.
  private sessionCursor: string | null = null // Next-page opaque composite cursor for session list pagination.
  private sessionCount = 0 // Sessions loaded so far; sizes the re-fetch on full refresh.
  private readonly streams = new SessionStreamScheduler((msg) => this.postMessage(msg))
  private readonly visibleTaskStreams = new VisibleTaskStreams((id, visible) => this.streams.setVisible(id, visible))
  private readonly confirmations = new MessageConfirmation()
  private catalogCbs: Array<(update: { ids: string[]; append?: boolean; hasMore?: boolean }) => void> = []
  private readonly costs = new MaxCostNudge()
  private readonly activeAlerts = new Map<string, number>() // sid -> limit currently shown in UI
  private unsubscribeEvent: (() => void) | null = null
  private unsubscribeState: (() => void) | null = null
  private unsubscribeLanguageChange: (() => void) | null = null
  private unsubscribeProfileChange: (() => void) | null = null
  private unsubscribeFavoritesChange: (() => void) | null = null
  private unsubscribeModelSelectorExpanded: (() => void) | null = null
  private unsubscribeDirectoryProvider: (() => void) | null = null
  private unsubscribeConfigRevision: (() => void) | null = null
  private unsubscribeSandboxPreference: (() => void) | null = null
  private unsubscribeCanonicalChange: { dispose(): void } | null = null
  private unsubscribeCanonicalError: { dispose(): void } | null = null
  private initConnectionPromise: Promise<void> | null = null
  private webviewMessageDisposable: vscode.Disposable | null = null
  private telemetryStateDisposable: vscode.Disposable | null = null
  private viewStateDisposable: vscode.Disposable | null = null
  private autoApproveBridge: ReturnType<typeof createAutoApproveBridge> | null = null
  private readonly marketplaceRemove = createMarketplaceRemover()

  private ignoreController: FileIgnoreController | null = null
  private ignoreControllerDir: string | null = null
  private projectDirectory: string | null | undefined
  private slimEditMetadata = true

  private pendingFollowup: Followup | null = null
  private followupListeners: Array<(session: SessionDetail | Session, directory: string) => void> = []
  private cachedGitRepo = false

  private onBeforeMessage: ((msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>) | null = null

  private remoteService: RemoteStatusService | null = null
  private unsubscribeRemote: (() => void) | null = null
  private readonly requirements: AgentRequirementsController
  private canonicalConfig: CanonicalConfigService | null
  private readonly privateSessionReader: import("./kilo-provider/options").PrivateSessionReader | null
  /** Legacy alias for tests — returns same reader. */
  private get privateSessionList(): import("./kilo-provider/options").PrivateSessionReader | null {
    return this.privateSessionReader
  }
  /**
   * Host-owned cleanup retry records keyed by opaque retryID.
   * Namespaced as "provider:<scope>:<id>" and "mcp:<scope>:<id>" so provider
   * and MCP records cannot collide. The stored record is the only authority;
   * retry requests carry the retryID only and never authority refs.
   */
  private readonly cleanupRetries = new Map<string, CleanupRetryRecord>()

  /**
   * P4.1 target-level reservation: keyed by validated target identity
   * "provider|<scope>|<id>|<ref>" or "mcp|<scope>|<id>|<ref>". Prevents two
   * distinct retry records with the same validated (kind, scope, id, exact ref)
   * from both executing a cleanup side effect concurrently. Released on success
   * or lossless failure restore.
   */
  private readonly cleanupTargets = new Map<string, string>() // targetKey → retryID

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionService: KiloConnectionService,
    private readonly extensionContext?: vscode.ExtensionContext,
    private readonly opts: KiloProviderOptions = {},
  ) {
    this.projectDirectory = opts.projectDirectory
    this.canonicalConfig = opts.canonicalConfig ?? null
    this.privateSessionReader = opts.privateSessionReader ?? opts.privateSessionList ?? null
    this.slimEditMetadata = opts.slimEditMetadata ?? true
    this.unsubscribeSandboxPreference = this.connectionService.sandboxPreference?.onChange(() => {
      if (this.connectionState === "connected") void this.fetchAndSendSandboxDefault()
    })
    this.requirements = new AgentRequirementsController({
      post: (msg) => this.postMessage(msg),
      client: () => this.client,
      connected: () => this.connectionState === "connected",
      generation: () => this.connectionGeneration,
      root: () => this.getRootDirectory(),
      folders: () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath),
      project: () => this.projectDirectory,
      sessions: () => this.sessionDirectories,
      extension: (id) => vscode.extensions.getExtension(id),
      subscribe:
        typeof vscode.extensions.onDidChange === "function"
          ? (listener) => vscode.extensions.onDidChange(listener)
          : undefined,
      error: getErrorMessage,
    })

    TelemetryProxy.getInstance().setProvider(this)

    // LOCK-001/002: seed the reconciliation dedupe with the current shared
    // revision so the first local save does not double-fetch when its canonical
    // SSE echo advances the revision.
    this.lastReconcileRevision = this.connectionService.getConfigRevision()
    this.subscribeCanonical()
  }

  setCanonicalConfig(service: CanonicalConfigService): void {
    this.canonicalConfig = service
    this.canonicalReady = false
    this.subscribeCanonical()
  }

  private subscribeCanonical(): void {
    this.unsubscribeCanonicalChange?.dispose()
    this.unsubscribeCanonicalError?.dispose()
    const service = this.canonicalConfig
    if (!service) return
    // P4.1: readiness always mirrors the service-owned materializationReady
    // fact. No provider-local error history gates the decision.
    this.canonicalReady = service.materializationReady
    this.unsubscribeCanonicalChange = service.onDidChange((event) => this.onCanonicalChange(event))
    this.unsubscribeCanonicalError = service.onDidError((error) => this.onCanonicalError(error))
    if (this.isWebviewReady) {
      this.sendCanonicalConfig("configUpdated")
      void this.sendCanonicalProviders()
      void this.sendCanonicalAgents()
    }
  }

  private onCanonicalChange(event: CanonicalConfigEvent): void {
    // P4.1: readiness always mirrors the service-owned materializationReady
    // fact. The service clears it before any error path and sets it only after
    // error-free success — no provider-local check needed.
    this.canonicalReady = this.canonicalConfig?.materializationReady ?? false
    if (!this.isWebviewReady) return
    this.sendCanonicalConfig(event.source === "gui" ? "configUpdated" : "configLoaded", event)
    void this.sendCanonicalProviders(event)
    void this.sendCanonicalAgents(event)
  }

  private onCanonicalError(error: CanonicalConfigError): void {
    if (!this.canonicalConfig) return
    // P4.1: readiness always mirrors the service-owned fact. The service
    // clears materializationReady before emitting errors, so this reads
    // the current authoritative value rather than hardcoding false.
    this.canonicalReady = this.canonicalConfig.materializationReady
    const stamp = { ...this.canonicalConfig.stamp, assetHash: null }
    this.cachedCanonicalError = {
      type: "canonicalConfigError",
      kind: error.kind,
      message: error.message,
      diagnostics: error.errors,
      stamp,
    }
    this.postMessage({
      type: "canonicalConfigError",
      kind: error.kind,
      message: error.message,
      diagnostics: error.errors,
      stamp,
    })
    if (this.canonicalConfig?.providerIndex) void this.sendCanonicalProviders()
    if (this.canonicalConfig?.agentIndex) void this.sendCanonicalAgents()
  }

  /**
   * Typed empty/not-ready canonical state published before the first successful
   * materialization and after a service replacement/disposal closes readiness.
   * `canonical: true` keeps the webview out of the legacy KILO_AUTO/kilo path;
   * empty payloads plus the pre-materialization stamp are the only content.
   * Never publishes rehydrated or backend-derived state pre-ready.
   */
  private publishCanonicalNotReady(): void {
    const stamp = this.canonicalConfig?.stamp ?? {
      globalHash: null,
      projectHash: null,
      materializationVersion: 0,
      assetHash: null,
    }
    const settings = { maxCost: this.maxCostSetting() }
    const features = configFeatures()
    this.postMessage({
      type: "configLoaded",
      config: {},
      globalConfig: {},
      projectConfig: {},
      settings,
      features,
      canonical: true,
      ready: false,
      contentHash: "",
      materializationVersion: stamp.materializationVersion,
      diagnostics: [],
      stamp,
    })
    this.postMessage({
      type: "providersLoaded",
      providers: {},
      connected: [],
      defaults: {},
      defaultSelection: { providerID: "", modelID: "" },
      canonical: true,
      ready: false,
      materializationVersion: stamp.materializationVersion,
      contentHash: "",
      diagnostics: {},
      stamp,
    })
    this.postMessage({
      type: "agentsLoaded",
      agents: [],
      allAgents: [],
      defaultAgent: "",
      canonical: true,
      ready: false,
      materializationVersion: stamp.materializationVersion,
      contentHash: "",
      diagnostics: {},
      stamp,
    })
  }

  private sendCanonicalConfig(type: "configLoaded" | "configUpdated", event?: CanonicalConfigEvent): void {
    const service = this.canonicalConfig
    if (!service) return
    // Readiness is the sole authority: before the first successful
    // materialization only typed empty/not-ready state may be published.
    if (!this.canonicalReady) {
      this.publishCanonicalNotReady()
      return
    }
    const snapshot = service.snapshot
    if (!snapshot) return
    if (!event || event.source === "gui" || !event.hasErrors) this.cachedCanonicalError = null
    if (this.cachedCanonicalError) this.postMessage(this.cachedCanonicalError)
    const global = service.getScopeConfig("global")
    const project = service.getScopeConfig("project")
    const config = canonicalConfigPayload(snapshot.config.value)
    const globalConfig = canonicalConfigPayload(global)
    const projectConfig = canonicalConfigPayload(project)
    const unsupported = [...Object.keys(global), ...Object.keys(project)]
      .filter((key, index, all) => all.indexOf(key) === index)
      .filter((key) => !CLOSED_JSONC_FIELDS.includes(key as (typeof CLOSED_JSONC_FIELDS)[number]))
    const message = {
      type,
      config,
      globalConfig,
      projectConfig,
      settings: { maxCost: this.maxCostSetting() },
      features: configFeatures(),
      canonical: true,
      ready: true,
      contentHash: snapshot.contentHash,
      materializationVersion: snapshot.generation,
      diagnostics: [
        ...(event?.errors ?? []),
        ...unsupported.map((key) => ({ path: [key], message: `Unsupported setting is read-only: ${key}` })),
      ],
      stamp: service.stamp,
      ...(event?.source === "gui" ? {} : {}),
    }
    this.cachedConfigMessage = message
    this.postMessage(message)
  }

  private async sendCanonicalProviders(event?: CanonicalConfigEvent): Promise<void> {
    const service = this.canonicalConfig
    if (!service) return
    // Readiness gate: pre-ready the rehydrated provider index must never be
    // published — only the typed empty/not-ready state.
    if (!this.canonicalReady) {
      this.publishCanonicalNotReady()
      return
    }
    const capturedService = service
    const capturedStamp: CanonicalStamp = { ...service.stamp }
    const capturedReady = this.canonicalReady
    const capturedDisposed = this.disposed
    const capturedWebviewReady = this.isWebviewReady
    const index = await service.buildProviderIndexAsync(
      this.cachedProvidersMessage &&
        typeof this.cachedProvidersMessage === "object" &&
        "defaultSelection" in this.cachedProvidersMessage
        ? ((this.cachedProvidersMessage as { defaultSelection?: { providerID?: string } }).defaultSelection
            ?.providerID ?? null)
        : null,
    )
    if (this.disposed !== capturedDisposed || this.disposed) return
    if (this.isWebviewReady !== capturedWebviewReady) return
    if (this.canonicalConfig !== capturedService) return
    if (!this.canonicalReady || this.canonicalReady !== capturedReady) return
    if (!capturedService.materializationReady || !this.canonicalConfig.materializationReady) return
    if (!sameStamp(capturedStamp, capturedService.stamp)) return
    if (!sameStamp(capturedStamp, this.canonicalConfig.stamp)) return
    if (!index) return
    const providers = mapProviderIndexToWebviewProviders(index)
    const selected =
      typeof service.snapshot?.config.value.model === "string"
        ? String(service.snapshot?.config.value.model).split("/")
        : []
    const providerID = selected[0] && index.providers.some((item) => item.id === selected[0]) ? selected[0] : ""
    const message = {
      type: "providersLoaded" as const,
      providers,
      connected: index.providers.filter((item) => item.hasCredential).map((item) => item.id),
      defaults: {},
      defaultSelection: { providerID, modelID: providerID ? selected.slice(1).join("/") || "auto" : "" },
      canonical: true,
      ready: true,
      materializationVersion: index.materializationVersion,
      contentHash: index.materializationHash,
      diagnostics: { ...index.diagnostics, external: event?.errors ?? [] },
      stamp: service.stamp,
    }
    this.cachedProvidersMessage = message
    this.postMessage(message)
  }

  private async sendCanonicalAgents(event?: CanonicalConfigEvent): Promise<void> {
    const service = this.canonicalConfig
    if (!service) return
    // Readiness gate: pre-ready the rehydrated agent index must never be
    // published — only the typed empty/not-ready state.
    if (!this.canonicalReady) {
      this.publishCanonicalNotReady()
      return
    }
    const index = service.agentIndex
    if (!index) return
    const map = (item: (typeof index.agents)[number]) => ({
      name: item.id,
      displayName: item.displayName,
      description: item.description,
      mode:
        item.mode === "specialized"
          ? ("subagent" as const)
          : item.mode === "primary"
            ? ("primary" as const)
            : ("all" as const),
      hidden: item.hidden,
      color: item.color,
      scope: item.source,
      path: item.filePath,
      assetHash: item.assetHash ?? service.getAssetStamp("agent", item.id, item.source),
      frontmatter: item.frontmatter,
      body: item.body,
      stamp: { ...service.stamp, assetHash: item.assetHash ?? service.getAssetStamp("agent", item.id, item.source) },
    })
    const message = {
      type: "agentsLoaded" as const,
      agents: index.agents.filter((item) => !item.hidden).map(map),
      allAgents: index.agents.map(map),
      // Legacy parity: configs without `default_agent` must still receive a
      // usable default derived from the served list (see resolveServedDefaultAgent);
      // "" only when zero agents are served.
      defaultAgent: resolveServedDefaultAgent(index),
      canonical: true,
      ready: true,
      materializationVersion: index.materializationVersion,
      contentHash: index.materializationHash,
      diagnostics: { ...index.diagnostics, external: event?.errors ?? [] },
      stamp: service.stamp,
    }
    this.cachedAgentsMessage = message
    this.postMessage(message)
  }

  private providerScope(id: string): "global" | "project" {
    const project = this.canonicalConfig?.getScopeConfig("project").provider
    const parsed = parseCanonicalProviderRecord(project)
    if (parsed && id in parsed) return "project"
    return "global"
  }

  /**
   * Authoritative canonical mode gate. True as soon as a canonical config
   * service is attached (regardless of materialization readiness). Legacy
   * loaded/mutation messages must not alter state once this is true.
   */
  get canonicalMode(): boolean {
    return this.canonicalConfig !== null
  }

  /**
   * Authoritative canonical readiness gate. Every canonical-facing select/read/
   * mutate/action path must pass through this — never mere `canonicalConfig != null`.
   * Readiness opens only after successful, error-free materialization.
   */
  private get canonicalReady(): boolean {
    return this._canonicalReady
  }
  private set canonicalReady(value: boolean) {
    this._canonicalReady = value
  }
  private _canonicalReady = false

  private async handleCanonicalProviderAction(msg: Record<string, unknown>): Promise<void> {
    const service = this.canonicalConfig
    const id = typeof msg.providerID === "string" ? msg.providerID : ""
    const requestId = typeof msg.requestId === "string" ? msg.requestId : ""
    if (!service || !this.canonicalReady) {
      this.postMessage({
        type: "providerActionError",
        requestId: requestId || crypto.randomUUID(),
        providerID: id,
        action:
          msg.type === "deleteCustomProvider" ? "delete" : msg.type === "disconnectProvider" ? "disconnect" : "connect",
        message: "Canonical provider authority is not ready",
        canonical: true,
        kind: "not-ready",
        stamp: service?.stamp,
      })
      return
    }
    if (!id || !requestId) {
      this.postMessage({
        type: "providerActionError",
        requestId: requestId || crypto.randomUUID(),
        providerID: id,
        action:
          msg.type === "deleteCustomProvider" ? "delete" : msg.type === "disconnectProvider" ? "disconnect" : "connect",
        message: "Canonical provider request is incomplete",
        canonical: true,
        kind: "invalid",
        stamp: service.stamp,
      })
      return
    }
    const scope = this.providerScope(id)
    const stamp = isCanonicalStamp(msg.stamp) ? msg.stamp : undefined
    const fail = (
      message: string,
      kind = "invalid",
      retry?: {
        scope: "global" | "project"
        stamp: CanonicalStamp
        mode?: "delete" | "restore"
        ref?: string
        priorRecord?: Record<string, unknown>
        priorValue?: string
      },
    ) => {
      // True operation-unique opaque retry ID: every cleanup failure gets its
      // own record key, so overlapping failures for the same resource can never
      // overwrite each other. The record itself carries kind/scope/id/mode/ref/
      // stamp; the map key is opaque.
      const retryID = retry ? crypto.randomUUID() : ""
      if (retry) {
        const record: CleanupRetryRecord = {
          kind: "provider",
          scope: retry.scope,
          id,
          mode: retry.mode ?? "delete",
          ref: retry.ref,
          priorRecord: retry.priorRecord,
          priorValue: retry.priorValue,
          stamp: retry.stamp,
          state: "available",
        }
        this.cleanupRetries.set(retryID, record)
      }
      this.postMessage({
        type: "providerActionError",
        requestId,
        providerID: id,
        action:
          msg.type === "deleteCustomProvider" ? "delete" : msg.type === "disconnectProvider" ? "disconnect" : "connect",
        message,
        canonical: true,
        stamp: service.stamp,
        kind,
        ...(retry
          ? {
              retry: {
                type: "retryProviderCleanup" as const,
                mode: retry.mode ?? "delete",
                scope: retry.scope,
                stamp: retry.stamp,
                retryID,
              },
            }
          : {}),
      })
    }
    const expected = stamp?.[scope === "global" ? "globalHash" : "projectHash"]
    if (!stamp || expected === undefined || stamp.assetHash !== null || !sameStamp(stamp, service.stamp))
      return fail("Provider draft stamp is stale or incomplete", "stale")
    const current = service.getScopeConfig(scope)
    const rawProviders =
      current.provider && typeof current.provider === "object" ? (current.provider as Record<string, unknown>) : {}
    const parsedProviders = parseCanonicalProviderRecord(rawProviders)
    if (!parsedProviders) return fail("Provider record contains invalid entries", "invalid")
    const providers: Record<string, CanonicalProviderPayload> = { ...parsedProviders }
    const ref = `secret:kilo.credentials.${scope}.provider.${id}`
    if (msg.type === "authorizeProviderOAuth" || msg.type === "completeProviderOAuth") {
      return fail("OAuth provider authentication is unavailable in canonical GUI authority", "unsupported")
    }
    if (msg.type === "connectProvider") {
      if (
        msg.canonical !== true ||
        Object.keys(msg).some((key) => CREDENTIAL_KEY.test(key)) ||
        !isCredentialFreeMetadata(msg.metadata)
      )
        return fail("Canonical provider requests must use the host credential prompt", "invalid")
      const key =
        msg.credentialRequested === true
          ? ((
              await vscode.window.showInputBox({
                password: true,
                prompt: `Enter credential for ${id}`,
                ignoreFocusOut: true,
              })
            )?.trim() ?? "")
          : ""
      if (!key) return fail("Credential entry was cancelled or empty", "cancelled")
      const existingEntry = isRecord(providers[id]) && narrowProviderEntry(providers[id])
      const provider: Record<string, unknown> = existingEntry ? { ...existingEntry } : { name: id }
      const priorRef =
        existingEntry && typeof existingEntry.credential === "string" ? existingEntry.credential : undefined
      const result = await service.processCredentialIntent(
        scope,
        "provider",
        id,
        key,
        { provider: { ...providers, [id]: { ...provider, credential: ref } } },
        expected ?? "absent",
        stamp,
        priorRef,
      )
      if (!result.ok) return fail(result.message, result.kind)
      this.postMessage({ type: "providerConnected", requestId, providerID: id, canonical: true, stamp: service.stamp })
      return
    }
    if (msg.type === "disconnectProvider") {
      const prior = providers[id]
      const provider: Record<string, unknown> = prior ? { ...prior } : (undefined as unknown as Record<string, unknown>)
      if (provider) delete provider.credential
      const next = provider ? { ...providers, [id]: provider as CanonicalProviderPayload } : providers
      const result = await service.writeConfig(scope, { provider: next }, expected ?? "absent")
      if (!result.ok) return fail(result.message, result.kind)
      const cleanup = await service.cleanupProviderCredential(
        scope,
        id,
        prior ? { ...prior } : undefined,
        service.stamp,
      )
      if (!cleanup.ok)
        return fail(
          cleanup.message,
          cleanup.retry ? "cleanupRetry" : "cleanup",
          cleanup.retry
            ? {
                scope,
                stamp: cleanup.stamp,
                mode: cleanup.mode,
                ref: cleanup.ref,
                priorRecord: cleanup.priorRecord,
                priorValue: cleanup.priorValue,
              }
            : undefined,
        )
      this.postMessage({
        type: "providerDisconnected",
        requestId,
        providerID: id,
        canonical: true,
        stamp: service.stamp,
      })
      return
    }
    if (msg.type === "deleteCustomProvider") {
      const prior = providers[id]
      delete providers[id]
      const result = await service.writeConfig(scope, { provider: providers }, expected ?? "absent")
      if (!result.ok) return fail(result.message, result.kind)
      const cleanup = await service.cleanupProviderCredential(
        scope,
        id,
        prior ? { ...prior } : undefined,
        service.stamp,
      )
      if (!cleanup.ok)
        return fail(
          cleanup.message,
          cleanup.retry ? "cleanupRetry" : "cleanup",
          cleanup.retry
            ? {
                scope,
                stamp: cleanup.stamp,
                mode: cleanup.mode,
                ref: cleanup.ref,
                priorRecord: cleanup.priorRecord,
                priorValue: cleanup.priorValue,
              }
            : undefined,
        )
      this.postMessage({ type: "providerDeleted", requestId, providerID: id, canonical: true, stamp: service.stamp })
      return
    }
    const raw = msg.config
    if (msg.canonical !== true || Object.keys(msg).some((key) => CREDENTIAL_KEY.test(key)))
      return fail("Canonical provider requests must not contain credential-bearing fields", "invalid")
    if (!isValidCanonicalProviderEntry(raw, id))
      return fail("Canonical provider payload failed shared schema validation", "invalid")
    // Canonical-only serialization: emit name/endpoint/protocol/models.
    // Never reuse legacy {npm, env, options:{baseURL,headers}, models} shape.
    // ID is the map key — never injected into the persisted record (LOCK-002).
    const canonical: Record<string, unknown> = {
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      ...(typeof raw.endpoint === "string" ? { endpoint: raw.endpoint } : {}),
      ...(typeof raw.protocol === "string" ? { protocol: raw.protocol } : {}),
      ...(isRecord(raw.models) ? { models: raw.models } : {}),
    }
    const changed = msg.canonical === true && msg.credentialRequested === true
    const key = changed
      ? (
          await vscode.window.showInputBox({
            password: true,
            prompt: `Enter credential for ${id}`,
            ignoreFocusOut: true,
          })
        )?.trim() || undefined
      : undefined
    if (changed && !key) return fail("Credential entry was cancelled or empty", "cancelled")
    const existingEntry = isRecord(providers[id]) && narrowProviderEntry(providers[id])
    const existing: Record<string, unknown> = existingEntry ? { ...existingEntry } : {}
    const existingPriorRef = typeof existing.credential === "string" ? existing.credential : undefined
    const provider = {
      ...canonical,
      ...(key && changed
        ? { credential: ref }
        : existing.credential && !changed
          ? { credential: existing.credential }
          : {}),
    }
    const result =
      key && changed
        ? await service.processCredentialIntent(
            scope,
            "provider",
            id,
            key,
            { provider: { ...providers, [id]: provider } },
            expected ?? "absent",
            stamp,
            existingPriorRef,
          )
        : await service.writeConfig(scope, { provider: { ...providers, [id]: provider } }, expected ?? "absent")
    if (!result.ok) return fail(result.message, result.kind)
    // credentialRequested=false preserves the existing opaque reference; explicit
    // removal is a separate disconnectProvider operation.
    this.postMessage({ type: "providerConnected", requestId, providerID: id, canonical: true, stamp: service.stamp })
  }

  /**
   * Build a stable target reservation key from the validated retry record.
   * Two records with the same (kind, scope, id, ref) produce the same key,
   * preventing concurrent side effects for the same credential target.
   */
  private cleanupTargetKey(kind: "provider" | "mcp", scope: string, id: string, ref?: string): string {
    return `${kind}|${scope}|${id}|${ref ?? ""}`
  }

  private async retryCanonicalProviderCleanup(msg: Record<string, unknown>): Promise<void> {
    const retryID = typeof msg.retryID === "string" ? msg.retryID : ""
    const requestId = typeof msg.requestId === "string" ? msg.requestId : ""
    const service = this.canonicalConfig
    if (!service || !retryID || !requestId) return
    // Host-owned record is the authority — look up by opaque retryID only.
    const retry = this.cleanupRetries.get(retryID)
    const action = "disconnect"
    if (
      !service ||
      !this.canonicalReady ||
      !retry ||
      retry.kind !== "provider" ||
      retry.state !== "available" ||
      !sameStamp(retry.stamp, service.stamp)
    ) {
      this.postMessage({
        type: "providerActionError",
        requestId,
        providerID: retry?.id ?? "",
        action,
        message: "Provider cleanup retry is stale",
        canonical: true,
        kind: "stale",
        stamp: service.stamp,
      })
      return
    }
    // Reject mismatch/replay: the stored record's scope/mode/id are the exact
    // operation identity; the request carries no authority refs to compare.
    const scope = retry.scope
    const mode = retry.mode
    const id = retry.id
    // The stored ref must be an exact owned provider ref for scope+id when present.
    const ref = retry.ref
    if (ref) {
      const parsed = parseSecretKey(ref.slice("secret:".length))
      if (!parsed || parsed.kind !== "provider" || parsed.id !== id || parsed.scope !== scope) {
        this.postMessage({
          type: "providerActionError",
          requestId,
          providerID: id,
          action,
          message: "Provider cleanup retry has invalid stored record",
          canonical: true,
          kind: "stale",
          stamp: service.stamp,
        })
        return
      }
    }
    // Delete-mode cleanup needs the exact validated stored ref. Without one
    // there is nothing verifiably owned to remove — never reconstruct a key
    // from scope/id.
    if (mode !== "restore" && !ref) {
      this.postMessage({
        type: "providerActionError",
        requestId,
        providerID: id,
        action,
        message: "Provider cleanup retry record has no credential ref",
        canonical: true,
        kind: "stale",
        stamp: service.stamp,
      })
      return
    }
    // P4.1 target-level reservation: a concurrent distinct retry with the same
    // validated (kind, scope, id, ref) target must not side-effect twice.
    const targetKey = this.cleanupTargetKey("provider", scope, id, ref)
    const owner = this.cleanupTargets.get(targetKey)
    if (owner && owner !== retryID) {
      this.postMessage({
        type: "providerActionError",
        requestId,
        providerID: id,
        action,
        message: "Provider cleanup retry target is already in flight",
        canonical: true,
        kind: "stale",
        stamp: service.stamp,
      })
      return
    }
    // Reserve atomically BEFORE any side effect: a concurrent duplicate retry
    // sees inFlight/absent and cannot side-effect twice.
    this.cleanupRetries.set(retryID, { ...retry, state: "inFlight" })
    this.cleanupTargets.set(targetKey, retryID)
    try {
      if (mode === "restore" && retry.priorRecord) {
        if (retry.priorValue !== undefined && retry.ref) await service.restoreSecret(retry.ref, retry.priorValue)
        const restored = await service.writeConfig(
          scope,
          {
            provider: {
              ...(parseCanonicalProviderRecord(service.getScopeConfig(scope).provider) ?? {}),
              [id]: retry.priorRecord,
            },
          },
          service.getConfigHash(scope) ?? "absent",
        )
        if (!restored.ok) {
          if (retry.ref) await service.removeSecretRef(retry.ref)
          throw new Error(restored.message)
        }
      } else {
        await service.removeSecretRef(ref!)
      }
      // Success: consume the record and release the target reservation — one-shot.
      this.cleanupRetries.delete(retryID)
      this.cleanupTargets.delete(targetKey)
      this.postMessage({
        type: "providerDisconnected",
        requestId,
        providerID: id,
        canonical: true,
        stamp: service.stamp,
      })
    } catch (err) {
      // Lossless restoration: restore the exact full record unchanged so the
      // operation can be retried later. Never reconstruct from webview fields.
      // Release the target reservation so a distinct retry ID can retry.
      this.cleanupRetries.set(retryID, { ...retry, state: "available" })
      this.cleanupTargets.delete(targetKey)
      this.postMessage({
        type: "providerActionError",
        requestId,
        providerID: id,
        action,
        message: `Credential cleanup retry failed: ${String(err)}`,
        canonical: true,
        kind: "cleanupRetry",
        stamp: service.stamp,
        retry: { type: "retryProviderCleanup", mode, scope, stamp: service.stamp, retryID },
      })
    }
  }

  private async handleCanonicalConfigUpdate(
    partial: CanonicalConfigPayload,
    project: CanonicalConfigPayload,
    globalUnset: string[][],
    projectUnset: string[][],
    saveID: string | undefined,
    stamp: CanonicalStamp,
  ): Promise<void> {
    const service = this.canonicalConfig
    if (!service || !this.canonicalReady) {
      this.postMessage({
        type: "configUpdateFailed",
        message: "Canonical config authority is not ready",
        kind: "not-ready",
        saveID,
        canonical: true,
        stamp: {
          ...(service?.stamp ?? { globalHash: null, projectHash: null, materializationVersion: 0, assetHash: null }),
          assetHash: null,
        },
      })
      return
    }
    if (!stamp || stamp.assetHash !== null || !sameStamp(stamp, { ...service.stamp, assetHash: null })) {
      this.postMessage({
        type: "configUpdateFailed",
        message: "Canonical config stamp is required",
        kind: "stale",
        saveID,
        canonical: true,
        stamp: { ...service.stamp, assetHash: null },
      })
      return
    }
    // Meta keys ($schema) are backend-owned validation metadata: excluded
    // from GUI write patches and never unsettable from the webview.
    const clean = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => isGuiField(key)))
    const unset = (value: Record<string, unknown>, paths: string[][]) => {
      for (const path of paths) if (path.length === 1 && isGuiField(path[0])) value[path[0]!] = undefined
      return value
    }
    const global = unset(clean({ ...partial }), globalUnset)
    const projectPatch = unset(clean({ ...project }), projectUnset)
    const scopes = {
      ...(Object.keys(global).length ? { global: { patch: global, expectedHash: stamp.globalHash ?? "absent" } } : {}),
      ...(Object.keys(projectPatch).length
        ? { project: { patch: projectPatch, expectedHash: stamp.projectHash ?? "absent" } }
        : {}),
    }
    const result = await service.writeConfigScopes(scopes, stamp)
    if (!result.ok) {
      this.postMessage({
        type: "configUpdateFailed",
        message: result.message,
        kind: result.kind,
        saveID,
        canonical: true,
        stamp: { ...service.stamp, assetHash: null },
        contentHash: service.snapshot?.contentHash,
        materializationVersion: service.snapshot?.generation,
        validationErrors: result.errors?.map((error) => ({ path: error.path, message: error.message })),
      })
      return
    }
    this.sendCanonicalConfig("configUpdated")
    this.postMessage({
      type: "configUpdated",
      config: canonicalConfigPayload(result.snapshot.config.value),
      globalConfig: canonicalConfigPayload(service.getScopeConfig("global")),
      projectConfig: canonicalConfigPayload(service.getScopeConfig("project")),
      settings: { maxCost: this.maxCostSetting() },
      features: configFeatures(),
      canonical: true,
      saveID,
      contentHash: result.snapshot.contentHash,
      materializationVersion: result.materializationVersion,
      stamp: result.stamp,
    })
  }

  setRemoteService(service: RemoteStatusService): void {
    this.remoteService = service
    this.unsubscribeRemote = service.onChange(() => this.sendRemoteStatus())
  }

  setAutoApproveController(ctrl: Parameters<typeof createAutoApproveBridge>[0]): void {
    this.autoApproveBridge?.dispose()
    this.autoApproveBridge = createAutoApproveBridge(ctrl, (msg) => this.postMessage(msg), this.onBeforeMessage)
    this.onBeforeMessage = (msg) => this.autoApproveBridge!.handle(msg)
  }

  private setCurrentSession(session: SessionDetail | null): void {
    const ids = new Set([this.currentSession?.id, session?.id])
    for (const id of ids) {
      if (id) this.refreshes.set(id, (this.refreshes.get(id) ?? 0) + 1)
    }
    this.currentSession = session
    this.opts.tabTitle?.(nativeTitle(session))
  }

  private checkpoint(sid: string, run: () => Promise<void>): void {
    const prior = this.checkpoints.get(sid) ?? Promise.resolve()
    const pending = prior.catch(() => undefined).then(run)
    const cleanup = () => {
      if (this.checkpoints.get(sid) === pending) this.checkpoints.delete(sid)
    }
    this.checkpoints.set(sid, pending)
    void pending.then(cleanup, (error) => {
      console.error("[Kilo New] checkpoint mutation failed:", error)
      cleanup()
    })
  }

  private stopCurrentSessionProcesses(next?: string): void {
    const sid = this.contextSessionID ?? this.currentSession?.id
    if (!sid || sid === next) return
    const session = this.currentSession?.id === sid ? this.currentSession : undefined
    void stopSessionProcesses(this.client, sid, this.getSessionDirectory(sid, session))
  }

  private sendRemoteStatus(): void {
    const s = this.remoteService?.getState()
    if (s) this.postMessage({ type: "remoteStatus", enabled: s.enabled, connected: s.connected })
  }
  private focusSession(id?: string): void {
    this.streams.focus(id)
    this.registerPresence()
  }

  private nextDetailLoad(): number {
    this.detailGeneration += 1
    return this.detailGeneration
  }

  private isCurrentDetailLoad(generation: number, target: string, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false
    if (generation !== this.detailGeneration) return false
    if (this.contextSessionID !== target) return false
    return true
  }

  private invalidateDetailLoads(): void {
    this.detailGeneration += 1
  }

  private clearSessionState(): void {
    this.invalidateDetailLoads()
    this.loadMessagesAbort?.abort()
    this.stopCurrentSessionProcesses()
    this.contextSessionID = undefined
    this.setCurrentSession(null)
    this.focusSession()
  }

  /**
   * Report presence for this provider: the focused Agent Manager session is
   * visible and attached. Agent Manager is the sole chat surface (LOCK-002).
   */
  private registerPresence(): void {
    if (this.opts.disableViewedRegistration) return
    const focused = this.streams.focused
    this.connectionService.registerVisible(this.instanceId, focused ? [focused] : [])
    const attached = new Set<string>()
    if (focused) attached.add(focused)
    this.connectionService.registerAttached(this.instanceId, [...attached])
  }

  public setStreamVisibility(active: boolean): void {
    this.visibleTaskStreams.setActive(active)
  }

  public setProjectDirectory(directory: string | null): void {
    if (this.projectDirectory === directory) return
    this.projectDirectory = directory
    this.postMessage({ type: "workspaceDirectoryChanged", directory: directory ?? "" })
    this.requirements.clear()
  }

  getTelemetryProperties(): Record<string, unknown> {
    return {
      appName: "kilo-code",
      appVersion: this.extensionVersion,
      platform: "vscode",
      editorName: vscode.env.appName,
      vscodeVersion: vscode.version,
      machineId: vscode.env.machineId,
      vscodeIsTelemetryEnabled: vscode.env.isTelemetryEnabled,
    }
  }

  /**
   * Convenience getter that returns the shared SDK KiloClient or null if not yet connected.
   * Preserves the existing null-check pattern used throughout handler methods.
   */
  private get client(): KiloClient | null {
    try {
      return this.connectionService.getClient()
    } catch (err) {
      console.warn("[KiloProvider] getClient failed:", err instanceof Error ? err.message : String(err))
      return null
    }
  }

  private postConnectionState(error = this.connectionService.getConnectionError()): void {
    this.postMessage({
      type: "connectionState",
      state: this.connectionState,
      ...(this.connectionState === "error" && {
        error: getErrorMessage(error) || "Connection to CLI backend lost. Retry to reconnect.",
      }),
    })
  }

  private openMarketplacePanel(directory: unknown): void {
    if (typeof directory === "string" && directory) {
      vscode.commands.executeCommand("kilo-code.new.marketplaceButtonClicked", directory)
      return
    }
    vscode.commands.executeCommand("kilo-code.new.marketplaceButtonClicked", this.projectDirectory)
  }

  // Strip metadata unused by the webview to keep session switches fast.
  // Logic in kilo-provider/slim-metadata.ts.
  private slimInfo<T>(info: T): T {
    if (!this.slimEditMetadata) return info
    return slimInfo(info)
  }

  private slimPart<T>(part: T): T {
    if (!this.slimEditMetadata) return part
    return slimPart(part)
  }

  private slimParts<T>(parts: T[]) {
    if (!this.slimEditMetadata) return parts
    return slimParts(parts)
  }

  private get forkCtx() {
    return {
      connection: this.connectionService,
      post: (msg: { type: "error"; message: string }) => this.postMessage(msg),
      register: (session: Session) => this.registerSession(session),
      forked: (session: Session, sourceID: string) =>
        this.postMessage({ type: "sessionForked", sessionID: session.id, forkedFromID: sourceID }),
      status: (sessionID: string) => this.sessionStatusMap.get(sessionID),
      directory: (sessionID: string) => this.getWorkspaceDirectory(sessionID),
    }
  }

  private get removeConfigItemCtx() {
    return {
      connection: this.connectionService,
      project: () => this.getProjectDirectory(this.currentSession?.id),
      directory: () => this.getWorkspaceDirectory(),
      remove: this.marketplaceRemove,
      refresh: async () => {
        this.cachedAgentsMessage = null
        this.cachedConfigMessage = null
        await Promise.all([this.fetchAndSendAgents(), this.fetchAndSendConfig()])
        this.requirements.clear()
      },
      storage: this.extensionContext?.globalStorageUri,
    }
  }

  private async syncWebviewState(reason: string): Promise<void> {
    const serverInfo = this.connectionService.getServerInfo()
    console.log("[Kilo New] KiloProvider: 🔄 syncWebviewState()", {
      reason,
      isWebviewReady: this.isWebviewReady,
      connectionState: this.connectionState,
      hasClient: !!this.client,
      hasServerInfo: !!serverInfo,
    })

    if (!this.isWebviewReady) {
      console.log("[Kilo New] KiloProvider: ⏭️ syncWebviewState skipped (webview not ready)")
      return
    }

    // Always push connection state first so the UI can render appropriately.
    this.postConnectionState()
    pushTelemetryState((m) => this.postMessage(m))

    // Re-send ready so the webview can recover after refresh.
    if (serverInfo) {
      const langConfig = vscode.workspace.getConfiguration("kilo-code.new")
      this.postMessage({
        type: "ready",
        serverInfo,
        extensionVersion: this.extensionVersion,
        vscodeLanguage: vscode.env.language,
        languageOverride: langConfig.get<string>("language"),
        workspaceDirectory: this.getProjectDirectory(this.currentSession?.id),
      })
    }

    // Always attempt to fetch+push profile when connected.
    // Profile returns 401 when user isn't logged into Kilo Gateway — that's expected.
    // Use fire-and-forget (no throwOnError) to match old getProfile() which returned null on error.
    if (this.connectionState === "connected" && this.client) {
      console.log("[Kilo New] KiloProvider: 👤 syncWebviewState fetching profile...")
      const profileResult = await retry(() => this.client!.kilo.profile())
      const profileData = profileResult.data ?? null
      console.log("[Kilo New] KiloProvider: 👤 syncWebviewState profile:", profileData ? "received" : "null")
      this.postMessage({
        type: "profileData",
        data: profileData,
      })

      if (this.currentSession) {
        this.refreshSessionDetails(this.currentSession.id, this.getWorkspaceDirectory(this.currentSession.id))
      }

      // Re-send cached git status after webview reload.
      this.postMessage({ type: "gitStatus", repo: this.cachedGitRepo })

      // Seed session status map so the Settings panel knows about already-running sessions.
      // Must run after webview is ready (postMessage is a no-op before that).
      // Only reconcile (reset missing busy→idle) when the map is empty, i.e.
      // on the very first seed before any real-time SSE events have arrived.
      // On SSE reconnects or webview recreations the live SSE data is
      // authoritative and reconciliation risks race-resetting busy sessions.
      const reconcile = this.sessionStatusMap.size === 0
      void this.seedSessionStatusMap(reconcile)

      this.sendRemoteStatus()
    }
  }

  /** Resolve a WebviewPanel for displaying Kilo in an editor tab. */
  public resolveWebviewPanel(panel: vscode.WebviewPanel): void {
    // WebviewPanel can be restored/reloaded; ensure we don't treat it as ready prematurely.
    this.isWebviewReady = false
    this.webview = panel.webview

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }

    panel.webview.html = this._getHtmlForWebview(panel.webview)

    this.setupWebviewMessageHandler(panel.webview)
    this.viewStateDisposable?.dispose()
    this.viewStateDisposable = this.visibleTaskStreams.bindPanel(panel, () => {
      if (this.opts.disableViewedRegistration) return
      const id = this.contextSessionID
      this.streams.focus(panel.visible ? id : undefined)
      this.connectionService.registerVisible(this.instanceId, panel.visible && id ? [id] : [])
    })
    this.initializeConnection()
  }

  /** Register a session created externally and notify the webview. */
  public registerSession(session: SessionDetail | Session): void {
    const detail = (session as SessionDetail).createdAt !== undefined ? (session as SessionDetail) : sdkSessionToDetail(session as Session)
    this.stopCurrentSessionProcesses(detail.id)
    this.setCurrentSession(detail)
    this.contextSessionID = detail.id
    this.trackedSessionIds.add(detail.id)
    this.postMessage({
      type: "sessionCreated",
      session: this.sessionToWebview(detail),
    })
  }

  /** Add a session ID to the tracked set without changing currentSession. */
  public trackSession(sessionId: string): void {
    this.trackedSessionIds.add(sessionId)
  }

  public loadMessages(sessionID: string): Promise<void> {
    // Sub-agent viewers share the normal paginated transcript and preserve
    // live deltas that arrive while the initial page is loading.
    return this.handleLoadMessages(sessionID, { preserveStream: true })
  }

  public async loadMessagesStrict(sessionID: string, info?: SessionDetail | Session): Promise<boolean> {
    const detail = info ? ((info as SessionDetail).createdAt !== undefined ? (info as SessionDetail) : sdkSessionToDetail(info as Session)) : undefined
    return this.doLoadMessages(sessionID, { preserveStream: true }, true, detail)
  }

  /** Exposes the session→directory map so callers outside the webview can resolve session directories. */
  public getSessionDirectories(): ReadonlyMap<string, string> {
    return this.sessionDirectories
  }

  public onCatalog(cb: (update: { ids: string[]; append?: boolean; hasMore?: boolean }) => void): { dispose(): void } {
    this.catalogCbs.push(cb)
    return {
      dispose: () => {
        const i = this.catalogCbs.indexOf(cb)
        if (i >= 0) this.catalogCbs.splice(i, 1)
      },
    }
  }

  private notifyCatalog(update: { ids: string[]; append?: boolean; hasMore?: boolean }): void {
    for (const cb of [...this.catalogCbs]) {
      try {
        cb(update)
      } catch (e) {
        console.warn("[Kilo New] catalog cb failed", e)
      }
    }
  }

  /** Optional session detail lookup (private-first, narrow detail). */
  public async getSessionInfo(sessionId: string): Promise<SessionDetail | undefined> {
    await this.initializeConnection()
    const directory = this.getWorkspaceDirectory(sessionId)
    try {
      return await this.getSessionDetail(sessionId, directory)
    } catch (e) {
      if (e instanceof SessionNotFoundError || e instanceof SessionScopeMismatchError) return undefined
      console.warn("[Kilo New] KiloProvider: Failed to resolve managed session:", e)
      return undefined
    }
  }

  /** Return the currently active session ID, if any. */
  public getCurrentSessionId(): string | undefined {
    return this.currentSession?.id ?? undefined
  }

  /** Posts a webview activation for an already-loaded session without refetching. */
  public activateSession(sessionID: string): void {
    this.postMessage({ type: "activateSession", sessionID } as unknown as Record<string, unknown>)
  }

  /**
   * Re-fetch and send the full session list to the webview.
   *
   * Any deferred refresh (requested before the client was ready) is flushed
   * first through the serialized load chain, so the load enqueued by THIS
   * call is always the last one applied. Resolves once it has been applied,
   * letting the env-gated E2E fixture deterministically re-seed after the
   * real backend list has landed.
   */
  public refreshSessions(): Promise<void> {
    return this.enqueueSessionLoad(async () => {
      if (this.pendingSessionRefresh) {
        await this.runFlushPendingSessionRefresh("refreshSessions")
      }
      await this.runLoadSessions()
    })
  }

  /** Register a listener invoked when a plan follow-up session is adopted. */
  public onFollowupAdopted(cb: (session: SessionDetail | Session, directory: string) => void): void {
    this.followupListeners.push(cb as unknown as (session: SessionDetail | Session, directory: string) => void)
  }

  /** Recover permission/question prompts after sessions and directories are tracked. */
  public recoverPendingPrompts(): void {
    this.promptRecoveryQueued = true
    if (!this.isWebviewReady) return
    if (!this.client) return
    if (this.promptRecovery) return

    this.promptRecovery = this.flushPendingPrompts().finally(() => {
      this.promptRecovery = null
      if (this.promptRecoveryQueued && this.isWebviewReady && this.client) this.recoverPendingPrompts()
    })
  }

  private async flushPendingPrompts(): Promise<void> {
    while (this.promptRecoveryQueued && this.isWebviewReady) {
      if (!this.client) return
      this.promptRecoveryQueued = false
      await Promise.all([
        fetchAndSendPendingPermissions(this.permissionCtx),
        fetchAndSendPendingQuestions(this.questionCtx),
        fetchAndSendPendingSuggestions(this.questionCtx),
      ])
    }
  }

  public selectKiloModel(modelID?: string, agent?: string): void {
    // Canonical mode rejects every direct selectKiloModel path — before
    // readiness (empty/not-ready, never Kilo/KILO_AUTO) and after readiness
    // (only canonical provider catalog can select).
    if (this.canonicalConfig) return
    if (!modelID && !agent) return
    this.pendingKiloModel = { ...(modelID && { modelID }), ...(agent && { agent }) }
    this.flushPendingKiloModel()
  }

  public attachToWebview(
    webview: vscode.Webview,
    options?: { onBeforeMessage?: (msg: Record<string, unknown>) => Promise<Record<string, unknown> | null> },
  ): void {
    this.isWebviewReady = false
    this.webview = webview
    if (!this.autoApproveBridge) this.onBeforeMessage = options?.onBeforeMessage ?? null
    this.setupWebviewMessageHandler(webview)
    this.initializeConnection()
  }

  private setupWebviewMessageHandler(webview: vscode.Webview): void {
    this.webviewMessageDisposable?.dispose()
    this.telemetryStateDisposable?.dispose()
    this.telemetryStateDisposable = watchTelemetryState((msg) => this.postMessage(msg))
    this.webviewMessageDisposable = webview.onDidReceiveMessage(async (message) => {
      const intercepted = await interceptMessage(message, {
        workspaceDir: (sid) => this.getWorkspaceDirectory(sid ?? this.currentSession?.id),
        post: (m) => this.postMessage(m),
        error: getErrorMessage,
        before: this.onBeforeMessage,
      })
      if (intercepted === null) return
      message = intercepted

      if (
        await routeEarlyMessage(message, {
          question: this.questionCtx,
          client: this.client,
          connection: this.connectionService,
          dir: this.getWorkspaceDirectory(this.currentSession?.id),
          post: (msg) => this.postMessage(msg),
          exportTranscript: (sessionID) => this.handleExportSessionTranscript(sessionID),
          variantCache: this.variantCache(),
          canonicalMode: this.canonicalMode,
        })
      ) {
        return
      }
      if (this.handleEditorOpenMessage(message)) return
      if (
        await handleWorkStyleMessage({
          message,
          connection: this.connectionService,
          directory: this.getWorkspaceDirectory(this.currentSession?.id),
          post: (msg) => this.postMessage(msg),
        })
      )
        return
      if (await this.handleModelSelectorExpandedMessage(message)) return
      this.visibleTaskStreams.handle(message)
      switch (message.type) {
        case "webviewReady":
          console.log("[Kilo New] KiloProvider: ✅ webviewReady received")
          p0Stage("webview.ready")
          this.isWebviewReady = true
          this.visibleTaskStreams.clear()
          this.flushPendingKiloModel()
          // P4.4-T22: publish canonical selectors immediately when canonical
          // materialization is ready, without waiting for initializeConnection
          // HTTP/SSE/generated-SDK connectivity or syncWebviewState.
          if (this.canonicalConfig) {
            this.sendCanonicalConfig("configLoaded")
            void this.sendCanonicalProviders()
            void this.sendCanonicalAgents()
          }
          await this.syncWebviewState("webviewReady")
          this.recoverPendingPrompts()
          this.readyResolvers.splice(0).forEach((r) => r())
          break
        case "sendMessage": {
          const msg = message as typeof message & ContextMessage
          await this.handleSendMessage(
            message.text,
            typeof message.messageID === "string" ? message.messageID : undefined,
            message.sessionID,
            typeof message.draftID === "string" ? message.draftID : undefined,
            message.providerID,
            message.modelID,
            message.agent,
            message.variant,
            parseMessageFiles(message.files),
            parseReview(message.review, message.text),
            typeof message.agentManagerContext === "string" ? message.agentManagerContext : undefined,
            typeof msg.contextDirectory === "string" ? msg.contextDirectory : undefined,
          )
          break
        }
        case "sendCommand": {
          const msg = message as typeof message & ContextMessage
          await this.handleSendCommand(
            message.command,
            message.arguments,
            typeof message.messageID === "string" ? message.messageID : undefined,
            message.sessionID,
            typeof message.draftID === "string" ? message.draftID : undefined,
            message.providerID,
            message.modelID,
            message.agent,
            message.variant,
            parseMessageFiles(message.files),
            typeof message.agentManagerContext === "string" ? message.agentManagerContext : undefined,
            typeof msg.contextDirectory === "string" ? msg.contextDirectory : undefined,
          )
          break
        }
        case "abort":
          this.cancelRetry(message.sessionID ?? "")
          await this.handleAbort(message.sessionID)
          break
        case "revertSession":
          this.checkpoint(message.sessionID, () =>
            this.handleRevertSession(message.sessionID, message.messageID, message.partID),
          )
          break
        case "unrevertSession":
          this.checkpoint(message.sessionID, () => this.handleUnrevertSession(message.sessionID))
          break
        case "cancelQueued":
          await this.handleCancelQueued(message.sessionID, message.messageID)
          break
        case "permissionResponse":
          await handlePermissionResponse(
            this.permissionCtx,
            message.permissionId,
            message.sessionID,
            message.response,
            message.approvedAlways,
            message.deniedAlways,
          )
          break
        case "createSession":
          await this.handleCreateSession()
          break
        case "clearSession":
          this.clearSessionState()
          break
        case "loadMessages":
          // Don't await: allow parallel loads so rapid session switching
          // isn't blocked by slow responses for earlier sessions.
          void this.handleLoadMessages(message.sessionID, {
            mode: message.mode,
            before: message.before,
            limit: message.limit,
          })
          break
        case "syncSession":
          this.handleSyncSession(message.sessionID, message.parentSessionID).catch((e) =>
            console.error("[Kilo New] handleSyncSession failed:", e),
          )
          break
        case "loadSessions":
          this.handleLoadSessions(message.cursor).catch((e) =>
            console.error("[Kilo New] handleLoadSessions failed:", e),
          )
          break
        case "requestSessionModelUsage":
          void this.fetchAndSendSessionModelUsage(message.sessionID, message.requestID)
          break
        case "login": {
          const attempt = ++this.loginAttempt
          await handleLogin(this.authCtx, attempt, () => this.loginAttempt)
          break
        }
        case "cancelLogin":
          this.loginAttempt++
          this.postMessage({ type: "deviceAuthCancelled" })
          break
        case "logout":
          await handleLogout(this.authCtx)
          break
        case "setOrganization":
          if (typeof message.organizationId === "string" || message.organizationId === null) {
            await handleSetOrganization(this.authCtx, message.organizationId)
          }
          break
        case "refreshProfile":
          await handleRefreshProfile(this.authCtx)
          break
        case "openSettingsPanel":
          vscode.commands.executeCommand("kilo-code.new.settingsButtonClicked", message.tab)
          break
        case "openProfilePanel":
          vscode.commands.executeCommand("kilo-code.new.profileButtonClicked")
          break
        case "openVSCodeSettings":
          vscode.commands.executeCommand("workbench.action.openSettings", message.query)
          break
        case "openConfigFile":
          await openConfig(message.scope, message.labels, this.getProjectDirectory(this.currentSession?.id))
          break
        case "openMarketplacePanel":
          this.openMarketplacePanel(message.directory)
          break
        case "forkSession":
          handleForkSession(this.forkCtx, message.sessionId, message.messageId).catch((e) =>
            console.error("[Kilo New] handleForkSession failed:", e),
          )
          break
        case "retryConnection":
          console.log("[Kilo New] KiloProvider: 🔄 Retrying connection...")
          this.initializeConnection().catch((e) =>
            console.error("[Kilo New] KiloProvider: ❌ Retry connection failed:", e),
          )
          break
        case "reload":
          this.handleReload().catch((e) => console.error("[Kilo New] KiloProvider: Reload failed:", e))
          break
        case "saveImage":
          return saveImage(this.getWorkspaceDirectory(this.currentSession?.id), message)
        case "requestProviders":
          this.fetchAndSendProviders().catch((e) => console.error("[Kilo New] fetchAndSendProviders failed:", e))
          break
        case "connectProvider":
        case "authorizeProviderOAuth":
        case "completeProviderOAuth":
        case "disconnectProvider":
        case "deleteCustomProvider":
        case "saveCustomProvider":
          await this.handleProviderAction(message)
          break
        case "retryProviderCleanup":
          await this.retryCanonicalProviderCleanup(message)
          break
        case "retryMcpCleanup":
          await this.retryCanonicalMcpCleanup(message)
          break
        case "anacondaDesktopStatus":
        case "anacondaDesktopOpen":
        case "anacondaDesktopSync":
        case "cancelAnacondaDesktopRequest":
          await this.anacondaDesktop.handle(message, {
            client: this.client,
            directory: this.getWorkspaceDirectory(),
            post: (reply) => this.postMessage(reply),
            refresh: () => this.fetchAndSendProviders(),
            error: getErrorMessage,
          })
          break
        case "getProviderCredential":
          this.handleGetProviderCredential(message).catch((e) =>
            console.error("[Kilo New] getProviderCredential failed:", e),
          )
          break
        case "fetchCustomProviderModels":
          this.handleFetchCustomProviderModels(message).catch((e) =>
            console.error("[Kilo New] fetchCustomProviderModels failed:", e),
          )
          break
        case "requestAgents":
          this.fetchAndSendAgents().catch((e) => console.error("[Kilo New] fetchAndSendAgents failed:", e))
          break
        case "requestSkills":
          this.fetchAndSendSkills().catch((e) => console.error("[Kilo New] fetchAndSendSkills failed:", e))
          break
        case "requestAgentRequirements":
          this.requirements
            .fetch({
              agent: message.agent,
              directory: message.directory,
              sessionID: message.sessionID,
              force: message.force === true,
            })
            .catch((e) => console.error("[Kilo New] fetchAndSendAgentRequirements failed:", e))
          break
        case "requestCommands":
          this.fetchAndSendCommands().catch((e) => console.error("[Kilo New] fetchAndSendCommands failed:", e))
          break
        case "removeSkill":
          this.removeSkillViaCli(message.location).catch((e: unknown) =>
            console.error("[Kilo New] removeSkill failed:", e),
          )
          break
        case "removeAgent": {
          // P4.1: canonical agent mutations require the canonical discriminator
          if (this.canonicalConfig && message.canonical !== true) {
            this.postMessage({
              type: "agentMutationError",
              requestId: typeof message.requestId === "string" ? message.requestId : crypto.randomUUID(),
              name: typeof message.name === "string" ? message.name : "",
              message: "Canonical agent mutation is missing the canonical discriminator",
              kind: "invalid",
              canonical: true,
              stamp: this.canonicalConfig.stamp,
            })
            break
          }
          this.handleRemoveAgent(
            message.name,
            message.scope,
            message.expectedHash,
            message.canonical ? message.stamp : undefined,
          ).catch((e) => console.error("[Kilo New] handleRemoveAgent failed:", e))
          break
        }
        case "mutateAgent": {
          // P4.1: canonical agent mutations require the canonical discriminator
          if (this.canonicalConfig && message.canonical !== true) {
            this.postMessage({
              type: "agentMutationError",
              requestId: typeof message.requestId === "string" ? message.requestId : crypto.randomUUID(),
              name: typeof message.name === "string" ? message.name : "",
              message: "Canonical agent mutation is missing the canonical discriminator",
              kind: "invalid",
              canonical: true,
              stamp: this.canonicalConfig.stamp,
            })
            break
          }
          this.handleCanonicalAgentMutation(message).catch((e) => console.error("[Kilo New] mutateAgent failed:", e))
          break
        }
        case "removeMcp":
          this.handleRemoveMcp(message.name, message).catch((e) =>
            console.error("[Kilo New] handleRemoveMcp failed:", e),
          )
          break
        case "requestMcpStatus":
          this.fetchAndSendMcpStatus().catch((e) => console.error("[Kilo New] fetchAndSendMcpStatus failed:", e))
          break
        case "connectMcp": {
          if (this.canonicalConfig) break
          const c1 = this.client
          if (c1) {
            void McpOAuth.connectMcpServer(c1, message.name, this.getWorkspaceDirectory(), () =>
              this.refreshMcpStatus(),
            ).catch((e) => console.error("[Kilo New] connectMcpServer failed:", e))
          }
          break
        }
        case "disconnectMcp": {
          if (this.canonicalConfig) break
          const c2 = this.client
          if (c2) {
            void McpOAuth.disconnectMcpServer(c2, message.name, this.getWorkspaceDirectory(), () =>
              this.refreshMcpStatus(),
            ).catch((e) => console.error("[Kilo New] disconnectMcpServer failed:", e))
          }
          break
        }
        case "authenticateMcp": {
          if (this.canonicalConfig) break
          const c = this.client
          if (c) {
            void McpOAuth.authenticateMcpServer(c, message.name, this.getWorkspaceDirectory(), () =>
              this.refreshMcpStatus(),
            ).catch((e) => console.error("[Kilo New] authenticateMcpServer failed:", e))
          }
          break
        }

        case "questionReply":
          this.noteFollowup(message.answers, message.sessionID)
          if (!(await handleQuestionReply(this.questionCtx, message.requestID, message.answers, message.sessionID))) {
            this.pendingFollowup = null
          }
          break
        case "questionReject":
          this.pendingFollowup = null
          await handleQuestionReject(this.questionCtx, message.requestID, message.sessionID)
          break
        case "sessionCostAlertResponse":
          await this.handleCostAlertResponse(message.sessionID, message.limit, message.response)
          break
        case "requestSandboxStatus":
          await this.fetchAndSendSandboxStatus(message.sessionID)
          break
        case "requestSandboxDefault":
          await this.fetchAndSendSandboxDefault(message.contextDirectory, message.requestID)
          break
        case "setSandboxDefault":
          await this.handleSetSandboxDefault(message.enabled, message.requestID, message.contextDirectory)
          break
        case "toggleSandbox":
          await this.handleToggleSandbox(message)
          break
        case "requestConfig":
          this.fetchAndSendConfig().catch((e) => console.error("[Kilo New] fetchAndSendConfig failed:", e))
          break
        case "requestGlobalConfig":
          this.fetchAndSendGlobalConfig().catch((e) => console.error("[Kilo New] fetchAndSendGlobalConfig failed:", e))
          break
        case "requestImageModels":
          this.fetchAndSendImageModels().catch((e) => console.error("[Kilo New] fetchAndSendImageModels failed:", e))
          break
        case "updateConfig":
          if (message.canonical === true) {
            if (!message.stamp) break
            await this.handleCanonicalConfigUpdate(
              message.config,
              message.projectConfig ?? {},
              message.globalUnset ?? [],
              message.projectUnset ?? [],
              message.saveID,
              message.stamp,
            )
          } else {
            await this.handleUpdateConfig(
              message.config,
              message.projectConfig,
              message.globalUnset,
              message.projectUnset,
              message.saveID,
            )
          }
          break
        case "setLanguage":
          await vscode.workspace
            .getConfiguration("kilo-code.new")
            .update("language", message.locale || undefined, vscode.ConfigurationTarget.Global)
          this.connectionService.notifyLanguageChanged(message.locale as string)
          break
        case "requestFileSearch":
          await handleFileSearch({
            client: this.client,
            message,
            current: this.currentSession?.id,
            context: this.contextSessionID,
            dir: (id) => this.getWorkspaceDirectory(id),
            open: (dir) => this.getOpenTabPaths(dir),
            post: (msg) => this.postMessage(msg),
            parity: this.connectionService,
          })
          break
        case "requestFilePicker":
          await handleFilePicker({ requestId: message.requestId, post: (msg) => this.postMessage(msg) })
          break
        case "requestTerminalContext":
          void this.handleTerminalContext(message.requestId)
          break
        case "toggleRemote":
        case "setRemoteEnabled":
        case "requestRemoteStatus":
          this.remoteService
            ?.handleMessage(message.type, message.enabled)
            .then((s) => {
              if (s) this.sendRemoteStatus()
            })
            .catch((err) => console.error("[Kilo New] remote message failed:", err))
          break
        case "deleteSession":
          await this.handleDeleteSession(message.sessionID)
          break
        case "renameSession":
          await this.handleRenameSession(message.sessionID, message.title)
          break
        case "updateSetting":
          await this.handleUpdateSetting(message.key, message.value)
          break
        case "requestBrowserSettings":
          this.sendBrowserSettings()
          break
        case "requestClaudeCompatSetting":
          this.sendClaudeCompatSetting()
          break
        case "requestNotificationSettings":
          this.sendNotificationSettings()
          break
        case "testNotification":
          previewSound(message.sound)
          break
        case "requestTimelineSetting":
          this.sendTimelineSetting()
          break
        case "resetAllSettings":
          await this.handleResetAllSettings()
          break
        case "telemetry":
          TelemetryProxy.capture(message.event, message.properties)
          break
        case "p0Perf":
          // Forward webview-recorded perf stages (opt-in KILO_P0_PERF only; the
          // webview never sends this when the flag is off).
          p0Webview(message.stage, message.t, message.wd)
          break
        case "persistRecents":
          await this.extensionContext?.globalState.update("recentModels", validateRecents(message.recents))
          break
        case "requestRecents": {
          const recents = validateRecents(this.extensionContext?.globalState.get("recentModels"))
          this.postMessage({ type: "recentsLoaded", recents })
          break
        }
        case "toggleFavorite": {
          await this.toggleFavorite(message)
          break
        }
        case "requestFavorites": {
          const favorites = validateFavorites(this.extensionContext?.globalState.get("favoriteModels"))
          this.postMessage({ type: "favoritesLoaded", favorites })
          break
        }
        case "enhancePrompt": {
          const sdkClient = this.client
          if (!sdkClient) {
            this.postMessage({
              type: "enhancePromptError",
              error: "Not connected to CLI backend",
              requestId: message.requestId,
            })
            break
          }
          void sdkClient.enhancePrompt
            .enhance({ text: message.text }, { throwOnError: true })
            .then(({ data }) => {
              this.postMessage({ type: "enhancePromptResult", text: data.text, requestId: message.requestId })
            })
            .catch((err: unknown) => {
              const raw = getErrorMessage(err) || "Failed to enhance prompt"
              const msg = normalizeEnhancePromptErrorMessage(raw)
              console.error("[Kilo New] KiloProvider: Failed to enhance prompt:", err)
              vscode.window.showErrorMessage(`Enhance prompt failed: ${msg}`)
              this.postMessage({
                type: "enhancePromptError",
                error: msg,
                requestId: message.requestId,
              })
            })
          break
        }
      }
    })
    this.webviewMessageDisposable = watchFontSizeConfig((msg) => this.postMessage(msg), this.webviewMessageDisposable)
    this.webviewMessageDisposable = watchWorkStyleConfig((msg) => this.postMessage(msg), this.webviewMessageDisposable)
  }

  private handleEditorOpenMessage(message: Parameters<typeof handleEditorAction>[0]): boolean {
    return handleEditorAction(message, {
      dir: () => this.getWorkspaceDirectory(this.currentSession?.id),
      storage: this.extensionContext?.globalStorageUri,
      post: (msg) => this.postMessage(msg),
    })
  }

  private async handleModelSelectorExpandedMessage(message: TypedWebviewMessage): Promise<boolean> {
    if (message.type === "persistModelSelectorExpanded") {
      if (typeof message.value !== "boolean") return true
      await this.extensionContext?.globalState.update("modelSelectorExpanded", message.value)
      this.connectionService.notifyModelSelectorExpandedChanged(message.value)
      return true
    }
    if (message.type === "requestModelSelectorExpanded") {
      const value = this.extensionContext?.globalState.get("modelSelectorExpanded", true) ?? true
      this.postMessage({ type: "modelSelectorExpandedLoaded", value })
      return true
    }
    return false
  }

  private async toggleFavorite(message: {
    action: "add" | "remove"
    providerID: string
    modelID: string
  }): Promise<void> {
    const current = validateFavorites(this.extensionContext?.globalState.get("favoriteModels"))
    const key = `${message.providerID}/${message.modelID}`
    const exists = current.some((f) => `${f.providerID}/${f.modelID}` === key)
    const favorites =
      message.action === "add" && !exists
        ? [...current, { providerID: message.providerID, modelID: message.modelID }]
        : message.action === "remove" && exists
          ? current.filter((f) => `${f.providerID}/${f.modelID}` !== key)
          : current
    await this.extensionContext?.globalState.update("favoriteModels", favorites)
    this.connectionService.notifyFavoritesChanged(favorites)
  }

  /**
   * Initialize connection to the CLI backend server.
   * Subscribes to the shared KiloConnectionService.
   */
  private initializeConnection(): Promise<void> {
    if (this.initConnectionPromise) {
      return this.initConnectionPromise
    }
    this.initConnectionPromise = this.doInitializeConnection().finally(() => {
      this.initConnectionPromise = null
    })
    return this.initConnectionPromise
  }

  private async doInitializeConnection(): Promise<void> {
    console.log("[Kilo New] KiloProvider: 🔧 Starting initializeConnection...")

    this.connectionState = "connecting"
    this.connectionGeneration++
    this.postMessage({ type: "connectionState", state: "connecting" })

    // Clean up any existing subscriptions (e.g., webview panel re-created)
    this.unsubscribeEvent?.()
    this.unsubscribeState?.()
    this.unsubscribeLanguageChange?.()
    this.unsubscribeProfileChange?.()
    this.unsubscribeFavoritesChange?.()
    this.unsubscribeModelSelectorExpanded?.()
    this.unsubscribeDirectoryProvider?.()
    this.unsubscribeConfigRevision?.()

    try {
      const workspaceDir = this.getWorkspaceDirectory()

      // Connect the shared service (no-op if already connected)
      await this.connectionService.connect(workspaceDir)
      this.flushPendingKiloModel()

      // Subscribe to SSE events for this webview (filtered by tracked sessions)
      this.unsubscribeEvent = this.connectionService.onEventFiltered(
        (payload, directory) => {
          const event = unwrapSyncEvent(payload)
          if (!event) return false

          // Remote status events are global and should always pass through
          if (event.type === "kilo-sessions.remote-status-changed") return true
          const sessionId = this.resolveEventSessionId(event)

          // message.part.* events are always session-scoped; drop if session unknown.
          if (!sessionId) return !isSessionScopedPartEvent(event.type)

          if (event.type === "session.created" && this.matchesPendingFollowup(event.properties.info)) {
            return true
          }

          // session.status must always pass through — even for sessions not tracked by this
          // KiloProvider instance. The Settings panel is a separate provider with no tracked
          // sessions, but it needs session.status to populate sessionStatusMap and allStatusMap
          // for the busy-session warning on Save.
          if (event.type === "session.status") return true

          // session.deleted must always pass through so the webview can run its cleanup
          // (messages, parts, stash, todos, permissions, drafts, etc.) — including for
          // sessions that were never explicitly tracked here (e.g. child sessions
          // cascade-deleted with the parent, or external CLI deletions). We deliberately
          // do NOT re-track the deleted id: handleLoadMessages intentionally drops late
          // responses for sessions that have been pruned, and re-tracking would let an
          // in-flight messagesLoaded response resurrect transcript state for a session
          // the webview just cleaned up.
          if (event.type === "session.deleted") return true

          return this.trackedSessionIds.has(sessionId)
        },
        (payload, directory) => {
          const event = unwrapSyncEvent(payload)
          if (event) this.handleEvent(event, directory)
        },
      )

      // Subscribe to connection state changes
      this.unsubscribeState = this.connectionService.onStateChange(async (state, error) => {
        if (this.connectionState !== state) this.connectionGeneration++
        this.connectionState = state
        this.postConnectionState(error)

        if (state === "connected") {
          this.flushPendingKiloModel()
          // Fire config warnings independently so a failure in the
          // sequential await chain doesn't prevent warnings from being shown
          void this.checkConfigWarnings("state")
          try {
            // Profile fetch is best-effort — returns 401 when user isn't logged into gateway.
            const sdkClient = this.client
            if (sdkClient) {
              const profileResult = await sdkClient.kilo.profile()
              this.postMessage({ type: "profileData", data: profileResult.data ?? null })
            }
            await this.syncWebviewState("sse-connected")
            await this.flushPendingSessionRefresh("sse-connected")
            this.recoverPendingPrompts()
          } catch (error) {
            console.error("[Kilo New] KiloProvider: ❌ Failed during connected state handling:", error)
            this.postMessage({
              type: "error",
              message: getErrorMessage(error) || "Failed to sync after connecting",
            })
          }
        }
      })

      // Subscribe to language change broadcast from other KiloProvider instances
      this.unsubscribeLanguageChange = this.connectionService.onLanguageChanged((locale) => {
        this.postMessage({ type: "languageChanged", locale })
      })

      // Subscribe to profile change broadcast from other KiloProvider instances
      this.unsubscribeProfileChange = this.connectionService.onProfileChanged((data) => {
        this.postMessage({ type: "profileData", data })
      })

      // Subscribe to favorites change broadcast from other KiloProvider instances
      this.unsubscribeFavoritesChange = this.connectionService.onFavoritesChanged((favorites) => {
        this.postMessage({ type: "favoritesLoaded", favorites })
      })

      // Subscribe to model-selector expand/collapse broadcast from other KiloProvider instances
      this.unsubscribeModelSelectorExpanded = this.connectionService.onModelSelectorExpandedChanged((value) => {
        this.postMessage({ type: "modelSelectorExpandedLoaded", value })
      })

      // Register this provider's directories so getKnownDirectories() covers all instances
      this.unsubscribeDirectoryProvider = this.connectionService.registerDirectoryProvider(() => {
        return [this.getWorkspaceDirectory(), ...this.sessionDirectories.values()]
      })

      // Subscribe to shared config revision advances — any local save or
      // foreign-window config change triggers a reconciliation (LOCK-005).
      this.unsubscribeConfigRevision = this.connectionService.onConfigRevision(() => this.queueReconcile())

      // Get current state and push to webview
      const serverInfo = this.connectionService.getServerInfo()
      this.connectionState = this.connectionService.getConnectionState()

      if (serverInfo) {
        const langConfig = vscode.workspace.getConfiguration("kilo-code.new")
        this.postMessage({
          type: "ready",
          serverInfo,
          extensionVersion: this.extensionVersion,
          vscodeLanguage: vscode.env.language,
          languageOverride: langConfig.get<string>("language"),
          fontSize: getWebviewFontSize(),
          workspaceDirectory: this.getProjectDirectory(this.currentSession?.id),
        })
      }
      this.postConnectionState()

      // connect() can resolve after SSE reaches "connected" but before this
      // provider subscribes to onStateChange(). In that case the initial
      // connected callback is missed, so run the warning check here too.
      if (this.connectionState === "connected") {
        void this.checkConfigWarnings("init")
      }

      await this.syncWebviewState("initializeConnection")
      await this.flushPendingSessionRefresh("initializeConnection")
      this.recoverPendingPrompts()

      // P4.4-T22: canonical provider/agent/config selectors publish via
      // CanonicalConfigService materialization (subscribeCanonical/onDidChange +
      // webviewReady immediate publish) independently of HTTP/SSE/generated-SDK
      // connectivity. HTTP/SSE/SDK fetch/reconcile remains as background.
      p0Stage("dataReady.start")
      if (this.canonicalConfig) {
        // Canonical selectors are handled via canonical materialization path;
        // reconcile them in background without blocking global data-ready.
        void Promise.all([
          this.fetchAndSendProviders().catch((e) =>
            console.error("[Kilo New] fetchAndSendProviders background failed:", e),
          ),
          this.fetchAndSendAgents().catch((e) => console.error("[Kilo New] fetchAndSendAgents background failed:", e)),
          this.fetchAndSendConfig().catch((e) => console.error("[Kilo New] fetchAndSendConfig background failed:", e)),
        ])
        await Promise.all([this.fetchAndSendSkills(), this.fetchAndSendCommands(), this.seedSessionStatusMap()])
      } else {
        await Promise.all([
          this.fetchAndSendProviders(),
          this.fetchAndSendAgents(),
          this.fetchAndSendSkills(),
          this.fetchAndSendCommands(),
          this.fetchAndSendConfig(),
          this.seedSessionStatusMap(),
        ])
      }
      this.cachedGitRepo = await hasGit(this.client!, this.getWorkspaceDirectory())
      this.postMessage({ type: "gitStatus", repo: this.cachedGitRepo })
      this.sendNotificationSettings()
      this.sendTimelineSetting()
      this.postMessage({ type: "extensionDataReady" })
      // P0 perf: the current global readiness gate (LOCK-012: P0 may measure
      // the current gate; LOCK-PERF-4 targets action-specific gates instead).
      p0Stage("dataReady.done")

      console.log("[Kilo New] KiloProvider: ✅ initializeConnection completed successfully")
    } catch (error) {
      console.error("[Kilo New] KiloProvider: ❌ Failed to initialize connection:", error)
      this.connectionState = "error"
      this.postMessage({
        type: "connectionState",
        state: "error",
        error: getErrorMessage(error) || "Failed to connect to CLI backend",
        ...(error instanceof ServerStartupError && {
          userMessage: error.userMessage,
          userDetails: error.userDetails,
        }),
      })
    }
  }

  private sessionToWebview(session: SessionDetail) {
    return detailToWebview(session)
  }

  /**
   * Centralized private-first single-session detail authority.
   * - Private valid `found` => authoritative detail, no SDK and no parity observer.
   * - Private `not_found`/`scope_mismatch` => authoritative terminal (bounded domain error), no SDK.
   * - Gate off/not started, malformed revalidation, JSON-RPC InternalError/MethodNotFound/transport/host-closed => bounded warning then SDK exactly once if client available.
   * - Never retry private, never init/reconnect, never cache private errors, never post private-specific error.
   * - Strict callers receive domain error for missing metadata so message load aborts; optional callers catch and return undefined / fail-closed.
   * - Signal is forwarded to SDK fallback only; private lacks signal but generation checks prevent stale writes.
   */
  private async getSessionDetail(sessionID: string, directory: string, signal?: AbortSignal): Promise<SessionDetail> {
    const reader = this.privateSessionReader
    const canUsePrivate = !!(reader && reader.isEnabled() && reader.isStarted())
    if (canUsePrivate) {
      try {
        const raw = await reader!.get({ directory, sessionId: sessionID })
        let result: import("./private-worker/observation").ObservationGetResult
        try {
          result = validatePrivateGetResult(raw, directory, sessionID)
        } catch (e) {
          console.warn("[Kilo Detail] private get malformed, falling back to SDK", { fallback: true })
          throw e
        }
        if (result.status === "found") {
          return observationSessionToDetail(result.session)
        }
        if (result.status === "not_found") throw new SessionNotFoundError()
        if (result.status === "scope_mismatch") throw new SessionScopeMismatchError()
        throw new Error("get returned invalid status")
      } catch (e) {
        if (e instanceof SessionNotFoundError || e instanceof SessionScopeMismatchError) throw e
        console.warn("[Kilo Detail] private get failed, falling back to SDK", { fallback: true })
        // fall through to SDK exactly once if client available
      }
    }
    // SDK exactly once (gate off/not started/malformed/transport path)
    if (!this.client) throw new Error("Not connected to CLI backend")
    let res: { data?: unknown; error?: unknown; response?: unknown }
    try {
      const raw = await this.client.session.get({ sessionID, directory }, { throwOnError: true, ...(signal ? { signal } : {}) } as unknown as { throwOnError: true })
      res = raw as unknown as { data?: unknown; error?: unknown; response?: unknown }
      if (!res.data) throw new Error("Session metadata not found")
      try {
        const { observeSessionGetParityDetached } = await import("./kilo-provider/session-get-parity")
        observeSessionGetParityDetached(
          this.connectionService as unknown as Parameters<typeof observeSessionGetParityDetached>[0],
          res as unknown as { data?: unknown },
          sessionID,
          directory,
        )
      } catch (err) {
        console.warn("[Kilo Get] private parity observation failed (fail-closed):", String(err).slice(0, 200))
      }
      return sdkSessionToDetail(res.data as Session)
    } catch (sdkErr) {
      try {
        const { observeSessionGetParityDetached } = await import("./kilo-provider/session-get-parity")
        observeSessionGetParityDetached(
          this.connectionService as unknown as Parameters<typeof observeSessionGetParityDetached>[0],
          sdkErr as { data?: unknown; error?: unknown; response?: unknown },
          sessionID,
          directory,
        )
      } catch {
        console.warn("[Kilo Get] private parity observation failed (fail-closed):", {
          op: "session/get",
          observationFailed: true,
        })
      }
      throw sdkErr
    }
  }

  private async handleCreateSession(): Promise<void> {
    if (!this.client) {
      this.postMessage({
        type: "error",
        message: "Not connected to CLI backend",
      })
      return
    }

    const workspaceDir = this.getContextDirectory()
    const { opId, idempotencyKey, requestId } = buildSessionCreateIdentity()
    const durableContext = { directory: workspaceDir, parentSessionId: null as string | null }
    let sdkResult: { data?: Session; error?: unknown; response?: unknown } | null = null
    let sdkData: Session | undefined
    let metadata: Record<string, unknown> | undefined
    try {
      // sandbox metadata lookup inside error boundary (previously outside)
      try {
        metadata = await sandboxSessionMetadata(this.connectionService.sandboxPreference, this.client!, workspaceDir)
      } catch (e) {
        console.warn("[Kilo New] KiloProvider: sandbox metadata lookup failed, using empty", String(e))
        metadata = undefined
      }
      const res = (await this.client!.session.create(
        {
          directory: workspaceDir,
          platform: this.opts.platform,
          metadata,
          opId,
          idempotencyKey,
          requestId,
          context: durableContext,
        } as unknown as Record<string, unknown>,
        { throwOnError: false } as unknown as { throwOnError: false },
      )) as unknown as { data?: Session; error?: unknown; response?: unknown }
      sdkResult = res
      if (res.error) {
        console.error("[Kilo New] KiloProvider: Failed to create session:", res.error)
        this.postMessage({ type: "error", message: getErrorMessage(res.error) || "Failed to create session" })
      } else if (res.data) {
        sdkData = res.data as Session
        const detail = sdkSessionToDetail(sdkData)
        this.stopCurrentSessionProcesses(detail.id)
        this.setCurrentSession(detail)
        this.contextSessionID = detail.id
        this.focusSession(detail.id)
        this.trackDirectory(detail.id, workspaceDir)
        this.trackedSessionIds.add(detail.id)
        this.postMessage({ type: "sessionCreated", session: this.sessionToWebview(this.currentSession!) })
      }
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to create session:", error)
      this.postMessage({ type: "error", message: getErrorMessage(error) || "Failed to create session" })
      sdkResult = { error, response: undefined, data: undefined }
    }

    // SDK-first parity observation (fail-closed)
    try {
      if (!sdkResult) return
      const isPrivateAvailable =
        (this.connectionService as unknown as { isPrivateAvailable?: () => boolean }).isPrivateAvailable?.() ?? false
      if (!isPrivateAvailable) return
      const hasTerminal = (() => {
        const resp = (sdkResult as unknown as { response?: { status?: unknown } })?.response
        const respStatus =
          resp && typeof resp.status === "number" && Number.isInteger(resp.status)
            ? (resp.status as number)
            : resp && typeof resp.status === "string"
              ? Number(resp.status)
              : null
        if (respStatus !== null && Number.isInteger(respStatus) && respStatus >= 100 && respStatus < 600) {
          if ([400, 404, 409, 500].includes(respStatus)) return true
          if (sdkResult.error) return false
          return true
        }
        if (!sdkResult.error) return true
        const err = sdkResult.error as Record<string, unknown>
        const candidates: unknown[] = [err.status, err.statusCode, err.code, err.httpStatus]
        for (const c of candidates) {
          if (typeof c === "number" && [400, 404, 409, 500].includes(c)) return true
          if (typeof c === "string" && ["400", "404", "409", "500"].includes(c)) return true
          const n = typeof c === "string" ? Number(c) : null
          if (n !== null && [400, 404, 409, 500].includes(n)) return true
        }
        if (typeof err.message === "string" && /\b(400|404|409|500)\b/.test(err.message)) return true
        const tag = typeof err._tag === "string" ? String(err._tag).toLowerCase() : ""
        if (
          tag.includes("badrequest") ||
          tag.includes("notfound") ||
          tag.includes("conflict") ||
          tag.includes("internal")
        )
          return true
        if (typeof err.status === "undefined" && typeof err.code === "undefined" && typeof err._tag === "undefined")
          return false
        return false
      })()
      if (!hasTerminal) return
      const privateReq = {
        v: 1 as const,
        requestId,
        opId,
        op: "session/create" as const,
        idempotencyKey,
        context: durableContext,
        payload: {},
      }
      const svc = this.connectionService as unknown as { privateCreate: (r: typeof privateReq) => Promise<unknown> }
      if (typeof svc.privateCreate !== "function") return
      const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
          ;(timer as unknown as { unref?: () => void })?.unref?.()
        })
        return Promise.race([p, timeout]).finally(() => {
          if (timer) clearTimeout(timer)
        }) as Promise<T>
      }
      const tryCancel =
        (
          this.connectionService as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean }
        )?.tryCancelPrivatePending?.bind(this.connectionService) ?? null
      const invalidate =
        (
          this.connectionService as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void }
        )?.invalidatePrivatePeerOnObserverTimeout?.bind(this.connectionService) ?? null
      const handleFactory =
        (
          this.connectionService as unknown as {
            privateCreateWithHandle?: (r: typeof privateReq) => {
              id: number
              promise: Promise<unknown>
              cancel?: (msg?: string) => boolean
            }
          }
        )?.privateCreateWithHandle?.bind(this.connectionService) ?? null
      const peekNextId =
        (
          this.connectionService as unknown as { peekPrivatePeerNextId?: () => number | null }
        )?.peekPrivatePeerNextId?.bind(this.connectionService) ?? null
      // Atomic ownership: handle-allocated id eliminates peek-before-request race; fallback to peek for legacy mocks.
      let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
      let exactId: number | null = null
      let privPromise: Promise<unknown>
      if (handleFactory) {
        try {
          const h = handleFactory(privateReq as unknown as never) as {
            id: number
            promise: Promise<unknown>
            cancel?: (msg?: string) => boolean
          }
          handle = h
          exactId = h.id
          privPromise = h.promise
        } catch (e) {
          privPromise = Promise.reject(e)
        }
      } else {
        exactId = peekNextId ? peekNextId() : null
        privPromise = svc.privateCreate(privateReq)
      }
      let priv: unknown
      try {
        priv = await withTimeout(privPromise, 3000).catch((e: unknown) => {
          const msg = String(e)
          const isTimeout = msg.includes("private parity timeout")
          if (isTimeout) {
            if (handle?.cancel) {
              try {
                handle.cancel(`private parity timeout opId=${opId}`)
              } catch (e) {
                console.warn("[Kilo Create] handle.cancel cleanup failed", String(e))
              }
            } else {
              let cleaned = false
              if (exactId !== null && tryCancel) {
                try {
                  cleaned = tryCancel(exactId as number, `private parity timeout opId=${opId}`)
                } catch (e) {
                  console.warn("[Kilo Create] tryCancel cleanup failed", String(e))
                }
              }
              if (!cleaned && invalidate) {
                try {
                  invalidate(`create observer timeout opId=${opId}`)
                } catch (e) {
                  console.warn("[Kilo Create] invalidate cleanup failed", String(e))
                }
              }
            }
          }
          return {
            v: 1,
            requestId,
            opId,
            op: "session/create",
            idempotencyKey,
            status: "ambiguous",
            outcome: { type: "ambiguous", time: Date.now() },
            accepted: false,
            transportUnknown: true,
            _error: String(e),
          }
        })
      } catch (e) {
        priv = {
          v: 1,
          requestId,
          opId,
          op: "session/create",
          idempotencyKey,
          status: "ambiguous",
          outcome: { type: "ambiguous", time: Date.now() },
          accepted: false,
          transportUnknown: true,
          _error: String(e),
        }
      }
      try {
        const { compareCreateParity } = await import("./services/cli-backend/serve-private-peer")
        const res = compareCreateParity(
          priv as unknown as import("./services/cli-backend/serve-private-peer").ServePrivateCreateResult,
          sdkResult as unknown as { data?: unknown; error?: unknown; response?: unknown },
        )
        if (res.divergence) {
          console.warn("[Kilo Create] parity divergence", { opId, divergence: res.divergence, details: res.details })
        } else if ((priv as Record<string, unknown>).transportUnknown) {
          console.warn("[Kilo Create] transport-unknown parity", { opId })
        }
      } catch (e) {
        console.warn("[Kilo Create] parity observation failed", { opId, error: String(e) })
      }
    } catch (e) {
      console.warn("[Kilo Create] private parity observation failed (fail-closed):", String(e).slice(0, 200))
    }
  }

  /** Non-blocking: refresh session metadata + status for the webview after switching. */
  private refreshSessionDetails(sessionID: string, dir: string, signal?: AbortSignal): void {
    const revision = this.revisions.get(sessionID)
    const refresh = (this.refreshes.get(sessionID) ?? 0) + 1
    this.refreshes.set(sessionID, refresh)
    const generation = this.detailGeneration
    const target = sessionID
    void (async () => {
      try {
        const detail = await this.getSessionDetail(sessionID, dir, signal)
        if (signal?.aborted || generation !== this.detailGeneration || this.contextSessionID !== target) return
        if (this.refreshes.get(sessionID) !== refresh) {
          if (this.revisions.get(sessionID) !== revision) this.refreshSessionDetails(sessionID, dir, signal)
          return
        }
        if (this.revisions.get(sessionID) !== revision) {
          this.refreshSessionDetails(sessionID, dir, signal)
          return
        }
        this.setCurrentSession(detail)
        this.contextSessionID = detail.id
        this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(detail) })
      } catch (e: unknown) {
        console.warn("[Kilo New] KiloProvider: getSession failed (non-critical):", e)
      }
    })()
    this.postMessage({ type: "workspaceDirectoryChanged", directory: this.getWorkspaceDirectory(sessionID) })
    this.requirements.clear()
    if (!this.client) return
    this.client.session
      .status({ directory: dir })
      .then((r) => {
        if (!r.data || signal?.aborted) return
        for (const [sid, info] of Object.entries(r.data) as [string, SessionStatus][]) {
          if (!this.trackedSessionIds.has(sid)) continue
          this.postMessage({
            type: "sessionStatus",
            sessionID: sid,
            status: info.type,
            ...(info.type === "retry" ? { attempt: info.attempt, message: info.message, next: info.next } : {}),
          })
        }
      })
      .catch((e: unknown) => console.error("[Kilo New] KiloProvider: Failed to fetch session statuses:", e))
  }

  private fetchAndSendSessionModelUsage(sessionID: string, requestID: string): Promise<void> {
    const directory = this.getWorkspaceDirectory(sessionID)
    return this.connectionService
      .getClientAsync(directory)
      .then((client) => client.kilocode.sessionModelUsage({ sessionID, directory }, { throwOnError: true }))
      .then((response) => {
        this.modelUsageSessionIds = new Set(response.data.sessionIDs)
        this.postMessage({ type: "sessionModelUsageLoaded", sessionID, requestID, data: response.data })
      })
      .catch((error: unknown) => {
        console.warn("[Kilo New] KiloProvider: Failed to load session model usage:", error)
        this.postMessage({ type: "sessionModelUsageLoaded", sessionID, requestID })
      })
  }

  private async handleLoadMessages(
    sessionID: string,
    options: { mode?: MessageLoadMode; before?: string; limit?: number; preserveStream?: boolean } = {},
  ): Promise<void> {
    try {
      await this.doLoadMessages(sessionID, options, false)
    } catch (error) {
      if (this.loadMessagesAbort?.signal.aborted) return
      console.error("[Kilo New] KiloProvider: Failed to load messages:", error)
      this.postMessage({ type: "error", message: getErrorMessage(error) || "Failed to load messages", sessionID })
    }
  }

  private async doLoadMessages(
    sessionID: string,
    options: { mode?: MessageLoadMode; before?: string; limit?: number; preserveStream?: boolean } = {},
    strict: boolean,
    info?: SessionDetail,
  ): Promise<boolean> {
    const mode = options.mode ?? "replace"
    const wasTracked = this.trackedSessionIds.has(sessionID)
    const isSwitch = mode === "replace" || mode === "focus"
    const generation = isSwitch ? this.nextDetailLoad() : this.detailGeneration
    const target = sessionID
    if (isSwitch) {
      this.stopCurrentSessionProcesses(sessionID)
      this.trackedSessionIds.add(sessionID)
      this.focusSession(sessionID)
      this.contextSessionID = sessionID
    }
    if (!this.client) throw new Error("Not connected to CLI backend")
    const dir = this.getWorkspaceDirectory(sessionID)
    if (mode === "focus") {
      if (strict) {
        if (info) {
          this.setCurrentSession(info)
          this.contextSessionID = info.id
          if (!wasTracked) this.postMessage({ type: "sessionCreated", session: this.sessionToWebview(info) })
          this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(info) })
        } else {
          let detail: SessionDetail
          try {
            detail = await this.getSessionDetail(sessionID, dir)
          } catch (e) {
            if (!this.isCurrentDetailLoad(generation, target)) return false
            throw e
          }
          if (!this.isCurrentDetailLoad(generation, target)) return false
          this.setCurrentSession(detail)
          this.contextSessionID = detail.id
          if (!wasTracked) this.postMessage({ type: "sessionCreated", session: this.sessionToWebview(detail) })
          this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(detail) })
        }
      } else {
        this.refreshSessionDetails(sessionID, dir)
      }
      if (Date.now() - (this.lastReconciledAt.get(sessionID) ?? 0) < 1000) {
        if (generation !== this.detailGeneration) return false
        return true
      }
      return this.doLoadMessages(sessionID, { mode: "reconcile", limit: options.limit ?? MESSAGE_PAGE_LIMIT }, strict)
    }
    const abort = mode === "replace" ? new AbortController() : undefined
    if (abort) {
      this.loadMessagesAbort?.abort()
      this.loadMessagesAbort = abort
      if (strict) {
        if (info) {
          if (abort.signal.aborted) return false
          this.setCurrentSession(info)
          this.contextSessionID = info.id
          if (!wasTracked) this.postMessage({ type: "sessionCreated", session: this.sessionToWebview(info) })
          this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(info) })
        } else {
          let detail: SessionDetail
          try {
            detail = await this.getSessionDetail(sessionID, dir, abort.signal)
          } catch (e) {
            if (!this.isCurrentDetailLoad(generation, target, abort.signal)) return false
            throw e
          }
          if (!this.isCurrentDetailLoad(generation, target, abort.signal)) return false
          this.setCurrentSession(detail)
          this.contextSessionID = detail.id
          if (!wasTracked) this.postMessage({ type: "sessionCreated", session: this.sessionToWebview(detail) })
          this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(detail) })
        }
      } else {
        this.refreshSessionDetails(sessionID, dir, abort.signal)
      }
    }
    // Occurrence boundary: parts/updates received at or after this instant are
    // newer than the snapshot query-start and must survive the snapshot.
    // Captured before the message fetch for replace and reconcile; reconcile
    // behavior is unchanged, replace now threads the same boundary.
    const since = mode === "replace" || mode === "reconcile" ? Date.now() : undefined
    let page: Awaited<ReturnType<typeof fetchMessagePage>>
    try {
      page = await fetchMessagePage(
        this.client,
        {
          sessionID,
          workspaceDir: dir,
          limit: options.limit ?? MESSAGE_PAGE_LIMIT,
          before: options.before,
          signal: abort?.signal,
        },
        this.connectionService,
      )
    } catch (e) {
      if (abort?.signal.aborted) return false
      if (generation !== this.detailGeneration) return false
      if (mode === "replace" && this.contextSessionID !== target) return false
      throw e
    }
    if (abort?.signal.aborted) return false
    if (generation !== this.detailGeneration) return false
    if (mode === "replace" && this.contextSessionID !== target) return false
    if (!this.trackedSessionIds.has(sessionID)) return false
    const messages = page.items.map((m) => ({
      ...this.slimInfo(m.info),
      parts: this.slimParts(m.parts),
      createdAt: new Date(m.info.time.created).toISOString(),
    }))
    for (const message of messages) {
      this.connectionService.recordMessageSessionId(message.id, message.sessionID)
    }
    if (mode === "replace" || mode === "reconcile") this.resetMessageCosts(sessionID, messages)
    if (mode === "reconcile") this.lastReconciledAt.set(sessionID, Date.now())
    // Ordering contract: messagesLoaded first, then the deterministic
    // snapshot-aware drain. The snapshot Set holds fetched (messageID, partID)
    // keys; the predicate keeps authoritative full updates (!delta) and
    // deltas for parts absent from the snapshot (new tail), and drops deltas
    // for parts present in the snapshot as ambiguous without inspecting text.
    // Pre-boundary receipts drop. Modes without since retain ordinary flush.
    this.postMessage({
      type: "messagesLoaded",
      sessionID,
      messages,
      mode,
      cursor: page.cursor,
      hasMore: Boolean(page.cursor),
      since,
    })
    if ((mode === "replace" || mode === "reconcile") && since !== undefined) {
      const snapshot = buildSnapshotPartKeys(page.items)
      this.streams.drainSince(sessionID, since, (update) => {
        if (!update.delta) return true
        const key = updateSnapshotKey(update)
        if (!key) return false
        return !snapshot.has(key)
      })
    } else if (options.preserveStream) this.streams.flush(sessionID)
    this.recoverPendingPrompts()
    if (strict) this.activateSession(sessionID)
    return true
  }

  /**
   * Handle syncing a child session (e.g. spawned by the task tool).
   * Tracks the session for SSE events and fetches its messages.
   */
  private async handleSyncSession(sessionID: string, parentSessionID?: string): Promise<void> {
    if (!this.client) return
    if (this.syncedChildSessions.has(sessionID)) return

    this.syncedChildSessions.add(sessionID)
    this.trackedSessionIds.add(sessionID)

    // Inherit the parent's directory so permission responses use the correct
    // backend Instance for child sessions.
    if (!this.sessionDirectories.has(sessionID) && parentSessionID) {
      const dir = this.sessionDirectories.get(parentSessionID)
      if (dir) {
        this.sessionDirectories.set(sessionID, dir)
      }
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory(sessionID)
      const since = Date.now()
      const historyWithObserve = retry(() =>
        this.client!.session.messages({ sessionID, directory: workspaceDir }, { throwOnError: true }),
      ).then(
        (result) => result,
        (err: unknown) => {
          try {
            observeSessionMessagesParityDetached(
              this.connectionService,
              err as { data?: unknown; error?: unknown; response?: unknown },
              sessionID,
              workspaceDir,
              {},
            )
          } catch {
            console.warn("[Kilo Messages] private parity observation failed (fail-closed):", {
              op: "session/messages",
              observationFailed: true,
            })
          }
          throw err
        },
      )
      const [detail, history] = await Promise.all([
        this.getSessionDetail(sessionID, workspaceDir),
        historyWithObserve,
      ])
      // Deletion tombstone: a delete racing the fetch wins over the snapshot.
      // Evict the in-flight marker so a later legitimate retry can run, drop
      // queued stream state, and return without posts so the child is not
      // resurrected. Background child sync never consults detailGeneration.
      if (!this.trackedSessionIds.has(sessionID)) {
        this.syncedChildSessions.delete(sessionID)
        this.streams.drop(sessionID)
        return
      }
      // SDK-first detached parity for the direct full messages read; the
      // private `session/messages` snapshot observes without mutating state.
      // Full load binds the exact empty query (no limit/before).
      if (history.data) {
        try {
          observeSessionMessagesParityDetached(
            this.connectionService,
            history as unknown as { data?: unknown },
            sessionID,
            workspaceDir,
            {},
          )
        } catch {
          console.warn("[Kilo Messages] private parity observation failed (fail-closed):", {
            op: "session/messages",
            observationFailed: true,
          })
        }
      }
      this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(detail) })

      const messages = history.data.map((m) => ({
        ...this.slimInfo(m.info),
        parts: this.slimParts(m.parts),
        createdAt: new Date(m.info.time.created).toISOString(),
      }))

      for (const message of messages) {
        this.connectionService.recordMessageSessionId(message.id, message.sessionID)
      }
      this.resetMessageCosts(sessionID, messages)

      // Same ordering contract as doLoadMessages: messagesLoaded first,
      // then the deterministic snapshot-aware drain over history.data keys.
      this.postMessage({
        type: "messagesLoaded",
        sessionID,
        messages,
        mode: "replace",
        hasMore: false,
        since,
      })
      const snapshot = buildSnapshotPartKeys(history.data)
      this.streams.drainSince(sessionID, since, (update) => {
        if (!update.delta) return true
        const key = updateSnapshotKey(update)
        if (!key) return false
        return !snapshot.has(key)
      })

      // Recover any prompts emitted by the child before we started tracking it.
      this.recoverPendingPrompts()
    } catch (err) {
      this.syncedChildSessions.delete(sessionID)
      console.error("[Kilo New] KiloProvider: Failed to sync child session:", err)
    }
  }

  /**
   * Build the context object used by the extracted session-refresh helpers.
   */
  private get sessionRefreshContext(): SessionRefreshContext {
    const client = this.client
    const directory = this.getWorkspaceDirectory()
    const connection = this.connectionService
    const privateList = this.privateSessionList
    const hasPrivate = !!privateList && privateList.isEnabled() && privateList.isStarted()
    const hasClient = !!client
    const listSessions: SessionRefreshContext["listSessions"] =
      hasPrivate || hasClient
        ? async (input: { limit: number; cursor?: string }) => {
            if (hasPrivate) {
              try {
                const canonicalRequested = (() => {
                  try {
                    return canonicalDirectory(directory)
                  } catch {
                    throw new Error("invalid requested directory")
                  }
                })()
                const raw = (await privateList!.list({
                  directory,
                  archived: false,
                  limit: input.limit,
                  ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
                })) as unknown as {
                  v?: unknown
                  entries?: unknown
                  nextCursor?: unknown
                }
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid private shape")
                const rec = raw as Record<string, unknown>
                if (rec.v !== "1.0") throw new Error("invalid private version")
                if (!Array.isArray(rec.entries)) throw new Error("invalid private entries")
                const entries = rec.entries as unknown[]
                for (const e of entries) {
                  if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error("invalid entry shape")
                  const r = e as Record<string, unknown>
                  const idOk =
                    typeof r.id === "string" &&
                    (r.id as string).length > 0 &&
                    (r.id as string).startsWith("ses") &&
                    !(r.id as string).includes("\0")
                  const titleOk = typeof r.title === "string"
                  const parentOk =
                    r.parentID === null ||
                    (typeof r.parentID === "string" &&
                      (r.parentID as string).length > 0 &&
                      (r.parentID as string).startsWith("ses") &&
                      !(r.parentID as string).includes("\0"))
                  const dirOk =
                    typeof r.directory === "string" &&
                    (r.directory as string).length > 0 &&
                    !(r.directory as string).includes("\0") &&
                    (() => {
                      try {
                        return canonicalDirectory(r.directory as string) === (r.directory as string) && (r.directory as string) === canonicalRequested
                      } catch {
                        return false
                      }
                    })()
                  const projOk =
                    typeof r.projectID === "string" &&
                    (r.projectID as string).length > 0 &&
                    !(r.projectID as string).includes("\0")
                  const createdOk =
                    typeof r.createdAt === "number" &&
                    Number.isFinite(r.createdAt as number) &&
                    Number.isSafeInteger(r.createdAt as number) &&
                    (r.createdAt as number) >= 0 &&
                    (r.createdAt as number) <= 8640000000000000
                  const updatedOk =
                    typeof r.updatedAt === "number" &&
                    Number.isFinite(r.updatedAt as number) &&
                    Number.isSafeInteger(r.updatedAt as number) &&
                    (r.updatedAt as number) >= 0 &&
                    (r.updatedAt as number) <= 8640000000000000
                  if (!idOk || !titleOk || !parentOk || !dirOk || !projOk || !createdOk || !updatedOk)
                    throw new Error("invalid entry shape")
                }
                const mapped = (entries as Array<{
                  id: string
                  parentID: string | null
                  title: string
                  directory: string
                  projectID: string
                  createdAt: number
                  updatedAt: number
                }>).map((e) => ({
                  id: e.id,
                  parentID: e.parentID ?? null,
                  title: e.title,
                  directory: e.directory,
                  projectID: e.projectID,
                  time: { created: e.createdAt, updated: e.updatedAt },
                })) as unknown as Session[]
                const rawNext = rec.nextCursor as unknown
                let next: string | null = null
                if (rawNext !== undefined) {
                  if (typeof rawNext !== "string") throw new Error("invalid nextCursor shape")
                  const decoded = decodeGlobalListCursor(rawNext)
                  if (
                    !Number.isFinite(decoded.updated) ||
                    !Number.isSafeInteger(decoded.updated) ||
                    decoded.updated < 0 ||
                    decoded.updated > 8640000000000000 ||
                    decoded.id.length === 0 ||
                    !decoded.id.startsWith("ses") ||
                    decoded.id.includes("\0")
                  )
                    throw new Error("invalid nextCursor content")
                  const normalized = normalizeSessionListNextCursor(rawNext)
                  if (normalized === null) throw new Error("invalid nextCursor")
                  next = normalized
                }
                return { sessions: mapped, cursor: next }
              } catch {
                console.warn("[Kilo SessionList] private projection invalid, falling back to SDK", {
                  fallback: true,
                })
              }
            }
            if (!client) throw new Error("Not connected to CLI backend")
            const filter = { limit: input.limit, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) }
            try {
              const result = await client.experimental.session.list(
                { directory, limit: input.limit, cursor: input.cursor },
                { throwOnError: true },
              )
              const raw = result.response.headers.get("x-next-cursor")
              const next = normalizeSessionListNextCursor(raw)
              try {
                observeSessionListParityDetached(
                  connection as unknown as Parameters<typeof observeSessionListParityDetached>[0],
                  { data: result.data, response: result.response } as Parameters<
                    typeof observeSessionListParityDetached
                  >[1],
                  directory,
                  undefined,
                  filter,
                )
              } catch {
                console.warn("[Kilo SessionList] private parity observation failed (fail-closed):", {
                  op: "experimental/session/list",
                  observationFailed: true,
                })
              }
              return { sessions: result.data, cursor: next }
            } catch (error) {
              try {
                observeSessionListParityDetached(
                  connection as unknown as Parameters<typeof observeSessionListParityDetached>[0],
                  { error, response: (error as { response?: unknown })?.response } as Parameters<
                    typeof observeSessionListParityDetached
                  >[1],
                  directory,
                  undefined,
                  filter,
                )
              } catch {
                console.warn("[Kilo SessionList] private parity observation failed (fail-closed):", {
                  op: "experimental/session/list",
                  observationFailed: true,
                })
              }
              throw error
            }
          }
        : null
    return {
      pendingSessionRefresh: this.pendingSessionRefresh,
      connectionState: this.connectionState,
      listSessions,
      loadedCount: this.sessionCount,
      cursor: this.sessionCursor,
      root: directory,
      postMessage: (msg: unknown) => this.postMessage(msg),
    }
  }

  /**
   * Retry a deferred sessions refresh once the client is ready.
   */
  private async flushPendingSessionRefresh(reason: string): Promise<void> {
    if (!this.pendingSessionRefresh) return
    return this.enqueueSessionLoad(() => this.runFlushPendingSessionRefresh(reason))
  }

  private async runFlushPendingSessionRefresh(reason: string): Promise<void> {
    console.log("[Kilo New] KiloProvider: 🔄 Flushing deferred sessions refresh", { reason })
    const ctx = this.sessionRefreshContext
    try {
      const resolved = await flushPendingSessionRefreshUtil(ctx)
      if (resolved) this.projectID = resolved
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to flush session refresh:", error)
    }
    this.syncSessionPaging(ctx)
  }

  /**
   * Handle loading sessions. Without a cursor this is a full refresh;
   * with a cursor it appends the next page ("load more").
   */
  private handleLoadSessions(cursor?: string): Promise<void> {
    return this.enqueueSessionLoad(() => this.runLoadSessions(cursor))
  }

  private async runLoadSessions(cursor?: string): Promise<void> {
    const ctx = this.sessionRefreshContext
    try {
      const resolved = await loadSessionsUtil(ctx, cursor)
      if (resolved) this.projectID = resolved
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to load sessions:", error)
      this.postMessage({
        type: "error",
        message: getErrorMessage(error) || "Failed to load sessions",
      })
    }
    this.syncSessionPaging(ctx)
  }

  /**
   * Serialize session-list loads (full refreshes, load-more pages, and
   * deferred flushes) so concurrent refreshes never interleave: the last
   * `sessionsLoaded` posted to the webview always belongs to the last load
   * enqueued. This is what lets the E2E fixture deterministically re-seed
   * after the real backend list has settled — no later in-flight refresh
   * can reconcile the fixture sessions away.
   */
  private sessionLoadChain: Promise<void> = Promise.resolve()

  private enqueueSessionLoad(task: () => Promise<void>): Promise<void> {
    const run = this.sessionLoadChain.then(task, task)
    this.sessionLoadChain = run.catch(() => {})
    return run
  }

  /** Copy pagination state mutated by the session-refresh helpers back onto this instance. */
  private syncSessionPaging(ctx: SessionRefreshContext): void {
    this.pendingSessionRefresh = ctx.pendingSessionRefresh
    this.sessionCursor = ctx.cursor
    this.sessionCount = ctx.loadedCount
  }

  private async handleTerminalContext(requestId: string): Promise<void> {
    try {
      const output = await getTerminalContents(-1)
      this.postMessage({
        type: "terminalContextResult",
        requestId,
        content: output.content,
        truncated: output.truncated,
      })
    } catch (error) {
      console.error("[Kilo New] Failed to capture terminal context:", error)
      this.postMessage({
        type: "terminalContextError",
        requestId,
        error: getErrorMessage(error) || "Failed to capture terminal output",
      })
    }
  }

  /**
   * Drops every per-session cache entry we hold for the given id. Shared between
   * the user-initiated delete path (handleDeleteSession, after the backend
   * confirms) and the SSE session.deleted path (cascaded child deletes and
   * external CLI/TUI deletes that arrive via the event stream), so both paths
   * leave trackedSessionIds, sessionDirectories, and the related Maps in the
   * same state — including currentSession / contextSessionID / focused-session
   * registration. Without clearing those three, resolveSession() would still
   * see the deleted id via this.currentSession and the next send would target
   * a session the backend has already deleted.
   */
  private pruneDeletedSession(sessionID: string): void {
    this.trackedSessionIds.delete(sessionID)
    for (const [key, session] of this.draftSessions) {
      if (session.sid === sessionID) this.draftSessions.delete(key)
    }
    this.streams.drop(sessionID)
    this.visibleTaskStreams.delete(sessionID)
    this.syncedChildSessions.delete(sessionID)
    this.sessionDirectories.delete(sessionID)
    this.aborts.delete(sessionID)
    this.lastReconciledAt.delete(sessionID)
    this.checkpoints.delete(sessionID)
    this.revisions.delete(sessionID)
    this.refreshes.delete(sessionID)
    this.sessionStatusMap.delete(sessionID)
    this.costs.onSessionDeleted(sessionID)
    const deletedAlertLimit = this.activeAlerts.get(sessionID)
    if (deletedAlertLimit !== undefined) {
      this.activeAlerts.delete(sessionID)
      this.postMessage({ type: "sessionCostAlertResolved", sessionID: sessionID, limit: deletedAlertLimit })
    }
    this.connectionService.pruneSession(sessionID)
    if (this.currentSession?.id === sessionID) {
      this.contextSessionID = undefined
      this.setCurrentSession(null)
    }
    if (this.streams.focused === sessionID) this.focusSession(undefined)
  }

  /**
   * Handle deleting a session.
   */
  private async handleDeleteSession(sessionID: string): Promise<void> {
    if (!this.client) {
      this.postMessage({ type: "error", message: "Not connected to CLI backend" })
      return
    }

    try {
      const workspaceDir = this.getSessionDirectory(
        sessionID,
        this.currentSession?.id === sessionID ? this.currentSession : undefined,
      )
      await stopSessionProcesses(this.client, sessionID, workspaceDir)
      await this.client.session.delete({ sessionID, directory: workspaceDir }, { throwOnError: true })
      this.pruneDeletedSession(sessionID)
      if (this.currentSession?.id === sessionID) {
        this.contextSessionID = undefined
        this.setCurrentSession(null)
        this.focusSession(undefined)
      }
      this.postMessage({ type: "sessionDeleted", sessionID })
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to delete session:", error)
      this.postMessage({
        type: "error",
        message: getErrorMessage(error) || "Failed to delete session",
      })
    }
  }

  /**
   * Handle renaming a session — SDK authoritative, private parity observation-only (B2).
   * SDK PATCH executes first and is the only user-visible authority; private session/update
   * replays the same identity (sessionUpdate:<sessionID> + per-attempt idempotencyKey) with
   * log-only compare, fail-closed on unavailable/timeout/epoch drift.
   */
  private async handleRenameSession(sessionID: string, title: string): Promise<void> {
    if (!this.client) {
      this.postMessage({ type: "error", message: "Not connected to CLI backend" })
      return
    }
    const dir = this.getWorkspaceDirectory(sessionID)
    const parsed = parseSessionTitle(title)
    if ("error" in parsed) {
      this.postMessage({
        type: "error",
        message: getErrorMessage(new Error("Invalid session title")) || "Invalid session title",
      })
      return
    }
    const { opId, idempotencyKey, requestId } = buildSessionUpdateIdentity(sessionID)
    const durableContext: { directory: string; sessionId: string; parentSessionId: null } = {
      directory: dir,
      sessionId: sessionID,
      parentSessionId: null,
    }
    let sdkRes: { data?: Session; error?: unknown; response?: unknown }
    let sdkThrew = false
    try {
      sdkRes = await renameSessionWithResult({
        client: this.client,
        sessionID,
        title: parsed.value,
        directory: dir,
        opId,
        idempotencyKey,
        requestId,
        context: durableContext,
      })
    } catch (error) {
      sdkThrew = true
      console.error("[Kilo New] KiloProvider: Failed to rename session:", error)
      this.postMessage({ type: "error", message: getErrorMessage(error) || "Failed to rename session" })
      sdkRes = { error, response: undefined, data: undefined }
    }
    // Preserve Session.Info success and SDK terminal status (authoritative)
    if (!sdkThrew) {
      if (sdkRes!.data && !sdkRes!.error) {
        const updated = sdkSessionToDetail(sdkRes!.data as Session)
        if (this.currentSession?.id === sessionID) this.setCurrentSession(updated)
        this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(updated) })
      } else if (sdkRes!.error) {
        console.error("[Kilo New] KiloProvider: Failed to rename session:", sdkRes!.error)
        this.postMessage({ type: "error", message: getErrorMessage(sdkRes!.error) || "Failed to rename session" })
      }
    }

    const isPrivateAvailable =
      (this.connectionService as unknown as { isPrivateAvailable?: () => boolean }).isPrivateAvailable?.() ?? false
    if (!isPrivateAvailable) return
    const sdkHasTerminal = (() => {
      const resp = (sdkRes as unknown as { response?: { status?: unknown } })?.response
      const respStatus =
        resp && typeof resp.status === "number" && Number.isInteger(resp.status)
          ? (resp.status as number)
          : resp && typeof resp.status === "string"
            ? Number(resp.status)
            : null
      if (respStatus !== null && Number.isInteger(respStatus) && respStatus >= 100 && respStatus < 600) {
        if ([400, 404, 409, 500].includes(respStatus)) return true
        if (sdkRes.error) return false
        return true
      }
      if (!sdkRes.error) return true
      const err = sdkRes.error as Record<string, unknown>
      const candidates: unknown[] = [err.status, err.statusCode, err.code, err.httpStatus]
      for (const c of candidates) {
        if (typeof c === "number" && [400, 404, 409, 500].includes(c)) return true
        if (typeof c === "string" && ["400", "404", "409", "500"].includes(c)) return true
        const n = typeof c === "string" ? Number(c) : null
        if (n !== null && [400, 404, 409, 500].includes(n)) return true
      }
      if (typeof err.message === "string" && /\b(400|404|409|500)\b/.test(err.message)) return true
      const tag = typeof err._tag === "string" ? String(err._tag).toLowerCase() : ""
      if (
        tag.includes("badrequest") ||
        tag.includes("notfound") ||
        tag.includes("conflict") ||
        tag.includes("internal")
      )
        return true
      if (typeof err.status === "undefined" && typeof err.code === "undefined" && typeof err._tag === "undefined")
        return false
      return false
    })()
    if (!sdkHasTerminal) return
    const privateReq = {
      v: 1 as const,
      requestId,
      opId,
      op: "session/update" as const,
      idempotencyKey,
      context: durableContext,
      payload: { title: parsed.value },
    }
    const svc = this.connectionService as unknown as {
      privateSessionUpdate: (req: typeof privateReq) => Promise<unknown>
      privateSessionUpdateWithHandle?: (req: typeof privateReq) => {
        id: number
        promise: Promise<unknown>
        cancel: (msg?: string) => boolean
      }
    }
    if (typeof svc.privateSessionUpdate !== "function" && typeof svc.privateSessionUpdateWithHandle !== "function")
      return
    let priv: unknown
    try {
      const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
          ;(timer as unknown as { unref?: () => void })?.unref?.()
        })
        return Promise.race([p, timeout]).finally(() => {
          if (timer) clearTimeout(timer)
        }) as Promise<T>
      }
      const tryCancel =
        (
          this.connectionService as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean }
        )?.tryCancelPrivatePending?.bind(this.connectionService) ?? null
      const invalidate =
        (
          this.connectionService as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void }
        )?.invalidatePrivatePeerOnObserverTimeout?.bind(this.connectionService) ?? null
      const handleFactory =
        (
          this.connectionService as unknown as {
            privateSessionUpdateWithHandle?: (r: typeof privateReq) => {
              id: number
              promise: Promise<unknown>
              cancel?: (msg?: string) => boolean
            }
          }
        )?.privateSessionUpdateWithHandle?.bind(this.connectionService) ?? null
      const peekNextId =
        (
          this.connectionService as unknown as { peekPrivatePeerNextId?: () => number | null }
        )?.peekPrivatePeerNextId?.bind(this.connectionService) ?? null
      let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
      let exactId: number | null = null
      let privPromise: Promise<unknown>
      if (handleFactory) {
        try {
          const h = handleFactory(privateReq as unknown as never) as {
            id: number
            promise: Promise<unknown>
            cancel?: (msg?: string) => boolean
          }
          handle = h
          exactId = h.id
          privPromise = h.promise
        } catch (e) {
          privPromise = Promise.reject(e)
        }
      } else {
        exactId = peekNextId ? peekNextId() : null
        privPromise = (svc.privateSessionUpdate as (r: typeof privateReq) => Promise<unknown>)(privateReq)
      }
      try {
        priv = await withTimeout(privPromise, 3000).catch((e: unknown) => {
          const msg = String(e)
          const isTimeout = msg.includes("private parity timeout")
          if (isTimeout) {
            if (handle?.cancel) {
              try {
                handle.cancel(`private parity timeout opId=${privateReq.opId}`)
              } catch (err) {
                console.warn("[Kilo PrivateParity] session/update handle.cancel failed:", String(err).slice(0, 200), {
                  opId: privateReq.opId,
                })
              }
            } else if (exactId !== null && tryCancel) {
              let cleaned = false
              try {
                cleaned = tryCancel(exactId, `private parity timeout opId=${privateReq.opId}`)
              } catch (err) {
                console.warn("[Kilo PrivateParity] session/update tryCancel failed:", String(err).slice(0, 200), {
                  opId: privateReq.opId,
                })
              }
              if (!cleaned && invalidate) {
                try {
                  invalidate(`session/update observer timeout opId=${privateReq.opId}`)
                } catch (err) {
                  console.warn("[Kilo PrivateParity] session/update invalidate failed:", String(err).slice(0, 200), {
                    opId: privateReq.opId,
                  })
                }
              }
            } else if (invalidate) {
              try {
                invalidate(`session/update observer timeout opId=${privateReq.opId}`)
              } catch (err) {
                console.warn("[Kilo PrivateParity] session/update invalidate failed:", String(err).slice(0, 200), {
                  opId: privateReq.opId,
                })
              }
            }
            console.warn("[Kilo PrivateParity] session/update private parity timeout after 3000ms:", {
              opId: privateReq.opId,
              requestId: privateReq.requestId,
            })
          }
          return {
            v: 1,
            requestId: privateReq.requestId,
            opId: privateReq.opId,
            op: "session/update",
            idempotencyKey: privateReq.idempotencyKey,
            status: "ambiguous",
            outcome: { type: "ambiguous", time: Date.now() },
            accepted: false,
            transportUnknown: true,
            _error: String(e),
          }
        })
      } catch (e) {
        const msg = String(e)
        const isTimeout = msg.includes("private parity timeout")
        if (isTimeout) {
          if (handle?.cancel) {
            try {
              handle.cancel(`private parity timeout opId=${privateReq.opId}`)
            } catch (err) {
              console.warn("[Kilo PrivateParity] session/update handle.cancel failed:", String(err).slice(0, 200), {
                opId: privateReq.opId,
              })
            }
          } else if (exactId !== null && tryCancel) {
            try {
              const cleaned = tryCancel(exactId, `private parity timeout opId=${privateReq.opId}`)
              if (!cleaned && invalidate) invalidate(`session/update observer timeout opId=${privateReq.opId}`)
            } catch (err) {
              console.warn("[Kilo PrivateParity] session/update timeout cancel failed:", String(err).slice(0, 200), {
                opId: privateReq.opId,
              })
            }
          } else if (invalidate) {
            try {
              invalidate(`session/update observer timeout opId=${privateReq.opId}`)
            } catch (err) {
              console.warn(
                "[Kilo PrivateParity] session/update timeout invalidate failed:",
                String(err).slice(0, 200),
                { opId: privateReq.opId },
              )
            }
          }
        }
        priv = {
          v: 1,
          requestId: privateReq.requestId,
          opId: privateReq.opId,
          op: "session/update",
          idempotencyKey: privateReq.idempotencyKey,
          status: "ambiguous",
          outcome: { type: "ambiguous", time: Date.now() },
          accepted: false,
          transportUnknown: true,
          _error: String(e),
        }
      }
    } catch (e) {
      console.warn("[Kilo PrivateParity] session/update parity observation failed", { opId, error: String(e) })
      return
    }
    try {
      const { compareUpdateParity } = await import("./services/cli-backend/serve-private-peer")
      const res = compareUpdateParity(
        priv as unknown as import("./services/cli-backend/serve-private-peer").ServePrivateSessionUpdateResult,
        sdkRes as unknown as { data?: unknown; error?: unknown; response?: unknown },
      )
      if (res.divergence) {
        const p = priv as Record<string, unknown>
        console.warn("[Kilo PrivateParity] divergence", {
          opId,
          sessionID,
          divergence: res.divergence,
          details: res.details,
          privStatus: (p.status as string) ?? "unknown",
          transportUnknown: !!(p.transportUnknown as boolean),
        })
      } else {
        console.log("[Kilo PrivateParity] parity match", { opId, status: sdkRes.error ? "failed" : "succeeded" })
      }
    } catch (e) {
      console.warn("[Kilo PrivateParity] session/update parity observation failed", { opId, error: String(e) })
    }
  }

  /**
   * Export a full session transcript as Markdown.
   */
  private async handleExportSessionTranscript(sessionID: string): Promise<void> {
    if (!this.client) {
      this.postMessage({ type: "error", message: "Not connected to CLI backend" })
      return
    }

    try {
      const dir = this.getWorkspaceDirectory(sessionID)
      const saved = await exportTranscript(
        this.client,
        {
          sessionID,
          dir,
          getSessionDetail: (sid, d) => this.getSessionDetail(sid, d),
        },
        this.connectionService,
      )
      if (saved) void vscode.window.showInformationMessage("Session transcript exported as Markdown.")
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to export session transcript:", error)
      this.postMessage({
        type: "error",
        message: getErrorMessage(error) || "Failed to export session transcript",
      })
    }
  }

  /** Fetch providers and send to webview. Coalesced: at most one in-flight + one queued. */
  private async fetchAndSendProviders(): Promise<void> {
    if (this.canonicalConfig) {
      await this.sendCanonicalProviders()
      return
    }
    const next = ++this.providersGeneration
    if (this.providersRefresh) {
      this.providersQueued = true
      await this.providersRefresh
      return
    }
    const task = (async () => {
      let generation = next
      while (true) {
        this.providersQueued = false
        const client = this.client
        if (!client) {
          if (this.cachedProvidersMessage && generation === this.providersGeneration)
            this.postMessage(this.cachedProvidersMessage)
          return
        }
        try {
          const { response, authMethods, authStates, storedKeys } = await fetchProviderData(
            client,
            this.getWorkspaceDirectory(),
          )
          if (generation !== this.providersGeneration || client !== this.client) {
            if (!this.providersQueued) return
            generation = this.providersGeneration
            continue
          }
          this.storedProviderKeys = storedKeys
          const settings = vscode.workspace.getConfiguration("kilo-code.new.model")
          const message = {
            type: "providersLoaded",
            providers: indexProvidersById(response.all),
            connected: response.connected,
            defaults: response.default,
            defaultSelection: computeDefaultSelection(
              this.cachedConfigMessage as { config?: { model?: string } } | null,
              settings.get<string>("providerID", ""),
              settings.get<string>("modelID", ""),
            ),
            authMethods,
            authStates,
          }
          this.cachedProvidersMessage = message
          this.postMessage(message)
        } catch (error) {
          if (generation !== this.providersGeneration) {
            if (!this.providersQueued) return
            generation = this.providersGeneration
            continue
          }
          console.error("[Kilo New] KiloProvider: Failed to fetch providers:", error)
        }
        if (!this.providersQueued) return
        generation = this.providersGeneration
      }
    })()
    const done = task.finally(() => {
      if (this.providersRefresh === done) this.providersRefresh = null
    })
    this.providersRefresh = done
    await done
  }

  private async handleProviderAction(msg: Record<string, unknown>): Promise<void> {
    if (
      this.canonicalConfig &&
      (msg.type === "connectProvider" ||
        msg.type === "authorizeProviderOAuth" ||
        msg.type === "completeProviderOAuth" ||
        msg.type === "disconnectProvider" ||
        msg.type === "deleteCustomProvider" ||
        msg.type === "saveCustomProvider")
    ) {
      // P4.1: every canonical mutation crossing the untrusted runtime boundary
      // requires the canonical === true discriminator; false/missing rejects.
      if (msg.type !== "authorizeProviderOAuth" && msg.type !== "completeProviderOAuth" && msg.canonical !== true) {
        const pid = typeof msg.providerID === "string" ? msg.providerID : ""
        const requestId = typeof msg.requestId === "string" ? msg.requestId : crypto.randomUUID()
        const action =
          msg.type === "disconnectProvider" ? "disconnect" : msg.type === "deleteCustomProvider" ? "delete" : "connect"
        this.postMessage({
          type: "providerActionError",
          requestId,
          providerID: pid,
          action,
          message: "Canonical provider request is missing the canonical discriminator",
          canonical: true,
          kind: "invalid",
          stamp: this.canonicalConfig.stamp,
        })
        return
      }
      await this.handleCanonicalProviderAction(msg)
      return
    }
    const rid = typeof msg.requestId === "string" ? msg.requestId : ""
    const pid = typeof msg.providerID === "string" ? msg.providerID : ""
    if (!rid || !pid) return
    if (!this.client) {
      const action =
        msg.type === "disconnectProvider"
          ? "disconnect"
          : msg.type === "deleteCustomProvider"
            ? "delete"
            : msg.type === "authorizeProviderOAuth"
              ? "authorize"
              : "connect"
      this.postMessage({
        type: "providerActionError",
        requestId: rid,
        providerID: pid,
        action,
        message: "Not connected to CLI backend",
      })
      return
    }
    const ctx = buildActionContext(
      this.client,
      (m) => this.postMessage(m),
      getErrorMessage,
      this.getWorkspaceDirectory(),
      () => this.fetchAndSendProviders(),
    )
    const set = (m: unknown) => {
      this.cachedConfigMessage = m
    }
    const method = typeof msg.method === "number" ? msg.method : 0
    const key = typeof msg.apiKey === "string" ? msg.apiKey : undefined
    const keyChanged = msg.apiKeyChanged === true
    const code = typeof msg.code === "string" ? msg.code : undefined
    const config = msg.config && typeof msg.config === "object" ? (msg.config as Record<string, unknown>) : undefined
    const metadata =
      msg.metadata && typeof msg.metadata === "object" ? (msg.metadata as Record<string, unknown>) : undefined
    if (msg.type === "connectProvider" && key) return connectProviderAction(ctx, rid, pid, key, metadata)
    if (msg.type === "authorizeProviderOAuth") return authorizeOAuthAction(ctx, rid, pid, method)
    if (msg.type === "completeProviderOAuth") return completeOAuthAction(ctx, rid, pid, method, code)
    if (msg.type === "disconnectProvider") return disconnectProviderAction(ctx, rid, pid, this.cachedConfigMessage, set)
    if (msg.type === "deleteCustomProvider")
      return deleteCustomProviderAction(ctx, rid, pid, this.cachedConfigMessage, set)
    if (msg.type === "saveCustomProvider" && config)
      return saveCustomProviderAction(ctx, rid, pid, config, key, keyChanged)
  }

  private async handleGetProviderCredential(msg: Record<string, unknown>): Promise<void> {
    const rid = typeof msg.requestID === "string" ? msg.requestID : ""
    const pid = typeof msg.providerID === "string" ? msg.providerID : ""
    if (!rid || !pid) return
    const errReply = (error: string) => {
      this.postMessage({ type: "providerCredentialError", requestID: rid, providerID: pid, error })
    }
    if (this.canonicalConfig) {
      // Credential reads are gated by canonical readiness: before the first
      // successful materialization no canonical credential may be exposed.
      if (!this.canonicalReady) return errReply("Canonical credential authority is not ready")
      const scope = this.providerScope(pid)
      const provider = this.canonicalConfig.getScopeConfig(scope).provider
      const parsed = parseCanonicalProviderRecord(provider)
      const record = parsed?.[pid]
      const ref = record && typeof record.credential === "string" ? record.credential : undefined
      // Exact owned ref only — never reconstruct a derived key as fallback.
      if (!ref) return errReply("Provider has no valid credential reference")
      const value = await this.canonicalConfig.hasSecret(ref)
      if (!value) return errReply("Credential is not available in SecretStorage")
      return this.postMessage({
        type: "providerCredentialLoaded",
        requestID: rid,
        providerID: pid,
        hasCredential: true,
        canonical: true,
        stamp: { ...this.canonicalConfig.stamp, assetHash: null },
      })
    }
    if (!this.client) return errReply("Unable to load API key")
    try {
      const { data: response } = await this.client.provider.list(
        { directory: this.getWorkspaceDirectory() },
        { throwOnError: true },
      )
      const auth = authorizeCredentialRead(pid, response.all as Array<Record<string, unknown>>)
      if (!auth.authorized) return errReply(auth.error)
      // LOCK-004: one-shot response — never cache key in storedProviderKeys or providersLoaded
      this.postMessage({
        type: "providerCredentialLoaded",
        requestID: rid,
        providerID: pid,
        apiKey: auth.key,
        hasCredential: true,
      })
    } catch (err) {
      console.warn("[KiloProvider] load api key failed:", err instanceof Error ? err.message : String(err))
      return errReply("Unable to load API key")
    }
  }

  private async handleFetchCustomProviderModels(msg: Record<string, unknown>): Promise<void> {
    const rid = typeof msg.requestId === "string" ? msg.requestId : ""
    const url = typeof msg.baseURL === "string" ? msg.baseURL : ""
    if (!rid || !url) return
    if (this.canonicalConfig && !this.canonicalReady) {
      return this.postMessage({
        type: "customProviderModelsFetched",
        requestId: rid,
        error: "Canonical model discovery authority is not ready",
      })
    }
    if (
      this.canonicalConfig &&
      (typeof msg.apiKey === "string" || msg.headers !== undefined || !isCredentialFreeMetadata(msg))
    ) {
      return this.postMessage({
        type: "customProviderModelsFetched",
        requestId: rid,
        error: "Canonical model discovery payload contains credential-bearing data",
      })
    }
    let key = typeof msg.apiKey === "string" ? msg.apiKey : undefined
    const stamp = isCanonicalStamp(msg.stamp) ? msg.stamp : undefined
    if (this.canonicalConfig && (!stamp || !sameStamp(stamp, this.canonicalConfig.stamp) || stamp.assetHash !== null)) {
      return this.postMessage({
        type: "customProviderModelsFetched",
        requestId: rid,
        error: "Canonical provider stamp is stale or incomplete",
      })
    }
    if (this.canonicalConfig && msg.canonical === true && msg.credentialRequested === true) {
      key = (
        await vscode.window.showInputBox({
          password: true,
          prompt: "Enter provider credential for model discovery",
          ignoreFocusOut: true,
        })
      )?.trim()
    }
    if (!key && this.canonicalConfig && typeof msg.providerID === "string") {
      const scope = this.providerScope(msg.providerID)
      const provider = this.canonicalConfig.getScopeConfig(scope).provider
      const parsed = parseCanonicalProviderRecord(provider)
      const record = parsed?.[msg.providerID]
      const ref = record && typeof record.credential === "string" ? record.credential : undefined
      // Exact owned ref only — never reconstruct a derived key as fallback.
      if (ref) key = await this.canonicalConfig.resolveSecret(ref)
    }
    if (!key && !this.canonicalConfig) key = resolveStoredKey(this.storedProviderKeys, msg.providerID, url)
    // Canonical mode never passes headers — they are host-only credential data
    const headers = this.canonicalConfig
      ? undefined
      : msg.headers && typeof msg.headers === "object"
        ? (msg.headers as Record<string, string>)
        : undefined
    try {
      const models = await fetchOpenAIModels({ baseURL: url, apiKey: key, headers })
      this.postMessage({ type: "customProviderModelsFetched", requestId: rid, models })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch models"
      const auth = err instanceof FetchModelsError && err.auth
      this.postMessage({ type: "customProviderModelsFetched", requestId: rid, error: message, auth })
    }
  }

  /**
   * Fetch agents (modes) from the backend and send to webview.
   */
  private async fetchAndSendAgents(): Promise<void> {
    if (this.canonicalConfig) {
      await this.sendCanonicalAgents()
      return
    }
    if (!this.client) {
      if (this.cachedAgentsMessage) {
        this.postMessage(this.cachedAgentsMessage)
      }
      return
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory()
      const { data: agents } = await retry(() =>
        this.client!.app.agents({ directory: workspaceDir }, { throwOnError: true }),
      )

      const { visible, defaultAgent } = filterVisibleAgents(agents)

      const message = {
        type: "agentsLoaded",
        agents: visible.map(mapAgent),
        allAgents: agents.map(mapAgent),
        defaultAgent,
      }
      this.cachedAgentsMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to fetch agents:", error)
    }
  }

  private async fetchAndSendSkills(): Promise<void> {
    if (!this.client) {
      if (this.cachedSkillsMessage) {
        this.postMessage(this.cachedSkillsMessage)
      }
      return
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory()
      const { data: skills } = await retry(() =>
        this.client!.app.skills({ directory: workspaceDir }, { throwOnError: true }),
      )

      const message = {
        type: "skillsLoaded",
        skills,
      }
      this.cachedSkillsMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to fetch skills:", error)
    }
  }

  private clearCommandsCache(): void {
    this.cachedCommandsMessage = null
    clearCommandsCache()
  }

  private async fetchAndSendCommands(): Promise<void> {
    if (!this.client) {
      if (this.cachedCommandsMessage) {
        this.postMessage(this.cachedCommandsMessage)
      }
      return
    }

    try {
      const dir = this.getWorkspaceDirectory()
      const message = await loadCommands(this.client, dir)

      this.cachedCommandsMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to fetch commands:", error)
    }
  }

  /**
   * Remove a skill via the CLI backend (deletes from disk + clears cache), then refresh.
   * Returns true on success, false on failure.
   * On failure, re-fetches skills so the webview reverts to the authoritative state.
   */
  private async removeSkillViaCli(location: string): Promise<boolean> {
    if (!this.client) return false
    try {
      const dir = this.getWorkspaceDirectory()
      const result = await this.client.kilocode.removeSkill({ location, directory: dir })
      if (result.error) {
        console.error("[Kilo New] removeSkill returned error:", result.error)
        this.cachedSkillsMessage = null
        this.clearCommandsCache()
        await Promise.all([this.fetchAndSendSkills(), this.fetchAndSendCommands()])
        return false
      }
    } catch (error) {
      console.error("[Kilo New] Failed to remove skill:", error)
      this.cachedSkillsMessage = null
      this.cachedCommandsMessage = null
      await Promise.all([this.fetchAndSendSkills(), this.fetchAndSendCommands()])
      return false
    }
    this.cachedSkillsMessage = null
    this.cachedCommandsMessage = null
    await Promise.all([this.fetchAndSendSkills(), this.fetchAndSendCommands()])
    this.requirements.clear()
    return true
  }

  /** Remove an agent via the CLI backend, then refresh. */
  private async handleRemoveAgent(
    name: string,
    scope: "global" | "project" = "project",
    expectedHash?: string,
    stamp?: CanonicalStamp,
  ): Promise<void> {
    if (this.canonicalConfig) {
      if (!this.canonicalReady) {
        // Canonical authority exists but has not materialized yet — never fall
        // through to the legacy backend path.
        this.postMessage({
          type: "agentMutationError",
          requestId: crypto.randomUUID(),
          name,
          message: "Canonical agent authority is not ready",
          kind: "not-ready",
          canonical: true,
          stamp: this.canonicalConfig.stamp,
        })
        return
      }
      if (
        !stamp ||
        !sameStamp(stamp, {
          ...this.canonicalConfig.stamp,
          assetHash: this.canonicalConfig.getAssetStamp("agent", name, scope),
        })
      ) {
        this.postMessage({
          type: "agentMutationError",
          requestId: crypto.randomUUID(),
          name,
          message: "Agent composite stamp is required",
          kind: "stale",
          canonical: true,
          stamp: { ...this.canonicalConfig.stamp, assetHash: this.canonicalConfig.getAssetStamp("agent", name, scope) },
        })
        return
      }
      const result = await this.canonicalConfig.deleteAsset("agent", name, scope, stamp.assetHash ?? "absent")
      if (!result.ok)
        this.postMessage({
          type: "agentMutationError",
          requestId: crypto.randomUUID(),
          name,
          message: result.message,
          kind: result.kind,
          canonical: true,
          stamp: { ...this.canonicalConfig.stamp, assetHash: this.canonicalConfig.getAssetStamp("agent", name, scope) },
        })
      else void this.sendCanonicalAgents()
      return
    }
    if (!this.client) return
    try {
      const result = await this.client.kilocode.removeAgent({ name, directory: this.getWorkspaceDirectory() })
      if (result.error) {
        console.error("[Kilo New] removeAgent returned error:", result.error)
      }
    } catch (err) {
      console.error("[Kilo New] Failed to remove agent:", err)
    }
    this.cachedAgentsMessage = null
    await this.fetchAndSendAgents()
    this.requirements.clear()
  }

  private async handleCanonicalAgentMutation(msg: Record<string, unknown>): Promise<void> {
    const service = this.canonicalConfig
    const id = typeof msg.name === "string" ? msg.name : ""
    const requestId = typeof msg.requestId === "string" ? msg.requestId : crypto.randomUUID()
    if (!service || !this.canonicalReady) {
      this.postMessage({
        type: "agentMutationError",
        requestId,
        name: id,
        message: "Canonical agent authority is not ready",
        kind: "not-ready",
        canonical: true,
        stamp: {
          ...(service?.stamp ?? { globalHash: null, projectHash: null, materializationVersion: 0, assetHash: null }),
          assetHash: null,
        },
      })
      return
    }
    if (!id || !isRecord(msg.frontmatter) || typeof msg.body !== "string") return
    const scope = msg.scope === "global" ? "global" : "project"
    const expectedHash = typeof msg.expectedHash === "string" ? msg.expectedHash : ""
    const stamp = isCanonicalStamp(msg.stamp) ? msg.stamp : undefined
    const current = { ...service.stamp, assetHash: service.getAssetStamp("agent", id, scope) }
    if (!stamp || !expectedHash || stamp.assetHash !== expectedHash || !sameStamp(stamp, current)) {
      this.postMessage({
        type: "agentMutationError",
        requestId,
        name: id,
        message: "Agent draft is stale",
        kind: "stale",
        canonical: true,
        stamp: current,
      })
      return
    }
    const result = await service.writeAsset("agent", id, msg.frontmatter, msg.body, scope, expectedHash)
    if (!result.ok) {
      this.postMessage({
        type: "agentMutationError",
        requestId,
        name: id,
        message: result.message,
        kind: result.kind,
        canonical: true,
        stamp: current,
      })
      return
    }
    this.postMessage({
      type: "agentMutationApplied",
      requestId,
      name: id,
      contentHash: result.contentHash,
      stamp: { ...service.stamp, assetHash: result.contentHash },
      canonical: true,
    })
    void this.sendCanonicalAgents()
  }

  private async handleRemoveMcp(
    name: string,
    msg?: { canonical?: boolean; scope?: "global" | "project"; expectedHash?: string; stamp?: unknown },
  ): Promise<void> {
    if (this.canonicalConfig) {
      if (!this.canonicalReady) {
        // Canonical authority exists but has not materialized yet — never fall
        // through to the legacy backend path.
        console.error("[Kilo New] KiloProvider: Canonical MCP removal rejected before canonical readiness")
        return
      }
      const service = this.canonicalConfig
      const stamp = isCanonicalStamp(msg?.stamp) ? msg.stamp : undefined
      const expected = typeof msg?.expectedHash === "string" ? msg.expectedHash : undefined
      const scope = msg?.scope === "global" || msg?.scope === "project" ? msg.scope : undefined
      // Strict identity: the request must carry an explicit legal scope. Never
      // fall back to a default scope when scope is missing or invalid, and never
      // proceed without a matching stamp — report a structured failure instead.
      if (
        msg?.canonical !== true ||
        !scope ||
        !stamp ||
        !expected ||
        !sameStamp(stamp, service.stamp) ||
        stamp.assetHash !== null
      ) {
        console.error("[Kilo New] KiloProvider: Canonical MCP removal rejected as stale")
        this.postMessage({
          type: "mcpCleanupError",
          name,
          scope,
          retryID: "",
          stamp: service.stamp,
          message: "MCP removal rejected: canonical scope or stamp is missing or invalid",
        })
        return
      }
      const current = service.getScopeConfig(scope)
      const prior = isRecord(current.mcp) && isRecord(current.mcp[name]) ? current.mcp[name] : undefined
      const mcp = isRecord(current.mcp) ? { ...current.mcp } : {}
      delete mcp[name]
      const result = await service.writeConfigScopes({ [scope]: { patch: { mcp }, expectedHash: expected } }, stamp)
      if (!result.ok) {
        console.error("[Kilo New] KiloProvider: Canonical MCP removal failed:", result.message)
        return
      }
      // Host-owned cleanup: only the exact validated stored ref may be deleted.
      // Missing/invalid scope/stamp/ref produce a structured failure — never a
      // reconstructed `secret:kilo.credentials.<scope>.mcp.<name>` fallback.
      const priorRef = isRecord(prior) && typeof prior.credential === "string" ? prior.credential : undefined
      const owned = priorRef ? parseSecretKey(priorRef.slice("secret:".length)) : null
      if (!priorRef || !owned || owned.kind !== "mcp" || owned.id !== name || owned.scope !== scope) {
        this.postMessage({
          type: "mcpCleanupError",
          name,
          scope,
          retryID: "",
          stamp: service.stamp,
          message: "MCP deletion committed; prior record has no owned credential ref — no credential was removed",
        })
        return
      }
      const ref = priorRef
      try {
        await service.removeSecretRef(ref)
      } catch (error) {
        // Store the exact record for host-owned retry — webview cannot choose a
        // different ref. The retryID is operation-unique: overlapping cleanup
        // failures for the same MCP server get distinct records.
        const retryID = crypto.randomUUID()
        this.cleanupRetries.set(retryID, {
          kind: "mcp",
          scope,
          id: name,
          mode: "delete",
          ref,
          stamp: service.stamp,
          state: "available",
        })
        this.postMessage({
          type: "mcpCleanupError",
          name,
          scope,
          retryID,
          stamp: service.stamp,
          message: `MCP deletion committed; credential cleanup failed: ${String(error)}`,
        })
        return
      }
      this.sendCanonicalConfig("configUpdated")
      return
    }
    const removed = await removeMcp(this.removeConfigItemCtx, name)
    if (!removed) {
      console.error("[Kilo New] KiloProvider: Failed to remove MCP server:", name)
    }
  }

  private async retryCanonicalMcpCleanup(msg: Record<string, unknown>): Promise<void> {
    const service = this.canonicalConfig
    const requestId = typeof msg.requestId === "string" ? msg.requestId : crypto.randomUUID()
    const retryID = typeof msg.retryID === "string" ? msg.retryID : ""
    // Request carries the opaque retryID only; the stored record is the sole
    // authority for scope/name/ref — never accept webview-provided identity.
    const stored = retryID ? this.cleanupRetries.get(retryID) : undefined
    if (
      !service ||
      !this.canonicalReady ||
      !stored ||
      stored.kind !== "mcp" ||
      stored.state !== "available" ||
      !sameStamp(stored.stamp, service.stamp)
    ) {
      this.postMessage({
        type: "mcpCleanupRetryResult",
        requestId,
        name: stored?.id ?? "",
        ok: false,
        message: "MCP cleanup retry is stale",
        stamp: service?.stamp,
      })
      return
    }
    const name = stored.id
    const scope = stored.scope
    // Exact stored identity: the record must carry an owned ref matching scope/mcp/name.
    const ref = stored.ref
    const parsed = ref && ref.startsWith("secret:") ? parseSecretKey(ref.slice("secret:".length)) : null
    if (!parsed || parsed.kind !== "mcp" || parsed.id !== name || parsed.scope !== scope || !ref) {
      this.postMessage({
        type: "mcpCleanupRetryResult",
        requestId,
        name,
        ok: false,
        message: "MCP cleanup retry has invalid stored record",
        stamp: service.stamp,
      })
      return
    }
    // P4.1 target-level reservation: a concurrent distinct retry with the same
    // validated (kind, scope, id, ref) target must not side-effect twice.
    const targetKey = this.cleanupTargetKey("mcp", scope, name, ref)
    const owner = this.cleanupTargets.get(targetKey)
    if (owner && owner !== retryID) {
      this.postMessage({
        type: "mcpCleanupRetryResult",
        requestId,
        name,
        ok: false,
        message: "MCP cleanup retry target is already in flight",
        stamp: service.stamp,
      })
      return
    }
    // Reserve atomically BEFORE the side effect — a concurrent duplicate retry
    // sees inFlight/absent and cannot side-effect twice.
    this.cleanupRetries.set(retryID, { ...stored, state: "inFlight" })
    this.cleanupTargets.set(targetKey, retryID)
    try {
      await service.removeSecretRef(ref)
      // Success: consume the record and release the target reservation — one-shot.
      this.cleanupRetries.delete(retryID)
      this.cleanupTargets.delete(targetKey)
      this.postMessage({ type: "mcpCleanupRetryResult", requestId, name, ok: true, stamp: service.stamp })
    } catch (error) {
      // Lossless restoration: restore the exact full record unchanged so the
      // operation can be retried later. Never reconstruct from webview fields.
      // Release the target reservation so a distinct retry ID can retry.
      this.cleanupRetries.set(retryID, { ...stored, state: "available" })
      this.cleanupTargets.delete(targetKey)
      this.postMessage({
        type: "mcpCleanupRetryResult",
        requestId,
        name,
        ok: false,
        message: String(error),
        stamp: service.stamp,
      })
    }
  }

  private async refreshMcpStatus(): Promise<void> {
    await this.fetchAndSendMcpStatus()
    this.requirements.clear()
  }

  private async fetchAndSendMcpStatus(): Promise<void> {
    if (!this.client) {
      if (this.cachedMcpStatusMessage) {
        this.postMessage(this.cachedMcpStatusMessage)
      }
      return
    }

    try {
      const directory = this.getWorkspaceDirectory()
      const { data } = await retry(() => this.client!.mcp.status({ directory }))
      if (data) {
        const message = { type: "mcpStatusLoaded", status: data }
        this.cachedMcpStatusMessage = message
        this.postMessage(message)
      }
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to fetch MCP status:", error)
    }
  }

  /**
   * Fetch backend config and send to webview.
   *
   * LOCK-002: captures the client identity, connection generation, and shared
   * config revision BEFORE any reads. Every cache mutation/post verifies the
   * provider is not disposed, still on the same client/generation, and the
   * revision has not advanced; a stale result is dropped silently — the
   * current reconcile/connect path owns the refetch. The `pending > 0` guard
   * keeps this fetch out of an in-flight handleUpdateConfig write so it never
   * races with a pending save/draft.
   */
  private async fetchAndSendConfig(): Promise<void> {
    if (this.canonicalConfig) {
      this.sendCanonicalConfig("configLoaded")
      return
    }
    const client = this.client
    if (!client || this.connectionState !== "connected") {
      if (this.cachedConfigMessage) {
        this.postMessage(this.cachedConfigMessage)
      }
      return
    }

    // Skip if handleUpdateConfig is in flight — sending a configLoaded now
    // would race with the write and potentially overwrite optimistic webview state.
    if (this.pending > 0) {
      return
    }

    // LOCK-002: lifecycle snapshot captured before the reads. A reconnect
    // (new client/generation) or a config revision advance while the fetch is
    // held makes the result stale — it must never mutate the cache or post.
    const generation = this.connectionGeneration
    const revision = this.connectionService.getConfigRevision()

    try {
      const workspaceDir = this.getWorkspaceDirectory()
      const [{ data: config }, { data: global }, { data: overlay }] = await Promise.all([
        retry(() => client.config.get({ directory: workspaceDir }, { throwOnError: true })),
        client.global.config.get({ throwOnError: true }),
        client.config.overlay({ directory: workspaceDir, scope: "project" }, { throwOnError: true }),
      ])
      // LOCK-002: drop stale results immediately before every cache mutation/post.
      if (!this.configGuard(client, generation, revision)) {
        return
      }

      const message = {
        type: "configLoaded",
        config,
        globalConfig: global,
        projectConfig: overlay?.project,
        settings: { maxCost: this.maxCostSetting() },
        features: configFeatures(),
      }
      this.cachedConfigMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to fetch config:", error)
    }
  }

  /** Fetch global-only config (no project/managed layers) for settings export. */
  private async fetchAndSendGlobalConfig(): Promise<void> {
    if (this.canonicalConfig) {
      this.sendCanonicalConfig("configLoaded")
      return
    }
    if (!this.client || this.connectionState !== "connected") return
    try {
      const { data: config } = await this.client.global.config.get({ throwOnError: true })
      this.postMessage({ type: "globalConfigLoaded", config })
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to fetch global config:", error)
    }
  }

  private async fetchAndSendImageModels(): Promise<void> {
    const dir = this.getWorkspaceDirectory()
    const result = await fetchImageModels(this.connectionService, dir)
    if (!result.ok) {
      if (this.cachedImageModelsMessage) {
        this.postMessage(this.cachedImageModelsMessage)
      }
      return
    }
    const message = { type: "imageModelsLoaded" as const, models: result.models }
    this.cachedImageModelsMessage = message
    this.postMessage(message)
  }

  /**
   * Seed sessionStatusMap with current session statuses on connect.
   * Without this, the Settings panel (which has no tracked sessions) would see
   * busyCount() = 0 for sessions that were already running before it opened.
   *
   * @param reconcile When true, reset locally-busy sessions absent from the
   *   server response to idle (crash recovery). Set to false on SSE reconnects
   *   to avoid a race where a brief HTTP fetch gap causes the spinner to vanish.
   */
  private async seedSessionStatusMap(reconcile = true): Promise<void> {
    if (!this.client || this.connectionState !== "connected") return
    const dir = this.getWorkspaceDirectory()
    // SDK-first: the SDK result seeds the map and drives reconcile; the
    // private carrier only observes parity and never overrides the SDK.
    await seedSessionStatuses(this.client, dir, this.sessionStatusMap, (msg) => this.postMessage(msg), reconcile, {
      connection: this.connectionService,
    })
  }

  /**
   * Fetch config warnings from the server and display a single consolidated
   * VS Code warning with a "Show Details" action button.
   * Only shown once per provider lifecycle (flag resets on dispose/re-create, not on SSE reconnect).
   */
  private async checkConfigWarnings(from: string): Promise<void> {
    if (this.configWarningsShown) {
      console.log("[Kilo New] KiloProvider: config warnings already shown", { from })
      return
    }
    if (!this.client) {
      console.log("[Kilo New] KiloProvider: config warnings skipped (no client)", { from })
      return
    }
    try {
      const dir = this.getWorkspaceDirectory()
      console.log("[Kilo New] KiloProvider: checking config warnings", { from })
      const result = await this.client.config.warnings({ directory: dir })
      const list = result?.data ?? []
      console.log("[Kilo New] KiloProvider: config warnings fetched", { from, count: list.length })
      // Detached SDK-first private parity: SDK stays the sole authority.
      // The observer is non-blocking and warn-only; it never touches the
      // warning UI, the once-per-lifecycle flag, or error handling.
      // The settled SDK error (if any) is forwarded so failed-vs-failed
      // agreement holds; list stays `result.data ?? []` with UI unchanged.
      observeConfigWarningsParity(
        {
          data: list,
          error: (result as unknown as { error?: unknown })?.error,
          response: (result as unknown as { response?: unknown })?.response,
        },
        dir,
      )
      if (list.length === 0) return
      this.configWarningsShown = true

      const first = list[0]!
      const summary = list.length === 1 ? first.message : `${first.message} (and ${list.length - 1} more)`
      console.warn("[Kilo New] KiloProvider: showing config warnings", { from, count: list.length })

      const action = await vscode.window.showWarningMessage(`Config: ${summary}`, "Show Details")
      if (action === "Show Details") {
        const lines = list.map((w) => {
          const base = `${w.path}\n  ${w.message}`
          return w.detail ? `${base}\n  ${w.detail}` : base
        })
        const channel = vscode.window.createOutputChannel("Kilo Config Warnings")
        channel.clear()
        channel.appendLine(lines.join("\n\n"))
        channel.show()
      }
    } catch (err) {
      // Fail-closed redaction: the thrown SDK error may carry warning
      // payload content, so only fixed fields are logged.
      observeConfigWarningsParity({ error: err }, this.getWorkspaceDirectory())
      console.warn("[Kilo New] KiloProvider: checkConfigWarnings failed:", { from, failed: true })
    }
  }

  /** Read attention settings from VS Code config and push to webview. */
  private sendNotificationSettings(): void {
    const attention = vscode.workspace.getConfiguration("kilo-code.new.attention")
    this.postMessage({
      type: "notificationSettingsLoaded",
      settings: {
        attentionEnabled: attention.get<boolean>("enabled", false),
        attentionSound: attention.get<string>("sound", "default"),
      },
    })
  }

  private sendTimelineSetting(): void {
    const config = vscode.workspace.getConfiguration("kilo-code.new")
    this.postMessage({
      type: "timelineSettingLoaded",
      visible: config.get<boolean>("showTaskTimeline", true),
    })
  }

  private sendWorkStyle(): void {
    this.postMessage(getWorkStylePayload())
  }

  private async fetchAndSendSandboxDefault(directory = this.getContextDirectory(), requestID?: string): Promise<void> {
    const revision = ++this.sandboxRevision
    const generation = this.connectionGeneration
    const client = this.client
    const sandbox = sandboxClient(client)
    if (!client || !sandbox || this.connectionState !== "connected") return
    try {
      const [desired, result] = await Promise.all([
        sandboxDefault(this.connectionService.sandboxPreference, client, directory),
        sandbox.support({ directory }, { throwOnError: true }),
      ])
      if (this.connectionState !== "connected" || this.connectionGeneration !== generation || this.client !== client)
        return
      this.postMessage({
        type: "sandboxDefaultStatus",
        desired,
        enabled: desired && result.data.available,
        available: result.data.available,
        reason: result.data.reason,
        revision,
        requestID,
      })
    } catch (error) {
      if (this.connectionState !== "connected" || this.connectionGeneration !== generation || this.client !== client)
        return
      this.postMessage({
        type: "sandboxDefaultStatus",
        desired: false,
        enabled: false,
        available: false,
        reason: getErrorMessage(error) || "Failed to load sandbox default",
        revision,
        requestID,
      })
    }
  }

  private async handleSetSandboxDefault(
    enabled: boolean,
    requestID: string,
    directory = this.getContextDirectory(),
  ): Promise<void> {
    const client = this.client
    const sandbox = sandboxClient(client)
    if (!client || !sandbox || this.connectionState !== "connected") {
      await this.fetchAndSendSandboxDefault(directory, requestID)
      return
    }
    try {
      await this.connectionService.sandboxPreference.set(enabled, async () => {
        const { data } = await sandbox.support({ directory }, { throwOnError: true })
        if (!data.available) throw new Error(data.reason ?? "Sandbox backend is unavailable")
      })
      await this.fetchAndSendSandboxDefault(directory, requestID)
      vscode.window.showInformationMessage(
        enabled ? "Sandbox enabled for new sessions" : "Sandbox disabled for new sessions",
      )
    } catch (error) {
      this.postMessage({
        type: "sandboxDefaultStatus",
        desired: this.connectionService.sandboxPreference.resolve(false),
        enabled: false,
        available: false,
        reason: getErrorMessage(error) || "Failed to update sandbox default",
        revision: ++this.sandboxRevision,
        requestID,
      })
    }
  }

  private postSandboxError(sessionID: string, error: unknown, revision: number, requestID?: string): void {
    this.postMessage({
      type: "sandboxStatusError",
      sessionID,
      directory: this.getWorkspaceDirectory(sessionID),
      message: getErrorMessage(error) || "Failed to update sandbox",
      requestID,
      revision,
    })
  }

  private async fetchAndSendSandboxStatus(sessionID: string, requestID?: string): Promise<void> {
    const revision = ++this.sandboxRevision
    const generation = this.connectionGeneration
    const client = this.client
    const sandbox = client?.sandbox
    if (!sandbox?.status) return
    if (this.connectionState !== "connected") {
      this.postSandboxError(sessionID, "Not connected to CLI backend", revision, requestID)
      return
    }
    try {
      const directory = this.getWorkspaceDirectory(sessionID)
      const { data } = await sandbox.status({ sessionID, directory }, { throwOnError: true })
      if (this.connectionState !== "connected" || this.connectionGeneration !== generation || this.client !== client)
        return
      if (!sameDirectory(data.directory, this.getWorkspaceDirectory(sessionID))) {
        if (requestID) void this.fetchAndSendSandboxStatus(sessionID, requestID)
        return
      }
      this.postMessage({ type: "sandboxStatus", sessionID, revision, ...data, requestID })
    } catch (error) {
      if (this.connectionState !== "connected" || this.connectionGeneration !== generation || this.client !== client)
        return
      this.postSandboxError(sessionID, error, revision, requestID)
    }
  }

  private sandboxKey(input: {
    sessionID?: string
    draftID?: string
    agentManagerContext?: string
    contextDirectory?: string
  }): string {
    if (input.sessionID) return `session:${input.sessionID}`
    if (input.draftID) return `draft:${input.draftID}`
    return `context:${input.agentManagerContext ?? ""}:${input.contextDirectory ?? this.getRootDirectory()}`
  }

  private handleToggleSandbox(input: {
    sessionID?: string
    draftID?: string
    requestID: string
    agentManagerContext?: string
    contextDirectory?: string
  }): Promise<void> {
    const key = this.sandboxKey(input)
    const pending = this.sandboxTransitions.get(key)
    if (pending) return pending.catch(() => undefined)
    const operation = this.runToggleSandbox(input, key)
    this.sandboxTransitions.set(key, operation)
    return operation
      .catch(() => undefined)
      .finally(() => {
        for (const [id, active] of this.sandboxTransitions) {
          if (active === operation) this.sandboxTransitions.delete(id)
        }
      })
  }

  private async runToggleSandbox(
    input: {
      sessionID?: string
      draftID?: string
      requestID: string
      agentManagerContext?: string
      contextDirectory?: string
    },
    key: string,
  ): Promise<void> {
    const revision = ++this.sandboxRevision
    if (!input.sessionID) {
      const error = new Error("Sandbox session is required")
      this.postSandboxError("", error, revision, input.requestID)
      throw error
    }
    const generation = this.connectionGeneration
    const client = this.client
    const sandbox = client?.sandbox
    if (!sandbox?.toggle || this.connectionState !== "connected") {
      const error = new Error("Not connected to CLI backend")
      this.postSandboxError(input.sessionID ?? "", error, revision, input.requestID)
      throw error
    }
    const resolved = await this.resolveSession(
      input.sessionID,
      input.draftID,
      input.agentManagerContext,
      input.contextDirectory,
    ).catch((error) => {
      this.postSandboxError(input.sessionID ?? "", error, revision, input.requestID)
      throw error
    })
    if (!resolved) {
      const error = new Error("Failed to resolve sandbox session")
      this.postSandboxError(input.sessionID ?? "", error, revision, input.requestID)
      throw error
    }
    const operation = this.sandboxTransitions.get(key)
    if (operation) this.sandboxTransitions.set(`session:${resolved.sid}`, operation)
    if (this.connectionGeneration !== generation || this.client !== client) {
      throw new Error("Sandbox connection changed")
    }
    try {
      const { data } = await sandbox.toggle(
        { sessionID: resolved.sid, directory: resolved.dir },
        { throwOnError: true },
      )
      if (this.connectionState !== "connected" || this.connectionGeneration !== generation || this.client !== client) {
        throw new Error("Sandbox connection changed")
      }
      if (!data.available) throw new Error(data.reason ?? "Sandbox backend is unavailable")
      if (!sameDirectory(data.directory, this.getWorkspaceDirectory(resolved.sid))) {
        throw new Error("Session directory changed during sandbox toggle")
      }
      const remembered = await this.connectionService.sandboxPreference
        .set(data.enabled)
        .then(() => true)
        .catch((error) => {
          console.error("[Kilo New] Failed to persist sandbox default:", error)
          return false
        })
      this.postMessage({
        type: "sandboxStatus",
        sessionID: resolved.sid,
        revision,
        ...data,
        requestID: input.requestID,
      })
      if (!remembered) {
        vscode.window.showWarningMessage(
          `Sandbox ${data.enabled ? "enabled" : "disabled"} for this session, but the new-session default could not be saved`,
        )
        return
      }
      vscode.window.showInformationMessage(data.enabled ? "Sandbox enabled" : "Sandbox disabled")
    } catch (error) {
      if (this.connectionState === "connected" && this.connectionGeneration === generation && this.client === client) {
        this.postSandboxError(resolved.sid, error, revision, input.requestID)
        void this.fetchAndSendSandboxStatus(resolved.sid)
      }
      throw error
    }
  }

  private async handleUpdateConfig(
    partial: Partial<Config>,
    project: Partial<Config> = {},
    globalUnset: string[][] = [],
    projectUnset: string[][] = [],
    saveID?: string,
    stamp?: CanonicalStamp,
  ): Promise<void> {
    if (this.canonicalConfig) {
      // P4.1: legacy config mutations are rejected when canonical authority is
      // attached but not ready — no legacy mutation window is permitted.
      if (!this.canonicalReady) {
        this.postMessage({
          type: "configUpdateFailed",
          message: "Canonical config authority is not ready",
          kind: "not-ready",
          saveID,
          canonical: true,
          stamp: {
            ...(this.canonicalConfig?.stamp ?? {
              globalHash: null,
              projectHash: null,
              materializationVersion: 0,
              assetHash: null,
            }),
            assetHash: null,
          },
        })
        return
      }
      if (!stamp) return
      const canonicalPartial = toCanonicalPayload(partial) ?? {}
      const canonicalProject = toCanonicalPayload(project) ?? {}
      await this.handleCanonicalConfigUpdate(
        canonicalPartial,
        canonicalProject,
        globalUnset,
        projectUnset,
        saveID,
        stamp,
      )
      return
    }
    if (!this.client || this.connectionState !== "connected") {
      this.postMessage({
        type: "configUpdateFailed",
        message: "Not connected to CLI backend",
        ...(saveID && { saveID }),
      })
      return
    }

    const refreshProviders =
      partial.provider !== undefined ||
      partial.disabled_providers !== undefined ||
      partial.enabled_providers !== undefined ||
      partial.hide_prompt_training_models !== undefined
    const refreshAgents =
      partial.default_agent !== undefined ||
      partial.agent !== undefined ||
      project.default_agent !== undefined ||
      project.agent !== undefined
    const hasGlobal = Object.keys(partial).length > 0 || globalUnset.length > 0
    const hasProject = Object.keys(project).length > 0 || projectUnset.length > 0

    // LOCK-006: no drainPendingPrompts — settings save must not reject
    // permissions, questions, suggestions, or network waits.
    const dir = this.getWorkspaceDirectory()

    // LOCK-001: send exactly one transaction request for all requested scopes.
    // Do not send empty scopes; all requested scopes succeed/fail as one request.
    const txGlobal = hasGlobal ? { set: partial, unset: globalUnset } : undefined
    const txProject = hasProject ? { set: project, unset: projectUnset } : undefined

    // LOCK-004: pending guards only the mutation/ack lifecycle and decrements
    // exactly once in finally, so a synchronous post/ack error can never leak
    // it; detached refresh/reconcile runs after the guard is released.
    this.pending++
    let txResult: { global: Config; project: Config; effective: Config } | undefined
    try {
      const res = await this.client.config.transaction(
        { directory: dir, global: txGlobal, project: txProject },
        { throwOnError: true },
      )
      txResult = res.data

      // LOCK-002: build immediate configUpdated directly from authoritative
      // transaction response {global, project, effective}. No local
      // reconstruction needed.
      this.postMessage({
        type: "configUpdated",
        config: txResult.effective,
        globalConfig: txResult.global,
        projectConfig: txResult.project,
        settings: { maxCost: this.maxCostSetting() },
        features: configFeatures(),
        ...(saveID && { saveID }),
      })
      this.requirements.clear()

      // LOCK-001: the immediate ack above is the authoritative save response,
      // but the revision is NOT advanced here — the connection service's SSE
      // dispatch owns revision advancement via the canonical
      // global.config.updated echo (one logical revision per transaction,
      // keyed by its transaction id, LOCK-004). queueReconcile below is the
      // deduplicated revision path for the rare case the echo is absent; it is
      // a no-op when the echo's advance already triggered a reconcile.
      void this.queueReconcile()
    } catch (error) {
      // LOCK-003: real backend detail; the webview keeps its draft/optimistic
      // state per the current failure contract — never claim success.
      this.postConfigFailure(error, saveID)
      return
    } finally {
      this.pending--
    }

    // Provider/agent pickers refresh independently; never blocks the ack.
    const refresh = async () => {
      if (refreshProviders) {
        await this.fetchAndSendProviders().catch((error) =>
          console.error("[Kilo New] KiloProvider: provider refresh after config save failed:", error),
        )
      }
      if (refreshAgents) {
        await this.fetchAndSendAgents().catch((error) =>
          console.error("[Kilo New] KiloProvider: agent refresh after config save failed:", error),
        )
      }
    }
    void refresh()
  }

  /** Bounded backoff for reconciliation retries: 1s, 2s, 5s, 10s, 30s (LOCK-003). */
  private static readonly RECONCILE_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
  private reconcileRetryTimer: (() => void) | null = null
  private reconcileRetryAttempt = 0

  /** Outcome of one reconciliation fetch; drives the retry state machine (LOCK-003/004/005). */
  private static readonly defaultScheduleRetry: (delayMs: number, fn: () => void) => () => void = (delay, fn) => {
    const timer = setTimeout(fn, delay)
    return () => clearTimeout(timer)
  }

  /**
   * Schedule a detached config reconciliation (LOCK-003/004/005):
   * - One fetch is in flight per provider at a time; further requests coalesce
   *   into it (they will re-run stale for the latest revision if needed).
   * - The dedupe key is the shared revision: a revision the last successful
   *   reconcile already covered is never re-fetched, so a local save whose
   *   canonical SSE echo advances the revision produces exactly one fetch.
   * - Real fetch failures enter the single bounded backoff path
   *   (1/2/5/10/30s) — never an immediate resolved-false loop.
   * - Starting, succeeding, or being superseded cancels obsolete retry timers
   *   and resets attempts appropriately.
   * - No-op after provider disposal (LOCK-004).
   */
  private queueReconcile(): void {
    if (this.canonicalConfig) return
    if (this.disposed) return
    if (this.reconcileInFlight) return
    const client = this.client
    if (!client || this.connectionState !== "connected") return
    const revision = this.connectionService.getConfigRevision()
    // LOCK-001/002: never re-fetch a revision the last successful reconcile
    // already covered — the canonical echo of a local save advances exactly
    // once, and this dedupe makes that advance the single fetch trigger.
    if (revision === this.lastReconcileRevision) return
    // LOCK-003: starting or being superseded by a newer revision cancels any
    // obsolete retry timer and restarts the attempt sequence.
    this.cancelReconcileRetry()
    this.reconcileRetryAttempt = 0
    this.startReconcile(revision, client)
  }

  /** Begin one reconciliation fetch for the given revision/lifecycle snapshot. */
  private startReconcile(revision: number, client: KiloClient): void {
    const seq = ++this.reconcileSeq
    this.reconcileInFlight = { seq }
    void this.reconcileConfig(seq, revision, this.connectionGeneration, client).then(
      (result) => {
        if (this.reconcileInFlight?.seq !== seq) return
        this.reconcileInFlight = null
        if (result === "ok") {
          // Success — cancel any obsolete retry timer and record the covered revision.
          this.cancelReconcileRetry()
          this.reconcileRetryAttempt = 0
          this.lastReconcileRevision = revision
        } else if (result === "failed") {
          // LOCK-003: real failure — exactly one bounded backoff path.
          this.scheduleReconcileRetry()
        } else {
          // Stale — a newer revision/lifecycle superseded this fetch. Schedule
          // only the latest needed attempt, never an immediate failure loop.
          this.queueReconcile()
        }
      },
      () => {
        // Defensive: reconcileConfig catches its own failures, but an
        // unexpected rejection must not leave the machine stuck.
        if (this.reconcileInFlight?.seq !== seq) return
        this.reconcileInFlight = null
        this.scheduleReconcileRetry()
      },
    )
  }

  /**
   * Schedule a bounded backoff retry for a failed reconciliation (LOCK-003).
   * The timer is created through the injectable scheduler (tests use a fake
   * clock; production defaults to setTimeout/clearTimeout) and is canceled by
   * cancelReconcileRetry on success, supersession, or disposal (LOCK-004).
   * The retry callback continues the SAME revision's attempt sequence — it
   * must not reset the backoff counter, or the 1/2/5/10/30s schedule would
   * never escalate.
   */
  private scheduleReconcileRetry(): void {
    this.cancelReconcileRetry()
    const attempt = this.reconcileRetryAttempt
    const delay = KiloProvider.RECONCILE_BACKOFF_MS[Math.min(attempt, KiloProvider.RECONCILE_BACKOFF_MS.length - 1)]
    this.reconcileRetryAttempt = attempt + 1
    const schedule = this.opts.scheduleRetry ?? KiloProvider.defaultScheduleRetry
    this.reconcileRetryTimer = schedule(delay, () => {
      this.reconcileRetryTimer = null
      const client = this.client
      if (this.disposed || !client || this.connectionState !== "connected") return
      // Defensive dedupe: if a successful reconcile covered this revision in
      // the meantime, there is nothing left to fetch.
      if (this.connectionService.getConfigRevision() === this.lastReconcileRevision) return
      this.startReconcile(this.connectionService.getConfigRevision(), client)
    })
  }

  /** Cancel any pending reconciliation retry timer (LOCK-003/004). */
  private cancelReconcileRetry(): void {
    this.reconcileRetryTimer?.()
    this.reconcileRetryTimer = null
  }

  /**
   * Fetch fresh config and push it as configUpdated once it is safe to do so
   * (LOCK-005): the sequence, shared revision, provider lifecycle epoch, and
   * connection generation are rechecked immediately before every cache
   * mutation and postMessage. Stale results return "stale" (never post), real
   * failures return "failed" (bounded backoff), success returns "ok".
   */
  private async reconcileConfig(
    seq: number,
    revision: number,
    generation: number,
    client: KiloClient,
  ): Promise<"ok" | "stale" | "failed"> {
    if (this.canonicalConfig) return "stale"
    try {
      const dir = this.getWorkspaceDirectory()
      const [{ data: merged }, { data: global }, { data: overlay }] = await Promise.all([
        retry(() => client.config.get({ directory: dir }, { throwOnError: true })),
        client.global.config.get({ throwOnError: true }),
        client.config.overlay({ directory: dir, scope: "project" }, { throwOnError: true }),
      ])
      // LOCK-005: drop stale results immediately before every cache mutation/post.
      if (!this.reconcileGuard(seq, revision, generation, client)) return "stale"
      this.cachedConfigMessage = {
        type: "configLoaded",
        config: merged,
        globalConfig: global,
        projectConfig: overlay?.project,
        settings: { maxCost: this.maxCostSetting() },
        features: configFeatures(),
      }
      this.postMessage({
        type: "configUpdated",
        config: merged,
        globalConfig: global,
        projectConfig: overlay?.project,
        settings: { maxCost: this.maxCostSetting() },
        features: configFeatures(),
      })
      return "ok"
    } catch (error) {
      // LOCK-004: a fetch that was superseded while in flight is not an error
      // and must not enter the backoff path; only real failures do.
      if (!this.reconcileGuard(seq, revision, generation, client)) return "stale"
      console.error("[Kilo New] KiloProvider: Config persisted but post-write reconciliation failed:", error)
      return "failed"
    }
  }

  /**
   * LOCK-004/005: true while this reconciliation attempt may still mutate the
   * cache and post — not disposed, still the newest attempt, same shared
   * revision, same provider lifecycle epoch, and same live client (a backend
   * reconnect replaces the client, so a held fetch across a reconnect goes
   * stale and never posts).
   */
  private reconcileGuard(seq: number, revision: number, generation: number, client: KiloClient): boolean {
    return (
      !this.disposed &&
      seq === this.reconcileSeq &&
      revision === this.connectionService.getConfigRevision() &&
      generation === this.connectionGeneration &&
      this.client === client
    )
  }

  /**
   * LOCK-002: true while an ordinary fetchAndSendConfig result may still
   * mutate the cache and post — not disposed, same live client (a backend
   * reconnect replaces it, so a held fetch across a reconnect goes stale),
   * same lifecycle epoch, and the shared config revision has not advanced.
   * A stale result is dropped; the reconcile/connect path owns the refetch.
   */
  private configGuard(client: KiloClient, generation: number, revision: number): boolean {
    return (
      !this.disposed &&
      this.client === client &&
      this.connectionGeneration === generation &&
      this.connectionService.getConfigRevision() === revision
    )
  }

  private postConfigFailure(error: unknown, saveID?: string): void {
    console.error("[Kilo New] KiloProvider: Failed to update config:", error)
    this.postMessage({
      type: "configUpdateFailed",
      message: getErrorMessage(error) || "Failed to update config",
      details: getConfigErrorDetails(error),
      ...(saveID && { saveID }),
    })
  }
  private async resolveSession(sessionID?: string, draftID?: string, context?: string, contextDirectory?: string) {
    if (!this.client) return undefined

    const dir = resolveNewSessionDirectory({
      sessionID,
      currentSessionID: this.currentSession?.id,
      contextSessionID: this.contextSessionID,
      agentManagerContext: context,
      contextDirectory,
      sessionDirectories: this.sessionDirectories,
      workspaceDirectory: this.getRootDirectory(),
    })

    const key = `${draftID ?? context ?? "new"}\0${dir}`
    const now = Date.now()
    for (const [draft, session] of this.draftSessions) {
      if (session.expires <= now) this.draftSessions.delete(draft)
    }
    if (!sessionID && draftID) {
      const resolved = this.draftSessions.get(key)
      if (resolved) {
        this.trackedSessionIds.add(resolved.sid)
        return { sid: resolved.sid, dir: resolved.dir }
      }
    }

    if (!sessionID && (draftID || !this.currentSession)) {
      const pending = this.sessionCreations.get(key)
      if (pending) return pending
      if (draftID) this.creatingDrafts.add(draftID)
      const creation = (async () => {
        const metadata = await sandboxSessionMetadata(this.connectionService.sandboxPreference, this.client!, dir)
        const { data: session } = await this.client!.session.create(
          { directory: dir, platform: this.opts.platform, metadata },
          { throwOnError: true },
        )
        if (draftID && this.closedDrafts.delete(draftID)) {
          await this.client!.session.delete({ sessionID: session.id, directory: dir }, { throwOnError: true })
          return undefined
        }
        const detail = sdkSessionToDetail(session as Session)
        this.stopCurrentSessionProcesses(detail.id)
        this.setCurrentSession(detail)
        this.contextSessionID = detail.id
        this.focusSession(detail.id)
        this.trackDirectory(detail.id, dir)
        this.trackedSessionIds.add(detail.id)
        this.postMessage({
          type: "sessionCreated",
          session: this.sessionToWebview(detail),
          draftID,
        })
        const resolved = { sid: session.id, dir }
        if (draftID) this.draftSessions.set(key, { ...resolved, expires: Date.now() + 60_000 })
        return resolved
      })().finally(() => {
        this.sessionCreations.delete(key)
        if (draftID) this.creatingDrafts.delete(draftID)
      })
      this.sessionCreations.set(key, creation)
      return creation
    }

    const sid = sessionID || this.currentSession?.id
    if (!sid) throw new Error("No session available")
    this.trackedSessionIds.add(sid)
    return { sid, dir }
  }

  /** Drafts closed while their backend session is being created or submitted. */
  private closedDrafts = new Set<string>()
  private creatingDrafts = new Set<string>()

  /** Abort controllers for active retry loops, keyed by session ID */
  private retryAbortControllers = new Map<string, AbortController>()

  /** Execute an SDK call with visible exponential backoff for retryable HTTP errors. */
  private async withRetry(
    fn: () => Promise<{ error?: unknown; response?: Response }>,
    sid: string,
    messageID?: string,
  ): Promise<void> {
    const abortController = new AbortController()
    this.retryAbortControllers.set(sid, abortController)

    try {
      for (let attempt = 1; ; attempt++) {
        if (abortController.signal.aborted) {
          // User cancelled — return normally without triggering sendMessageFailed
          return
        }

        const result = await fn()
        if (!result.error) return
        if (this.confirmations.has(messageID)) return

        const status = result.response?.status ?? 0

        // Non-retryable status codes fail immediately without retry
        if (!retryable(status)) {
          this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
          throw result.error
        }

        // Stop retrying after MAX_RETRIES attempts
        if (attempt >= MAX_RETRIES) {
          this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
          throw result.error
        }

        const delay = backoff(attempt, result.response?.headers)
        console.log(`[Kilo New] KiloProvider: Retry on ${status}, attempt ${attempt}/${MAX_RETRIES}, delay ${delay}ms`)

        this.postMessage({
          type: "sessionStatus",
          sessionID: sid,
          status: "retry",
          attempt,
          message: `Error (${status}). Retrying...`,
          next: Date.now() + delay,
        })

        // Wait for delay or until aborted
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            abortController.signal.removeEventListener("abort", done)
            resolve()
          }
          const timer = setTimeout(done, delay)
          abortController.signal.addEventListener("abort", done, { once: true })
        })
        if (this.confirmations.has(messageID)) return
      }
    } finally {
      this.retryAbortControllers.delete(sid)
    }
  }

  /** Cancel an active retry loop for a session */
  private cancelRetry(sid: string): void {
    const controller = this.retryAbortControllers.get(sid)
    if (controller) {
      controller.abort()
      this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
    }
  }

  private maxCostSetting(): number {
    return this.setMaxCost(vscode.workspace.getConfiguration("kilo-code.new").get<number>("maxCost", 0))
  }

  private setMaxCost(value: unknown): number {
    maxCost = MaxCostNudge.normalizeLimit(typeof value === "number" ? value : Number(value)) ?? 0
    this.costs.setLimit(maxCost)
    return maxCost
  }

  private costLimit(): number | undefined {
    const limit = maxCost
    this.costs.setLimit(limit)
    return this.costs.limit
  }

  private requestCostAlert(sid: string, cost: number): void {
    const limit = this.costLimit()
    if (limit === undefined || !Number.isFinite(cost) || cost < limit) return

    this.costs.setSessionCost(sid, cost)
    const alert = this.costs.check(sid)
    if (!alert) return
    this.activeAlerts.set(sid, alert.limit)
    this.postMessage({
      type: "sessionCostAlert",
      sessionID: sid,
      limit: alert.limit,
      cost: MaxCostNudge.formatCost(alert.cost),
    })
  }

  private async handleCostAlertResponse(sid: string, limit: number, response: MaxCostChoice): Promise<void> {
    this.activeAlerts.delete(sid)
    this.costs.resolve(sid, response, limit)
    if (response !== "continue") await this.handleAbort(sid)
    this.postMessage({ type: "sessionCostAlertResolved", sessionID: sid, limit })
  }

  private resetMessageCosts(
    sid: string,
    messages: Array<{ id: string; sessionID: string; role?: string; cost?: number }>,
  ) {
    const total = this.costs.resetMessageCosts(sid, messages)
    this.requestCostAlert(sid, total)
  }

  private updateMessageCost(
    sid: string,
    id: string,
    role: string | undefined,
    cost: number | undefined,
  ): number | undefined {
    if (role !== "assistant" || !Number.isFinite(cost)) return undefined
    return this.costs.updateMessageCost(sid, id, role, cost)
  }

  private removeMessageCost(id: string): void {
    this.costs.removeMessageCost(id)
  }

  private async handleSendMessage(
    text: string,
    messageID?: string,
    sessionID?: string,
    draftID?: string,
    providerID?: string,
    modelID?: string,
    agent?: string,
    variant?: string,
    files?: MessageFile[],
    review?: ReviewMessageData,
    context?: string,
    contextDirectory?: string,
  ): Promise<void> {
    if (!this.client) {
      this.postMessage({
        type: "sendMessageFailed",
        error: "Not connected to CLI backend",
        text,
        sessionID,
        draftID,
        messageID,
        files,
        review,
      })
      return
    }

    let resolved: { sid: string; dir: string } | undefined
    try {
      const sandbox = this.sandboxTransitions.get(
        this.sandboxKey({ sessionID, draftID, agentManagerContext: context, contextDirectory }),
      )
      resolved = await this.resolveSession(sessionID, draftID, context, contextDirectory)
      if (!resolved) return
      if (sandbox) await sandbox
      const sid = resolved.sid
      const dir = resolved.dir

      const parts: Array<TextPartInput | FilePartInput> = []
      if (files) {
        for (const f of files) {
          parts.push({ type: "file", mime: f.mime, url: f.url, filename: f.filename, source: f.source })
        }
      }
      parts.push({ type: "text", text, metadata: review ? reviewMetadata(review) : undefined })

      await this.requirements.assertAgentRequirements(agent, dir)
      const editorContext = await this.gatherEditorContext(dir)
      if (draftID && this.closedDrafts.delete(draftID)) {
        for (const [k, v] of this.draftSessions) if (v.sid === sid) this.draftSessions.delete(k)
        return
      }

      // P0 perf: record the submit after session resolution so new-session
      // first turns carry the resolved session id; `messageID` (the user
      // message id) is the join key to `model.firstEvent`'s `parentID`.
      p0Stage("prompt.submit", {
        sessionID: sid,
        messageID,
        draftID,
        ...(dir ? { dir } : {}),
      })

      if (messageID) {
        this.connectionService.recordMessageSessionId(messageID, sid)
      }

      await this.checkpoints.get(sid)
      await runWithMessageConfirmation(this.confirmations, messageID, "KiloProvider: Message request", () =>
        this.withRetry(
          () =>
            this.client!.session.promptAsync({
              sessionID: sid,
              directory: dir,
              messageID,
              parts,
              model: providerID && modelID ? { providerID, modelID } : undefined,
              agent,
              variant,
              editorContext,
              snapshotInitialization: this.opts.snapshotInitialization,
            }),
          sid,
          messageID,
        ),
      )
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to send message:", error)
      this.postMessage({
        type: "sendMessageFailed",
        error: getErrorMessage(error) || "Failed to send message",
        text,
        sessionID: resolved?.sid ?? sessionID,
        draftID,
        messageID,
        files,
        review,
      })
    }
  }

  private async handleSendCommand(
    command: string,
    args: string,
    messageID?: string,
    sessionID?: string,
    draftID?: string,
    providerID?: string,
    modelID?: string,
    agent?: string,
    variant?: string,
    files?: MessageFile[],
    context?: string,
    contextDirectory?: string,
  ): Promise<void> {
    if (!this.client) {
      this.postMessage({
        type: "sendMessageFailed",
        error: "Not connected to CLI backend",
        text: `/${command} ${args}`.trim(),
        sessionID,
        draftID,
        messageID,
        files,
      })
      return
    }

    let resolved: { sid: string; dir: string } | undefined
    try {
      const sandbox = this.sandboxTransitions.get(
        this.sandboxKey({ sessionID, draftID, agentManagerContext: context, contextDirectory }),
      )
      resolved = await this.resolveSession(sessionID, draftID, context, contextDirectory)
      if (!resolved) return
      if (sandbox) await sandbox
      const sid = resolved.sid
      const dir = resolved.dir

      // P0 perf: record the submit after session resolution so new-session
      // first turns carry the resolved session id; `messageID` (the user
      // message id) is the join key to `model.firstEvent`'s `parentID`.
      p0Stage("prompt.submit", {
        sessionID: sid,
        messageID,
        draftID,
        command,
        ...(dir ? { dir } : {}),
      })

      if (messageID) {
        this.connectionService.recordMessageSessionId(messageID, sid)
      }

      const parts = files?.map((f) => ({
        type: "file" as const,
        mime: f.mime,
        url: f.url,
        filename: f.filename,
        source: f.source,
      }))

      await this.requirements.assertAgentRequirements(agent, dir)
      await this.checkpoints.get(sid)
      await runWithMessageConfirmation(this.confirmations, messageID, "KiloProvider: Command request", () =>
        this.withRetry(
          () =>
            this.client!.session.command({
              sessionID: sid,
              directory: dir,
              command,
              arguments: args,
              messageID,
              model: providerID && modelID ? `${providerID}/${modelID}` : undefined,
              agent,
              variant,
              parts,
              snapshotInitialization: this.opts.snapshotInitialization,
            }),
          sid,
          messageID,
        ),
      )
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to send command:", error)
      this.postMessage({
        type: "sendMessageFailed",
        error: getErrorMessage(error) || "Failed to send command",
        text: `/${command} ${args}`.trim(),
        sessionID: resolved?.sid ?? sessionID,
        draftID,
        messageID,
        files,
      })
    }
  }

  public acknowledgeDraft(draftID: string, sessionID: string): void {
    for (const [k, v] of this.draftSessions) {
      if (v.sid === sessionID) {
        this.draftSessions.delete(k)
        break
      }
    }
    this.closedDrafts.delete(draftID)
  }

  public async abortSessions(ids: readonly string[]): Promise<void> {
    const sessions = [...new Set(ids)]
    const targets = new Set(sessions.filter((sid) => !sid.startsWith("pending:")))
    for (const draft of sessions.filter((sid) => sid.startsWith("pending:"))) {
      let sid: string | undefined
      for (const [k, v] of this.draftSessions) {
        if (k.startsWith(`${draft}\0`)) {
          sid = v.sid
          break
        }
      }
      if (!sid && !this.creatingDrafts.has(draft)) continue
      this.closedDrafts.add(draft)
      if (sid) targets.add(sid)
    }
    await Promise.all([...targets].map((sid) => this.stopSession(sid)))
  }

  private stopSession(sid: string): Promise<boolean> {
    this.cancelRetry(sid)
    const client = this.client
    if (!client) return Promise.resolve(false)
    return this.aborts.stop(client, sid, this.getWorkspaceDirectory(sid))
  }

  private async handleAbort(sessionID?: string): Promise<void> {
    const sid = sessionID || this.currentSession?.id
    if (!sid || !(await this.stopSession(sid))) return
    this.sessionStatusMap.set(sid, "idle")
    this.streams.flush(sid)
    this.postMessage({ type: "sessionTurnClosed", sessionID: sid, reason: "interrupted" })
    this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
  }

  private async handleRevertSession(sessionID: string, messageID: string, partID?: string): Promise<void> {
    if (!this.client) return
    const dir = this.getWorkspaceDirectory(sessionID)
    const { data, error } = await this.client.session.revert({ sessionID, messageID, partID, directory: dir })
    if (error) {
      console.error("[Kilo New] KiloProvider: Failed to revert session:", error)
      this.postMessage({ type: "error", message: "Failed to revert session", sessionID })
      throw error
    }
    if (!data) throw new Error("Revert returned no session")
    this.refreshes.set(sessionID, (this.refreshes.get(sessionID) ?? 0) + 1)
    const detail = sdkSessionToDetail(data as Session)
    if (this.currentSession?.id === sessionID) this.setCurrentSession(detail)
    this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(detail) })
  }

  private async handleUnrevertSession(sessionID: string): Promise<void> {
    if (!this.client) return
    const dir = this.getWorkspaceDirectory(sessionID)
    const { data, error } = await this.client.session.unrevert({ sessionID, directory: dir })
    if (error) {
      console.error("[Kilo New] KiloProvider: Failed to unrevert session:", error)
      this.postMessage({ type: "error", message: "Failed to redo session", sessionID })
      throw error
    }
    if (!data) throw new Error("Redo returned no session")
    this.refreshes.set(sessionID, (this.refreshes.get(sessionID) ?? 0) + 1)
    const detail = sdkSessionToDetail(data as Session)
    if (this.currentSession?.id === sessionID) this.setCurrentSession(detail)
    this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(detail) })
  }

  /**
   * Cancel a single queued (not-yet-started) message. The backend removes the
   * message on success and emits `message.removed`, which the webview handles to
   * drop the row and update the queued shimmer/counter. Failures surface as a
   * native notification.
   */
  private async handleCancelQueued(sessionID: string, messageID: string): Promise<void> {
    if (!this.client) return
    const dir = this.getWorkspaceDirectory(sessionID)
    const opId = `cancelQueued:${sessionID}:${messageID}`
    const idempotencyKey = `legacy:${sessionID}:${messageID}`
    const sdkRes = await this.client.session.cancelQueued({ sessionID, messageID, directory: dir })
    if (sdkRes.error) {
      console.error("[Kilo New] KiloProvider: Failed to cancel queued message:", sdkRes.error)
      void vscode.window.showErrorMessage(getErrorMessage(sdkRes.error) || "Failed to cancel queued message")
    }
    const isPrivateAvailable =
      (this.connectionService as unknown as { isPrivateAvailable?: () => boolean }).isPrivateAvailable?.() ?? false
    if (!isPrivateAvailable) return
    const sdkHasTerminal = (() => {
      // Authoritative: SDK tuple response.status is primary signal (LOCK-002)
      const resp = (sdkRes as unknown as { response?: { status?: unknown } })?.response
      const respStatus =
        resp && typeof resp.status === "number" && Number.isInteger(resp.status)
          ? (resp.status as number)
          : resp && typeof resp.status === "string"
            ? Number(resp.status)
            : null
      if (respStatus !== null && Number.isInteger(respStatus) && respStatus >= 100 && respStatus < 600) {
        if ([400, 404, 409, 500].includes(respStatus)) return true
        // SDK error with non-terminal HTTP status (e.g. 502) is not terminal
        if (sdkRes.error) return false
        return true
      }
      if (!sdkRes.error) return true
      const err = sdkRes.error as Record<string, unknown>
      const candidates: unknown[] = [err.status, err.statusCode, err.code, err.httpStatus]
      for (const c of candidates) {
        if (typeof c === "number" && [400, 404, 409, 500].includes(c)) return true
        if (typeof c === "string" && ["400", "404", "409", "500"].includes(c)) return true
        const n = typeof c === "string" ? Number(c) : null
        if (n !== null && [400, 404, 409, 500].includes(n)) return true
      }
      if (typeof err.message === "string" && /\b(400|404|409|500)\b/.test(err.message)) return true
      const tag = typeof err._tag === "string" ? String(err._tag).toLowerCase() : ""
      if (
        tag.includes("badrequest") ||
        tag.includes("notfound") ||
        tag.includes("conflict") ||
        tag.includes("internal")
      )
        return true
      if (typeof err.status === "undefined" && typeof err.code === "undefined" && typeof err._tag === "undefined")
        return false
      return false
    })()
    if (!sdkHasTerminal) return
    const privateReq = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId,
      op: "session/cancelQueued" as const,
      idempotencyKey,
      context: { directory: dir, sessionId: sessionID, parentSessionId: null },
      payload: { messageId: messageID },
    }
    const svc = this.connectionService as unknown as {
      privateCancelQueued: (req: typeof privateReq) => Promise<unknown>
      privateCancelQueuedWithHandle?: (req: typeof privateReq) => {
        id: number
        promise: Promise<unknown>
        cancel: (msg?: string) => boolean
      }
    }
    if (typeof svc.privateCancelQueued !== "function" && typeof svc.privateCancelQueuedWithHandle !== "function") return
    let priv: unknown
    try {
      const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
          ;(timer as unknown as { unref?: () => void })?.unref?.()
        })
        return Promise.race([p, timeout]).finally(() => {
          if (timer) clearTimeout(timer)
        }) as Promise<T>
      }
      const tryCancel =
        (
          this.connectionService as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean }
        )?.tryCancelPrivatePending?.bind(this.connectionService) ?? null
      const invalidate =
        (
          this.connectionService as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void }
        )?.invalidatePrivatePeerOnObserverTimeout?.bind(this.connectionService) ?? null
      const handleFactory =
        (
          this.connectionService as unknown as {
            privateCancelQueuedWithHandle?: (r: typeof privateReq) => {
              id: number
              promise: Promise<unknown>
              cancel?: (msg?: string) => boolean
            }
          }
        )?.privateCancelQueuedWithHandle?.bind(this.connectionService) ?? null
      const peekNextId =
        (
          this.connectionService as unknown as { peekPrivatePeerNextId?: () => number | null }
        )?.peekPrivatePeerNextId?.bind(this.connectionService) ?? null
      let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
      let exactId: number | null = null
      let privPromise: Promise<unknown>
      if (handleFactory) {
        try {
          const h = handleFactory(privateReq as unknown as never) as {
            id: number
            promise: Promise<unknown>
            cancel?: (msg?: string) => boolean
          }
          handle = h
          exactId = h.id
          privPromise = h.promise
        } catch (e) {
          privPromise = Promise.reject(e)
        }
      } else {
        exactId = peekNextId ? peekNextId() : null
        privPromise = (svc.privateCancelQueued as (r: typeof privateReq) => Promise<unknown>)(privateReq)
      }
      try {
        priv = await withTimeout(privPromise, 3000).catch((e: unknown) => {
          const msg = String(e)
          const isTimeout = msg.includes("private parity timeout")
          if (isTimeout) {
            if (handle?.cancel) {
              try {
                handle.cancel(`private parity timeout opId=${privateReq.opId}`)
              } catch (err) {
                console.warn("[Kilo PrivateParity] cancelQueued handle.cancel failed:", String(err).slice(0, 200), {
                  opId: privateReq.opId,
                })
              }
            } else if (exactId !== null && tryCancel) {
              let cleaned = false
              try {
                cleaned = tryCancel(exactId, `private parity timeout opId=${privateReq.opId}`)
              } catch (err) {
                console.warn("[Kilo PrivateParity] cancelQueued tryCancel failed:", String(err).slice(0, 200), {
                  opId: privateReq.opId,
                })
              }
              if (!cleaned && invalidate) {
                try {
                  invalidate(`cancelQueued observer timeout opId=${privateReq.opId}`)
                } catch (err) {
                  console.warn("[Kilo PrivateParity] cancelQueued invalidate failed:", String(err).slice(0, 200), {
                    opId: privateReq.opId,
                  })
                }
              }
            } else if (invalidate) {
              try {
                invalidate(`cancelQueued observer timeout opId=${privateReq.opId}`)
              } catch (err) {
                console.warn("[Kilo PrivateParity] cancelQueued invalidate failed:", String(err).slice(0, 200), {
                  opId: privateReq.opId,
                })
              }
            }
            console.warn("[Kilo PrivateParity] cancelQueued private parity timeout after 3000ms:", {
              opId: privateReq.opId,
              requestId: privateReq.requestId,
            })
          }
          return {
            v: 1,
            requestId: privateReq.requestId,
            opId: privateReq.opId,
            op: "session/cancelQueued",
            idempotencyKey: privateReq.idempotencyKey,
            status: "ambiguous",
            outcome: { type: "ambiguous", time: Date.now() },
            accepted: false,
            transportUnknown: true,
            _error: String(e),
          }
        })
      } catch (e) {
        const msg = String(e)
        const isTimeout = msg.includes("private parity timeout")
        if (isTimeout) {
          if (handle?.cancel) {
            try {
              handle.cancel(`private parity timeout opId=${privateReq.opId}`)
            } catch (err) {
              console.warn("[Kilo PrivateParity] cancelQueued handle.cancel failed:", String(err).slice(0, 200), {
                opId: privateReq.opId,
              })
            }
          } else if (exactId !== null && tryCancel) {
            try {
              const cleaned = tryCancel(exactId, `private parity timeout opId=${privateReq.opId}`)
              if (!cleaned && invalidate) invalidate(`cancelQueued observer timeout opId=${privateReq.opId}`)
            } catch (err) {
              console.warn("[Kilo PrivateParity] cancelQueued timeout cancel failed:", String(err).slice(0, 200), {
                opId: privateReq.opId,
              })
            }
          } else if (invalidate) {
            try {
              invalidate(`cancelQueued observer timeout opId=${privateReq.opId}`)
            } catch (err) {
              console.warn("[Kilo PrivateParity] cancelQueued timeout invalidate failed:", String(err).slice(0, 200), {
                opId: privateReq.opId,
              })
            }
          }
        }
        priv = {
          v: 1,
          requestId: privateReq.requestId,
          opId: privateReq.opId,
          op: "session/cancelQueued",
          idempotencyKey: privateReq.idempotencyKey,
          status: "ambiguous",
          outcome: { type: "ambiguous", time: Date.now() },
          accepted: false,
          transportUnknown: true,
          _error: String(e),
        }
      }
    } catch (e) {
      console.warn("[Kilo PrivateParity] parity observation failed", { opId, error: String(e) })
      return
    }
    try {
      const { compareParity } = await import("./services/cli-backend/serve-private-peer")
      const res = compareParity(
        priv as unknown as import("./services/cli-backend/serve-private-peer").ServePrivateCancelQueuedResult,
        sdkRes as unknown as { data?: unknown; error?: unknown; response?: unknown },
      )
      if (res.divergence) {
        const p = priv as Record<string, unknown>
        console.warn("[Kilo PrivateParity] divergence", {
          opId,
          sessionID,
          messageID,
          divergence: res.divergence,
          details: res.details,
          privStatus: (p.status as string) ?? "unknown",
          transportUnknown: !!(p.transportUnknown as boolean),
        })
      } else {
        console.log("[Kilo PrivateParity] parity match", { opId, status: sdkRes.error ? "failed" : "succeeded" })
      }
    } catch (e) {
      console.warn("[Kilo PrivateParity] parity observation failed", { opId, error: String(e) })
    }
  }

  // Permission + question handlers extracted to kilo-provider/handlers/permission.ts and question.ts

  private get permissionCtx(): PermissionContext {
    return {
      client: this.client,
      currentSessionId: this.currentSession?.id,
      trackedSessionIds: this.trackedSessionIds,
      sessionDirectories: this.sessionDirectories,
      postMessage: (msg) => this.postMessage(msg),
      getWorkspaceDirectory: (sid) => this.getWorkspaceDirectory(sid),
      recordPermissionDirectory: (id, dir) => this.connectionService.recordPermissionDirectory(id, dir),
      getPermissionDirectory: (id) => this.connectionService.getPermissionDirectory(id),
      clearPermissionDirectory: (id) => this.connectionService.clearPermissionDirectory(id),
      prunePermissionDirectories: (active, dirs) => this.connectionService.prunePermissionDirectories(active, dirs),
    }
  }

  private get questionCtx() {
    return {
      client: this.client,
      currentSessionId: this.currentSession?.id,
      trackedSessionIds: this.trackedSessionIds,
      sessionDirectories: this.sessionDirectories,
      postMessage: (msg: unknown) => this.postMessage(msg),
      getWorkspaceDirectory: (sid?: string) => this.getWorkspaceDirectory(sid),
      recordQuestionDirectory: (id: string, dir: string) => this.connectionService.recordQuestionDirectory(id, dir),
      getQuestionDirectory: (id: string) => this.connectionService.getQuestionDirectory(id),
      clearQuestionDirectory: (id: string) => this.connectionService.clearQuestionDirectory(id),
      getQuestionRevision: () => this.connectionService.getQuestionRevision(),
      pruneQuestionDirectories: (active: Set<string>, dirs: Set<string>) =>
        this.connectionService.pruneQuestionDirectories(active, dirs),
    }
  }

  // Auth handlers extracted to kilo-provider/handlers/auth.ts

  private get authCtx(): AuthContext {
    return {
      client: this.client,
      postMessage: (msg) => this.postMessage(msg),
      getWorkspaceDirectory: () => this.getWorkspaceDirectory(),
      disposeGlobal: () => this.disposeGlobal(),
      fetchAndSendProviders: () => this.fetchAndSendProviders(),
      fetchAndSendAgents: () => this.fetchAndSendAgents(),
    }
  }

  private async disposeGlobal(): Promise<void> {
    if (!this.client) return

    await this.client.global
      .dispose()
      .catch((e: unknown) => console.warn("[Kilo New] KiloProvider: global.dispose() after org switch failed:", e))

    // Org switch succeeded — refresh profile and providers independently (best-effort)
    try {
      const profileResult = await this.client!.kilo.profile()
      // Broadcast to all webviews (editor tabs, profile tab, agent manager, etc.)
      this.connectionService.notifyProfileChanged(profileResult.data ?? null)
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to refresh profile after org switch:", error)
    }
    try {
      await this.fetchAndSendProviders()
    } catch (error) {
      console.error("[Kilo New] KiloProvider: Failed to refresh providers after org switch:", error)
    }
  }

  /**
   * Handle a generic setting update from the webview.
   * The key uses dot notation relative to `kilo-code.new` (e.g. "browserAutomation.enabled").
   */
  private async handleUpdateSetting(key: string, value: unknown): Promise<void> {
    if (key === "maxCost") {
      const normalized = this.setMaxCost(value)
      await vscode.workspace
        .getConfiguration("kilo-code.new")
        .update("maxCost", normalized, vscode.ConfigurationTarget.Global)
      for (const sid of this.trackedSessionIds) {
        const oldLimit = this.activeAlerts.get(sid)
        if (oldLimit !== undefined) {
          this.activeAlerts.delete(sid)
          this.postMessage({ type: "sessionCostAlertResolved", sessionID: sid, limit: oldLimit })
        }
        this.costs.rearm(sid)
        this.requestCostAlert(sid, this.costs.sessionCost(sid))
      }
      return
    }
    const { section, leaf } = buildSettingPath(key)
    const config = vscode.workspace.getConfiguration(`kilo-code.new${section ? `.${section}` : ""}`)
    // Normalize a webview-side clear to `undefined` so VS Code removes the
    // key from settings.json rather than persisting a literal `null`. This
    // lets the runtime fall back to the resolved default.
    const next = value === null ? undefined : value
    await config.update(leaf, next, vscode.ConfigurationTarget.Global)
    if (isWorkStyleSetting(key)) this.sendWorkStyle()
  }

  /**
   * VS Code globalState `variantSelections` adapter used as the model.json
   * variant-memory migration source / synchronized compatibility cache.
   */
  private variantCache(): ModelState.VariantCache {
    return {
      read: () => this.extensionContext?.globalState.get<Record<string, string>>("variantSelections") ?? {},
      write: async (value) => {
        await this.extensionContext?.globalState.update("variantSelections", value)
      },
    }
  }

  /**
   * Reset all "kilo-code.new.*" extension settings to their defaults by reading
   * contributes.configuration from the extension's package.json at runtime.
   * Only resets settings under the "kilo-code.new." namespace to avoid touching
   * settings from the previous version of the extension which shares the same
   * extension ID and "kilo-code.*" namespace.
   */
  private async handleResetAllSettings(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "Reset all Kilo Code extension settings to defaults?",
      { modal: true },
      "Reset",
    )
    if (confirmed !== "Reset") return

    const prefix = "kilo-code.new."
    const ext = vscode.extensions.getExtension("kilocode.kilo-code")
    const properties = ext?.packageJSON?.contributes?.configuration?.properties as Record<string, unknown> | undefined
    if (!properties) return

    for (const key of Object.keys(properties)) {
      if (!key.startsWith(prefix)) continue
      const parts = key.split(".")
      const section = parts.slice(0, -1).join(".")
      const leaf = parts[parts.length - 1]!
      const config = vscode.workspace.getConfiguration(section)
      await config.update(leaf, undefined, vscode.ConfigurationTarget.Global)
    }

    // Clear globalState items that are not part of the configuration
    await this.extensionContext?.globalState.update("recentModels", undefined)
    await this.extensionContext?.globalState.update("kilo.agentMigrationBannerDismissed", undefined)
    await this.extensionContext?.globalState.update("kilo.marketplace.dismissedSuggestions", undefined)

    // Re-send all settings to the webview so the UI reflects the reset
    this.sendBrowserSettings()
    this.sendNotificationSettings()
    this.sendTimelineSetting()
    this.sendWorkStyle()
    await ModelState.reset(this.client, (msg) => this.postMessage(msg), this.variantCache())

    // Re-send globalState items to the webview
    this.postMessage({ type: "recentsLoaded", recents: [] })

    vscode.window.showInformationMessage("Kilo Code settings have been reset to defaults.")
  }

  /**
   * Read the current browser automation settings and push them to the webview.
   */
  private sendBrowserSettings(): void {
    const config = vscode.workspace.getConfiguration("kilo-code.new.browserAutomation")
    this.postMessage({
      type: "browserSettingsLoaded",
      settings: {
        enabled: config.get<boolean>("enabled", false),
        useSystemChrome: config.get<boolean>("useSystemChrome", true),
        headless: config.get<boolean>("headless", false),
      },
    })
  }

  /**
   * Read the current Claude Code compatibility setting and push it to the webview.
   */
  private sendClaudeCompatSetting(): void {
    const enabled = vscode.workspace.getConfiguration("kilo-code.new").get<boolean>("claudeCodeCompat", false)
    this.postMessage({
      type: "claudeCompatSettingLoaded",
      enabled: enabled ?? false,
    })
  }

  /** Re-fetch all server-side state after an auth change. */
  private async reloadAfterAuthChange(): Promise<void> {
    this.requirements.clear()
    await this.fetchAndSendConfig()
    await Promise.all([
      this.fetchAndSendProviders(),
      this.fetchAndSendAgents(),
      this.fetchAndSendSkills(),
      this.fetchAndSendCommands(),
    ])
  }

  /** Reload config, skills, agents, and commands from disk by rebooting the instance. */
  private async handleReload(): Promise<void> {
    if (!this.client) {
      console.warn("[Kilo New] handleReload: no client connection")
      return
    }
    const dir = this.getWorkspaceDirectory(this.currentSession?.id)
    try {
      await this.client.instance.reload({ directory: dir }, { throwOnError: true })
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
        console.error("[Kilo New] handleReload: reload endpoint failed:", err)
        vscode.window.showErrorMessage("Reload failed. See extension logs for details.")
      }
      return
    }
    this.clearCommandsCache()
    if (!sameDirectory(dir, this.getWorkspaceDirectory())) {
      await this.reloadAfterAuthChange()
    }
  }

  /** Public reload entry point for VS Code commands. */
  async reload(): Promise<void> {
    return this.handleReload()
  }

  private mapSyncEventToWebviewMessage(event: LegacySyncEvent) {
    switch (event.type) {
      case "message.updated": {
        const info = event.properties.info
        return {
          type: "messageCreated" as const,
          message: {
            ...info,
            createdAt: new Date(info.time.created).toISOString(),
          },
        }
      }
      case "message.removed":
        return {
          type: "messageRemoved" as const,
          sessionID: event.properties.sessionID,
          messageID: event.properties.messageID,
        }
      case "message.part.updated":
        return {
          type: "partUpdated" as const,
          sessionID: event.properties.sessionID,
          messageID: event.properties.part.messageID,
          part: event.properties.part,
        }
      case "message.part.removed":
        return {
          type: "partRemoved" as const,
          sessionID: event.properties.sessionID,
          messageID: event.properties.messageID,
          partID: event.properties.partID,
        }
      case "session.created":
        return {
          type: "sessionCreated" as const,
          session: this.sessionToWebview(sdkSessionToDetail(event.properties.info as Session)),
        }
      case "session.updated":
        return {
          type: "sessionUpdated" as const,
          session: this.sessionToWebview(sdkSessionToDetail(event.properties.info as Session)),
        }
      case "session.deleted":
        return {
          type: "sessionDeleted" as const,
          sessionID: event.properties.sessionID,
        }
    }
  }

  private resolveEventSessionId(event: ProviderEvent): string | undefined {
    switch (event.type) {
      case "session.created":
      case "session.updated":
      case "session.deleted":
        return event.properties.sessionID
      case "message.updated":
        this.connectionService.recordMessageSessionId(event.properties.info.id, event.properties.sessionID)
        return event.properties.sessionID
      case "message.removed":
      case "message.part.updated":
      case "message.part.removed":
        return event.properties.sessionID
      default:
        return this.connectionService.resolveEventSessionId(event)
    }
  }

  private postModelUsageChanged(event: ProviderEvent, sessionID: string | undefined): boolean {
    if (!sessionID || this.trackedSessionIds.has(sessionID)) return false
    if (event.type === "session.created") {
      const parent = event.properties.info.parentID
      if (!parent || !this.modelUsageSessionIds.has(parent)) return false
      this.modelUsageSessionIds.add(sessionID)
      this.postMessage({ type: "sessionModelUsageChanged", sessionID })
      return true
    }
    if (!this.modelUsageSessionIds.has(sessionID)) return false
    if (event.type === "message.part.updated") {
      const part = event.properties.part as {
        type?: string
        tool?: string
        metadata?: { sessionId?: string }
        state?: { metadata?: { sessionId?: string } }
      }
      const child = childID(part)
      if (child && !this.modelUsageSessionIds.has(child)) {
        this.modelUsageSessionIds.add(child)
        this.postMessage({ type: "sessionModelUsageChanged", sessionID: child })
        return true
      }
    }
    const changed =
      event.type === "message.removed" ||
      event.type === "message.part.removed" ||
      event.type === "session.deleted" ||
      (event.type === "message.part.updated" && event.properties.part.type === "step-finish")
    if (!changed) return false
    if (event.type === "session.deleted") this.modelUsageSessionIds.delete(sessionID)
    this.postMessage({ type: "sessionModelUsageChanged", sessionID })
    return true
  }

  /**
   * Handle SSE events from the CLI backend.
   * Filters events by project ID and tracked session IDs so each webview only sees its own sessions.
   */
  private handleEvent(event: ProviderEvent, directory?: string): void {
    if (event.type === "kilo-sessions.remote-status-changed") {
      this.remoteService?.updateFromEvent({ enabled: event.properties.enabled, connected: event.properties.connected })
      return
    }

    // Drop session events from other projects before any tracking logic.
    // This must come first: the trackedSessionIds guard below would otherwise
    // let a foreign session through if it was accidentally tracked.
    if (!isLegacySyncEvent(event) && isEventFromForeignProject(event, this.projectID)) return
    if (
      this.projectID &&
      (event.type === "session.created" || event.type === "session.updated") &&
      event.properties.info.projectID !== undefined &&
      event.properties.info.projectID !== null &&
      event.properties.info.projectID !== this.projectID
    ) {
      return
    }

    if (event.type === "mcp.browser.open.failed") {
      McpOAuth.openMcpOAuthUrlOnce(event.properties.url)
      return
    }

    if (event.type === "message.updated") {
      this.confirmations.confirm(event.properties.info.id)
    }

    // session.status events pass the onEventFiltered pre-filter for all providers (see line 842),
    // so this runs on every KiloProvider instance — including the Settings panel which has no
    // tracked sessions. Update sessionStatusMap and forward to webview before the
    // trackedSessionIds guard so the Settings panel's allStatusMap stays current for the
    // busy-session warning on Save.
    if (event.type === "session.status") {
      const sid = event.properties.sessionID
      const prev = this.sessionStatusMap.get(sid)
      if ((prev === undefined || prev === "idle") && event.properties.status.type !== "idle") {
        this.costs.rearm(sid)
      }
      this.sessionStatusMap.set(sid, event.properties.status.type)
      this.aborts.observe(sid, event.properties.status.type, directory)
      const msg = mapSSEEventToWebviewMessage(event, sid)
      if (msg) {
        this.streams.flush(sid)
        this.postMessage(msg)
      }
      return
    }

    // Extract sessionID from the event
    if (event.type === "session.created" && this.adoptPendingFollowup(event.properties.info)) {
      return
    }

    const sessionID = this.resolveEventSessionId(event)

    // Events without sessionID (server.connected, server.heartbeat) → always forward
    // Events with sessionID → only forward if this webview tracks that session
    // message.part.* events are always session-scoped; drop if session unknown.
    if (!sessionID && isSessionScopedPartEvent(event.type)) return
    if (this.postModelUsageChanged(event, sessionID)) return
    if (event.type !== "session.deleted" && sessionID && !this.trackedSessionIds.has(sessionID)) return

    if (event.type === "session.updated" && typeof event.properties.info.cost === "number") {
      const cost = this.costs.setSessionCost(event.properties.sessionID, event.properties.info.cost)
      this.requestCostAlert(event.properties.sessionID, cost)
    }

    if (event.type === "session.updated") {
      // Full bus snapshots duplicate sync patches with the same event ID but no sequence metadata.
      if (!isLegacySyncEvent(event)) return
      const sid = event.properties.sessionID
      const revision = this.revisions.get(sid)
      const versioned = event.seq > 0 || (revision?.seq ?? 0) > 0
      if (revision && (versioned ? event.seq <= revision.seq : event.id <= revision.id)) return
      this.revisions.set(sid, { id: event.id, seq: event.seq })
    }

    // Refresh provider and agent lists when the server signals a state disposal
    if (event.type === "global.disposed") {
      void this.reloadAfterAuthChange()
      return
    }

    if (event.type === "server.instance.disposed") {
      const props = event.properties as Record<string, unknown> | null
      const dir = typeof props?.directory === "string" ? props.directory : undefined
      if (dir) for (const sid of this.aborts.dispose(dir)) this.sessionStatusMap.set(sid, "idle")
      if (dir && !sameDirectory(dir, this.getWorkspaceDirectory())) return
      void this.reloadAfterAuthChange()
      return
    }

    // Config was updated without a full dispose (e.g. permission-only save).
    // The connection service already advanced the shared revision and the
    // onConfigRevision subscription already queued reconciliation. Refresh
    // agents/providers so the UI reflects new capability state (LOCK-003/LOCK-005).
    if (event.type === "global.config.updated") {
      this.requirements.clear()
      void Promise.all([this.fetchAndSendAgents(), this.fetchAndSendProviders()])
      return
    }

    // Forward relevant events to webview
    // Side effects that must happen before the webview message is sent
    if (event.type === "message.updated") {
      const info = event.properties.info
      const value = info.role === "assistant" ? info.cost : undefined
      const cost = this.updateMessageCost(event.properties.sessionID, info.id, info.role, value)
      if (cost !== undefined) this.requestCostAlert(event.properties.sessionID, cost)
    }
    if (event.type === "message.removed") {
      this.removeMessageCost(event.properties.messageID)
    }
    if (event.type === "session.created" && !this.currentSession) {
      const detail = sdkSessionToDetail(event.properties.info as Session)
      this.setCurrentSession(detail)
      this.contextSessionID = detail.id
      this.trackedSessionIds.add(detail.id)
    }
    if (event.type === "session.updated" && this.currentSession?.id === event.properties.sessionID) {
      const detail = sdkSessionToDetail(event.properties.info as Session)
      this.setCurrentSession(detail)
      this.contextSessionID = event.properties.sessionID
    }
    if (event.type === "session.deleted") {
      const sid = event.properties.sessionID
      this.trackedSessionIds.delete(sid)
      this.modelUsageSessionIds.delete(sid)
      this.sessionDirectories.delete(sid)
      this.connectionService.pruneSession(sid)
      this.costs.onSessionDeleted(sid)
    }

    // Auto-adopt child sessions as soon as the task tool part reveals their ID.
    // This means the child's permission/question events are tracked immediately —
    // before the webview renderer has a chance to call syncSession — eliminating
    // the race where the child blocks on a prompt that the UI never sees.
    if (event.type === "message.part.updated") {
      const part = event.properties.part as {
        type?: string
        tool?: string
        metadata?: { sessionId?: string }
        state?: { metadata?: { sessionId?: string } }
        sessionID?: string
      }
      const childId = childID(part)
      if (childId && !this.trackedSessionIds.has(childId)) {
        console.log("[Kilo New] KiloProvider: 🔗 Auto-adopting child session from task tool", { childId })
        void this.handleSyncSession(childId, part.sessionID ?? sessionID)
      }
    }

    // Drop the per-session caches for deleted sessions so a late
    // handleLoadMessages response (or any other guarded read) can't resurrect
    // transcript state for a session the webview just cleaned up. The
    // prefilter lets session.deleted through without re-tracking, and the
    // handleEvent guard does the same — this is the matching prune.
    if (event.type === "session.deleted" && sessionID) {
      this.pruneDeletedSession(sessionID)
    }

    if (!isLegacySyncEvent(event)) {
      const props = event.properties
      handleNetworkEvent(
        event.type,
        {
          id: "id" in props && typeof props.id === "string" ? props.id : undefined,
          sessionID: "sessionID" in props && typeof props.sessionID === "string" ? props.sessionID : undefined,
          requestID: "requestID" in props && typeof props.requestID === "string" ? props.requestID : undefined,
        },
        this.client,
        (s) => this.getWorkspaceDirectory(s),
      )
    }

    const msg = isLegacySyncEvent(event)
      ? this.mapSyncEventToWebviewMessage(event)
      : mapSSEEventToWebviewMessage(event, sessionID)
    if (!msg) return
    if (msg.type === "partUpdated") {
      this.streams.push({ ...msg, part: this.slimPart(msg.part) })
      return
    }
    const next = msg.type === "messageCreated" ? { ...msg, message: this.slimInfo(msg.message) } : msg
    if (next.type === "sandboxStatus") {
      if (!sameDirectory(next.directory, this.getWorkspaceDirectory(next.sessionID))) return
      this.postMessage({ ...next, revision: ++this.sandboxRevision })
      return
    }
    this.streams.flush(sessionID)
    this.postMessage(next)
  }

  /** Wait until the webview has sent "webviewReady". Resolves immediately when already ready. */
  public waitForReady(): Promise<void> {
    return this.isWebviewReady && this.webview ? Promise.resolve() : new Promise((r) => this.readyResolvers.push(r))
  }

  /** Fixture-only: count of pending webviewReady waiters (test inspection of exact removal). */
  public getReadyResolverCountForFixture(): number {
    return this.readyResolvers.length
  }

  /**
   * Fixture-only: reset readiness and atomically re-assign HTML, awaiting the next real webviewReady.
   * Owns a specific resolver callback registered before assign; on assign throw that exact resolver is
   * removed, in-flight cleared, and a sanitized error is thrown. After the waiter resolves the
   * provider checks not disposed, webview exists, and isWebviewReady true; a dispose-woke resolver
   * rejects with `webview reload aborted` instead of success. Coalesces overlapping callers onto the
   * same promise and clears in-flight on all paths. No rebind/init/recreate.
   */
  public reloadWebviewForFixture(assign: () => void): Promise<void> {
    if (!this.webview || this.disposed) throw new Error("KiloProvider: no webview to reload or disposed")
    if (this.reloadInFlight) return this.reloadInFlight
    this.isWebviewReady = false
    let owned!: () => void
    const waiter = new Promise<void>((resolve) => {
      owned = resolve
      this.readyResolvers.push(resolve)
    })
    const p: Promise<void> = (async () => {
      try {
        assign()
      } catch {
        const idx = this.readyResolvers.indexOf(owned)
        if (idx >= 0) this.readyResolvers.splice(idx, 1)
        throw new Error("webview reload assign failed")
      }
      await waiter
      if (this.disposed || !this.webview || !this.isWebviewReady) throw new Error("webview reload aborted")
    })()
    this.reloadInFlight = p
    const clear = () => {
      if (this.reloadInFlight === p) this.reloadInFlight = null
    }
    p.then(clear, clear)
    return p
  }

  /** Post a message to the webview. Public so toolbar button commands can send messages. */
  public postMessage(message: unknown): void {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: string }).type === "sessionsLoaded" &&
      Array.isArray((message as { sessions?: unknown }).sessions)
    ) {
      const ids = ((message as { sessions: Array<{ id?: string }> }).sessions ?? [])
        .map((s) => s.id)
        .filter((id): id is string => typeof id === "string")
      const append = (message as { append?: unknown }).append as boolean | undefined
      const hasMore = (message as { hasMore?: unknown }).hasMore as boolean | undefined
      this.notifyCatalog({ ids, append, hasMore })
    }
    if (!this.webview) {
      const type =
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        typeof (message as { type?: unknown }).type === "string"
          ? (message as { type: string }).type
          : "<unknown>"
      console.warn("[Kilo New] KiloProvider: ⚠️ postMessage dropped (no webview)", { type })
      return
    }

    void this.webview.postMessage(message).then(undefined, (error) => {
      console.error("[Kilo New] KiloProvider: ❌ postMessage failed", error)
    })
  }

  private flushPendingKiloModel(): void {
    if (!this.webview || !this.isWebviewReady || !this.client || !this.pendingKiloModel) return

    const pending = this.pendingKiloModel
    this.pendingKiloModel = null
    this.postMessage({ type: "selectKiloModel", ...pending })
  }

  /**
   * Get the git remote URL for the current workspace using VS Code's built-in Git API.
   * Returns undefined if not in a git repo or no remotes are configured.
   */
  private async getGitRemoteUrl(): Promise<string | undefined> {
    try {
      const extension = vscode.extensions.getExtension("vscode.git")
      if (!extension) return undefined
      const api = extension.isActive ? extension.exports?.getAPI(1) : (await extension.activate())?.getAPI(1)
      if (!api) return undefined
      const repo = api.repositories?.[0]
      if (!repo) return undefined
      const remote = repo.state?.remotes?.find((r: { name: string }) => r.name === "origin")
      return remote?.fetchUrl ?? remote?.pushUrl
    } catch (error) {
      console.warn("[Kilo New] KiloProvider: Failed to get git remote URL:", error)
      return undefined
    }
  }

  /**
   * Gather VS Code editor context to send alongside messages to the CLI backend.
   */
  /**
   * Return the set of relative paths for all open text-editor tabs within the
   * given directory, filtered through .kilocodeignore.
   */
  private async getOpenTabPaths(dir: string): Promise<Set<string>> {
    const controller = await this.getIgnoreController(dir)
    const result = new Set<string>()
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri =
          tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputNotebook
            ? tab.input.uri
            : undefined
        if (uri?.scheme !== "file") continue

        const rel = path.relative(dir, uri.fsPath)
        if (!rel.startsWith("..") && !path.isAbsolute(rel) && controller.validateAccess(uri.fsPath)) {
          result.add(rel.replaceAll("\\", "/"))
        }
      }
    }
    return result
  }

  /**
   * Get or create a FileIgnoreController for the current workspace directory.
   * Reinitializes if the workspace directory has changed.
   */
  private async getIgnoreController(workspaceDir: string): Promise<FileIgnoreController> {
    if (this.ignoreController && this.ignoreControllerDir === workspaceDir) {
      return this.ignoreController
    }
    const controller = new FileIgnoreController(workspaceDir)
    await controller.initialize()
    this.ignoreController = controller
    this.ignoreControllerDir = workspaceDir
    return controller
  }

  private async gatherEditorContext(dir?: string): Promise<EditorContext> {
    const workspaceDir = dir ?? this.getWorkspaceDirectory()
    const controller = await this.getIgnoreController(workspaceDir)

    const toRelative = (fsPath: string): string | undefined => {
      if (!workspaceDir) {
        return undefined
      }
      const relative = path.relative(workspaceDir, fsPath)
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return undefined
      }
      return relative
    }

    // Visible files (capped to avoid bloating context, filtered through .kilocodeignore)
    const visibleFiles = [
      ...new Set(
        [
          ...vscode.window.visibleTextEditors.map((editor) => notebookUri(editor.document.uri)),
          ...vscode.window.visibleNotebookEditors.map((editor) => editor.notebook.uri),
        ]
          .filter((uri): uri is vscode.Uri => uri?.scheme === "file")
          .map((uri) => toRelative(uri.fsPath))
          .filter(
            (file): file is string => file !== undefined && controller.validateAccess(path.resolve(workspaceDir, file)),
          ),
      ),
    ].slice(0, 200)

    // Open tabs — text and notebook files only; exclude diffs and custom editors
    const openTabs = [...(await this.getOpenTabPaths(workspaceDir))].slice(0, 20)

    // Active file (also filtered through .kilocodeignore)
    const activeEditor = vscode.window.activeTextEditor
    const activeUri = activeEditor
      ? notebookUri(activeEditor.document.uri)
      : vscode.window.activeNotebookEditor?.notebook.uri
    const activeRel = activeUri ? toRelative(activeUri.fsPath) : undefined
    const activeFile = activeRel && activeUri && controller.validateAccess(activeUri.fsPath) ? activeRel : undefined

    // Shell
    const shell = vscode.env.shell || undefined

    return {
      ...(visibleFiles.length > 0 ? { visibleFiles } : {}),
      ...(openTabs.length > 0 ? { openTabs } : {}),
      ...(activeFile ? { activeFile } : {}),
      ...(shell ? { shell } : {}),
    }
  }

  private getWorkspaceDirectory(sessionId?: string): string {
    return resolveWorkspaceDirectory({
      sessionID: sessionId,
      sessionDirectories: this.sessionDirectories,
      workspaceDirectory: this.getRootDirectory(),
    })
  }

  private getSessionDirectory(sessionId: string, session?: SessionDetail | Session): string {
    return this.sessionDirectories.get(sessionId) ?? session?.directory ?? this.getRootDirectory()
  }

  private getContextDirectory(): string {
    return resolveContextDirectory({
      currentSessionID: this.currentSession?.id,
      contextSessionID: this.contextSessionID,
      sessionDirectories: this.sessionDirectories,
      workspaceDirectory: this.getRootDirectory(),
    })
  }

  private getRootDirectory(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0]!.uri.fsPath
    }
    return process.cwd()
  }

  private trackDirectory(sessionId: string, dir: string) {
    if (path.resolve(dir) === path.resolve(this.getRootDirectory())) {
      this.sessionDirectories.delete(sessionId)
      return
    }
    this.sessionDirectories.set(sessionId, dir)
  }

  private noteFollowup(answers: string[][], sessionID?: string) {
    const dir = this.getWorkspaceDirectory(sessionID)
    this.pendingFollowup = recordFollowup({ answers, dir, now: Date.now() }) ?? null
  }

  private matchesPendingFollowup(session: SessionDetail | Session) {
    const dir = (session as SessionDetail).directory ?? (session as Session).directory
    return matchFollowup({
      pending: this.pendingFollowup,
      dir,
      now: Date.now(),
    })
  }

  private adoptPendingFollowup(session: SessionDetail | Session) {
    const now = Date.now()
    const match = this.matchesPendingFollowup(session)
    if (!match) {
      if (
        this.pendingFollowup &&
        !matchFollowup({ pending: this.pendingFollowup, dir: this.pendingFollowup.dir, now })
      ) {
        this.pendingFollowup = null
      }
      return false
    }

    this.pendingFollowup = null
    const dir = (session as SessionDetail).directory ?? (session as Session).directory
    const id = (session as SessionDetail).id ?? (session as Session).id
    this.trackDirectory(id, dir)
    const detailForCb = (session as SessionDetail).createdAt !== undefined ? (session as SessionDetail) : sdkSessionToDetail(session as Session)
    for (const cb of this.followupListeners) cb(detailForCb, dir)
    this.registerSession(detailForCb as unknown as SessionDetail)
    void this.handleLoadMessages(id)
    return true
  }

  private getProjectDirectory(sessionId?: string): string | undefined {
    return resolveProjectDirectory(this.projectDirectory, () => this.getWorkspaceDirectory(sessionId))
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return buildWebviewHtml(webview, {
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css")),
      iconsBaseUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "assets", "icons")),
      workerUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "shiki-worker.js")),
      title: "Kilo Code",
      port: this.connectionService.getServerInfo()?.port,
      perfEnabled: isP0PerfEnabled(),
      extraStyles: `.container { height: 100%; display: flex; flex-direction: column; height: 100vh; border-right: 1px solid var(--border-weak-base); }`,
    })
  }

  /**
   * Dispose of the provider and clean up subscriptions.
   * Does NOT kill the server — that's the connection service's job.
   * Idempotent: repeated calls are no-ops.
   */
  dispose(): void {
    if (this.disposed) return
    this.unsubscribeRemote?.()
    this.streams.focus(undefined)
    this.connectionService.unregisterVisible(this.instanceId)
    this.connectionService.unregisterAttached(this.instanceId)
    this.unsubscribeEvent?.()
    this.unsubscribeState?.()
    this.unsubscribeLanguageChange?.()
    this.unsubscribeProfileChange?.()
    this.unsubscribeFavoritesChange?.()
    this.unsubscribeModelSelectorExpanded?.()
    this.unsubscribeDirectoryProvider?.()
    this.unsubscribeConfigRevision?.()
    this.unsubscribeSandboxPreference?.()
    this.unsubscribeCanonicalChange?.dispose()
    this.unsubscribeCanonicalError?.dispose()
    // Reset canonical readiness on disposal so a later re-armed provider does
    // not inherit a stale ready state from the replaced service.
    this.canonicalReady = false
    this.cleanupRetries.clear()
    this.cleanupTargets.clear()
    // LOCK-004: terminal disposal — cancel any pending reconciliation retry
    // timer, invalidate the attempt sequence and the lifecycle epoch so a held
    // reconciliation result can neither post nor schedule a retry, and make
    // queueReconcile a no-op.
    this.disposed = true
    this.cancelReconcileRetry()
    this.reconcileInFlight = null
    this.reconcileSeq += 1
    this.connectionGeneration += 1
    this.viewStateDisposable?.dispose()
    this.webviewMessageDisposable?.dispose()
    this.telemetryStateDisposable?.dispose()
    this.autoApproveBridge?.dispose()
    this.visibleTaskStreams.clear()
    this.streams.dispose()
    this.isWebviewReady = false
    // Release any waitForReady() awaiters so their callers don't hang after disposal.
    this.readyResolvers.splice(0).forEach((r) => r())
    this.promptRecoveryQueued = false
    clearNetworkWaits(this.trackedSessionIds)
    this.trackedSessionIds.clear()
    this.syncedChildSessions.clear()
    this.draftSessions.clear()
    this.sessionDirectories.clear()
    this.anacondaDesktop.dispose()
    this.aborts.clear()
    this.sessionStatusMap.clear()
    this.requirements.dispose()
    this.ignoreController?.dispose()
    disposeGitChangesTarget()
  }
}
