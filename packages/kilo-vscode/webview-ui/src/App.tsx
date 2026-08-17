import { Component, createSignal, Switch, Match, Show, onMount, onCleanup } from "solid-js"
import { ThemeProvider } from "@kilocode/kilo-ui/theme"
import { DialogProvider } from "@kilocode/kilo-ui/context/dialog"
import { MarkedProvider } from "@kilocode/kilo-ui/context/marked"
import { CodeComponentProvider } from "@kilocode/kilo-ui/context/code"
import { DiffComponentProvider } from "@kilocode/kilo-ui/context/diff"
import { FileComponentProvider } from "@kilocode/kilo-ui/context/file"
import { Code } from "@kilocode/kilo-ui/code"
import { Diff } from "@kilocode/kilo-ui/diff"
import { File } from "@kilocode/kilo-ui/file"
import { Toast } from "@kilocode/kilo-ui/toast"
import Settings from "./components/settings/Settings"
import ProfileView from "./components/profile/ProfileView"
import { VSCodeProvider, useVSCode } from "./context/vscode"
import { ServerProvider, useServer } from "./context/server"
import { ProviderProvider } from "./context/provider"
import { ConfigProvider } from "./context/config"
import { DisplayProvider } from "./context/display"
import { WorkStyleProvider } from "./context/work-style"
import { AgentRequirementsProvider } from "./context/agent-requirements"
import { SessionProvider, useSession } from "./context/session"
import { LocalTabsProvider, useLocalTabs } from "./context/local-tabs"
import { LanguageBridge } from "./context/language-bridge"
import { ChatView } from "./components/chat"
import { SidebarEmptyState } from "./components/chat/SidebarEmptyState"
import { registerExpandedTaskTool } from "./components/chat/TaskToolExpanded"
import { registerVscodeToolOverrides } from "./components/chat/VscodeToolOverrides"
import { SpeechToTextPrewarm } from "./components/speech-to-text/SpeechToTextPrewarm"
import { p0WebviewStage } from "./utils/perf"

// Override the upstream "task" tool renderer with the fully-expanded version
// that shows child session parts inline in the VS Code chat UI.
registerExpandedTaskTool()
// Apply VS Code chat UI preferences to other tools (e.g. bash expanded by default).
registerVscodeToolOverrides()
import HistoryView from "./components/history/HistoryView"
import { MigrationWizard } from "./components/migration" // legacy-migration
import { FeedbackProvider } from "./context/feedback"
import { ImageModelsProvider } from "./context/image-models"
// Side-effect-free bridges (shared with the Agent Manager webview). Imported
// here for the editor-tab webview's provider chain and re-exported so the
// editor-tab surface keeps its public API; no module-scope side effects run on
// import.
import { DataBridge, MermaidDownloadBridge } from "./AppBridge"
export { DataBridge, MermaidDownloadBridge }
import "./styles/chat.css"

type ViewType = "newTask" | "history" | "profile" | "settings"
const VALID_VIEWS = new Set<string>(["newTask", "history", "profile", "settings"])

// Inner app component that uses the contexts
const AppContent: Component = () => {
  const [currentView, setCurrentView] = createSignal<ViewType>("newTask")
  const [settingsTab, setSettingsTab] = createSignal<string | undefined>()
  // legacy-migration: state-driven flag independent of currentView to avoid
  // race conditions with SettingsEditorProvider's navigate messages.
  const [migrationNeeded, setMigrationNeeded] = createSignal(false)
  const [migrationSource, setMigrationSource] = createSignal<"legacy" | "roo">("legacy")
  const session = useSession()
  const tabs = useLocalTabs()
  const server = useServer()
  const vscode = useVSCode()

  const handleViewAction = (action: string) => {
    switch (action) {
      case "plusButtonClicked": {
        const chat = currentView() === "newTask"
        if (chat) window.dispatchEvent(new CustomEvent("newTaskRequest"))
        if (!chat && tabs) tabs.add()
        if (!chat && !tabs) session.clearCurrentSession()
        setCurrentView("newTask")
        break
      }
      case "historyButtonClicked":
        setCurrentView("history")
        break
      case "profileButtonClicked":
        setCurrentView("profile")
        break
      case "settingsButtonClicked":
        setCurrentView("settings")
        break
      case "cycleAgentMode":
        if (document.hasFocus()) cycleAgent(1)
        break
      case "cyclePreviousAgentMode":
        if (document.hasFocus()) cycleAgent(-1)
        break
      case "focusSearch":
        setCurrentView("newTask")
        window.dispatchEvent(new CustomEvent("focusTranscriptSearch"))
        break
    }
  }

  const cycleAgent = (direction: 1 | -1) => {
    const available = session.agents().filter((a) => a.mode !== "subagent" && !a.hidden)
    if (available.length <= 1) return
    const current = session.selectedAgent()
    // Fixed-agent sessions (e.g. child sessions with a delegated subagent that
    // is not in the visible list) must not cycle.
    if (!available.some((a) => a.name === current)) return
    const idx = available.findIndex((a) => a.name === current)
    const raw = idx + direction
    const next = raw < 0 ? available.length - 1 : raw >= available.length ? 0 : raw
    const agent = available[next]
    if (agent) session.selectAgent(agent.name)
  }

  const handleForked = (message: { type?: string; sessionID?: string; forkedFromID?: string }) => {
    if (message.type !== "sessionForked" || !message.sessionID) return
    if (tabs && message.forkedFromID) tabs.openAfter(message.forkedFromID, message.sessionID)
    if (tabs && !message.forkedFromID) tabs.open(message.sessionID)
    if (!tabs) session.selectSession(message.sessionID)
    setCurrentView("newTask")
  }

  const handleKiloModel = (message: { type?: string }) => {
    if (message.type === "selectKiloModel") setCurrentView("newTask")
  }

  const openSession = (id: string) => {
    if (tabs) tabs.open(id)
    else session.selectSession(id)
    setCurrentView("newTask")
  }

  onMount(() => {
    // P0 perf: first DOM mount of the app content (opt-in KILO_P0_PERF).
    p0WebviewStage("webview.mount")
    const handler = (event: MessageEvent) => {
      const message = event.data
      if (message?.type === "action" && message.action) {
        console.log("[Kilo New] App: 🎬 action:", message.action)
        handleViewAction(message.action)
      }
      if (message?.type === "navigate" && message.view && VALID_VIEWS.has(message.view)) {
        console.log("[Kilo New] App: 🧭 navigate:", message.view, message.tab ? `tab=${message.tab}` : "")
        if (message.tab) setSettingsTab(message.tab)
        setCurrentView(message.view as ViewType)
        vscode.postMessage({ type: "settingsTabChanged", tab: message.tab })
      }
      handleKiloModel(message)
      handleForked(message)
      if (message?.type === "viewChildSession" && message.sessionID) {
        console.log("[Kilo New] App: 🔍 viewChildSession:", message.sessionID)
        openSession(message.sessionID)
      }
      // legacy-migration: state-driven migration wizard
      if (message?.type === "migrationState") {
        console.log("[Kilo New] App: 🔄 migrationState:", message.needed)
        setMigrationSource(message.source)
        setMigrationNeeded(message.needed)
      }
    }
    window.addEventListener("message", handler)
    onCleanup(() => window.removeEventListener("message", handler))
  })

  const handleForkMessage = (sessionId: string, messageId: string) => {
    vscode.postMessage({ type: "forkSession", sessionId, messageId })
  }

  const emptyState = () => (
    <SidebarEmptyState onSelectSession={openSession} onShowHistory={() => setCurrentView("history")} />
  )

  return (
    <div class="container">
      {/* legacy-migration start — state-driven overlay, independent of currentView */}
      <Show
        when={migrationNeeded()}
        fallback={
          <Switch
            fallback={
              <ChatView
                onForkMessage={session.status() === "idle" ? handleForkMessage : undefined}
                promptBoxId="sidebar:fallback"
                emptyState={emptyState}
              />
            }
          >
            <Match when={currentView() === "newTask"}>
              <ChatView
                onSelectSession={openSession}
                onShowHistory={() => setCurrentView("history")}
                onForkMessage={session.status() === "idle" ? handleForkMessage : undefined}
                promptBoxId="sidebar:new-task"
                emptyState={emptyState}
              />
            </Match>
            <Match when={currentView() === "history"}>
              <HistoryView onSelectSession={openSession} onBack={() => setCurrentView("newTask")} />
            </Match>
            <Match when={currentView() === "profile"}>
              <ProfileView
                profileData={server.profileData()}
                deviceAuth={server.deviceAuth()}
                onLogin={server.startLogin}
              />
            </Match>
            <Match when={currentView() === "settings"}>
              <Settings
                tab={settingsTab()}
                onTabChange={setSettingsTab}
                onMigrationClick={(source) => {
                  setMigrationSource(source)
                  setMigrationNeeded(true)
                }}
              />
            </Match>
          </Switch>
        }
      >
        <MigrationWizard
          source={migrationSource()}
          onBack={() => setMigrationNeeded(false)}
          onComplete={() => setMigrationNeeded(false)}
        />
      </Show>
      {/* legacy-migration end */}
    </div>
  )
}

// Main App component with context providers
const App: Component = () => {
  return (
    <ThemeProvider defaultTheme="kilo-vscode">
      <DialogProvider>
        <VSCodeProvider>
          <MermaidDownloadBridge />
          <ServerProvider>
            <LanguageBridge>
              <MarkedProvider>
                <DiffComponentProvider component={Diff}>
                  <CodeComponentProvider component={Code}>
                    <FileComponentProvider component={File}>
                      <ProviderProvider>
                        <ConfigProvider>
                          <SpeechToTextPrewarm />
                          <DisplayProvider>
                            <WorkStyleProvider>
                              <ImageModelsProvider>
                                <SessionProvider>
                                  <LocalTabsProvider>
                                    <AgentRequirementsProvider>
                                      <FeedbackProvider>
                                        <DataBridge>
                                          <AppContent />
                                        </DataBridge>
                                      </FeedbackProvider>
                                    </AgentRequirementsProvider>
                                  </LocalTabsProvider>
                                </SessionProvider>
                              </ImageModelsProvider>
                            </WorkStyleProvider>
                          </DisplayProvider>
                        </ConfigProvider>
                      </ProviderProvider>
                    </FileComponentProvider>
                  </CodeComponentProvider>
                </DiffComponentProvider>
              </MarkedProvider>
            </LanguageBridge>
          </ServerProvider>
        </VSCodeProvider>
        <Toast.Region />
      </DialogProvider>
    </ThemeProvider>
  )
}

export default App
