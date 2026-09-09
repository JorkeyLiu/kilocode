import type { InstallMarketplaceItemOptions, MarketplaceFilters, MarketplaceItem } from "../marketplace"
import type { FileAttachment } from "./parts"
import type { MessageLoadMode } from "./sessions"
import type { ModelSelection, ProviderConfig } from "./providers"
import type { CanonicalConfigPayload, CanonicalProviderPayload, CanonicalStamp } from "../../../../src/config/types"
import type { ReviewMessageData } from "../../../../src/shared/review-comments"
import type { WorkStyle, WorkStyleState } from "../../../../src/shared/work-style-presets"
import type { AnacondaDesktopWebviewMessage } from "../../../../src/shared/anaconda-desktop-messages"

// ============================================
// Messages FROM webview TO extension
// ============================================

export interface SendMessageRequest {
  type: "sendMessage"
  text: string
  messageID?: string
  sessionID?: string
  draftID?: string
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
  files?: FileAttachment[]
  review?: ReviewMessageData
  agentManagerContext?: string
  contextDirectory?: string
}

export interface AbortRequest {
  type: "abort"
  sessionID: string
}

export interface RevertSessionRequest {
  type: "revertSession"
  sessionID: string
  messageID: string
  partID?: string
}

export interface UnrevertSessionRequest {
  type: "unrevertSession"
  sessionID: string
}

export interface CancelQueuedRequest {
  type: "cancelQueued"
  sessionID: string
  messageID: string
}

export interface PermissionResponseRequest {
  type: "permissionResponse"
  permissionId: string
  sessionID: string
  response: "once" | "always" | "reject"
  approvedAlways: string[]
  deniedAlways: string[]
}

export interface CreateSessionRequest {
  type: "createSession"
}

export interface ClearSessionRequest {
  type: "clearSession"
}

export interface LoadMessagesRequest {
  type: "loadMessages"
  sessionID: string
  mode?: MessageLoadMode
  before?: string
  limit?: number
}

export interface LoadSessionsRequest {
  type: "loadSessions"
  /** Opaque next-page cursor for load-more; omit for a full refresh (page 1). */
  cursor?: string
}

export interface RequestSessionModelUsageMessage {
  type: "requestSessionModelUsage"
  sessionID: string
  requestID: string
}

export interface LoginRequest {
  type: "login"
}

export interface LogoutRequest {
  type: "logout"
}

export interface RefreshProfileRequest {
  type: "refreshProfile"
}

export interface OpenExternalRequest {
  type: "openExternal"
  url: string
}

export interface OpenFileRequest {
  type: "openFile"
  filePath: string
  line?: number
  column?: number
}

export interface OpenContentRequest {
  type: "openContent"
  content: string
  language?: string
}

export interface ValidateFilesRequest {
  type: "validateFiles"
  id: string
  paths: string[]
}

export interface CancelLoginRequest {
  type: "cancelLogin"
}

export interface SetOrganizationRequest {
  type: "setOrganization"
  organizationId: string | null
}

export interface WebviewReadyRequest {
  type: "webviewReady"
}

export interface SelectSourceRequest {
  type: "selectSource"
  id: string
}

export interface RequestProvidersMessage {
  type: "requestProviders"
}

export interface OpenSettingsPanelRequest {
  type: "openSettingsPanel"
  tab?: string
}

export interface OpenProfilePanelRequest {
  type: "openProfilePanel"
}

export interface OpenVSCodeSettingsRequest {
  type: "openVSCodeSettings"
  query: string
}

export interface OpenConfigFileRequest {
  type: "openConfigFile"
  scope: "local" | "global"
  labels: {
    scope: string
    statusLoaded: string
    statusNotLoaded: string
    statusCreate: string
    title: string
    placeholder: string
    noWorkspace: string
    openFailed: string
    sourceGlobal: string
    sourceLocal: string
  }
}

export interface OpenMarketplacePanelRequest {
  type: "openMarketplacePanel"
  directory?: string
}

export interface RequestAgentsMessage {
  type: "requestAgents"
}

export interface RequestSkillsMessage {
  type: "requestSkills"
}

export interface RequestAgentRequirementsMessage {
  type: "requestAgentRequirements"
  agent: string
  directory: string
  sessionID?: string
  force?: boolean
}

export interface RequestCommandsMessage {
  type: "requestCommands"
}

export interface SendCommandRequest {
  type: "sendCommand"
  command: string
  arguments: string
  messageID?: string
  sessionID?: string
  draftID?: string
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
  files?: FileAttachment[]
  agentManagerContext?: string
  contextDirectory?: string
}

export interface RemoveSkillMessage {
  type: "removeSkill"
  location: string
}

export interface LegacyRemoveModeMessage {
  type: "removeAgent"
  name: string
  canonical?: false
  scope?: "global" | "project"
  expectedHash?: string
}

export interface CanonicalRemoveModeMessage {
  type: "removeAgent"
  name: string
  canonical: true
  scope: "global" | "project"
  expectedHash: string
  stamp: CanonicalStamp
}

export type RemoveModeMessage = LegacyRemoveModeMessage | CanonicalRemoveModeMessage

export interface LegacyMutateAgentMessage {
  type: "mutateAgent"
  action: "create" | "edit" | "import"
  name: string
  frontmatter: Record<string, unknown>
  body: string
  scope?: "global" | "project"
  expectedHash: string
  canonical?: false
  requestId: string
}

export interface CanonicalMutateAgentMessage {
  type: "mutateAgent"
  canonical: true
  action: "create" | "edit" | "import"
  name: string
  frontmatter: Record<string, unknown>
  body: string
  scope: "global" | "project"
  expectedHash: string
  stamp: CanonicalStamp
  requestId: string
}

export type MutateAgentMessage = LegacyMutateAgentMessage | CanonicalMutateAgentMessage

export interface LegacyRemoveMcpMessage {
  type: "removeMcp"
  name: string
  canonical?: false
}

export interface CanonicalRemoveMcpMessage {
  type: "removeMcp"
  name: string
  canonical: true
  scope: "global" | "project"
  expectedHash: string
  stamp: CanonicalStamp
}

export type RemoveMcpMessage = LegacyRemoveMcpMessage | CanonicalRemoveMcpMessage

export interface RetryMcpCleanupMessage {
  type: "retryMcpCleanup"
  requestId: string
  /** Opaque host-owned retry ID — the host looks up its stored record. */
  retryID: string
}

export interface RequestMcpStatusMessage {
  type: "requestMcpStatus"
}

export interface ConnectMcpMessage {
  type: "connectMcp"
  name: string
}

export interface DisconnectMcpMessage {
  type: "disconnectMcp"
  name: string
}

export interface AuthenticateMcpMessage {
  type: "authenticateMcp"
  name: string
}

export interface SetLanguageRequest {
  type: "setLanguage"
  locale: string
}

export interface QuestionReplyRequest {
  type: "questionReply"
  requestID: string
  sessionID?: string
  answers: string[][]
}

export interface QuestionRejectRequest {
  type: "questionReject"
  requestID: string
  sessionID?: string
}

export interface SessionCostAlertResponseRequest {
  type: "sessionCostAlertResponse"
  sessionID: string
  limit: number
  response: "continue" | "stop"
}

export interface SuggestionAcceptRequest {
  type: "suggestionAccept"
  requestID: string
  sessionID: string
  index: number
}

export interface SuggestionDismissRequest {
  type: "suggestionDismiss"
  requestID: string
  sessionID: string
}

export interface DeleteSessionRequest {
  type: "deleteSession"
  sessionID: string
}

export interface RenameSessionRequest {
  type: "renameSession"
  sessionID: string
  title: string
}

export interface ExportSessionTranscriptRequest {
  type: "exportSessionTranscript"
  sessionID: string
}

export interface SpeechToTextPrewarmMessage {
  type: "speechToTextPrewarm"
}

export interface SpeechToTextStartMessage {
  type: "speechToTextStart"
  requestId: string
  model: string
  language?: string
}

export interface SpeechToTextStopMessage {
  type: "speechToTextStop"
  requestId: string
}

export interface SpeechToTextCancelMessage {
  type: "speechToTextCancel"
  requestId: string
}

export interface RequestFileSearchMessage {
  type: "requestFileSearch"
  query: string
  requestId: string
  sessionID?: string
}

export interface RequestFilePickerMessage {
  type: "requestFilePicker"
  requestId: string
}

export interface RequestTerminalContextMessage {
  type: "requestTerminalContext"
  requestId: string
  sessionID?: string
}

export interface RequestGitChangesContextMessage {
  type: "requestGitChangesContext"
  requestId: string
  sessionID?: string
  agentManagerContext?: string
}

export interface UpdateSettingRequest {
  type: "updateSetting"
  key: string
  value: unknown
}

export interface RequestTimelineSettingMessage {
  type: "requestTimelineSetting"
}

export interface RequestWorkStyleMessage {
  type: "requestWorkStyle"
}

export interface SetWorkStyleMessage {
  type: "setWorkStyle"
  style: WorkStyleState
}

export interface ApplyWorkStyleMessage {
  type: "applyWorkStyle"
  style: WorkStyle
}

export interface StreamSessionVisibleMessage {
  type: "streamSessionVisible"
  sessionID: string
  visible: boolean
}

export interface RequestBrowserSettingsMessage {
  type: "requestBrowserSettings"
}

export interface RequestClaudeCompatSettingMessage {
  type: "requestClaudeCompatSetting"
}

export interface RequestConfigMessage {
  type: "requestConfig"
}

export interface RequestGlobalConfigMessage {
  type: "requestGlobalConfig"
}

export interface RequestImageModelsMessage {
  type: "requestImageModels"
}

export interface CanonicalUpdateConfigMessage {
  type: "updateConfig"
  canonical: true
  config: CanonicalConfigPayload
  globalUnset?: string[][]
  projectConfig?: CanonicalConfigPayload
  projectUnset?: string[][]
  saveID?: string
  stamp: CanonicalStamp
}

/**
 * VS Code Settings writes are canonical-only. The legacy SDK-transaction
 * updateConfig shape was removed with the reconcile path; the extension
 * rejects any non-canonical message with a structured configUpdateFailed.
 */
export type UpdateConfigMessage = CanonicalUpdateConfigMessage

export interface RequestNotificationSettingsMessage {
  type: "requestNotificationSettings"
}

export interface TestNotificationMessage {
  type: "testNotification"
  sound: string
}

export interface ResetAllSettingsRequest {
  type: "resetAllSettings"
}

export interface SettingsTabChangedMessage {
  type: "settingsTabChanged"
  tab: string
}

export interface SyncSessionRequest {
  type: "syncSession"
  sessionID: string
  parentSessionID?: string
}

export interface TelemetryRequest {
  type: "telemetry"
  event: string
  properties?: Record<string, unknown>
}

// Fork an existing session (copies conversation history)
export interface ForkSessionRequest {
  type: "agentManager.forkSession"
  sessionId: string
  messageId?: string
}

export interface SidebarForkSessionRequest {
  type: "forkSession"
  sessionId: string
  messageId?: string
}

// Stop and remove a session from Agent Manager
export interface CloseSessionRequest {
  type: "agentManager.closeSession"
  sessionId: string
}

/** Persist a session to the managed-session registry. */
export interface PersistSessionRequest {
  type: "agentManager.persistSession"
  sessionId: string
  draftID?: string
}

/** Remove a session from the managed-session registry. */
export interface ForgetSessionRequest {
  type: "agentManager.forgetSession"
  sessionId: string
}

export interface RequestRepoInfoMessage {
  type: "agentManager.requestRepoInfo"
}

export interface RequestStateMessage {
  type: "agentManager.requestState"
}

// Show terminal for a session
export interface ShowTerminalRequest {
  type: "agentManager.showTerminal"
  sessionId: string
}

// Show terminal for the local workspace (when no session is active)
export interface ShowLocalTerminalRequest {
  type: "agentManager.showLocalTerminal"
}

// Copy text to the system clipboard via the extension host
export interface CopyToClipboardRequest {
  type: "agentManager.copyToClipboard"
  text: string
}

// Show existing local terminal when switching to local context (no-op if none exists)
export interface ShowExistingLocalTerminalRequest {
  type: "agentManager.showExistingLocalTerminal"
}

// Create a new xterm terminal tab in the local workspace
export interface AgentManagerTerminalCreateRequest {
  type: "agentManager.terminal.create"
  slotId: string | null
}

// Close a terminal tab
export interface AgentManagerTerminalCloseRequest {
  type: "agentManager.terminal.close"
  terminalId: string
}

// Notify the extension of an xterm resize so it can update the backend PTY dimensions
export interface AgentManagerTerminalResizeRequest {
  type: "agentManager.terminal.resize"
  terminalId: string
  cols: number
  rows: number
}

// Open a file in the selected session
export interface AgentManagerOpenFileRequest {
  type: "agentManager.openFile"
  sessionId: string
  filePath: string
  line?: number
  column?: number
}

// Persist tab order for a context
export interface SetTabOrderRequest {
  type: "agentManager.setTabOrder"
  key: string
  order: string[]
}

// Persist sessions collapsed state
export interface SetSessionsCollapsedRequest {
  type: "agentManager.setSessionsCollapsed"
  collapsed: boolean
}

// Persist sidebar collapsed state
export interface SetSidebarCollapsedRequest {
  type: "agentManager.setSidebarCollapsed"
  collapsed: boolean
}

// Variant persistence (webview → extension)
export interface PersistVariantRequest {
  type: "persistVariant"
  key: string
  value: string
}

// Request stored variants from extension (webview → extension)
export interface RequestVariantsMessage {
  type: "requestVariants"
}

// Enhance prompt request (webview → extension)
export interface EnhancePromptRequest {
  type: "enhancePrompt"
  text: string
  requestId: string
}

export interface RetryConnectionRequest {
  type: "retryConnection"
}

export interface ReloadRequest {
  type: "reload"
}

// Preview an image attachment in VS Code's built-in image viewer
export interface PreviewImageRequest {
  type: "previewImage"
  dataUrl: string
  filename: string
}

export interface SaveImageRequest {
  type: "saveImage"
  dataUrl: string
  filename: string
}

// Set default base branch (webview → extension)
export interface SetDefaultBaseBranchRequest {
  type: "agentManager.setDefaultBaseBranch"
  branch?: string
}

// Report all open session IDs to extension for heartbeat (webview → extension)
export interface AgentManagerOpenSessionsMessage {
  type: "agentManager.openSessions"
  sessionIDs: string[]
}

export interface AgentManagerVisibleSessionMessage {
  type: "agentManager.visibleSession"
  sessionID: string | null
}

export interface RequestAutoApproveStateMessage {
  type: "requestAutoApproveState"
}

export interface ToggleAutoApproveMessage {
  type: "toggleAutoApprove"
}

export interface RequestSandboxStatusMessage {
  type: "requestSandboxStatus"
  sessionID: string
}

export interface RequestSandboxDefaultMessage {
  type: "requestSandboxDefault"
  requestID?: string
  agentManagerContext?: string
  contextDirectory?: string
}

export interface SetSandboxDefaultMessage {
  type: "setSandboxDefault"
  enabled: boolean
  requestID: string
  agentManagerContext?: string
  contextDirectory?: string
}

export interface ToggleSandboxMessage {
  type: "toggleSandbox"
  sessionID: string
  requestID: string
  agentManagerContext?: string
  contextDirectory?: string
}

export interface ToggleRemoteMessage {
  type: "toggleRemote"
}

export interface SetRemoteEnabledMessage {
  type: "setRemoteEnabled"
  enabled: boolean
}

export interface RequestRemoteStatusMessage {
  type: "requestRemoteStatus"
}

export interface CanonicalConnectProviderMessage {
  type: "connectProvider"
  canonical: true
  requestId: string
  providerID: string
  metadata?: Record<string, string>
  credentialRequested: boolean
  stamp: CanonicalStamp
}

export type ConnectProviderMessage = CanonicalConnectProviderMessage

export interface AuthorizeProviderOAuthMessage {
  type: "authorizeProviderOAuth"
  canonical: false
  requestId: string
  providerID: string
  method: number
}

export interface CompleteProviderOAuthMessage {
  type: "completeProviderOAuth"
  canonical: false
  requestId: string
  providerID: string
  method: number
  code?: string
}

export interface DisconnectProviderMessage {
  type: "disconnectProvider"
  requestId: string
  providerID: string
  canonical: true
  stamp: CanonicalStamp
}

export interface RetryProviderCleanupMessage {
  type: "retryProviderCleanup"
  requestId: string
  /** Opaque host-owned retry ID — the host looks up its stored record. */
  retryID: string
}

export interface CanonicalSaveCustomProviderMessage {
  type: "saveCustomProvider"
  canonical: true
  requestId: string
  providerID: string
  config: CanonicalProviderPayload
  credentialRequested: boolean
  stamp: CanonicalStamp
}

export type SaveCustomProviderMessage = CanonicalSaveCustomProviderMessage

export interface CanonicalDeleteCustomProviderMessage {
  type: "deleteCustomProvider"
  requestId: string
  providerID: string
  canonical: true
  stamp: CanonicalStamp
}

export type DeleteCustomProviderMessage = CanonicalDeleteCustomProviderMessage

export interface GetProviderCredentialMessage {
  type: "getProviderCredential"
  requestID: string
  providerID: string
}

export interface FetchCustomProviderModelsMessage {
  type: "fetchCustomProviderModels"
  requestId: string
  baseURL: string
  apiKey?: string
  canonical?: false
  /**
   * When editing an existing provider and the key field is untouched, the
   * webview has no key to send (keys are stripped before they reach it).
   * It sends the providerID instead so the extension can authenticate the
   * fetch with the stored key — which never crosses into the webview.
   */
  providerID?: string
  headers?: Record<string, string>
}

export interface CanonicalFetchCustomProviderModelsMessage {
  type: "fetchCustomProviderModels"
  canonical: true
  requestId: string
  baseURL: string
  providerID?: string
  credentialRequested: boolean
  stamp: CanonicalStamp
}

export interface PersistRecentsRequest {
  type: "persistRecents"
  recents: ModelSelection[]
}

export interface RequestRecentsMessage {
  type: "requestRecents"
}

export interface PersistModelSelectorExpandedRequest {
  type: "persistModelSelectorExpanded"
  value: boolean
}

export interface RequestModelSelectorExpandedMessage {
  type: "requestModelSelectorExpanded"
}

export interface ToggleFavoriteRequest {
  type: "toggleFavorite"
  action: "add" | "remove"
  providerID: string
  modelID: string
}

export interface RequestFavoritesMessage {
  type: "requestFavorites"
}

// Per-mode model selection persistence (webview → extension)
export interface PersistModelSelectionRequest {
  type: "persistModelSelection"
  agent: string
  providerID: string
  modelID: string
}

export interface ClearModelSelectionRequest {
  type: "clearModelSelection"
  agent: string
}

export interface RequestModelSelectionsMessage {
  type: "requestModelSelections"
}

export interface FetchMarketplaceDataMessage {
  type: "fetchMarketplaceData"
}

export interface FilterMarketplaceItemsMessage {
  type: "filterMarketplaceItems"
  filters: MarketplaceFilters
}

export interface InstallMarketplaceItemMessage {
  type: "installMarketplaceItem"
  mpItem: MarketplaceItem
  mpInstallOptions: InstallMarketplaceItemOptions
}

export interface RemoveInstalledMarketplaceItemMessage {
  type: "removeInstalledMarketplaceItem"
  mpItem: MarketplaceItem
  mpInstallOptions: InstallMarketplaceItemOptions
}

export interface DismissAgentMigrationBannerMessage {
  type: "dismissAgentMigrationBanner"
}

/**
 * Opt-in P0 perf stage forwarded from the webview (only sent when the
 * extension injected `window.__KILO_P0_PERF__ = true` into the webview HTML).
 */
export interface P0PerfMessage {
  type: "p0Perf"
  stage: string
  t: number
  wd: number
}

export type WebviewMessage =
  | SendMessageRequest
  | AbortRequest
  | RevertSessionRequest
  | UnrevertSessionRequest
  | CancelQueuedRequest
  | PermissionResponseRequest
  | CreateSessionRequest
  | ClearSessionRequest
  | LoadMessagesRequest
  | LoadSessionsRequest
  | RequestSessionModelUsageMessage
  | LoginRequest
  | LogoutRequest
  | RefreshProfileRequest
  | OpenExternalRequest
  | OpenSettingsPanelRequest
  | OpenProfilePanelRequest
  | OpenVSCodeSettingsRequest
  | OpenConfigFileRequest
  | OpenMarketplacePanelRequest
  | OpenFileRequest
  | ValidateFilesRequest
  | CancelLoginRequest
  | SetOrganizationRequest
  | WebviewReadyRequest
  | SelectSourceRequest
  | RequestProvidersMessage
  | RequestAgentsMessage
  | RequestSkillsMessage
  | RequestAgentRequirementsMessage
  | RequestCommandsMessage
  | SendCommandRequest
  | RemoveSkillMessage
  | RemoveModeMessage
  | MutateAgentMessage
  | RemoveMcpMessage
  | RetryMcpCleanupMessage
  | RequestMcpStatusMessage
  | ConnectMcpMessage
  | DisconnectMcpMessage
  | AuthenticateMcpMessage
  | SetLanguageRequest
  | QuestionReplyRequest
  | QuestionRejectRequest
  | SessionCostAlertResponseRequest
  | SuggestionAcceptRequest
  | SuggestionDismissRequest
  | DeleteSessionRequest
  | RenameSessionRequest
  | ExportSessionTranscriptRequest
  | SpeechToTextPrewarmMessage
  | SpeechToTextStartMessage
  | SpeechToTextStopMessage
  | SpeechToTextCancelMessage
  | RequestFileSearchMessage
  | RequestFilePickerMessage
  | RequestTerminalContextMessage
  | RequestGitChangesContextMessage
  | UpdateSettingRequest
  | RequestTimelineSettingMessage
  | RequestWorkStyleMessage
  | SetWorkStyleMessage
  | ApplyWorkStyleMessage
  | StreamSessionVisibleMessage
  | RequestBrowserSettingsMessage
  | RequestClaudeCompatSettingMessage
  | RequestConfigMessage
  | RequestGlobalConfigMessage
  | UpdateConfigMessage
  | RequestNotificationSettingsMessage
  | TestNotificationMessage
  | ResetAllSettingsRequest
  | SettingsTabChangedMessage
  | SyncSessionRequest
  | ForkSessionRequest
  | SidebarForkSessionRequest
  | CloseSessionRequest
  | PersistSessionRequest
  | ForgetSessionRequest
  | TelemetryRequest
  | RequestRepoInfoMessage
  | RequestStateMessage
  | ShowTerminalRequest
  | ShowLocalTerminalRequest
  | CopyToClipboardRequest
  | ShowExistingLocalTerminalRequest
  | AgentManagerOpenFileRequest
  | SetTabOrderRequest
  | SetSessionsCollapsedRequest
  | SetSidebarCollapsedRequest
  | PersistVariantRequest
  | RequestVariantsMessage
  | EnhancePromptRequest
  | RetryConnectionRequest
  | ReloadRequest
  | PreviewImageRequest
  | SaveImageRequest
  | SetDefaultBaseBranchRequest
  | AgentManagerOpenSessionsMessage
  | AgentManagerVisibleSessionMessage
  | RequestAutoApproveStateMessage
  | ToggleAutoApproveMessage
  | RequestSandboxStatusMessage
  | RequestSandboxDefaultMessage
  | SetSandboxDefaultMessage
  | ToggleSandboxMessage
  | FetchMarketplaceDataMessage
  | FilterMarketplaceItemsMessage
  | InstallMarketplaceItemMessage
  | RemoveInstalledMarketplaceItemMessage
  | DismissAgentMigrationBannerMessage
  | ConnectProviderMessage
  | AuthorizeProviderOAuthMessage
  | CompleteProviderOAuthMessage
  | DisconnectProviderMessage
  | RetryProviderCleanupMessage
  | AnacondaDesktopWebviewMessage
  | SaveCustomProviderMessage
  | DeleteCustomProviderMessage
  | GetProviderCredentialMessage
  | FetchCustomProviderModelsMessage
  | CanonicalFetchCustomProviderModelsMessage
  | PersistRecentsRequest
  | RequestRecentsMessage
  | PersistModelSelectorExpandedRequest
  | RequestModelSelectorExpandedMessage
  | ToggleFavoriteRequest
  | RequestFavoritesMessage
  | PersistModelSelectionRequest
  | ClearModelSelectionRequest
  | RequestModelSelectionsMessage
  | ToggleRemoteMessage
  | SetRemoteEnabledMessage
  | RequestRemoteStatusMessage
  | OpenContentRequest
  | AgentManagerTerminalCreateRequest
  | AgentManagerTerminalCloseRequest
  | AgentManagerTerminalResizeRequest
  | RequestImageModelsMessage
  | P0PerfMessage

// ============================================
// VS Code API type
// ============================================

export interface VSCodeAPI {
  postMessage(message: WebviewMessage): void
  getState(): unknown
  setState(state: unknown): void
}

declare global {
  function acquireVsCodeApi(): VSCodeAPI
}
