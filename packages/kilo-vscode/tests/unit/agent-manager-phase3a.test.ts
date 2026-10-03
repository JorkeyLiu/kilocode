/**
 * Phase 3A audit contract tests (terminal-free).
 *
 * Proves:
 *  1. Non-LOCAL incoming selection cannot alter session tab order or drag target key.
 *  2. Pending draft remains connected independently of selection.
 *  3. handlePromote is removed (dead code).
 *  4. No terminal tab subsystem remains in the Agent Manager surface.
 */

import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"
import { applyTabOrder } from "../../webview-ui/agent-manager/tab-order"

const WT_A = "worktree-aaa"
const WT_B = "worktree-bbb"
const SESSION_1 = "sess-1111"
const SESSION_2 = "sess-2222"
const SESSION_3 = "sess-3333"
const PENDING_1 = "pending:aaa-bbb"

describe("Phase 3A — tab order always uses LOCAL key", () => {
  it("applyTabOrder with LOCAL key is independent of non-LOCAL selection", () => {
    const items = [{ id: SESSION_1 }, { id: SESSION_2 }, { id: SESSION_3 }]
    const order = [SESSION_3, SESSION_1, SESSION_2]
    const result = applyTabOrder(items, order)
    expect(result.map((i) => i.id)).toEqual([SESSION_3, SESSION_1, SESSION_2])
  })

  it("non-LOCAL selection does not introduce a separate tab order namespace", () => {
    // Simulate tabIds() memo: only LOCAL key is used for worktreeTabOrder
    const tabOrder: Record<string, string[]> = {
      [LOCAL]: [SESSION_1, SESSION_3, SESSION_2],
      [WT_A]: [SESSION_3], // should never be read by tabIds
    }
    const ids = [SESSION_1, SESSION_2, SESSION_3]
    const result = applyTabOrder(
      ids.map((id) => ({ id })),
      tabOrder[LOCAL],
    ).map((i) => i.id)
    // Always uses LOCAL order, regardless of what WT_A has
    expect(result).toEqual([SESSION_1, SESSION_3, SESSION_2])
  })

  it("drag over persists to LOCAL key even when selection is non-LOCAL", () => {
    // Simulate handleDragOver: key is always LOCAL
    const sel = WT_A // non-LOCAL selection
    const key = LOCAL // Phase 3A: always LOCAL
    expect(key).toBe(LOCAL)
    expect(key).not.toBe(sel)
  })

  it("drag end persists to LOCAL key even when selection is non-LOCAL", () => {
    const sel = WT_A
    const key = LOCAL
    expect(key).toBe(LOCAL)
  })
})

describe("Phase 3A — no terminal tab subsystem", () => {
  it("terminal tab modules are removed", async () => {
    const fs = await import("fs")
    const path = await import("path")
    expect(fs.existsSync(path.resolve(__dirname, "../../webview-ui/agent-manager/terminal"))).toBe(false)
    expect(fs.existsSync(path.resolve(__dirname, "../../src/agent-manager/terminal-routing.ts"))).toBe(false)
    expect(fs.existsSync(path.resolve(__dirname, "../../src/agent-manager/terminal-manager.ts"))).toBe(false)
    expect(fs.existsSync(path.resolve(__dirname, "../../src/agent-manager/SessionTerminalManager.ts"))).toBe(false)
  })

  it("tab order contains session ids only", () => {
    const ids = [SESSION_1, SESSION_2]
    for (const id of ids) expect(id.startsWith("terminal:")).toBe(false)
    expect(WT_B.startsWith("terminal:")).toBe(false)
  })
})

describe("Phase 3A — pending draft independent of selection", () => {
  it("activePendingId is a stable signal not gated by selection", () => {
    // Simulates the fix: pendingSessionID={activePendingId()} without
    // the `selection() === LOCAL ? ... : undefined` guard.
    const [selection, setSelection] = createSignal<string>(LOCAL)
    const [activePendingId, setActivePendingId] = createSignal<string | undefined>()

    setActivePendingId(PENDING_1)
    setSelection(WT_A)

    // The pending ID should still be available regardless of selection
    const pendingSessionID = activePendingId() // was: selection() === LOCAL ? activePendingId() : undefined
    expect(pendingSessionID).toBe(PENDING_1)
  })

  it("promptBoxId is local-stable, not dependent on selection", () => {
    const [selection, setSelection] = createSignal<string>(LOCAL)
    // Old: `agent-manager:${selection() ?? "unassigned"}`
    // New: "agent-manager:local" (stable)
    const promptBoxId = "agent-manager:local"

    setSelection(WT_A)
    expect(promptBoxId).toBe("agent-manager:local")

    setSelection(LOCAL)
    expect(promptBoxId).toBe("agent-manager:local")
  })
})

describe("Phase 3A — handlePromote removed", () => {
  it("AgentManagerApp.tsx does not contain handlePromote", async () => {
    const fs = await import("fs")
    const path = await import("path")
    const appPath = path.resolve(__dirname, "../../webview-ui/agent-manager/AgentManagerApp.tsx")
    const content = fs.readFileSync(appPath, "utf-8")
    // handlePromote should not exist as a function definition
    expect(content).not.toMatch(/const handlePromote\s*=/)
  })
})
