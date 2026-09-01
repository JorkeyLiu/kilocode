/** @jsxImportSource solid-js */

/**
 * ChatView component
 * Main chat container that combines all chat components
 */

import { type Component, type JSX, Show, createMemo } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { TaskHeader } from "./TaskHeader"
import { MessageList } from "./MessageList"
import { AgentRequirements } from "./AgentRequirements"
import { PromptInput } from "./PromptInput"
import { PermissionDock } from "./PermissionDock"
import { StartupErrorBanner } from "./StartupErrorBanner"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { useAgentManager } from "../../context/agent-manager"
import { useServer } from "../../context/server"
import { useAgentRequirements } from "../../context/agent-requirements"
import { TranscriptSearchProvider } from "../../context/transcript-search"
import { isPromptBlocked, isSuggesting, isQuestioning } from "./prompt-input-utils"

interface ChatViewProps {
  onSelectSession?: (id: string) => void
  onShowHistory?: () => void
  onForkMessage?: (sessionId: string, messageId: string) => void
  onForkSession?: (sessionId: string) => void
  readonly?: boolean
  promptBoxId?: string
  pendingSessionID?: string
  emptyState?: () => JSX.Element
}

export const ChatView: Component<ChatViewProps> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const inAgentManager = useAgentManager()
  const server = useServer()
  const requirements = useAgentRequirements()
  const pendingSessionID = () => props.pendingSessionID

  const id = () => session.currentSessionID()
  const hasMessages = () => session.messages().length > 0
  const idle = () => session.status() !== "busy"

  const familyPermissions = createMemo(() => session.scopedPermissions(id()))
  const familyQuestions = createMemo(() => session.scopedQuestions(id()))
  const familySuggestions = createMemo(() => session.scopedSuggestions(id()))
  const standaloneQuestions = createMemo(() => familyQuestions().filter((q) => !q.tool))
  const standaloneSuggestions = createMemo(() => familySuggestions().filter((s) => !s.tool))
  const permissionRequest = () => familyPermissions().find((p) => p.sessionID === id()) ?? familyPermissions()[0]
  const blocked = () => isPromptBlocked(familyPermissions().length) || (!props.readonly && requirements.blocked())
  const requirementReason = () =>
    !props.readonly && requirements.blocked() ? language.t("agentRequirements.prompt.blocked") : undefined
  const suggesting = () => isSuggesting(blocked(), familySuggestions().length)
  const questioning = () => isQuestioning(blocked(), familyQuestions().length)
  const dock = () => !props.readonly || !!permissionRequest()

  const decide = (response: "once" | "always" | "reject", approvedAlways: string[], deniedAlways: string[]) => {
    const perm = permissionRequest()
    if (!perm || session.respondingPermissions().has(perm.id)) return
    session.respondToPermission(perm.id, response, approvedAlways, deniedAlways)
  }

  const startSession = () => window.dispatchEvent(new CustomEvent("newTaskRequest"))

  const fork = () => {
    const sid = id()
    if (!sid) return
    props.onForkSession?.(sid)
  }

  const canStartSession = (hasChat: boolean) => hasChat

  const canFork = (hasChat: boolean) => hasChat && !!inAgentManager && session.status() === "idle" && !!props.onForkSession

  const hasActions = (hasChat: boolean) => canStartSession(hasChat) || canFork(hasChat)

  const renderActions = (hasChat: boolean) => (
    <Show when={hasActions(hasChat)}>
      <div class="new-task-button-wrapper" classList={{ "new-task-button-wrapper--empty": !hasChat }}>
        <div class="session-actions-row">
          <Show when={canStartSession(hasChat)}>
            <Tooltip value={language.t("sidebar.session.newSession.tooltip")} placement="top">
              <Button
                variant="secondary"
                size="small"
                class="session-new-button"
                onClick={startSession}
                aria-label={language.t("sidebar.session.newSession")}
              >
                {language.t("sidebar.session.newSession")}
              </Button>
            </Tooltip>
          </Show>
          <Show when={canFork(hasChat)}>
            <Tooltip value={language.t("agentManager.tab.forkSession")} placement="top">
              <Button
                variant="ghost"
                size="small"
                onClick={fork}
                aria-label={language.t("agentManager.tab.forkSession")}
              >
                <Icon name="fork" size="small" />
                {language.t("agentManager.tab.forkSession")}
              </Button>
            </Tooltip>
          </Show>
        </div>
      </div>
    </Show>
  )

  return (
    <TranscriptSearchProvider>
      <div class="chat-view">
        <TaskHeader readonly={props.readonly} />
        <div class="chat-messages-wrapper">
          <div class="chat-messages">
            <Show
              when={!props.readonly && requirements.visible()}
              fallback={
                <MessageList
                  onSelectSession={props.onSelectSession}
                  onShowHistory={props.onShowHistory}
                  onForkMessage={props.onForkMessage}
                  questions={standaloneQuestions}
                  suggestions={standaloneSuggestions}
                  readonly={props.readonly}
                  emptyState={props.emptyState}
                  announce={false}
                  sessionID={pendingSessionID}
                />
              }
            >
              <AgentRequirements />
            </Show>
          </div>
        </div>

        <Show when={dock()}>
          <div class="chat-input">
            <Show when={server.connectionState() === "error" && server.errorMessage()}>
              <StartupErrorBanner errorMessage={server.errorMessage()!} errorDetails={server.errorDetails()!} />
            </Show>
            <Show when={permissionRequest()} keyed>
              {(perm) => (
                <PermissionDock
                  request={perm}
                  responding={session.respondingPermissions().has(perm.id)}
                  onDecide={decide}
                />
              )}
            </Show>
            <Show when={!props.readonly && idle() && !blocked() && hasActions(hasMessages())}>
              {renderActions(hasMessages())}
            </Show>
            <Show when={!props.readonly}>
              <PromptInput
                blocked={blocked}
                blockedReason={requirementReason}
                suggesting={suggesting}
                questioning={questioning}
                boxId={props.promptBoxId}
                pendingSessionID={pendingSessionID()}
              />
            </Show>
          </div>
        </Show>
      </div>
    </TranscriptSearchProvider>
  )
}
