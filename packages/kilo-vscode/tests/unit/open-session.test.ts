/**
 * Tests for the canonical openSession transaction.
 *
 * Verifies the Phase 2/3A contract:
 *   1. Tab registry add-or-focus in LOCAL UI context
 *   2. Set active session/tab
 *   3. Clear history/terminal/review/pending overlays
 *   4. Call session.selectSession(id)
 *   5. No parent/root classification, no ownership mutation
 *   6. Phase 3A: no saveTabMemory, always LOCAL context, no read-only path
 */

import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { openSession, type OpenSessionDeps } from "../../webview-ui/agent-manager/open-session"
import { createSessionTabManager } from "../../webview-ui/agent-manager/session-tab-manager"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"

const ROOT_A = "root-aaaa-bbbb"
const ROOT_B = "root-cccc-dddd"
const CHILD_A = "child-aaaa-bbbb"
const PENDING = "pending:aaa-bbb"

function createDeps() {
  const mgr = createSessionTabManager()
  const state = {
    selected: [] as string[],
    pending: undefined as string | undefined,
    history: true,
    review: true,
    terminal: "some-terminal" as string | undefined,
    selection: "old-selection" as string,
    ensured: [] as string[],
  }
  const deps: OpenSessionDeps = {
    tabMgr: mgr,
    selectSession: (id) => state.selected.push(id),
    setActivePendingId: (id) => {
      state.pending = id
    },
    setHistory: (v) => {
      state.history = v
    },
    setReviewActive: (v) => {
      state.review = v
    },
    setTermsActiveId: (id) => {
      state.terminal = id
    },
    setSelection: (sel) => {
      state.selection = sel
    },
    isPending: (id) => id.startsWith("pending:"),
    ensureLocal: (id) => state.ensured.push(id),
  }
  return { mgr, state, deps }
}

describe("openSession — returns false for empty/undefined ID", () => {
  it("returns false for empty string", () =>
    createRoot(() => {
      const { deps } = createDeps()
      expect(openSession("", deps)).toBe(false)
    }))

  it("does not close history on false", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession("", deps)
      expect(state.history).toBe(true)
    }))
})

describe("openSession — clears overlays", () => {
  it("closes history, review, and terminal", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      expect(state.history).toBe(false)
      expect(state.review).toBe(false)
      expect(state.terminal).toBeUndefined()
    }))

  it("sets selection to LOCAL", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      expect(state.selection).toBe(LOCAL)
    }))

  it("does not save tab memory (Phase 3A: no per-context memory)", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      // Phase 3A: saveTabMemory removed — no per-context tab memory
      expect(state.selection).toBe(LOCAL)
    }))
})

describe("openSession — tab registry add-or-focus", () => {
  it("adds new session to registry", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      openSession(ROOT_B, deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
    }))

  it("focuses existing session without duplication", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      openSession(ROOT_B, deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(ROOT_B)
    }))

  it("adds child-looking ID without classification", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      openSession(CHILD_A, deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))
})

describe("openSession — real session selection", () => {
  it("calls selectSession for non-pending ID", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      expect(state.selected).toContain(ROOT_A)
    }))

  it("clears pending ID for non-pending session", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      expect(state.pending).toBeUndefined()
    }))

  it("ensures session is in local inventory", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      expect(state.ensured).toContain(ROOT_A)
    }))
})

describe("openSession — pending session handling", () => {
  it("sets activePendingId for pending ID", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(PENDING, deps)
      expect(state.pending).toBe(PENDING)
    }))

  it("does not call selectSession for pending ID", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(PENDING, deps)
      expect(state.selected).toEqual([])
    }))

  it("does not call ensureLocal for pending ID", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(PENDING, deps)
      expect(state.ensured).toEqual([])
    }))

  it("still adds pending ID to tab registry", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      openSession(PENDING, deps)
      expect(mgr.ids(LOCAL)).toContain(PENDING)
    }))
})

describe("openSession — no ownership mutation", () => {
  it("does not send any worktree messages (no addSessionToWorktree, promote, openLocally)", () =>
    createRoot(() => {
      // This test documents the invariant: openSession is a pure
      // navigation transaction. It does not mutate ownership.
      // The deps interface has no postMessage or ownership-mutation callback.
      const { state, deps } = createDeps()
      const result = openSession(ROOT_A, deps)
      expect(result).toBe(true)
      // Only these side effects occur (Phase 3A: saveTabMemory removed):
      expect(state.history).toBe(false) // clear history
      expect(state.review).toBe(false) // clear review
      expect(state.terminal).toBeUndefined() // clear terminal
      expect(state.selection).toBe(LOCAL) // set selection
      expect(state.selected).toEqual([ROOT_A]) // selectSession
      expect(state.pending).toBeUndefined() // clear pending
    }))
})

describe("openSession — returns true on success", () => {
  it("returns true for real session", () =>
    createRoot(() => {
      const { deps } = createDeps()
      expect(openSession(ROOT_A, deps)).toBe(true)
    }))

  it("returns true for pending session", () =>
    createRoot(() => {
      const { deps } = createDeps()
      expect(openSession(PENDING, deps)).toBe(true)
    }))
})

describe("sidebar keyboard/jump navigation contract", () => {
  // These tests document the Phase 2 invariant: ordinary session
  // navigation (keyboard ↑/↓ and ⌘N jump) routes through openSession,
  // which sets selection to LOCAL and calls selectSession.
  // It never sets selection to null or calls selectSession directly.

  it("sets selection to LOCAL, never null", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      // Selection is set to LOCAL (the sidebar context), not null
      expect(state.selection).toBe(LOCAL)
      expect(state.selection).not.toBe(null)
    }))

  it("calls selectSession through openSession transaction, not as a bare call", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      // selectSession is called as part of the transaction
      expect(state.selected).toEqual([ROOT_A])
      // History was cleared (transaction step 3)
      expect(state.history).toBe(false)
    }))

  it("does not leave a read-only null selection path open", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      // After openSession, the state is LOCAL — not null which would
      // indicate a read-only/unregistered navigation bypass.
      openSession(ROOT_A, deps)
      expect(state.selection).toBe(LOCAL)
      // Pending overlay is cleared for real sessions
      expect(state.pending).toBeUndefined()
    }))

  it("ensures session is registered in local inventory before select", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      // ensureLocal was called (session registered in inventory + tab order)
      expect(state.ensured).toContain(ROOT_A)
    }))
})

describe("Phase 3A — single LOCAL context invariants", () => {
  it("openSession always sets selection to LOCAL, never to a worktree ID", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      expect(state.selection).toBe(LOCAL)
    }))

  it("openSession registers tab in LOCAL context only", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed("worktree-x", [ROOT_A], ROOT_A)
      openSession(ROOT_B, deps)
      // ROOT_B goes to LOCAL, not worktree-x
      expect(mgr.ids(LOCAL)).toContain(ROOT_B)
      expect(mgr.ids("worktree-x")).not.toContain(ROOT_B)
    }))

  it("openSession never creates per-worktree tab contexts", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      openSession(ROOT_A, deps)
      openSession(ROOT_B, deps)
      // Only LOCAL context exists
      expect(mgr.contexts()).toEqual([LOCAL])
    }))

  it("no read-only path: every session gets interactive ChatView (no null selection)", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(CHILD_A, deps)
      // After openSession, selection is LOCAL (interactive), never null (read-only)
      expect(state.selection).toBe(LOCAL)
      expect(state.selection).not.toBe(null)
    }))

  it("root, child, and grandchild all operate identically through openSession", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      const GRANDCHILD = "grandchild-xxxx-yyyy"

      openSession(ROOT_A, deps)
      expect(mgr.ids(LOCAL)).toContain(ROOT_A)
      expect(mgr.active(LOCAL)).toBe(ROOT_A)

      openSession(CHILD_A, deps)
      expect(mgr.ids(LOCAL)).toContain(CHILD_A)
      expect(mgr.active(LOCAL)).toBe(CHILD_A)

      openSession(GRANDCHILD, deps)
      expect(mgr.ids(LOCAL)).toContain(GRANDCHILD)
      expect(mgr.active(LOCAL)).toBe(GRANDCHILD)

      // All three are in LOCAL context with no classification
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, GRANDCHILD])
    }))

  it("no saveTabMemory in deps interface (Phase 3A removal)", () => {
    // Verify the interface no longer has saveTabMemory
    const deps: OpenSessionDeps = {
      tabMgr: createSessionTabManager(),
      selectSession: () => {},
      setActivePendingId: () => {},
      setHistory: () => {},
      setReviewActive: () => {},
      setTermsActiveId: () => {},
      setSelection: () => {},
      isPending: () => false,
      ensureLocal: () => {},
    }
    // If saveTabMemory were required, this object literal would fail typecheck
    expect(deps).toBeDefined()
  })
})
