import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const APP = path.join(ROOT, "webview-ui/src/App.tsx")

function src() {
  return fs.readFileSync(APP, "utf-8")
}

describe("ordinary App no-chat", () => {
  it("initial view is pending (not newTask)", () => {
    const s = src()
    expect(s).toContain('"pending"')
    expect(s).not.toMatch(/createSignal<ViewType>\("newTask"\)/)
  })

  it("VALID_VIEWS does not contain newTask or chat", () => {
    const s = src()
    expect(s).toContain("VALID_VIEWS")
    // extract the set construction line
    const match = s.match(/VALID_VIEWS\s*=\s*new Set[^\)]+\)/)
    expect(match).not.toBeNull()
    const setStr = match![0]
    expect(setStr).not.toContain("newTask")
    expect(setStr).not.toContain("chat")
    expect(setStr).toContain("settings")
    expect(setStr).toContain("profile")
  })

  it("does not import or render ChatView/SidebarEmptyState/HistoryView", () => {
    const s = src()
    expect(s).not.toContain("ChatView")
    expect(s).not.toContain("SidebarEmptyState")
    expect(s).not.toContain("HistoryView")
    expect(s).not.toContain("PromptInput")
  })

  it("does not register chat tool overrides in ordinary bundle", () => {
    const s = src()
    expect(s).not.toContain("registerExpandedTaskTool")
    expect(s).not.toContain("registerVscodeToolOverrides")
  })

  it("fallback is pending shell, not ChatView", () => {
    const s = src()
    expect(s).toContain("fallback=")
    expect(s).toContain("ordinary-pending")
    expect(s).not.toContain("fallback={<ChatView")
  })

  it("handles only settings/profile navigate, fail-safe pending", () => {
    const s = src()
    // should check VALID_VIEWS has check before setCurrentView
    expect(s).toContain("VALID_VIEWS.has(message.view)")
    // Switch should only have profile and settings matches
    expect(s).toContain('currentView() === "profile"')
    expect(s).toContain('currentView() === "settings"')
    expect(s).not.toContain('currentView() === "newTask"')
    expect(s).not.toContain('currentView() === "history"')
  })

  it("ViewType does not include newTask/chat", () => {
    const s = src()
    const m = s.match(/type ViewType\s*=\s*([^\n]+)/)
    expect(m).not.toBeNull()
    const t = m![1]
    expect(t).not.toContain("newTask")
    expect(t).not.toContain("chat")
    expect(t).toContain("pending")
  })

  it("restores SessionProvider wrapper without ChatView", () => {
    const s = src()
    expect(s).toContain("SessionProvider")
    expect(s).toContain('from "./context/session"')
    expect(s).toContain("<SessionProvider>")
    expect(s).toContain("</SessionProvider>")
    // SessionProvider must wrap AgentRequirementsProvider and DataBridge
    const sessIdx = s.indexOf("<SessionProvider>")
    const agentIdx = s.indexOf("<AgentRequirementsProvider>")
    const dataIdx = s.indexOf("<DataBridge>")
    expect(sessIdx).toBeGreaterThan(-1)
    expect(agentIdx).toBeGreaterThan(sessIdx)
    expect(dataIdx).toBeGreaterThan(agentIdx)
    // still no chat
    expect(s).not.toContain("ChatView")
  })

  it("SessionProvider dependency order is correct (inside Config/Display, outside AgentRequirements)", () => {
    const s = src()
    const cfgIdx = s.indexOf("<ConfigProvider>")
    const displayIdx = s.indexOf("<DisplayProvider>")
    const imgIdx = s.indexOf("<ImageModelsProvider>")
    const sessIdx = s.indexOf("<SessionProvider>")
    const agentIdx = s.indexOf("<AgentRequirementsProvider>")
    expect(cfgIdx).toBeGreaterThan(-1)
    expect(displayIdx).toBeGreaterThan(cfgIdx)
    expect(imgIdx).toBeGreaterThan(displayIdx)
    expect(sessIdx).toBeGreaterThan(imgIdx)
    expect(agentIdx).toBeGreaterThan(sessIdx)
  })
})
