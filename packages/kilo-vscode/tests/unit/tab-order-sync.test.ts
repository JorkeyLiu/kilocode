import { describe, it, expect } from "bun:test"
import { createTabOrderSync, type TabOrderSyncDeps } from "../../webview-ui/agent-manager/tab-order-sync"
import { applyTabOrder } from "../../webview-ui/agent-manager/tab-order"

// Builds a simulated AgentManager tab state with controllable accessors.
// Mirrors the real call order: source state (localSessionIDs)
// is mutated BEFORE the factory method is invoked.
function scene(init: { order?: Record<string, string[]>; sessions?: string[] }) {
  const state = {
    order: { ...(init.order ?? {}) } as Record<string, string[]>,
    localIds: [...(init.sessions ?? [])],
    persisted: [] as { key: string; order: string[] }[],
  }
  const deps: TabOrderSyncDeps = {
    LOCAL: "LOCAL",
    order: () => state.order,
    setOrder: (u) => {
      state.order = u(state.order)
    },
    persist: (key, order) => {
      state.persisted.push({ key, order: [...order] })
    },
    localSessionIDs: () => state.localIds,
  }
  return { state, sync: createTabOrderSync(deps), deps }
}

// Simulate how `tabIds()` renders the final tab bar: base composed as
// `[...sessions]` and `applyTabOrder` layered on top.
function render(deps: TabOrderSyncDeps, key: string): string[] {
  const sids = key === deps.LOCAL ? deps.localSessionIDs() : []
  return applyTabOrder(
    sids.map((id) => ({ id })),
    deps.order()[key],
  ).map((i) => i.id)
}

describe("createTabOrderSync.append", () => {
  it("puts a new pending tab at the tail (regression)", () => {
    // Setup: existing session s1, no stored order yet. User presses
    // Cmd+T → pending_1 added to local sessions first, then append.
    const { state, sync, deps } = scene({
      sessions: ["s1", "pending_1"],
    })
    sync.append("LOCAL", "pending_1")
    expect(render(deps, "LOCAL")).toEqual(["s1", "pending_1"])
    expect(state.order.LOCAL).toEqual(["s1", "pending_1"])
  })

  it("appends to tail when stored order exists and lacks the id", () => {
    const { state, sync, deps } = scene({
      order: { LOCAL: ["s1"] },
      sessions: ["s1", "s2"],
    })
    sync.append("LOCAL", "s2")
    expect(state.order.LOCAL).toEqual(["s1", "s2"])
    expect(render(deps, "LOCAL")).toEqual(["s1", "s2"])
  })

  it("moves the id to the tail if it was already present in stored", () => {
    const { state, sync } = scene({
      order: { LOCAL: ["s1", "s2"] },
      sessions: ["s1", "s2"],
    })
    sync.append("LOCAL", "s1")
    expect(state.order.LOCAL).toEqual(["s2", "s1"])
  })

  it("resolves undefined key to LOCAL", () => {
    const { state, sync } = scene({ sessions: ["s1"] })
    sync.append(undefined, "s1")
    expect(state.order.LOCAL).toEqual(["s1"])
  })

  it("handles an empty base (nothing mutated yet) by just writing the id", () => {
    const { state, sync } = scene({})
    sync.append("LOCAL", "x")
    expect(state.order.LOCAL).toEqual(["x"])
  })
})

describe("createTabOrderSync.replaceOrAppend", () => {
  it("swaps a pending id for a real session id, preserving position", () => {
    const { state, sync, deps } = scene({
      order: { LOCAL: ["s1", "pending_1"] },
      sessions: ["s1", "real_1"], // caller already mapped pending_1 → real_1
    })
    sync.replaceOrAppend("LOCAL", "pending_1", "real_1")
    expect(state.order.LOCAL).toEqual(["s1", "real_1"])
    expect(render(deps, "LOCAL")).toEqual(["s1", "real_1"])
  })

  it("appends at the tail when the anchor isn't in stored", () => {
    const { state, sync } = scene({
      order: { LOCAL: ["s1"] },
      sessions: ["s1", "s2"], // s2 not yet in stored
    })
    sync.replaceOrAppend("LOCAL", "missing", "s2")
    expect(state.order.LOCAL).toEqual(["s1", "s2"])
  })
})

describe("createTabOrderSync.insertAfter", () => {
  it("inserts a fork directly after its parent in the rendered order", () => {
    const { state, sync, deps } = scene({
      order: { LOCAL: ["s1"] },
      sessions: ["s1", "child", "s2"], // caller already inserted child after s1
    })
    sync.insertAfter("LOCAL", "s1", "child")
    expect(state.order.LOCAL).toEqual(["s1", "child", "s2"])
    // Rendered result has child immediately after s1.
    expect(render(deps, "LOCAL")).toEqual(["s1", "child", "s2"])
  })

  it("appends when the anchor is missing entirely", () => {
    const { state, sync } = scene({
      order: { LOCAL: ["s1"] },
      sessions: ["s1", "fork"],
    })
    sync.insertAfter("LOCAL", "missing_anchor", "fork")
    expect(state.order.LOCAL).toEqual(["s1", "fork"])
  })

  it("seeds from base when no stored order exists (first fork)", () => {
    const { state, sync } = scene({
      sessions: ["s1", "child", "s2"],
    })
    sync.insertAfter("LOCAL", "s1", "child")
    expect(state.order.LOCAL).toEqual(["s1", "child", "s2"])
  })

  it("leaves an already-stored id untouched (focus-only, no reorder — LOCK-002)", () => {
    // The child is already persisted at a NON-adjacent position. Re-opening it
    // from the source must NOT move it in the persisted order or repersist.
    const { state, sync, deps } = scene({
      order: { LOCAL: ["s1", "child", "s2"] },
      sessions: ["s1", "child", "s2"],
    })
    sync.insertAfter("LOCAL", "s1", "child")
    expect(state.order.LOCAL).toEqual(["s1", "child", "s2"])
    expect(state.persisted).toEqual([])
    expect(render(deps, "LOCAL")).toEqual(["s1", "child", "s2"])
  })
})

describe("createTabOrderSync.insertLocalAfter (LOCK-002 three-store coordination)", () => {
  function setLocal(state: ReturnType<typeof scene>["state"], u: (prev: string[]) => string[]) {
    state.localIds = u(state.localIds)
  }

  it("inserts a new child after its source in inventory AND persisted order", () => {
    const { state, sync } = scene({
      order: { LOCAL: ["s1", "s2"] },
      sessions: ["s1", "s2"],
    })
    sync.insertLocalAfter("s1", "child", (u) => setLocal(state, u))
    expect(state.localIds).toEqual(["s1", "child", "s2"])
    expect(state.order.LOCAL).toEqual(["s1", "child", "s2"])
  })

  it("appends when the source is missing, in both stores", () => {
    const { state, sync } = scene({
      order: { LOCAL: ["s1", "s2"] },
      sessions: ["s1", "s2"],
    })
    sync.insertLocalAfter("missing", "child", (u) => setLocal(state, u))
    expect(state.localIds).toEqual(["s1", "s2", "child"])
    expect(state.order.LOCAL).toEqual(["s1", "s2", "child"])
  })

  it("leaves an already-open child untouched in BOTH stores (no reorder, no repersist)", () => {
    const { state, sync } = scene({
      order: { LOCAL: ["s1", "child", "s2"] },
      sessions: ["s1", "child", "s2"],
    })
    const before = { local: [...state.localIds], order: [...(state.order.LOCAL ?? [])] }
    sync.insertLocalAfter("s1", "child", (u) => setLocal(state, u))
    expect(state.localIds).toEqual(before.local)
    expect(state.order.LOCAL).toEqual(before.order)
    expect(state.persisted).toEqual([])
  })

  it("positions a child that is in inventory but not yet persisted", () => {
    const { state, sync } = scene({
      order: { LOCAL: ["s1", "s2"] },
      sessions: ["s1", "child", "s2"],
    })
    sync.insertLocalAfter("s1", "child", (u) => setLocal(state, u))
    expect(state.localIds).toEqual(["s1", "child", "s2"])
    expect(state.order.LOCAL).toEqual(["s1", "child", "s2"])
  })

  it("does not move an already-persisted non-adjacent child (LOCK-002 regression)", () => {
    // Simulates: source s1 at position 0, child persisted at position 2 after
    // a drag. Re-opening the child from s1 must focus WITHOUT yanking it back
    // next to s1 in the persisted order.
    const { state, sync } = scene({
      order: { LOCAL: ["s1", "s2", "child"] },
      sessions: ["s1", "s2", "child"],
    })
    sync.insertLocalAfter("s1", "child", (u) => setLocal(state, u))
    expect(state.localIds).toEqual(["s1", "s2", "child"])
    expect(state.order.LOCAL).toEqual(["s1", "s2", "child"])
    expect(state.persisted).toEqual([])
  })
})

describe("createTabOrderSync persistence filter", () => {
  it("callers strip transient ids before persisting (pending never hits disk)", () => {
    // Mirror AgentManagerApp's real filter: strip pending ids.
    const { state, sync } = scene({
      sessions: ["s1", "pending:1"],
    })
    // Rebuild sync with a filtering persist to mimic the call site.
    const filteredSync = createTabOrderSync({
      LOCAL: "LOCAL",
      order: () => state.order,
      setOrder: (u) => {
        state.order = u(state.order)
      },
      persist: (key, order) => {
        const clean = order.filter((id) => !id.startsWith("pending:"))
        state.persisted.push({ key, order: clean })
      },
      localSessionIDs: () => state.localIds,
    })
    filteredSync.append("LOCAL", "pending:1")
    // In-memory order keeps the pending tab for tab-strip state.
    expect(state.order.LOCAL).toEqual(["s1", "pending:1"])
    // Persisted payload is session-only.
    expect(state.persisted.at(-1)?.order).toEqual(["s1"])
  })
})

describe("createTabOrderSync cross-method scenario", () => {
  it("preserves position through pending → real lifecycle", () => {
    const s = scene({ sessions: ["s1"] })

    // 1. User presses Cmd+T → pending_1 appended to localIds first.
    s.state.localIds = ["s1", "pending_1"]
    s.sync.append("LOCAL", "pending_1")
    expect(s.state.order.LOCAL).toEqual(["s1", "pending_1"])

    // 2. Real session created → caller mapped pending_1 → real_1 in localIds.
    s.state.localIds = ["s1", "real_1"]
    s.sync.replaceOrAppend("LOCAL", "pending_1", "real_1")
    expect(s.state.order.LOCAL).toEqual(["s1", "real_1"])

    // Rendered tab bar keeps the new session in its slot.
    expect(render(s.deps, "LOCAL")).toEqual(["s1", "real_1"])
  })
})
