/**
 * Tests for the canonical openSession transaction.
 *
 * Verifies the Phase 2/3A contract:
 *   1. Tab registry add-or-focus in LOCAL UI context
 *   2. Set active session/tab
 *   3. Clear history/terminal/pending overlays
 *   4. Call session.selectSession(id)
 *   5. No parent/root classification, no ownership mutation
 *   6. Phase 3A: no saveTabMemory, always LOCAL context, no read-only path
 */

import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  openSession,
  openChildSession,
  type OpenChildSessionDeps,
  type OpenSessionDeps,
} from "../../webview-ui/agent-manager/open-session"
import { createSessionTabManager } from "../../webview-ui/agent-manager/session-tab-manager"
import { createTabOrderSync } from "../../webview-ui/agent-manager/tab-order-sync"
import { applyTabOrder } from "../../webview-ui/agent-manager/tab-order"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"

const ROOT_A = "root-aaaa-bbbb"
const ROOT_B = "root-cccc-dddd"
const ROOT_C = "root-eeee-ffff"
const CHILD_A = "child-aaaa-bbbb"
const PENDING = "pending:aaa-bbb"

function createDeps() {
  const mgr = createSessionTabManager()
  const state = {
    selected: [] as string[],
    pending: undefined as string | undefined,
    history: true,
    terminal: "some-terminal" as string | undefined,
    selection: "old-selection" as string,
    ensured: [] as string[],
    insertedAfter: [] as { source?: string; id: string }[],
  }
  const deps: OpenChildSessionDeps = {
    tabMgr: mgr,
    selectSession: (id) => state.selected.push(id),
    setActivePendingId: (id) => {
      state.pending = id
    },
    setHistory: (v) => {
      state.history = v
    },
    setTermsActiveId: (id) => {
      state.terminal = id
    },
    setSelection: (sel) => {
      state.selection = sel
    },
    isPending: (id) => id.startsWith("pending:"),
    ensureLocal: (id) => state.ensured.push(id),
    insertLocalAfter: (source, id) => state.insertedAfter.push({ source, id }),
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
  it("closes history and terminal", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openSession(ROOT_A, deps)
      expect(state.history).toBe(false)
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
      setTermsActiveId: () => {},
      setSelection: () => {},
      isPending: () => false,
      ensureLocal: () => {},
    }
    // If saveTabMemory were required, this object literal would fail typecheck
    expect(deps).toBeDefined()
  })
})

describe("openChildSession — source-relative placement contract", () => {
  it("returns false for empty ID and does not clear overlays", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      expect(openChildSession("", ROOT_A, deps)).toBe(false)
      expect(state.history).toBe(true)
    }))

  it("inserts a missing child immediately after its source in the tab registry", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      openChildSession(CHILD_A, ROOT_A, deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("inserts after a middle source preserving the other tabs' relative order", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_C, ROOT_A, ROOT_B], ROOT_A)
      openChildSession(CHILD_A, ROOT_A, deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_C, ROOT_A, CHILD_A, ROOT_B])
    }))

  it("focuses an already-open child without reordering", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], ROOT_A)
      openChildSession(CHILD_A, ROOT_A, deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("appends when the source is missing from the registry", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      openChildSession(CHILD_A, "missing-source", deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("appends when the source is undefined", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      openChildSession(CHILD_A, undefined, deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
    }))

  it("calls insertLocalAfter with the explicit source before selecting", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openChildSession(CHILD_A, ROOT_A, deps)
      expect(state.insertedAfter).toEqual([{ source: ROOT_A, id: CHILD_A }])
      expect(state.selected).toEqual([CHILD_A])
    }))

  it("clears overlays and sets selection to LOCAL", () =>
    createRoot(() => {
      const { state, deps } = createDeps()
      openChildSession(CHILD_A, ROOT_A, deps)
      expect(state.history).toBe(false)
      expect(state.terminal).toBeUndefined()
      expect(state.selection).toBe(LOCAL)
    }))

  it("handles pending IDs like openSession (no insertLocalAfter, sets pending)", () =>
    createRoot(() => {
      const { mgr, state, deps } = createDeps()
      openChildSession(PENDING, ROOT_A, deps)
      expect(state.insertedAfter).toEqual([])
      expect(state.pending).toBe(PENDING)
      expect(state.selected).toEqual([])
      expect(mgr.ids(LOCAL)).toContain(PENDING)
    }))

  it("keeps generic openSession append semantics untouched", () =>
    createRoot(() => {
      const { mgr, deps } = createDeps()
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      openSession(CHILD_A, deps)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
    }))
})

// ---------------------------------------------------------------------------
// Real three-store integration (LOCK-002): openChildSession wired to the real
// tabOrderSync (local inventory signal + persisted tab order) and the real tab
// registry. Uses the exact production `insertLocalAfter` wiring
// (tabOrderSync.insertLocalAfter), NOT a stub — this is what catches the
// persisted-order reorder that the stubbed deps hide.
// ---------------------------------------------------------------------------

describe("openChildSession — real three-store coordination (LOCK-002)", () => {
  function realDeps(initIds: string[], initOrder: string[] | undefined) {
    const [local, setLocal] = createSignal<string[]>(initIds)
    const [order, setOrder] = createSignal<Record<string, string[]>>({ [LOCAL]: initOrder ?? [] })
    const persisted: string[][] = []
    const mgr = createSessionTabManager()
    const tabOrderSync = createTabOrderSync({
      LOCAL,
      order,
      setOrder,
      persist: (_key, value) => persisted.push([...value]),
      localSessionIDs: local,
      terminalIdsFor: () => [],
    })
    const deps: OpenChildSessionDeps = {
      tabMgr: mgr,
      selectSession: () => {},
      setActivePendingId: () => {},
      setHistory: () => {},
      setTermsActiveId: () => {},
      setSelection: () => {},
      isPending: (id) => id.startsWith("pending:"),
      ensureLocal: () => {},
      insertLocalAfter: (source, id) => tabOrderSync.insertLocalAfter(source, id, setLocal),
    }
    return { mgr, deps, local, order, persisted }
  }

  it("focuses an already-open child without changing ANY of the three stores", () =>
    createRoot(() => {
      const { mgr, deps, local, order, persisted } = realDeps([ROOT_A, CHILD_A, ROOT_B], [ROOT_A, CHILD_A, ROOT_B])
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], ROOT_A)
      const before = {
        local: local(),
        order: order()[LOCAL],
        mgr: mgr.ids(LOCAL),
        persistedCount: persisted.length,
      }
      openChildSession(CHILD_A, ROOT_A, deps)
      expect(local()).toEqual(before.local)
      expect(order()[LOCAL]).toEqual(before.order)
      expect(mgr.ids(LOCAL)).toEqual(before.mgr)
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
      expect(persisted.length).toBe(before.persistedCount)
    }))

  it("does not reorder an already-persisted non-adjacent child (LOCK-002 regression)", () =>
    createRoot(() => {
      // Child is persisted at the far end (user dragged it there). Re-opening
      // from the source must focus it without yanking it back next to source.
      const { mgr, deps, local, order, persisted } = realDeps([ROOT_A, ROOT_B, CHILD_A], [ROOT_A, ROOT_B, CHILD_A])
      mgr.seed(LOCAL, [ROOT_A, ROOT_B, CHILD_A], ROOT_A)
      openChildSession(CHILD_A, ROOT_A, deps)
      expect(local()).toEqual([ROOT_A, ROOT_B, CHILD_A])
      expect(order()[LOCAL]).toEqual([ROOT_A, ROOT_B, CHILD_A])
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
      expect(persisted).toEqual([])
    }))

  it("inserts a missing child after its source in all three stores", () =>
    createRoot(() => {
      const { mgr, deps, local, order, persisted } = realDeps([ROOT_A, ROOT_B], [ROOT_A, ROOT_B])
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      openChildSession(CHILD_A, ROOT_A, deps)
      expect(local()).toEqual([ROOT_A, CHILD_A, ROOT_B])
      expect(order()[LOCAL]).toEqual([ROOT_A, CHILD_A, ROOT_B])
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
      expect(persisted.at(-1)).toEqual([ROOT_A, CHILD_A, ROOT_B])
    }))

  it("appends in all three stores when the source is unknown", () =>
    createRoot(() => {
      const { mgr, deps, local, order, persisted } = realDeps([ROOT_A, ROOT_B], [ROOT_A, ROOT_B])
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      openChildSession(CHILD_A, "missing-source", deps)
      expect(local()).toEqual([ROOT_A, ROOT_B, CHILD_A])
      expect(order()[LOCAL]).toEqual([ROOT_A, ROOT_B, CHILD_A])
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
      expect(persisted.at(-1)).toEqual([ROOT_A, ROOT_B, CHILD_A])
    }))

  it("renders the persisted order in the visible tab strip (applyTabOrder)", () =>
    createRoot(() => {
      // The tab strip derives from tabOrder via applyTabOrder; a non-adjacent
      // already-open child must render where it was persisted, not beside the
      // source, after re-open.
      const { mgr, deps, order } = realDeps([ROOT_A, ROOT_B, CHILD_A], [ROOT_A, ROOT_B, CHILD_A])
      mgr.seed(LOCAL, [ROOT_A, ROOT_B, CHILD_A], ROOT_A)
      openChildSession(CHILD_A, ROOT_A, deps)
      const rendered = applyTabOrder(
        mgr.ids(LOCAL).map((id) => ({ id })),
        order()[LOCAL],
      ).map((i) => i.id)
      expect(rendered).toEqual([ROOT_A, ROOT_B, CHILD_A])
    }))
})
