/**
 * Terminal tab-close successor contract.
 *
 * Locks the active-tab successor selection inside `closeTerminal`: closing
 * the active tab activates the previous (left) neighbor, falls back to the
 * next (right) neighbor when the first tab is closed, and clears the
 * session when the last terminal is closed. Closing a non-active terminal
 * never changes the active selection.
 */

import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { TerminalFont } from "../../src/types/messages/agent-manager"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"
import {
  createTerminalHandlers,
  createTerminalState,
  TERMINAL_PREFIX,
} from "../../webview-ui/agent-manager/terminal/state"

const font: TerminalFont = { fontFamily: "Menlo", fontSize: 14 }
const T1 = `${TERMINAL_PREFIX}a`
const T2 = `${TERMINAL_PREFIX}b`
const T3 = `${TERMINAL_PREFIX}c`

const setup = (ids: string[], active: string) => {
  const state = createTerminalState(() => LOCAL)
  for (const id of ids) state.add(null, { id, title: id, wsUrl: "ws://...", font })
  state.setActiveId(active)
  let count = 0
  const cleared = () => count
  const selected: string[] = []
  const posted: unknown[] = []
  const handlers = createTerminalHandlers({
    state,
    tabIds: () => ids,
    selectSessionTab: (id) => selected.push(id),
    clearSession: () => count++,
    resetOthers: () => undefined,
    isPendingId: () => false,
    findTab: () => undefined,
    postMessage: (msg) => posted.push(msg),
    getSelection: () => LOCAL,
    LOCAL,
  })
  return { state, handlers, cleared, selected, posted }
}

describe("Agent Manager terminal close successor", () => {
  it("closing the active middle tab activates the previous (left) tab", () => {
    createRoot((dispose) => {
      const { state, handlers, cleared, selected, posted } = setup([T1, T2, T3], T2)
      handlers.closeTerminal(T2)
      expect(state.activeId()).toBe(T1)
      expect(state.forSelection(LOCAL).map((t) => t.id)).toEqual([T1, T3])
      expect(cleared()).toBe(0)
      expect(selected).toEqual([])
      expect(posted).toEqual([{ type: "agentManager.terminal.close", terminalId: T2 }])
      dispose()
    })
  })

  it("closing the active first tab falls back to the next (right) tab", () => {
    createRoot((dispose) => {
      const { state, handlers, cleared, selected } = setup([T1, T2, T3], T1)
      handlers.closeTerminal(T1)
      expect(state.activeId()).toBe(T2)
      expect(state.forSelection(LOCAL).map((t) => t.id)).toEqual([T2, T3])
      expect(cleared()).toBe(0)
      expect(selected).toEqual([])
      dispose()
    })
  })

  it("closing the active last tab activates the previous (left) tab", () => {
    createRoot((dispose) => {
      const { state, handlers, cleared, selected } = setup([T1, T2, T3], T3)
      handlers.closeTerminal(T3)
      expect(state.activeId()).toBe(T2)
      expect(state.forSelection(LOCAL).map((t) => t.id)).toEqual([T1, T2])
      expect(cleared()).toBe(0)
      expect(selected).toEqual([])
      dispose()
    })
  })

  it("closing the only terminal leaves no successor and clears the session", () => {
    createRoot((dispose) => {
      const { state, handlers, cleared, selected, posted } = setup([T1], T1)
      handlers.closeTerminal(T1)
      expect(state.activeId()).toBeUndefined()
      expect(state.forSelection(LOCAL)).toEqual([])
      expect(cleared()).toBe(1)
      expect(selected).toEqual([])
      expect(posted).toEqual([{ type: "agentManager.terminal.close", terminalId: T1 }])
      dispose()
    })
  })

  it("closing a non-active terminal leaves the active selection unchanged", () => {
    createRoot((dispose) => {
      const { state, handlers, cleared, selected, posted } = setup([T1, T2, T3], T2)
      handlers.closeTerminal(T1)
      expect(state.activeId()).toBe(T2)
      expect(state.forSelection(LOCAL).map((t) => t.id)).toEqual([T2, T3])
      expect(cleared()).toBe(0)
      expect(selected).toEqual([])
      expect(posted).toEqual([{ type: "agentManager.terminal.close", terminalId: T1 }])
      dispose()
    })
  })
})
