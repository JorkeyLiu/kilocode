import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@kilocode/sdk/v2/client"
import type { PartBatch, PartRemove, PartUpdate } from "../../../../src/shared/stream-messages"
import type { ConnectionState, ServerInfo, SessionStatus } from "./connection"
import type { FileAttachment, Part } from "./parts"
import type { ImageAttachment } from "../../hooks/useImageAttachments"
import type {
  Message,
  MessageLoadMode,
  SessionCloseReason,
  SessionInfo,
  SessionModelUsage,
  SessionUpdate,
} from "./sessions"
import type { PermissionRequest } from "./permissions"
import type { AnacondaDesktopExtensionMessage } from "../../../../src/shared/anaconda-desktop-messages"
import type { QuestionRequest, SuggestionRequest, TodoItem } from "./questions"
import type { CanonicalProviderView, ModelSelection, Provider, ProviderAuthState } from "./providers"
import type { AgentInfo, AgentRequirementResult, SkillInfo, SlashCommandInfo } from "./agents"
import type { BrowserSettings, Config, FeatureFlags } from "./config"
import type { WorkStyle, WorkStyleState } from "../../../../src/shared/work-style-presets"
import type { ProfileData } from "./profile"
import type { CanonicalConfigPayload, CanonicalStamp } from "../../../../src/config/types"
import type {
  LocalGitStats,
  ManagedSessionState,
  ReviewComment,
  SessionTimingEntry,
  TerminalFont,
} from "./agent-manager"

// ============================================
// Messages FROM extension TO webview
// ============================================

export interface ReadyMessage {
  type: "ready"
  serverInfo?: ServerInfo
  extensionVersion?: string
  vscodeLanguage?: string
  languageOverride?: string
  fontSize?: number
  workspaceDirectory?: string
}

export interface FontSizeChangedMessage {
  type: "fontSizeChanged"
  fontSize: number
}

export interface GitStatusMessage {
  type: "gitStatus"
  repo: boolean
}

export interface WorkspaceDirectoryChangedMessage {
  type: "workspaceDirectoryChanged"
  directory: string
}

export interface LanguageChangedMessage {
  type: "languageChanged"
  locale: string
}

export interface ConnectionStateMessage {
  type: "connectionState"
  state: ConnectionState
  error?: string
  userMessage?: string
  userDetails?: string
}

export interface ErrorMessage {
  type: "error"
  message: string
  code?: string
  sessionID?: string
}

export interface SendMessageFailedMessage {
  type: "sendMessageFailed"
  error: string
  text: string
  sessionID?: string
  draftID?: string
  messageID?: string
  files?: FileAttachment[]
  review?: import("../../../../src/shared/review-comments").ReviewMessageData
}

// Wire shape lives in src/shared/stream-messages.ts; narrow `part` to the
// webview's concrete union.
export type PartUpdatedMessage = PartUpdate<Part>
export type PartsUpdatedMessage = PartBatch<Part>
export type PartRemovedMessage = PartRemove

export interface SessionStatusMessage {
  type: "sessionStatus"
  sessionID: string
  status: SessionStatus
  // Retry fields (present when status === "retry")
  attempt?: number
  message?: string
  next?: number
}

export interface SessionTurnClosedMessage {
  type: "sessionTurnClosed"
  sessionID: string
  reason: SessionCloseReason
}

export interface SessionErrorMessage {
  type: "sessionError"
  sessionID?: string
  error?: { name: string; data?: Record<string, unknown> }
}

export interface PermissionRequestMessage {
  type: "permissionRequest"
  permission: PermissionRequest
}

export interface PermissionResolvedMessage {
  type: "permissionResolved"
  permissionID: string
}

export interface PermissionErrorMessage {
  type: "permissionError"
  permissionID: string
  stale?: boolean
}

export interface TodoUpdatedMessage {
  type: "todoUpdated"
  sessionID: string
  items: TodoItem[]
}

export interface SessionCreatedMessage {
  type: "sessionCreated"
  session: SessionInfo
  draftID?: string
}

export interface SessionForkedMessage {
  type: "sessionForked"
  sessionID: string
  forkedFromID: string
}

export interface SessionUpdatedMessage {
  type: "sessionUpdated"
  session: SessionUpdate
}

export interface SessionDeletedMessage {
  type: "sessionDeleted"
  sessionID: string
}

export interface MessageRemovedMessage {
  type: "messageRemoved"
  sessionID: string
  messageID: string
}

export interface MessagesLoadedMessage {
  type: "messagesLoaded"
  sessionID: string
  messages: Message[]
  mode?: Exclude<MessageLoadMode, "focus">
  cursor?: string
  hasMore?: boolean
  since?: number
}

export interface SessionModelUsageLoadedMessage {
  type: "sessionModelUsageLoaded"
  sessionID: string
  requestID: string
  data?: SessionModelUsage
}

export interface SessionModelUsageChangedMessage {
  type: "sessionModelUsageChanged"
  sessionID: string
}

export interface MessageCreatedMessage {
  type: "messageCreated"
  message: Message
}

export interface SessionsLoadedMessage {
  type: "sessionsLoaded"
  sessions: SessionInfo[]
  preserveSessionIds?: string[]
  /** True when sessions are a load-more page to append; false/absent for a full refresh. */
  append?: boolean
  /** Opaque cursor for the next page, or null when there are no more sessions. */
  nextCursor?: string | null
  /** True when another page can be requested via loadSessions cursor. */
  hasMore?: boolean
}

export interface SelectKiloModelMessage {
  type: "selectKiloModel"
  modelID?: string
  agent?: string
}

export interface ActionMessage {
  type: "action"
  action: string
}

export interface SetChatBoxMessage {
  type: "setChatBoxMessage"
  text: string
  /**
   * Exact relative paths of the file attachments carried by the restored
   * message, if known (e.g. when reverting to a message that had @mentions).
   * When present, PromptInput seeds these directly instead of re-deriving
   * candidate mentions from the text via regex, which cannot tell a complete
   * mention from a truncated prefix when the real path contains a space.
   */
  paths?: string[]
  /**
   * Image attachments to restore into the composer (data-URL FileParts
   * converted to ImageAttachment), e.g. when pulling a queued message back to
   * the editor. When present, PromptInput replaces its current image set.
   */
  images?: ImageAttachment[]
  /**
   * Review comments to restore into the composer, e.g. when pulling a queued
   * message back to the editor. When present, PromptInput replaces its current
   * review comment set.
   */
  review?: ReviewComment[]
  /**
   * When true, PromptInput focuses the textarea after restoring the content
   * (e.g. pull-back-to-editor). The revert path posts without the flag and
   * keeps its current non-focus behavior.
   */
  focus?: boolean
}

export interface AppendChatBoxMessage {
  type: "appendChatBoxMessage"
  text: string
}

export interface TriggerTaskMessage {
  type: "triggerTask"
  text: string
}

export interface ProfileDataMessage {
  type: "profileData"
  data: ProfileData | null
}

export interface DeviceAuthStartedMessage {
  type: "deviceAuthStarted"
  code?: string
  verificationUrl: string
  expiresIn: number
}

export interface DeviceAuthCompleteMessage {
  type: "deviceAuthComplete"
}

export interface DeviceAuthFailedMessage {
  type: "deviceAuthFailed"
  error: string
}

export interface DeviceAuthCancelledMessage {
  type: "deviceAuthCancelled"
}

export interface NavigateMessage {
  type: "navigate"
  view: "newTask" | "history" | "profile" | "settings"
  tab?: string
}

export interface ImageModelsLoadedMessage {
  type: "imageModelsLoaded"
  models: Array<{ id: string; name: string; description?: string }>
}

export interface ProvidersLoadedMessage {
  type: "providersLoaded"
  providers: Record<string, Provider>
  connected: string[]
  defaults: Record<string, string>
  defaultSelection: ModelSelection
  authMethods: Record<string, ProviderAuthMethod[]>
  authStates: Record<string, ProviderAuthState>
  canonical?: false
  materializationVersion?: number
  contentHash?: string
  diagnostics?: Record<string, unknown>
}

export interface CanonicalProvidersLoadedMessage {
  type: "providersLoaded"
  providers: Readonly<Record<string, CanonicalProviderView>>
  connected: readonly string[]
  defaults: Readonly<Record<string, string>>
  defaultSelection: ModelSelection
  canonical: true
  /** P4.1: explicit readiness signal — false for pre-materialization not-ready state. */
  ready: boolean
  materializationVersion: number
  contentHash: string
  diagnostics: Readonly<Record<string, unknown>>
  stamp: CanonicalStamp
}

export interface AgentsLoadedMessage {
  type: "agentsLoaded"
  agents: AgentInfo[]
  allAgents: AgentInfo[]
  defaultAgent: string
  canonical?: false
  materializationVersion?: number
  contentHash?: string
  diagnostics?: Record<string, unknown>
}

export interface CanonicalAgentsLoadedMessage
  extends Omit<AgentsLoadedMessage, "canonical" | "materializationVersion" | "contentHash" | "stamp"> {
  canonical: true
  /** P4.1: explicit readiness signal — false for pre-materialization not-ready state. */
  ready: boolean
  materializationVersion: number
  contentHash: string
  diagnostics: Record<string, unknown>
  stamp: CanonicalStamp
}

export interface AgentMutationAppliedMessage {
  type: "agentMutationApplied"
  requestId: string
  name: string
  contentHash: string
  stamp: CanonicalStamp
  canonical: true
}

export interface AgentMutationErrorMessage {
  type: "agentMutationError"
  requestId: string
  name: string
  message: string
  kind?: string
  canonical: true
  stamp: CanonicalStamp
}

export interface SkillsLoadedMessage {
  type: "skillsLoaded"
  skills: SkillInfo[]
}

export interface AgentRequirementsLoadedMessage {
  type: "agentRequirementsLoaded"
  result: AgentRequirementResult
}

export interface AgentRequirementsInvalidatedMessage {
  type: "agentRequirementsInvalidated"
}

export interface CommandsLoadedMessage {
  type: "commandsLoaded"
  commands: SlashCommandInfo[]
}

export interface SpeechToTextResultMessage {
  type: "speechToTextResult"
  text: string
  requestId: string
}

export interface SpeechToTextStartedMessage {
  type: "speechToTextStarted"
  requestId: string
}

export interface SpeechToTextCancelledMessage {
  type: "speechToTextCancelled"
  requestId: string
}

export interface SpeechToTextErrorMessage {
  type: "speechToTextError"
  error: string
  code?: string
  requestId: string
}

export interface FileSearchItem {
  path: string
  type: "file" | "folder" | "opened-file"
}

export interface FileSearchResultMessage {
  type: "fileSearchResult"
  paths: string[]
  items?: FileSearchItem[]
  dir: string
  requestId: string
}

export interface FilePickerResultMessage {
  type: "filePickerResult"
  path: string
  requestId: string
}

export interface TerminalContextResultMessage {
  type: "terminalContextResult"
  requestId: string
  content: string
  truncated?: boolean
}

export interface TerminalContextErrorMessage {
  type: "terminalContextError"
  requestId: string
  error: string
}

export interface GitChangesContextResultMessage {
  type: "gitChangesContextResult"
  requestId: string
  content: string
  truncated?: boolean
}

export interface GitChangesContextErrorMessage {
  type: "gitChangesContextError"
  requestId: string
  error: string
}

export interface QuestionRequestMessage {
  type: "questionRequest"
  question: QuestionRequest
}

export interface QuestionResolvedMessage {
  type: "questionResolved"
  requestID: string
}

export interface QuestionErrorMessage {
  type: "questionError"
  requestID: string
}

export interface SessionCostAlertMessage {
  type: "sessionCostAlert"
  sessionID: string
  limit: number
  cost: string
}

export interface SessionCostAlertResolvedMessage {
  type: "sessionCostAlertResolved"
  sessionID: string
  limit: number
}

export interface SuggestionRequestMessage {
  type: "suggestionRequest"
  suggestion: SuggestionRequest
}

export interface SuggestionResolvedMessage {
  type: "suggestionResolved"
  requestID: string
}

export interface SuggestionErrorMessage {
  type: "suggestionError"
  requestID: string
}

export interface BrowserSettingsLoadedMessage {
  type: "browserSettingsLoaded"
  settings: BrowserSettings
}

export interface ClaudeCompatSettingLoadedMessage {
  type: "claudeCompatSettingLoaded"
  enabled: boolean
}

export interface ExtensionSettings {
  maxCost?: number
  [key: string]: unknown
}

export interface ConfigLoadedMessage {
  type: "configLoaded"
  config: Config
  globalConfig?: Config
  projectConfig?: Config
  settings?: ExtensionSettings
  features: FeatureFlags
  canonical?: false
  contentHash?: string
  materializationVersion?: number
  diagnostics?: Array<{ path: string[]; message: string }>
}

export interface CanonicalConfigLoadedMessage
  extends Omit<
    ConfigLoadedMessage,
    | "canonical"
    | "config"
    | "globalConfig"
    | "projectConfig"
    | "contentHash"
    | "materializationVersion"
    | "diagnostics"
    | "stamp"
  > {
  canonical: true
  /** P4.1: explicit readiness signal — false for pre-materialization not-ready state. */
  ready: boolean
  config: CanonicalConfigPayload
  globalConfig?: CanonicalConfigPayload
  projectConfig?: CanonicalConfigPayload
  contentHash: string
  materializationVersion: number
  diagnostics: Array<{ path: string[]; message: string }>
  stamp: CanonicalStamp
}

export interface ConfigUpdatedMessage {
  type: "configUpdated"
  config: Config
  globalConfig?: Config
  projectConfig?: Config
  settings?: ExtensionSettings
  features: FeatureFlags
  /**
   * Present when this message acknowledges a specific saveConfig() write.
   * The webview only clears its draft for the save matching its pending ID;
   * echoes of already-confirmed saves are applied, and stale acks for
   * superseded saves only release their own sent snapshot (LOCK-002/005).
   */
  saveID?: string
  /** P4.1: content hash of the committed canonical config for draft stamp tracking. */
  contentHash?: string
  /** P4.1: materialization version for stamp tracking. */
  materializationVersion?: number
  canonical?: false
  diagnostics?: Array<{ path: string[]; message: string }>
}

export interface CanonicalConfigUpdatedMessage
  extends Omit<
    ConfigUpdatedMessage,
    | "canonical"
    | "config"
    | "globalConfig"
    | "projectConfig"
    | "contentHash"
    | "materializationVersion"
    | "diagnostics"
    | "stamp"
  > {
  canonical: true
  /** P4.1: explicit readiness signal — false for pre-materialization not-ready state. */
  ready: boolean
  config: CanonicalConfigPayload
  globalConfig?: CanonicalConfigPayload
  projectConfig?: CanonicalConfigPayload
  contentHash: string
  materializationVersion: number
  diagnostics: Array<{ path: string[]; message: string }>
  stamp: CanonicalStamp
}

export interface ConfigUpdateFailedMessage {
  type: "configUpdateFailed"
  message: string
  details?: string
  /** Save identity echoed from the webview, when the failure maps to one. */
  saveID?: string
  /** P4.1: structured conflict/invalid/stale/not-ready kind. */
  kind?: "stale" | "invalid" | "conflict" | "backend" | "not-ready"
  /** P4.1: content hash of the last-known valid config for stale detection. */
  contentHash?: string
  /** P4.1: materialization version for stamp tracking. */
  materializationVersion?: number
  /** P4.1: validation errors when kind is "invalid". */
  validationErrors?: Array<{ path: string[]; message: string }>
  canonical?: false
}

export interface CanonicalConfigUpdateFailedMessage extends Omit<ConfigUpdateFailedMessage, "canonical"> {
  canonical: true
  stamp: CanonicalStamp
}

export interface GlobalConfigLoadedMessage {
  type: "globalConfigLoaded"
  config: Config
}

export interface NotificationSettingsLoadedMessage {
  type: "notificationSettingsLoaded"
  settings: {
    attentionEnabled: boolean
    attentionSound: string
  }
}

export interface TimelineSettingLoadedMessage {
  type: "timelineSettingLoaded"
  visible: boolean
}

export interface WorkStyleLoadedMessage {
  type: "workStyleLoaded"
  style: WorkStyleState
}

export interface WorkStyleAppliedMessage {
  type: "workStyleApplied"
  style: WorkStyle
}

export interface WorkStyleApplyFailedMessage {
  type: "workStyleApplyFailed"
  message: string
  rollbackFailed: boolean
}

// Agent Manager repo info (current branch of the main workspace)
export interface AgentManagerRepoInfoMessage {
  type: "agentManager.repoInfo"
  branch: string
  defaultBranch?: string
}

export interface AgentManagerSessionAddedMessage {
  type: "agentManager.sessionAdded"
  sessionId: string
}

// Agent Manager session forked from an existing session
export interface AgentManagerSessionForkedMessage {
  type: "agentManager.sessionForked"
  sessionId: string
  forkedFromId: string
}

// Full state push from extension to webview
export interface AgentManagerStateMessage {
  type: "agentManager.state"
  sessions: ManagedSessionState[]
  timing?: Record<string, SessionTimingEntry>
  tabOrder?: Record<string, string[]>
  sessionsCollapsed?: boolean
  sidebarCollapsed?: boolean
  isGitRepo?: boolean
  activeSessionId?: string
}

// ---------------------------------------------------------------------------
// Agent Manager terminal messages
// ---------------------------------------------------------------------------

export interface AgentManagerTerminalCreatedMessage {
  type: "agentManager.terminal.created"
  /** Local workspace slot id (always null for root-local). */
  slotId: string | null
  terminalId: string
  title: string
  wsUrl: string
  font: TerminalFont
}

export interface AgentManagerTerminalFontChangedMessage {
  type: "agentManager.terminal.fontChanged"
  font: TerminalFont
}

export interface AgentManagerTerminalClosedMessage {
  type: "agentManager.terminal.closed"
  terminalId: string
}

export interface AgentManagerTerminalErrorMessage {
  type: "agentManager.terminal.error"
  terminalId?: string
  message: string
}

// Resolved keybindings for agent manager actions
export interface AgentManagerKeybindingsMessage {
  type: "agentManager.keybindings"
  bindings: Record<string, string>
}

export interface AutoApproveStateMessage {
  type: "autoApproveState"
  active: boolean
}

export interface SandboxStatusMessage {
  type: "sandboxStatus"
  sessionID: string
  enabled: boolean
  available: boolean
  reason?: string
  version: number
  directory: string
  revision: number
  requestID?: string
}

export interface SandboxDefaultStatusMessage {
  type: "sandboxDefaultStatus"
  desired: boolean
  enabled: boolean
  available: boolean
  reason?: string
  revision: number
  requestID?: string
}

export interface SandboxStatusErrorMessage {
  type: "sandboxStatusError"
  sessionID: string
  directory: string
  message: string
  revision: number
  requestID?: string
}

// Multi-version creation progress (extension → webview)
export interface AgentManagerMultiVersionProgressMessage {
  type: "agentManager.multiVersionProgress"
  status: "creating" | "done"
  total: number
  completed: number
  groupId?: string
}

// Stored variant selections loaded from extension globalState (extension → webview)
export interface VariantsLoadedMessage {
  type: "variantsLoaded"
  variants: Record<string, string>
}

export interface RecentsLoadedMessage {
  type: "recentsLoaded"
  recents: ModelSelection[]
}

// Persisted model-selector expand/collapse preference (extension → webview)
export interface ModelSelectorExpandedLoadedMessage {
  type: "modelSelectorExpandedLoaded"
  value: boolean
}

export interface FavoritesLoadedMessage {
  type: "favoritesLoaded"
  favorites: ModelSelection[]
}

// Per-mode model selections loaded from model.json (extension → webview)
export interface ModelSelectionsLoadedMessage {
  type: "modelSelectionsLoaded"
  selections: Record<string, ModelSelection>
}

// Agent Manager: Local workspace git stats push (extension → webview)
export interface AgentManagerLocalStatsMessage {
  type: "agentManager.localStats"
  stats: LocalGitStats
}

// Set the model for a session (extension → webview, used during multi-version creation)
export interface AgentManagerSetSessionModelMessage {
  type: "agentManager.setSessionModel"
  sessionId: string
  providerID: string
  modelID: string
}

// Request webview to send initial prompt to a newly created session (extension → webview)
export interface AgentManagerSendInitialMessage {
  type: "agentManager.sendInitialMessage"
  sessionId: string
  text?: string
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
  files?: Array<{ mime: string; url: string }>
}

// Enhance prompt result (extension → webview)
export interface EnhancePromptResultMessage {
  type: "enhancePromptResult"
  text: string
  requestId: string
}

// Enhance prompt error (extension → webview)
export interface EnhancePromptErrorMessage {
  type: "enhancePromptError"
  error: string
  requestId: string
}

export interface ExtensionDataReadyMessage {
  type: "extensionDataReady"
}

export interface TelemetryStateMessage {
  type: "telemetryState"
  enabled: boolean
}

export interface ProviderOAuthReadyMessage {
  type: "providerOAuthReady"
  requestId: string
  providerID: string
  authorization: ProviderAuthAuthorization
}

export interface ProviderConnectedMessage {
  type: "providerConnected"
  requestId: string
  providerID: string
  canonical?: false
}

export interface CanonicalProviderConnectedMessage extends Omit<ProviderConnectedMessage, "canonical"> {
  canonical: true
  stamp: CanonicalStamp
}

export interface ProviderDisconnectedMessage {
  type: "providerDisconnected"
  requestId: string
  providerID: string
  canonical?: false
}

export interface CanonicalProviderDisconnectedMessage extends Omit<ProviderDisconnectedMessage, "canonical"> {
  canonical: true
  stamp: CanonicalStamp
}

export interface ProviderDeletedMessage {
  type: "providerDeleted"
  requestId: string
  providerID: string
  canonical?: false
}

export interface CanonicalProviderDeletedMessage extends Omit<ProviderDeletedMessage, "canonical"> {
  canonical: true
  stamp: CanonicalStamp
}

export interface ProviderActionErrorMessage {
  type: "providerActionError"
  requestId: string
  providerID: string
  action: "authorize" | "connect" | "disconnect" | "delete"
  message: string
  canonical?: false
  kind?: string
  diagnostic?: boolean
  retry?: {
    type: "retryProviderCleanup"
    mode: "delete" | "restore"
    scope: "global" | "project"
    stamp: CanonicalStamp
    retryID: string
  }
}

export interface CanonicalProviderActionErrorMessage extends Omit<ProviderActionErrorMessage, "canonical" | "retry"> {
  canonical: true
  stamp: CanonicalStamp
  retry?: {
    type: "retryProviderCleanup"
    mode: "delete" | "restore"
    scope: "global" | "project"
    stamp: CanonicalStamp
    retryID: string
  }
}

export interface ProviderCredentialLoadedMessage {
  type: "providerCredentialLoaded"
  requestID: string
  providerID: string
  hasCredential?: boolean
  canonical?: false
  apiKey?: string
}

export interface CanonicalProviderCredentialLoadedMessage {
  type: "providerCredentialLoaded"
  requestID: string
  providerID: string
  hasCredential: boolean
  canonical: true
  stamp: CanonicalStamp
}

export interface ProviderCredentialErrorMessage {
  type: "providerCredentialError"
  requestID: string
  providerID: string
  error: string
}

export interface CanonicalConfigErrorMessage {
  type: "canonicalConfigError"
  kind: string
  message: string
  diagnostics?: readonly unknown[]
  stamp: CanonicalStamp
}

export interface CustomProviderModelsFetchedMessage {
  type: "customProviderModelsFetched"
  requestId: string
  models?: Array<{ id: string; name: string }>
  error?: string
  /** True when error was HTTP 401/403 — hints the user to check their API key */
  auth?: boolean
}

export interface McpStatusEntry {
  status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"
  error?: string
}

export interface McpStatusLoadedMessage {
  type: "mcpStatusLoaded"
  status: Record<string, McpStatusEntry>
}

export interface McpCleanupErrorMessage {
  type: "mcpCleanupError"
  name: string
  /** Present only when the request carried a legal scope (post-commit failures). */
  scope?: "global" | "project"
  retryID: string
  message: string
  stamp: CanonicalStamp
}

export interface McpCleanupRetryResultMessage {
  type: "mcpCleanupRetryResult"
  requestId: string
  name: string
  ok: boolean
  message?: string
  stamp?: CanonicalStamp
}

export interface RemoteStatusMessage {
  type: "remoteStatus"
  enabled: boolean
  connected: boolean
}

export interface ActivateSessionMessage {
  type: "activateSession"
  sessionID: string
}

export interface ValidateFilesResultMessage {
  type: "validateFilesResult"
  id: string
  existing: string[]
}

export type ExtensionMessage =
  | ActivateSessionMessage
  | ReadyMessage
  | FontSizeChangedMessage
  | GitStatusMessage
  | ConnectionStateMessage
  | ErrorMessage
  | SendMessageFailedMessage
  | PartUpdatedMessage
  | PartsUpdatedMessage
  | PartRemovedMessage
  | SessionStatusMessage
  | SessionTurnClosedMessage
  | SessionErrorMessage
  | PermissionRequestMessage
  | PermissionResolvedMessage
  | PermissionErrorMessage
  | TodoUpdatedMessage
  | SessionCreatedMessage
  | SessionForkedMessage
  | SessionUpdatedMessage
  | SessionDeletedMessage
  | MessageRemovedMessage
  | MessagesLoadedMessage
  | SessionModelUsageLoadedMessage
  | SessionModelUsageChangedMessage
  | MessageCreatedMessage
  | SessionsLoadedMessage
  | ActionMessage
  | ProfileDataMessage
  | DeviceAuthStartedMessage
  | DeviceAuthCompleteMessage
  | DeviceAuthFailedMessage
  | DeviceAuthCancelledMessage
  | NavigateMessage
  | ImageModelsLoadedMessage
  | ProvidersLoadedMessage
  | CanonicalProvidersLoadedMessage
  | AgentsLoadedMessage
  | CanonicalAgentsLoadedMessage
  | AgentMutationAppliedMessage
  | AgentMutationErrorMessage
  | SkillsLoadedMessage
  | AgentRequirementsLoadedMessage
  | AgentRequirementsInvalidatedMessage
  | CommandsLoadedMessage
  | SpeechToTextStartedMessage
  | SpeechToTextCancelledMessage
  | SpeechToTextResultMessage
  | SpeechToTextErrorMessage
  | FileSearchResultMessage
  | FilePickerResultMessage
  | TerminalContextResultMessage
  | TerminalContextErrorMessage
  | GitChangesContextResultMessage
  | GitChangesContextErrorMessage
  | QuestionRequestMessage
  | QuestionResolvedMessage
  | QuestionErrorMessage
  | SessionCostAlertMessage
  | SessionCostAlertResolvedMessage
  | SuggestionRequestMessage
  | SuggestionResolvedMessage
  | SuggestionErrorMessage
  | BrowserSettingsLoadedMessage
  | ClaudeCompatSettingLoadedMessage
  | ConfigLoadedMessage
  | CanonicalConfigLoadedMessage
  | ConfigUpdatedMessage
  | CanonicalConfigUpdatedMessage
  | ConfigUpdateFailedMessage
  | CanonicalConfigUpdateFailedMessage
  | GlobalConfigLoadedMessage
  | NotificationSettingsLoadedMessage
  | TimelineSettingLoadedMessage
  | WorkStyleLoadedMessage
  | WorkStyleAppliedMessage
  | WorkStyleApplyFailedMessage
  | AgentManagerRepoInfoMessage
  | AgentManagerSessionAddedMessage
  | AgentManagerSessionForkedMessage
  | AgentManagerStateMessage
  | AgentManagerKeybindingsMessage
  | AutoApproveStateMessage
  | SandboxStatusMessage
  | SandboxDefaultStatusMessage
  | SandboxStatusErrorMessage
  | AgentManagerMultiVersionProgressMessage
  | AgentManagerSetSessionModelMessage
  | AgentManagerSendInitialMessage
  | SetChatBoxMessage
  | AppendChatBoxMessage
  | TriggerTaskMessage
  | VariantsLoadedMessage
  | SelectKiloModelMessage
  | AgentManagerLocalStatsMessage
  | WorkspaceDirectoryChangedMessage
  | AgentManagerTerminalCreatedMessage
  | AgentManagerTerminalFontChangedMessage
  | AgentManagerTerminalClosedMessage
  | AgentManagerTerminalErrorMessage
  | EnhancePromptResultMessage
  | EnhancePromptErrorMessage
  | ProviderOAuthReadyMessage
  | ProviderConnectedMessage
  | CanonicalProviderConnectedMessage
  | ProviderDisconnectedMessage
  | CanonicalProviderDisconnectedMessage
  | ProviderDeletedMessage
  | CanonicalProviderDeletedMessage
  | ProviderActionErrorMessage
  | CanonicalProviderActionErrorMessage
  | ProviderCredentialLoadedMessage
  | CanonicalProviderCredentialLoadedMessage
  | ProviderCredentialErrorMessage
  | CanonicalConfigErrorMessage
  | AnacondaDesktopExtensionMessage
  | CustomProviderModelsFetchedMessage
  | RecentsLoadedMessage
  | ModelSelectorExpandedLoadedMessage
  | FavoritesLoadedMessage
  | ModelSelectionsLoadedMessage
  | LanguageChangedMessage
  | McpStatusLoadedMessage
  | McpCleanupErrorMessage
  | McpCleanupRetryResultMessage
  | ExtensionDataReadyMessage
  | TelemetryStateMessage
  | RemoteStatusMessage
  | ValidateFilesResultMessage
