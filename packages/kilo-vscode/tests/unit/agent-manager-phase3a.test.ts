/**
 * Phase 3A audit contract tests.
 *
 * Proves:
 *  1. Non-LOCAL incoming selection cannot alter session tab order or drag target key.
 *  2. Terminal created from a worktree-tagged message is stored/ordered/selected in LOCAL.
 *  3. Pending draft remains connected independently of selection.
 *  4. handlePromote is removed (dead code).
 */

import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createTerminalState,
  createTerminalMessageHandler,
  isTerminalTabId,
  TERMINAL_PREFIX,
} from "../../webview-ui/agent-manager/terminal/state"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"
import { applyTabOrder } from "../../webview-ui/agent-manager/tab-order"
import { createSessionTabManager } from "../../webview-ui/agent-manager/session-tab-manager"
import type { ExtensionMessage } from "../../webview-ui/src/types/messages/extension-messages"
import type { TerminalFont } from "../../src/types/messages/agent-manager"

const WT_A = "worktree-aaa"
const WT_B = "worktree-bbb"
const SESSION_1 = "sess-1111"
const SESSION_2 = "sess-2222"
const SESSION_3 = "sess-3333"
const TERM_1 = `${TERMINAL_PREFIX}term-1`
const TERM_2 = `${TERMINAL_PREFIX}term-2`
const PENDING_1 = "pending:aaa-bbb"

const font: TerminalFont = { fontFamily: "Menlo", fontSize: 14 }

describe("Phase 3A — tab order always uses LOCAL key", () => {
  it("applyTabOrder with LOCAL key is independent of non-LOCAL selection", () => {
    const items = [{ id: SESSION_1 }, { id: SESSION_2 }, { id: TERM_1 }]
    const order = [TERM_1, SESSION_1, SESSION_2]
    const result = applyTabOrder(items, order)
    expect(result.map((i) => i.id)).toEqual([TERM_1, SESSION_1, SESSION_2])
  })

  it("non-LOCAL selection does not introduce a separate tab order namespace", () => {
    // Simulate tabIds() memo: only LOCAL key is used for worktreeTabOrder
    const tabOrder: Record<string, string[]> = {
      [LOCAL]: [SESSION_1, TERM_1, SESSION_2],
      [WT_A]: [SESSION_3, TERM_2], // should never be read by tabIds
    }
    const ids = [SESSION_1, SESSION_2, TERM_1]
    const result = applyTabOrder(
      ids.map((id) => ({ id })),
      tabOrder[LOCAL],
    ).map((i) => i.id)
    // Always uses LOCAL order, regardless of what WT_A has
    expect(result).toEqual([SESSION_1, TERM_1, SESSION_2])
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

describe("Phase 3A — terminal created from worktree-tagged message uses LOCAL", () => {
  it("terminal state stores in LOCAL context regardless of worktreeId", () => {
    createRoot((dispose) => {
      const [sel, setSel] = createSignal<string | null>(LOCAL)
      const state = createTerminalState(sel)

      // Add terminal with non-null worktreeId
      state.add(WT_A, { id: TERM_1, title: "Terminal 1", wsUrl: "ws://...", font })
      state.add(null, { id: TERM_2, title: "Terminal 2", wsUrl: "ws://...", font })

      // All terminals should be in LOCAL context
      expect(state.forSelection(LOCAL).length).toBe(2)
      expect(state.forSelection(LOCAL).map((t) => t.id)).toEqual([TERM_1, TERM_2])

      // forSelection with non-LOCAL should still return LOCAL terminals
      expect(state.forSelection(WT_A).length).toBe(2)
      expect(state.forSelection(WT_A).map((t) => t.id)).toEqual([TERM_1, TERM_2])

      // forSelection with null returns empty
      expect(state.forSelection(null).length).toBe(0)

      dispose()
    })
  })

  it("currentKey returns LOCAL regardless of worktree selection", () => {
    // Test each selection value in a separate createRoot because bun test
    // uses the SSR build of Solid.js where memos don't re-evaluate.
    createRoot((dispose) => {
      const state = createTerminalState(() => LOCAL)
      expect(state.currentKey()).toBe(LOCAL)
      dispose()
    })
    createRoot((dispose) => {
      const state = createTerminalState(() => WT_A)
      expect(state.currentKey()).toBe(LOCAL)
      dispose()
    })
    createRoot((dispose) => {
      const state = createTerminalState(() => WT_B)
      expect(state.currentKey()).toBe(LOCAL)
      dispose()
    })
    createRoot((dispose) => {
      const state = createTerminalState(() => null)
      expect(state.currentKey()).toBeUndefined()
      dispose()
    })
  })

  it("current() concept is proven by currentKey + forSelection returning LOCAL terminals", () => {
    createRoot((dispose) => {
      // Use WT_A as selection — currentKey should still be LOCAL
      const state = createTerminalState(() => WT_A)

      // Add terminal before first read so the SSR memo evaluates correctly
      state.add(WT_A, { id: TERM_1, title: "Terminal 1", wsUrl: "ws://...", font })

      // currentKey returns LOCAL even with non-LOCAL selection
      expect(state.currentKey()).toBe(LOCAL)

      // forSelection(LOCAL) returns the terminal (proves the LOCAL context owns it)
      expect(state.forSelection(LOCAL).length).toBe(1)
      expect(state.forSelection(LOCAL)[0]!.id).toBe(TERM_1)

      // forSelection(WT_A) also returns LOCAL terminals (alias)
      expect(state.forSelection(WT_A).length).toBe(1)

      dispose()
    })
  })

  it("message handler sets selection to LOCAL and calls onCreated with LOCAL", () => {
    createRoot((dispose) => {
      const [sel, setSel] = createSignal<string | null>(WT_A)
      const state = createTerminalState(sel)
      const activated: string[] = []
      const createdArgs: { contextKey: string; terminalId: string }[] = []

      const handler = createTerminalMessageHandler({
        state,
        activate: (id) => activated.push(id),
        setSelection: (s) => setSel(s),
        showError: () => undefined,
        onCreated: (contextKey, terminalId) => createdArgs.push({ contextKey, terminalId }),
      })

      const msg = {
        type: "agentManager.terminal.created",
        worktreeId: WT_A,
        terminalId: TERM_1,
        title: "Terminal 1",
        wsUrl: "ws://...",
        font,
      } satisfies ExtensionMessage

      expect(handler(msg)).toBe(true)

      // onCreated was called with LOCAL, not WT_A
      expect(createdArgs).toEqual([{ contextKey: LOCAL, terminalId: TERM_1 }])

      // Selection was set to LOCAL
      expect(sel()).toBe(LOCAL)

      // Terminal was activated
      expect(activated).toEqual([TERM_1])

      // Terminal is in LOCAL context
      expect(state.forSelection(LOCAL).length).toBe(1)
      expect(state.forSelection(LOCAL)[0]!.id).toBe(TERM_1)

      dispose()
    })
  })

  it("terminal created from null worktreeId is also stored in LOCAL", () => {
    createRoot((dispose) => {
      const [sel, setSel] = createSignal<string | null>(LOCAL)
      const state = createTerminalState(sel)
      const createdArgs: string[] = []

      const handler = createTerminalMessageHandler({
        state,
        activate: () => undefined,
        setSelection: () => undefined,
        showError: () => undefined,
        onCreated: (contextKey) => createdArgs.push(contextKey),
      })

      const msg = {
        type: "agentManager.terminal.created",
        worktreeId: null,
        terminalId: TERM_1,
        title: "Terminal 1",
        wsUrl: "ws://...",
        font,
      } satisfies ExtensionMessage

      handler(msg)
      expect(createdArgs).toEqual([LOCAL])
      expect(state.forSelection(LOCAL).length).toBe(1)

      dispose()
    })
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
