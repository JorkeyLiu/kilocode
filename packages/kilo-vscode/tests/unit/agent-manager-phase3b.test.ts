/**
 * Phase 3B contract tests — local-only UI state model.
 *
 * Proves:
 *  1. Local UI state loads/saves correctly via webview state API.
 *  2. Legacy migration imports only local sessions (worktreeId === null).
 *  3. activeTabId is sanitized against openTabIds (non-member → undefined).
 *  4. Malformed IDs are filtered/deduped and invalid active is cleared.
 *  5. Migration marker is false before completion and true only after import.
 *  6. agentManager.state handler does NOT overwrite LOCAL tab order.
 *  7. Reconciliation no-op removed — invariant by absence.
 *  8. Persist effect reads legacyImportDone synchronously for Solid tracking.
 */

import { describe, expect, it } from "bun:test"
import {
  loadLocalUIState,
  saveLocalUIState,
  importLegacyLocalTabs,
  LOCAL_UI_STATE_VERSION,
  defaultLocalUIState,
  type LocalUIState,
} from "../../webview-ui/agent-manager/local-ui-state"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"

// ---------------------------------------------------------------------------
// loadLocalUIState
// ---------------------------------------------------------------------------

describe("Phase 3B — loadLocalUIState", () => {
  it("returns defaults when no state exists", () => {
    const state = loadLocalUIState(() => undefined)
    expect(state.openTabIds).toEqual([])
    expect(state.activeTabId).toBeUndefined()
    expect(state.sidebarCollapsed).toBe(false)
    expect(state.sidebarWidth).toBe(260)
    expect(state.legacyImported).toBe(false)
  })

  it("loads from current format", () => {
    const ui: LocalUIState = {
      version: LOCAL_UI_STATE_VERSION,
      openTabIds: ["s1", "s2"],
      activeTabId: "s1",
      sidebarCollapsed: true,
      sidebarWidth: 300,
      legacyImported: true,
    }
    const state = loadLocalUIState(() => ({ localUIState: ui }))
    expect(state.openTabIds).toEqual(["s1", "s2"])
    expect(state.activeTabId).toBe("s1")
    expect(state.sidebarCollapsed).toBe(true)
    expect(state.sidebarWidth).toBe(300)
    expect(state.legacyImported).toBe(true)
  })

  it("migrates from legacy localSessionIDs key", () => {
    const state = loadLocalUIState(() => ({
      localSessionIDs: ["legacy-1", "legacy-2"],
      sidebarWidth: 320,
    }))
    expect(state.openTabIds).toEqual(["legacy-1", "legacy-2"])
    expect(state.sidebarWidth).toBe(320)
    expect(state.legacyImported).toBe(false)
  })

  it("prefers current format over legacy keys", () => {
    const ui: LocalUIState = {
      version: 1,
      openTabIds: ["new-1"],
      activeTabId: undefined,
      sidebarCollapsed: false,
      sidebarWidth: 260,
      legacyImported: true,
    }
    const state = loadLocalUIState(() => ({
      localUIState: ui,
      localSessionIDs: ["old-1"],
      sidebarWidth: 400,
    }))
    expect(state.openTabIds).toEqual(["new-1"])
  })

  it("filters non-string and empty tab IDs, deduplicates preserving order", () => {
    const state = loadLocalUIState(() => ({
      localUIState: {
        version: 1,
        openTabIds: ["s1", "", 42, "s2", "s1", null, "s3"],
        activeTabId: "s1",
        sidebarCollapsed: false,
        sidebarWidth: 260,
        legacyImported: false,
      },
    }))
    expect(state.openTabIds).toEqual(["s1", "s2", "s3"])
    expect(state.activeTabId).toBe("s1")
  })

  it("clears activeTabId when empty string", () => {
    const state = loadLocalUIState(() => ({
      localUIState: {
        version: 1,
        openTabIds: ["s1"],
        activeTabId: "",
        sidebarCollapsed: false,
        sidebarWidth: 260,
        legacyImported: false,
      },
    }))
    expect(state.activeTabId).toBeUndefined()
  })

  it("handles non-object localUIState safely", () => {
    const state = loadLocalUIState(() => ({ localUIState: "invalid" }))
    expect(state.openTabIds).toEqual([])
    expect(state.legacyImported).toBe(false)
  })

  it("handles null get/set state gracefully", () => {
    const state = loadLocalUIState(() => null)
    expect(state.openTabIds).toEqual([])
    expect(state.activeTabId).toBeUndefined()
    expect(state.legacyImported).toBe(false)
  })

  it("clears activeTabId when not a member of sanitized openTabIds", () => {
    const state = loadLocalUIState(() => ({
      localUIState: {
        version: 1,
        openTabIds: ["s1", "s2"],
        activeTabId: "ghost-tab",
        sidebarCollapsed: false,
        sidebarWidth: 260,
        legacyImported: false,
      },
    }))
    expect(state.openTabIds).toEqual(["s1", "s2"])
    expect(state.activeTabId).toBeUndefined()
  })

  it("clears activeTabId when it was filtered out by sanitizeTabIds", () => {
    const state = loadLocalUIState(() => ({
      localUIState: {
        version: 1,
        openTabIds: ["", 42, null],
        activeTabId: "",
        sidebarCollapsed: false,
        sidebarWidth: 260,
        legacyImported: false,
      },
    }))
    expect(state.openTabIds).toEqual([])
    expect(state.activeTabId).toBeUndefined()
  })

  it("handles malformed activeTabId (non-string types)", () => {
    for (const bad of [42, null, true, {}, [], undefined]) {
      const state = loadLocalUIState(() => ({
        localUIState: {
          version: 1,
          openTabIds: ["s1"],
          activeTabId: bad,
          sidebarCollapsed: false,
          sidebarWidth: 260,
          legacyImported: false,
        },
      }))
      expect(state.activeTabId).toBeUndefined()
    }
  })

  it("returns activeTabId when it IS a member of sanitized openTabIds", () => {
    const state = loadLocalUIState(() => ({
      localUIState: {
        version: 1,
        openTabIds: ["s1", "s2"],
        activeTabId: "s2",
        sidebarCollapsed: false,
        sidebarWidth: 260,
        legacyImported: false,
      },
    }))
    expect(state.activeTabId).toBe("s2")
  })
})

// ---------------------------------------------------------------------------
// saveLocalUIState
// ---------------------------------------------------------------------------

describe("Phase 3B — saveLocalUIState", () => {
  it("persists to webview state and preserves other keys", () => {
    let stored: Record<string, unknown> = { otherKey: "preserved" }
    const ui: LocalUIState = {
      version: LOCAL_UI_STATE_VERSION,
      openTabIds: ["s1"],
      activeTabId: "s1",
      sidebarCollapsed: false,
      sidebarWidth: 260,
      legacyImported: true,
    }
    saveLocalUIState(
      () => stored,
      (s) => {
        stored = s
      },
      ui,
    )
    expect(stored.otherKey).toBe("preserved")
    expect(stored.localUIState).toEqual(ui)
    expect(stored.localSessionIDs).toEqual(["s1"])
    expect(stored.sidebarWidth).toBe(260)
  })
})

// ---------------------------------------------------------------------------
// importLegacyLocalTabs
// ---------------------------------------------------------------------------

describe("Phase 3B — importLegacyLocalTabs", () => {
  it("imports only local sessions (worktreeId === null)", () => {
    const result = importLegacyLocalTabs(
      {
        managedSessions: [
          { id: "local-1", worktreeId: null },
          { id: "local-2", worktreeId: null },
          { id: "wt-1", worktreeId: "wt-aaa" },
          { id: "wt-2", worktreeId: "wt-bbb" },
        ],
      },
      LOCAL,
    )
    expect(result.openTabIds).toEqual(["local-1", "local-2"])
    expect(result.activeTabId).toBe("local-1")
  })

  it("uses extension tabOrder[LOCAL] for ordering", () => {
    const result = importLegacyLocalTabs(
      {
        managedSessions: [
          { id: "a", worktreeId: null },
          { id: "b", worktreeId: null },
          { id: "c", worktreeId: null },
        ],
        tabOrder: { [LOCAL]: ["c", "a", "b"] },
      },
      LOCAL,
    )
    expect(result.openTabIds).toEqual(["c", "a", "b"])
  })

  it("appends local sessions not in tab order", () => {
    const result = importLegacyLocalTabs(
      {
        managedSessions: [
          { id: "a", worktreeId: null },
          { id: "b", worktreeId: null },
          { id: "extra", worktreeId: null },
        ],
        tabOrder: { [LOCAL]: ["a", "b"] },
      },
      LOCAL,
    )
    expect(result.openTabIds).toEqual(["a", "b", "extra"])
  })

  it("does not import worktree-owned sessions even if in tab order", () => {
    const result = importLegacyLocalTabs(
      {
        managedSessions: [
          { id: "local-1", worktreeId: null },
          { id: "wt-1", worktreeId: "wt-aaa" },
        ],
        tabOrder: { [LOCAL]: ["wt-1", "local-1"] },
      },
      LOCAL,
    )
    expect(result.openTabIds).toEqual(["local-1"])
    // wt-1 is filtered out even though it was in the tab order
  })

  it("imports sidebarCollapsed", () => {
    const result = importLegacyLocalTabs(
      {
        managedSessions: [{ id: "s1", worktreeId: null }],
        sidebarCollapsed: true,
      },
      LOCAL,
    )
    expect(result.sidebarCollapsed).toBe(true)
  })

  it("defaults sidebarCollapsed to false when absent", () => {
    const result = importLegacyLocalTabs(
      {
        managedSessions: [{ id: "s1", worktreeId: null }],
      },
      LOCAL,
    )
    expect(result.sidebarCollapsed).toBe(false)
  })

  it("returns empty when no local sessions exist", () => {
    const result = importLegacyLocalTabs(
      {
        managedSessions: [{ id: "wt-1", worktreeId: "wt-aaa" }],
      },
      LOCAL,
    )
    expect(result.openTabIds).toEqual([])
    expect(result.activeTabId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Static analysis: no-op reconciliation removed — invariant by absence
// ---------------------------------------------------------------------------

describe("Phase 3B — reconciliation invariant by absence", () => {
  const fs = require("fs")
  const path = require("path")
  const ROOT = path.resolve(__dirname, "../..")
  const TSX_FILE = path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx")
  const STATE_FILE = path.join(ROOT, "webview-ui/agent-manager/local-ui-state.ts")

  it("reconcileLocalTabs is NOT imported in AgentManagerApp", () => {
    const text = fs.readFileSync(TSX_FILE, "utf-8")
    expect(text).not.toContain("reconcileLocalTabs")
  })

  it("reconcileLocalTabs does NOT exist in local-ui-state.ts", () => {
    const text = fs.readFileSync(STATE_FILE, "utf-8")
    expect(text).not.toContain("reconcileLocalTabs")
  })

  it("reconcileTrackedTabs is not imported", () => {
    const text = fs.readFileSync(TSX_FILE, "utf-8")
    expect(text).not.toContain("reconcileTrackedTabs")
  })

  it("trackedSessionInventory is not imported", () => {
    const text = fs.readFileSync(TSX_FILE, "utf-8")
    expect(text).not.toContain("trackedSessionInventory")
  })

  it("sessionsLoaded handler does NOT mutate local tab IDs", () => {
    const text = fs.readFileSync(TSX_FILE, "utf-8")
    // Find sessionsLoaded handler
    const idx = text.indexOf('"sessionsLoaded"')
    if (idx === -1) return // No handler means nothing to violate
    // Use a smaller window to avoid matching the nearby sessionForked handler
    const block = text.slice(idx, idx + 200)
    expect(block).not.toContain("setLocalSessionIDs")
  })

  it("state handler does NOT reconcile or evict local tab IDs", () => {
    const text = fs.readFileSync(TSX_FILE, "utf-8")
    const idx = text.indexOf('"agentManager.state"')
    expect(idx, "state handler must exist").toBeGreaterThan(-1)
    const block = text.slice(idx, idx + 3000)
    // The only legitimate use of setLocalSessionIDs in the state handler
    // is inside the one-time legacy import guard (!legacyImportDone() && localSessionIDs().length === 0).
    // There must be no unconditional or reconciliation-based mutation.
    expect(block).not.toContain("reconcileLocalTabs")
    expect(block).not.toContain("reconcileTrackedTabs")
    // Verify legacy import guard exists (the only valid mutation path)
    expect(block).toContain("!legacyImportDone()")
  })
})

// ---------------------------------------------------------------------------
// Static analysis: agentManager.state handler isolation
// ---------------------------------------------------------------------------

describe("Phase 3B — state-push isolation (static analysis)", () => {
  const fs = require("fs")
  const path = require("path")
  const ROOT = path.resolve(__dirname, "../..")
  const TSX_FILE = path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx")

  function stateHandler(): string {
    const text = fs.readFileSync(TSX_FILE, "utf-8")
    const start = text.indexOf('"agentManager.state"')
    expect(start, "agentManager.state handler must exist").toBeGreaterThan(-1)
    // Find the next closing of the if block (approximate — grab enough context)
    return text.slice(start, start + 3000)
  }

  it("does NOT call restoreTrackedTabs in state handler", () => {
    const handler = stateHandler()
    expect(handler).not.toContain("restoreTrackedTabs")
  })

  it("does NOT call trackedSessionInventory in state handler", () => {
    const handler = stateHandler()
    expect(handler).not.toContain("trackedSessionInventory")
  })

  it("does NOT set selection to worktreeId in state handler", () => {
    const handler = stateHandler()
    expect(handler).not.toContain("setSelection(ms.worktreeId)")
  })

  it("does NOT overwrite worktreeTabOrder with full state.tabOrder", () => {
    const handler = stateHandler()
    // Should NOT have: setWorktreeTabOrder(state.tabOrder)
    expect(handler).not.toMatch(/setWorktreeTabOrder\(state\.tabOrder\)/)
    // Should have: filtering to exclude LOCAL key
    expect(handler).toContain("key !== LOCAL")
  })

  it("uses importLegacyLocalTabs for one-time migration", () => {
    const handler = stateHandler()
    expect(handler).toContain("importLegacyLocalTabs")
    expect(handler).toContain("setLegacyImportDone")
  })
})

// ---------------------------------------------------------------------------
// Migration marker semantics
// ---------------------------------------------------------------------------

describe("Phase 3B — migration marker semantics", () => {
  it("legacyImported is false on fresh state", () => {
    const state = loadLocalUIState(() => undefined)
    expect(state.legacyImported).toBe(false)
  })

  it("legacyImported round-trips through save/load as true", () => {
    let stored: Record<string, unknown> = {}
    const ui = { ...defaultLocalUIState(), legacyImported: true, openTabIds: ["s1"] }
    saveLocalUIState(
      () => stored,
      (s) => {
        stored = s
      },
      ui,
    )
    const reloaded = loadLocalUIState(() => stored)
    expect(reloaded.legacyImported).toBe(true)
  })

  it("legacyImported remains false when field absent from persisted state", () => {
    const state = loadLocalUIState(() => ({
      localUIState: {
        version: 1,
        openTabIds: ["s1"],
        activeTabId: "s1",
        sidebarCollapsed: false,
        sidebarWidth: 260,
      },
    }))
    expect(state.legacyImported).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Static analysis: persist effect uses signal for migration marker
// ---------------------------------------------------------------------------

describe("Phase 3B — persist effect isolation (static analysis)", () => {
  const fs = require("fs")
  const path = require("path")
  const ROOT = path.resolve(__dirname, "../..")
  const TSX_FILE = path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx")

  it("persist effect reads legacyImportDone synchronously in tracking scope", () => {
    const text = fs.readFileSync(TSX_FILE, "utf-8")
    // Find the createEffect that calls saveLocalUIState
    const effectIdx = text.indexOf("createEffect(() => {")
    const saveIdx = text.indexOf("saveLocalUIState(", effectIdx)
    expect(saveIdx, "saveLocalUIState call must exist").toBeGreaterThan(-1)
    // The tracking scope is between createEffect and saveLocalUIState
    const trackingScope = text.slice(effectIdx, saveIdx)
    // legacyImportDone() must be read in the tracking scope (before setTimeout)
    expect(trackingScope).toContain("legacyImportDone()")
    // The saveLocalUIState block should use a captured variable, not call legacyImportDone() again
    const saveBlock = text.slice(saveIdx, saveIdx + 500)
    expect(saveBlock).not.toContain("legacyImportDone()")
    expect(saveBlock).not.toMatch(/legacyImported:\s*true/)
  })

  it("legacyImportDone signal is declared", () => {
    const text = fs.readFileSync(TSX_FILE, "utf-8")
    expect(text).toContain("legacyImportDone")
    expect(text).toContain("setLegacyImportDone")
  })
})
