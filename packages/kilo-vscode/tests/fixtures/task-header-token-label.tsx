import { Window } from "happy-dom"

const window = new Window()
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  SVGElement: window.SVGElement,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: () => 0,
})

globalThis.acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
})

const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { MemoryContext } = await import("../../webview-ui/src/context/memory")
const { LanguageContext } = await import("../../webview-ui/src/context/language")
const { TranscriptSearchProvider } = await import("../../webview-ui/src/context/transcript-search")
const { TaskHeader } = await import("../../webview-ui/src/components/chat/TaskHeader")

const language = {
  locale: () => "en",
  setLocale: () => {},
  userOverride: () => "",
  t: (key: string) => key,
}

const memory = {
  status: () => undefined,
  show: () => undefined,
  loading: () => false,
  pending: () => false,
  error: () => undefined,
  enabled: () => false,
  sessionTokens: () => 0,
  totalTokens: () => 0,
  activity: () => [],
  refresh: () => {},
  showMemory: () => {},
  enable: () => {},
  disable: () => {},
  auto: () => {},
  verbose: () => {},
  rebuild: () => {},
  remember: () => {},
  forget: () => {},
}

const sessionFor = (contextUsage: { tokens: number; percentage: number | null }) => ({
  currentSessionID: () => "test-session",
  currentSession: () => ({
    id: "test-session",
    title: "Test session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  setCurrentSessionID: () => {},
  status: () => "idle",
  messages: () => [{ id: "msg-1" }],
  visibleMessages: () => [],
  allParts: () => ({}),
  getParts: () => [],
  selected: () => undefined,
  costBreakdown: () => [],
  contextUsage: () => contextUsage,
  modelUsage: () => undefined,
  todos: () => [],
  compact: () => {},
  renameSession: () => {},
  revertSession: () => {},
})

const mount = (session: ReturnType<typeof sessionFor>) => {
  const root = document.createElement("div")
  const dispose = render(
    () => (
      <VSCodeProvider>
        <LanguageContext.Provider value={language as never}>
          <TranscriptSearchProvider>
            <MemoryContext.Provider value={memory as never}>
              <SessionContext.Provider value={session as never}>
                <TaskHeader />
              </SessionContext.Provider>
            </MemoryContext.Provider>
          </TranscriptSearchProvider>
        </LanguageContext.Provider>
      </VSCodeProvider>
    ),
    root,
  )
  return { root, dispose }
}

const spanText = (root: HTMLElement) => [...root.querySelectorAll("span")].map((s) => s.textContent ?? "")

// LOCK-001: percentage available → locale-formatted tokens with percentage in parentheses.
const withPct = mount(sessionFor({ tokens: 34300, percentage: 17 }))
const withPctSpans = spanText(withPct.root)
if (!withPctSpans.includes("34,300 (17%)")) {
  throw new Error(`expected visible label '34,300 (17%)', got ${JSON.stringify(withPctSpans)}`)
}
withPct.dispose()

// LOCK-001: percentage unavailable → token count alone, no percentage leak.
const withoutPct = mount(sessionFor({ tokens: 34300, percentage: null }))
const withoutPctSpans = spanText(withoutPct.root)
if (!withoutPctSpans.includes("34,300")) {
  throw new Error(`expected visible label '34,300', got ${JSON.stringify(withoutPctSpans)}`)
}
if (withoutPctSpans.some((text) => text.includes("%"))) {
  throw new Error(`percentage leaked into label without percentage: ${JSON.stringify(withoutPctSpans)}`)
}
withoutPct.dispose()
