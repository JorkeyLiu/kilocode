/**
 * Regression contract: creating a new Agent Manager session must preserve
 * the user's internal sidebar collapsed/expanded state, and every new-session
 * entry point must route through one shared sidebar-preserving handler.
 *
 * Proves:
 *  1. handleAddSession does NOT call expandSidebar — the new-session action
 *     no longer forces a collapsed sidebar open.
 *  2. handleAddSession still runs the full new-session transaction
 *     (coverBottomPage, addPendingTab, setIsBottomPage(false)).
 *  3. actionMap.newTab (keyboard/command newTab) routes through handleAddSession
 *     instead of duplicating the transaction inline.
 *  4. Button new-session actions (tab-bar new button, empty-state button) route
 *     through handleAddSession.
 *  5. handleNewTabForCurrentSelection (Cmd+T handler) routes through
 *     handleAddSession instead of duplicating the transaction.
 *  6. handleSearchAction still calls expandSidebar — search UI lives in the
 *     sidebar, so its expand-on-search behavior is intentionally preserved.
 */

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const APP = path.resolve(import.meta.dir, "../../webview-ui/agent-manager/AgentManagerApp.tsx")

function handlerBlock(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = () => {`)
  expect(start, `${name} handler must exist`).toBeGreaterThan(-1)
  const end = source.indexOf("\n  }", start)
  expect(end, `${name} handler must close`).toBeGreaterThan(start)
  return source.slice(start, end)
}

function actionMapEntry(source: string, key: string): string {
  const start = source.indexOf(`      ${key}:`)
  expect(start, `${key} action must exist in actionMap`).toBeGreaterThan(-1)
  const end = source.indexOf("\n", start)
  return source.slice(start, end)
}

describe("Agent Manager new-session sidebar coupling", () => {
  const source = fs.readFileSync(APP, "utf-8")

  it("handleAddSession does not expand the sidebar", () => {
    expect(handlerBlock(source, "handleAddSession")).not.toContain("expandSidebar")
  })

  it("handleAddSession preserves the new-session transaction", () => {
    const block = handlerBlock(source, "handleAddSession")
    expect(block).toContain("coverBottomPage()")
    expect(block).toContain("addPendingTab()")
    expect(block).toContain("setIsBottomPage(false)")
  })

  it("actionMap.newTab routes through handleAddSession", () => {
    const entry = actionMapEntry(source, "newTab")
    expect(entry).toContain("handleAddSession")
    expect(entry).not.toContain("coverBottomPage")
    expect(entry).not.toContain("addPendingTab")
    expect(entry).not.toContain("setIsBottomPage")
  })

  it("button new-session actions route through handleAddSession", () => {
    expect(source).toContain('onNewSession: metrics.click("new_session", "tab_bar", handleAddSession)')
    expect(source).toContain("onClick={handleAddSession}")
  })

  it("handleNewTabForCurrentSelection routes through handleAddSession", () => {
    const block = handlerBlock(source, "handleNewTabForCurrentSelection")
    expect(block).toContain("handleAddSession()")
    expect(block).not.toContain("coverBottomPage")
    expect(block).not.toContain("addPendingTab")
    expect(block).not.toContain("setIsBottomPage")
  })

  it("handleSearchAction still expands the sidebar for search", () => {
    expect(handlerBlock(source, "handleSearchAction")).toContain("expandSidebar()")
  })
})
