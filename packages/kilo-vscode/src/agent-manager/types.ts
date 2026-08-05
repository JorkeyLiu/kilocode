/**
 * Typed message contracts for the Agent Manager extension ↔ webview boundary.
 *
 * These types must stay in sync with webview-ui/src/types/messages.ts.
 * The webview side re-uses the types directly; this file provides the
 * extension-side equivalents so onMessage() and postToWebview() are
 * type-checked rather than relying on Record<string, unknown> casts.
 */

import type { SnapshotFileDiff } from "@kilocode/sdk/v2/client"
import type { DiffImage } from "../diff/types"
import type { RunStatus } from "./run/manager"
import type { TerminalFont } from "./terminal-font"
import type { SessionTimingMap } from "./session-timing"

export type { TerminalFont }
export type { SessionTimingEntry } from "./session-timing"

// ---------------------------------------------------------------------------
// Shared payload types
// ---------------------------------------------------------------------------

export type WorktreeDiffEntry = SnapshotFileDiff & {
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

interface StateMessage {
  type: "agentManager.state"
  worktrees: never[]
  sessions: ManagedSession[]
  timing?: SessionTimingMap
  tabOrder?: Record<string, string[]>
  sessionsCollapsed?: boolean
  sidebarCollapsed?: boolean
  reviewDiffStyle?: "unified" | "split"
  reviewMarkdownRender?: boolean
  isGitRepo?: boolean
  runStatuses?: RunStatus[]
  runScriptConfigured?: boolean
  runScriptPath?: string
}

interface TerminalCreatedMessage {
  type: "agentManager.terminal.created"
  worktreeId: string | null // legacy field name
  terminalId: string
  title: string
  wsUrl: string
  font: TerminalFont
}

interface TerminalClosedMessage {
  type: "agentManager.terminal.closed"
  terminalId: string
}

interface TerminalErrorMessage {
  type: "agentManager.terminal.error"
  terminalId?: string
  message: string
}

interface TerminalFontChangedMessage {
  type: "agentManager.terminal.fontChanged"
  font: TerminalFont
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

interface WorktreeDiffLoadingMessage {
  type: "agentManager.worktreeDiffLoading"
  sessionId: string
  loading: boolean
}

interface WorktreeDiffMessage {
  type: "agentManager.worktreeDiff"
  sessionId: string
  diffs: unknown[]
}

interface WorktreeDiffFileMessage {
  type: "agentManager.worktreeDiffFile"
  sessionId: string
  file: string
  diff: unknown | null
}

interface RevertWorktreeFileResultMessage {
  type: "agentManager.revertWorktreeFileResult"
  sessionId: string
  file: string
  status: "success" | "error"
  message: string
}

interface ActionOutMessage {
  type: "action"
  action: string
}

interface RunStatusMessage extends RunStatus {
  type: "agentManager.runStatus"
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
  | WorktreeDiffLoadingMessage
  | WorktreeDiffMessage
  | WorktreeDiffFileMessage
  | RevertWorktreeFileResultMessage
  | ActionOutMessage
  | RunStatusMessage
  | TerminalCreatedMessage
  | TerminalClosedMessage
  | TerminalErrorMessage
  | TerminalFontChangedMessage

// ---------------------------------------------------------------------------
// Webview → Extension messages (onMessage)
// ---------------------------------------------------------------------------

interface CloseSessionIn {
  type: "agentManager.closeSession"
  sessionId: string
}

/** Persist a session to agent-manager.json. */
interface PersistSessionIn {
  type: "agentManager.persistSession"
  sessionId: string
  draftID?: string
}

/** Remove a session from agent-manager.json. */
interface ForgetSessionIn {
  type: "agentManager.forgetSession"
  sessionId: string
}

interface ConfigureRunScriptIn {
  type: "agentManager.configureRunScript"
}

interface RunScriptIn {
  type: "agentManager.runScript"
  worktreeId: string // legacy field name
}

interface StopRunScriptIn {
  type: "agentManager.stopRunScript"
  worktreeId: string // legacy field name
}

interface ShowTerminalIn {
  type: "agentManager.showTerminal"
  sessionId: string
}

interface ShowLocalTerminalIn {
  type: "agentManager.showLocalTerminal"
}

interface CopyToClipboardIn {
  type: "agentManager.copyToClipboard"
  text: string
}

interface ShowExistingLocalTerminalIn {
  type: "agentManager.showExistingLocalTerminal"
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

interface SetReviewDiffStyleIn {
  type: "agentManager.setReviewDiffStyle"
  style: "unified" | "split"
}

interface SetReviewMarkdownRenderIn {
  type: "agentManager.setReviewMarkdownRender"
  render: boolean
}

interface StartDiffWatchIn {
  type: "agentManager.startDiffWatch"
  sessionId: string
}

interface StopDiffWatchIn {
  type: "agentManager.stopDiffWatch"
}

interface RequestWorktreeDiffFileIn {
  type: "agentManager.requestWorktreeDiffFile"
  sessionId: string
  file: string
}

interface RevertWorktreeFileIn {
  type: "agentManager.revertWorktreeFile"
  sessionId: string
  file: string
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

interface RequestTerminalContextIn {
  type: "requestTerminalContext"
  requestId: string
  sessionID?: string
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

// ---------------------------------------------------------------------------
// Terminal inbound messages
// ---------------------------------------------------------------------------

interface TerminalCreateIn {
  type: "agentManager.terminal.create"
  worktreeId: string | null // legacy field name
}

interface TerminalCloseIn {
  type: "agentManager.terminal.close"
  terminalId: string
}

interface TerminalResizeIn {
  type: "agentManager.terminal.resize"
  terminalId: string
  cols: number
  rows: number
}

/** All messages the Agent Manager expects from the webview (onMessage input). */
export type AgentManagerInMessage =
  | CloseSessionIn
  | PersistSessionIn
  | ForgetSessionIn
  | ForkSessionIn
  | ConfigureRunScriptIn
  | RunScriptIn
  | StopRunScriptIn
  | ShowTerminalIn
  | ShowLocalTerminalIn
  | CopyToClipboardIn
  | ShowExistingLocalTerminalIn
  | RequestRepoInfoIn
  | RequestStateIn
  | SetTabOrderIn
  | SetSessionsCollapsedIn
  | SetSidebarCollapsedIn
  | SetReviewDiffStyleIn
  | SetReviewMarkdownRenderIn
  | StartDiffWatchIn
  | StopDiffWatchIn
  | RequestWorktreeDiffFileIn
  | RevertWorktreeFileIn
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
  | RequestTerminalContextIn
  | ClearSessionIn
  | AbortIn
  | TerminalCreateIn
  | TerminalCloseIn
  | TerminalResizeIn
