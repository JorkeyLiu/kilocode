import { Component, createSignal, Switch, Match, onMount, onCleanup } from "solid-js"
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
import { LanguageBridge } from "./context/language-bridge"
import { SpeechToTextPrewarm } from "./components/speech-to-text/SpeechToTextPrewarm"
import { p0WebviewStage } from "./utils/perf"

import { FeedbackProvider } from "./context/feedback"
import { ImageModelsProvider } from "./context/image-models"
import { SessionProvider } from "./context/session"
import { DataBridge, MermaidDownloadBridge } from "./AppBridge"
export { DataBridge, MermaidDownloadBridge }
import "./styles/chat.css"

type ViewType = "pending" | "profile" | "settings"
const VALID_VIEWS = new Set<string>(["profile", "settings"])

const AppContent: Component = () => {
  const [currentView, setCurrentView] = createSignal<ViewType>("pending")
  const [settingsTab, setSettingsTab] = createSignal<string | undefined>()
  const server = useServer()
  const vscode = useVSCode()

  onMount(() => {
    p0WebviewStage("webview.mount")
    const handler = (event: MessageEvent) => {
      const message = event.data
      if (message?.type === "navigate" && message.view && VALID_VIEWS.has(message.view)) {
        if (message.tab) setSettingsTab(message.tab)
        setCurrentView(message.view as ViewType)
        vscode.postMessage({ type: "settingsTabChanged", tab: message.tab })
      }
    }
    window.addEventListener("message", handler)
    onCleanup(() => window.removeEventListener("message", handler))
  })

  return (
    <div class="container">
      <Switch fallback={<div class="ordinary-pending" aria-hidden="true" />}>
        <Match when={currentView() === "profile"}>
          <ProfileView
            profileData={server.profileData()}
            deviceAuth={server.deviceAuth()}
            onLogin={server.startLogin}
          />
        </Match>
        <Match when={currentView() === "settings"}>
          <Settings tab={settingsTab()} onTabChange={setSettingsTab} />
        </Match>
      </Switch>
    </div>
  )
}

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
                                  <AgentRequirementsProvider>
                                    <FeedbackProvider>
                                      <DataBridge>
                                        <AppContent />
                                      </DataBridge>
                                    </FeedbackProvider>
                                  </AgentRequirementsProvider>
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
