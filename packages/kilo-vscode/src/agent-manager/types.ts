/**
 * Typed message contracts for the Agent Manager extension ↔ webview boundary.
 *
 * These types must stay in sync with webview-ui/src/types/messages.ts.
 * The webview side re-uses the types directly; this file provides the
 * extension-side equivalents so onMessage() and postToWebview() are
 * type-checked rather than relying on Record<string, unknown> casts.
 */

import type { SnapshotFileDiff } from "@kilocode/sdk/v2/client"
import type { DiffImage } from "./diff-media"
import type { SessionTimingMap } from "./session-timing"

export type { SessionTimingEntry } from "./session-timing"

// ---------------------------------------------------------------------------
// Shared payload types
// ---------------------------------------------------------------------------

export type LocalDiffEntry = SnapshotFileDiff & {
  before?: string
  after?: string
  tracked?: boolean
  generatedLike?: boolean
  summarized?: boolean
  stamp?: string
  kind?: "image"
  image?: DiffImage
}

/** Minimal session record for local-only Agent Manager state. */
export interface ManagedSession {
  id: string
}

// ---------------------------------------------------------------------------
// Extension → Webview messages (postToWebview)
// ---------------------------------------------------------------------------

interface LocalStatsMessage {
  type: "agentManager.localStats"
  stats: { branch: string; files: number; additions: number; deletions: number; ahead: number; behind: number }
}

export interface PanelOperationRecovery {
  v: 1
  owner: "generation"
  scope: string
  used: number
  limit: number
  terminated: boolean
  nextAt: number | null
  retryOccurrence: number | null
  layer: "provider" | "incomplete" | "broker" | "task" | "restart" | null
  closeReason: "completed" | "interrupted" | "error" | "crash" | null
  replay: false
}

export interface PanelOperation {
  opId: string
  outcome: "succeeded" | "failed" | "ambiguous" | "in-flight" | "superseded" | "abandoned"
  code: string
  message: string
  time: number
  cancel?: { source: "user_stop" | "steering" | "timeout" | "network_disconnect" | "unknown" }
  recovery?: PanelOperationRecovery
}

interface StateMessage {
  type: "agentManager.state"
  sessions: ManagedSession[]
  timing?: SessionTimingMap
  tabOrder?: Record<string, string[]>
  sessionsCollapsed?: boolean
  sidebarCollapsed?: boolean
  isGitRepo?: boolean
  activeSessionId?: string
  recentOperations?: Record<string, PanelOperation>
}

interface ErrorOutMessage {
  type: "error"
  message: string
}

interface SessionAddedMessage {
  type: "agentManager.sessionAdded"
  sessionId: string
}

interface SessionForkedMessage {
  type: "agentManager.sessionForked"
  sessionId: string
  forkedFromId: string
}

interface SetSessionModelMessage {
  type: "agentManager.setSessionModel"
  sessionId: string
  providerID: string
  modelID: string
}

interface SendInitialMessage {
  type: "agentManager.sendInitialMessage"
  sessionId: string
  text?: string
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
  files?: Array<{ mime: string; url: string }>
}

interface KeybindingsMessage {
  type: "agentManager.keybindings"
  bindings: Record<string, string>
}

interface RepoInfoMessage {
  type: "agentManager.repoInfo"
  branch: string
  defaultBranch?: string
}

interface ActionOutMessage {
  type: "action"
  action: string
}

/**
 * Fixture-only per-seed delivery barrier (KILO_E2E_FIXTURE).
 * Extension→webview ping with a non-empty token; the webview acks after at
 * most one rAF so FIFO ordering proves prior synchronous seed handlers ran.
 * Production never sends this; no queue, no production semantics change.
 */
interface FixtureBarrierMessage {
  type: "agentManager.fixtureBarrier"
  token: string
}

/** All messages the Agent Manager extension sends to the webview. */
export type AgentManagerOutMessage =
  | LocalStatsMessage
  | StateMessage
  | ErrorOutMessage
  | SessionAddedMessage
  | SessionForkedMessage
  | SetSessionModelMessage
  | SendInitialMessage
  | KeybindingsMessage
  | RepoInfoMessage
  | ActionOutMessage
  | FixtureBarrierMessage

// ---------------------------------------------------------------------------
// Webview → Extension messages (onMessage)
// ---------------------------------------------------------------------------

interface CloseSessionIn {
  type: "agentManager.closeSession"
  sessionId: string
}

/** Persist a session to the managed-session registry. */
interface PersistSessionIn {
  type: "agentManager.persistSession"
  sessionId: string
  draftID?: string
}

/** Remove a session from the managed-session registry. */
interface ForgetSessionIn {
  type: "agentManager.forgetSession"
  sessionId: string
}

interface CopyToClipboardIn {
  type: "agentManager.copyToClipboard"
  text: string
}

interface RequestRepoInfoIn {
  type: "agentManager.requestRepoInfo"
}

interface RequestStateIn {
  type: "agentManager.requestState"
}

interface SetTabOrderIn {
  type: "agentManager.setTabOrder"
  key: string
  order: string[]
}

interface SetSessionsCollapsedIn {
  type: "agentManager.setSessionsCollapsed"
  collapsed: boolean
}

interface SetSidebarCollapsedIn {
  type: "agentManager.setSidebarCollapsed"
  collapsed: boolean
}

interface OpenSessionsIn {
  type: "agentManager.openSessions"
  sessionIDs: string[]
}

interface VisibleSessionIn {
  type: "agentManager.visibleSession"
  sessionID: string | null
}

interface OpenFileIn {
  type: "agentManager.openFile"
  sessionId: string
  filePath: string
  line?: number
  column?: number
}

// Pass-through messages intercepted for side effects
interface GenericOpenFileIn {
  type: "openFile"
  filePath: string
  line?: number
  column?: number
}

interface PreviewImageIn {
  type: "previewImage"
  dataUrl: string
  filename: string
}

interface SaveImageIn {
  type: "saveImage"
  dataUrl: string
  filename: string
}

interface LoadMessagesIn {
  type: "loadMessages"
  sessionID: string
  mode?: "replace" | "prepend" | "focus"
  before?: string
  limit?: number
}

interface FileSourceIn {
  type: "file"
  path: string
  text: {
    value: string
    start: number
    end: number
  }
}

interface SendMessageIn {
  type: "sendMessage"
  text: string
  messageID?: string
  sessionID?: string
  draftID?: string
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
  files?: Array<{ mime: string; url: string; filename?: string; source?: FileSourceIn }>
  agentManagerContext?: string
  contextDirectory?: string
}

interface SendCommandIn {
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
  files?: Array<{ mime: string; url: string; filename?: string; source?: FileSourceIn }>
  agentManagerContext?: string
  contextDirectory?: string
}

interface QuestionReplyIn {
  type: "questionReply"
  requestID: string
  sessionID?: string
  answers: string[][]
}

interface RequestSandboxDefaultIn {
  type: "requestSandboxDefault"
  requestID?: string
  agentManagerContext?: string
  contextDirectory?: string
}

interface SetSandboxDefaultIn {
  type: "setSandboxDefault"
  enabled: boolean
  requestID: string
  agentManagerContext?: string
  contextDirectory?: string
}

interface ToggleSandboxIn {
  type: "toggleSandbox"
  sessionID?: string
  draftID?: string
  requestID: string
  agentManagerContext?: string
  contextDirectory?: string
}

interface ClearSessionIn {
  type: "clearSession"
}

interface ForkSessionIn {
  type: "agentManager.forkSession"
  sessionId: string
  messageId?: string
}

interface AbortIn {
  type: "abort"
  sessionID: string
}

/**
 * Fixture-only barrier ack (KILO_E2E_FIXTURE). Webview→extension echo of the
 * barrier token. Consumed by the fixture bridge only; ignored in production.
 */
interface FixtureBarrierAckIn {
  type: "agentManager.fixtureBarrierAck"
  token: string
}

/** All messages the Agent Manager expects from the webview (onMessage input). */
export type AgentManagerInMessage =
  | CloseSessionIn
  | PersistSessionIn
  | ForgetSessionIn
  | ForkSessionIn
  | CopyToClipboardIn
  | RequestRepoInfoIn
  | RequestStateIn
  | SetTabOrderIn
  | SetSessionsCollapsedIn
  | SetSidebarCollapsedIn
  | OpenSessionsIn
  | VisibleSessionIn
  | OpenFileIn
  | GenericOpenFileIn
  | PreviewImageIn
  | SaveImageIn
  | LoadMessagesIn
  | SendMessageIn
  | SendCommandIn
  | QuestionReplyIn
  | RequestSandboxDefaultIn
  | SetSandboxDefaultIn
  | ToggleSandboxIn
  | ClearSessionIn
  | AbortIn
  | FixtureBarrierAckIn
