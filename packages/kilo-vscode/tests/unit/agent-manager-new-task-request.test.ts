/**
 * Contract: shared ChatView new-session affordances route through
 * AgentManagerApp.handleAddSession exactly once, without an orphaning
 * clearCurrentSession in the PromptInput path.
 *
 * Verifies:
 *  - AgentManagerApp listens for newTaskRequest and calls handleAddSession
 *    exactly once, with add/remove lifecycle and no direct clear.
 *  - PromptInput guards newTaskRequest with useAgentManager() so the
 *    Agent Manager pending-tab owner is not bypassed.
 *  - ChatView startSession and slash "/new" still dispatch newTaskRequest.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const APP = path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx")
const PROMPT = path.join(ROOT, "webview-ui/src/components/chat/PromptInput.tsx")
const CHATVIEW = path.join(ROOT, "webview-ui/src/components/chat/ChatView.tsx")
const SLASH = path.join(ROOT, "webview-ui/src/hooks/useSlashCommand.ts")

describe("Agent Manager newTaskRequest → handleAddSession contract", () => {
  const app = fs.readFileSync(APP, "utf-8")
  const prompt = fs.readFileSync(PROMPT, "utf-8")
  const chat = fs.readFileSync(CHATVIEW, "utf-8")
  const slash = fs.readFileSync(SLASH, "utf-8")

  it("AgentManagerApp registers exactly one newTaskRequest listener routing to handleAddSession", () => {
    const adds = (app.match(/window\.addEventListener\("newTaskRequest"/g) ?? []).length
    expect(adds).toBe(1)
    expect(app).toContain('window.addEventListener("newTaskRequest", onNewTaskRequest)')
    expect(app).toContain('window.removeEventListener("newTaskRequest", onNewTaskRequest)')
    // onCleanup must be paired for lifecycle
    expect(app).toContain('onCleanup(() => window.removeEventListener("newTaskRequest", onNewTaskRequest))')
  })

  it("AgentManagerApp onNewTaskRequest calls handleAddSession exactly once and does not clear directly", () => {
    const start = app.indexOf("const onNewTaskRequest = () => {")
    expect(start).toBeGreaterThan(-1)
    const end = app.indexOf("\n  }", start)
    expect(end).toBeGreaterThan(start)
    const block = app.slice(start, end)
    const count = (block.match(/handleAddSession\(\)/g) ?? []).length
    expect(count).toBe(1)
    expect(block).not.toContain("clearCurrentSession")
    expect(block).not.toContain("session.clear")
  })

  it("AgentManagerApp onNewTaskRequest is defined adjacent to handleAddSession (shared owner)", () => {
    const handleIdx = app.indexOf("const handleAddSession = () => {")
    const reqIdx = app.indexOf("const onNewTaskRequest = () => {")
    expect(handleIdx).toBeGreaterThan(-1)
    expect(reqIdx).toBeGreaterThan(handleIdx)
    // No other state owner is introduced between them that would duplicate tab creation
    const between = app.slice(handleIdx, reqIdx)
    expect(between).not.toContain("newTab:")
    expect(between).not.toContain("createSignal")
  })

  it("PromptInput guards newTaskRequest with useAgentManager to avoid orphaning active tab", () => {
    expect(prompt).toContain('import { useAgentManager } from "../../context/agent-manager"')
    expect(prompt).toContain("const inAgentManager = useAgentManager()")
    const start = prompt.indexOf("const onNewTaskRequest = () => {")
    expect(start).toBeGreaterThan(-1)
    const end = prompt.indexOf("\n  }", start)
    expect(end).toBeGreaterThan(start)
    const block = prompt.slice(start, end)
    expect(block).toContain("if (inAgentManager) return")
    // Guard must precede the clear — ensures exactly one path (Agent Manager's handleAddSession) wins
    const guardIdx = block.indexOf("if (inAgentManager) return")
    const clearIdx = block.indexOf("session.clearCurrentSession()")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(guardIdx)
  })

  it("ChatView startSession still dispatches newTaskRequest (shared affordance)", () => {
    expect(chat).toContain('window.dispatchEvent(new CustomEvent("newTaskRequest"))')
    expect(chat).toMatch(/const startSession = \(\) => window\.dispatchEvent\(new CustomEvent\("newTaskRequest"\)\)/)
  })

  it("slash /new still dispatches newTaskRequest (keyboard/ slash entrypoint)", () => {
    expect(slash).toContain('name: "new"')
    expect(slash).toContain('window.dispatchEvent(new CustomEvent("newTaskRequest"))')
    // Must be inside the /new action block, not a stray dispatch
    const newIdx = slash.indexOf('name: "new"')
    const dispatchIdx = slash.indexOf('window.dispatchEvent(new CustomEvent("newTaskRequest"))')
    expect(newIdx).toBeGreaterThan(-1)
    expect(dispatchIdx).toBeGreaterThan(newIdx)
    const nextName = slash.indexOf('name: "sessions"', newIdx)
    expect(dispatchIdx).toBeLessThan(nextName)
  })
})
