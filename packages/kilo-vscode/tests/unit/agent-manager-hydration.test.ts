import { describe, expect, it } from "bun:test"
import {
  accumulateCatalog,
  deriveDurableIds,
  durableFilteredOrder,
  isPending,
  isTerminal,
  pruneIds,
  pruneOrder,
  reconcile,
} from "../../webview-ui/agent-manager/hydration"
import { createSessionTabManager } from "../../webview-ui/agent-manager/session-tab-manager"
import { createTabOrderSync } from "../../webview-ui/agent-manager/tab-order-sync"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"

function catalogOf(...ids: string[]): Set<string> {
  return new Set(ids)
}

describe("hydration — deferred pending + order independent", () => {
  it("state then full catalog and catalog then state produce same 2 tabs/order/active", () => {
    const durable = {
      sessions: [{ id: "a" }, { id: "b" }],
      tabOrder: { [LOCAL]: ["b", "a"] },
      activeSessionId: "b",
    }
    const full = catalogOf("a", "b")

    const fresh = () => ({
      localIds: [] as string[],
      tabOrder: undefined as string[] | undefined,
      active: undefined as string | undefined,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })

    const seqStateThenCatalog = (() => {
      const s1 = reconcile({ ...fresh(), durable, catalog: undefined })
      expect(s1.nextIds).toBeUndefined()
      const s2 = reconcile({ ...fresh(), durable, catalog: full, hasMore: false })
      return s2
    })()

    const seqCatalogThenState = (() => {
      const c1 = reconcile({ ...fresh(), durable: undefined, catalog: full, hasMore: false })
      expect(c1.nextIds).toBeUndefined()
      const c2 = reconcile({ ...fresh(), durable, catalog: full, hasMore: false })
      return c2
    })()

    expect(seqStateThenCatalog.nextIds).toEqual(["b", "a"])
    expect(seqCatalogThenState.nextIds).toEqual(["b", "a"])
    expect(seqStateThenCatalog.nextActive).toBe("b")
    expect(seqCatalogThenState.nextActive).toBe("b")
    expect(seqStateThenCatalog.nextOrder).toEqual(["b", "a"])
    expect(seqCatalogThenState.nextOrder).toEqual(["b", "a"])
  })

  it("complete snapshot replaces: no prefix gating, deprecated hasMore ignored", () => {
    // Complete inventory is always authoritative; deprecated hasMore/append
    // flags are ignored.
    const localIds = ["a", "b"]
    const tabOrder = ["b", "a"]
    const durable = { sessions: [{ id: "a" }, { id: "b" }], tabOrder: { [LOCAL]: ["b", "a"] }, activeSessionId: "b" }

    // Complete snapshot with both ids: no prune even with deprecated hasMore true.
    const catalog = accumulateCatalog(undefined, [{ id: "a" }, { id: "b" }], false)
    const out = reconcile({
      localIds,
      tabOrder,
      active: "b",
      durable,
      catalog,
      hasMore: true,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(out.nextIds).toBeUndefined()
    expect(out.nextOrder).toBeUndefined()
    expect(catalog).toEqual(catalogOf("a", "b"))

    // Fresh hydration from a complete snapshot hydrates even with hasMore true.
    const freshOut = reconcile({
      localIds: [],
      tabOrder: undefined,
      active: undefined,
      durable,
      catalog: catalogOf("a", "b"),
      hasMore: true,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(freshOut.nextIds).toEqual(["b", "a"])
    expect(freshOut.nextActive).toBe("b")
    expect(freshOut.markHydrated).toBe(true)

    // accumulateCatalog replaces: second snapshot drops absent ids.
    const replaced = accumulateCatalog(catalog, [{ id: "a" }], true)
    expect(replaced).toEqual(catalogOf("a"))
  })

  it("preserveSessionIds protects target across partial refresh", () => {
    const localIds = ["a", "protected"]
    const tabOrder = ["a", "protected"]
    const durable = { sessions: [{ id: "a" }, { id: "protected" }] }
    const catalog = catalogOf("a") // protected missing
    const outProtected = reconcile({
      localIds,
      tabOrder,
      active: "a",
      durable,
      catalog,
      hasMore: false,
      preserveSessionIds: ["protected"],
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(outProtected.nextIds).toBeUndefined() // protected keeps it, no prune
    const outWithout = reconcile({
      localIds,
      tabOrder,
      active: "a",
      durable,
      catalog,
      hasMore: false,
      preserveSessionIds: [],
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(outWithout.nextIds).toEqual(["a"])
  })

  it("no catalog means no pending creation merely from state", () => {
    const out = reconcile({
      localIds: [],
      tabOrder: undefined,
      active: undefined,
      durable: { sessions: [{ id: "a" }] },
      catalog: undefined,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.needsPending).toBe(false)
    expect(out.markHydrated).toBe(false)
    expect(out.nextIds).toBeUndefined()
  })

  it("empty durable + final empty catalog creates one pending", () => {
    const out = reconcile({
      localIds: [],
      tabOrder: undefined,
      active: undefined,
      durable: { sessions: [] },
      catalog: catalogOf(),
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.needsPending).toBe(true)
    expect(out.markHydrated).toBe(true)
    expect(out.nextIds).toEqual([])
    expect(out.nextOrder).toEqual([])
    expect(out.nextActive).toBeUndefined()
  })

  it("existing local state prunes deleted on final catalog", () => {
    const localIds = ["a", "b", "c"]
    const tabOrder = ["c", "b", "a"]
    const out = reconcile({
      localIds,
      tabOrder,
      active: "b",
      durable: { sessions: [{ id: "a" }, { id: "c" }] },
      catalog: catalogOf("a", "c"),
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(out.nextIds).toEqual(["a", "c"])
    expect(out.nextOrder).toEqual(["c", "a"])
    expect(out.nextActive).toBe("a")
  })

  it("pending/terminal retained UI, filtered durable order", () => {
    const pending = "pending:xyz"
    const local = ["a", pending, "b"]
    const catalog = catalogOf("a")
    const out = reconcile({
      localIds: local,
      tabOrder: ["a", pending, "b", "terminal:1"],
      active: pending,
      durable: { sessions: [{ id: "a" }] },
      catalog,
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(out.nextIds).toEqual(["a", pending])
    expect(out.nextOrder).toEqual(["a", pending, "terminal:1"])
    // durableFilteredOrder strips pending/terminal
    const filtered = durableFilteredOrder(["a", pending, "terminal:1"])
    expect(filtered).toEqual(["a"])
    const mgr = createSessionTabManager()
    mgr.seed(LOCAL, out.nextIds!, pending)
    expect(mgr.ids(LOCAL)).toEqual(["a", pending])
    expect(mgr.active(LOCAL)).toBe(pending)
  })

  it("idempotent repeated messages", () => {
    const durable = { sessions: [{ id: "a" }, { id: "b" }], tabOrder: { [LOCAL]: ["b", "a"] }, activeSessionId: "b" }
    const catalog = catalogOf("a", "b")
    const first = reconcile({
      localIds: [],
      tabOrder: undefined,
      active: undefined,
      durable,
      catalog,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(first.nextIds).toEqual(["b", "a"])
    // apply first, then second call with same inputs but isFresh false and local already hydrated
    const second = reconcile({
      localIds: first.nextIds!,
      tabOrder: first.nextOrder,
      active: first.nextActive,
      durable,
      catalog,
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(second.nextIds).toBeUndefined()
    expect(second.nextOrder).toBeUndefined()
    expect(second.nextActive).toBeUndefined()

    // also prune idempotent
    const local = ["a", "b"]
    const p1 = reconcile({
      localIds: local,
      tabOrder: ["b", "a"],
      active: "b",
      durable,
      catalog,
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(p1.nextIds).toBeUndefined()
    const p2 = reconcile({
      localIds: local,
      tabOrder: ["b", "a"],
      active: "b",
      durable,
      catalog,
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(p2.nextIds).toBeUndefined()
  })

  it("pruneOrder keeps terminal and pending but removes missing real ids", () => {
    const order = ["a", "pending:1", "terminal:abc", "missing"]
    const catalog = catalogOf("a")
    const next = pruneOrder(order, catalog)
    expect(next).toEqual(["a", "pending:1", "terminal:abc"])
  })

  it("deriveDurableIds respects activeSessionId not in tabOrder", () => {
    const durable = {
      sessions: [{ id: "a" }, { id: "b" }, { id: "c" }],
      tabOrder: { [LOCAL]: ["a", "b"] },
      activeSessionId: "c",
    }
    const { ids, active } = deriveDurableIds(durable, LOCAL)
    expect(ids).toEqual(["a", "b", "c"])
    expect(active).toBe("c")
  })

  it("accumulateCatalog merges append and dedupes, non-append resets", () => {
    const first = accumulateCatalog(undefined, [{ id: "a" }], false)
    expect(first).toEqual(catalogOf("a"))
    const appended = accumulateCatalog(first, [{ id: "b" }, { id: "a" }], true)
    expect(appended).toEqual(catalogOf("a", "b"))
    const reset = accumulateCatalog(appended, [{ id: "c" }], false)
    expect(reset).toEqual(catalogOf("c"))
  })

  it("durable setTabOrder excludes pending and terminal IDs", () => {
    const persisted: { key: string; order: string[] }[] = []
    const state = {
      order: {} as Record<string, string[]>,
      localIds: ["a", "pending:1", "b"],
      terminals: { [LOCAL]: ["terminal:1"] },
    }
    const sync = createTabOrderSync({
      LOCAL,
      order: () => state.order,
      setOrder: (u) => {
        state.order = u(state.order)
      },
      persist: (key, order) => {
        const clean = order.filter((id) => !isPending(id) && !isTerminal(id))
        persisted.push({ key, order: clean })
      },
      localSessionIDs: () => state.localIds,
      terminalIdsFor: (key) => state.terminals[key] ?? [],
    })
    sync.append(LOCAL, "pending:1")
    expect(state.order[LOCAL]).toContain("pending:1")
    expect(state.order[LOCAL]).toContain("terminal:1")
    const last = persisted.at(-1)!
    expect(last.order.includes("pending:1")).toBe(false)
    expect(last.order.includes("terminal:1")).toBe(false)
    expect(last.order).toEqual(["a", "b"])
  })

  it("fresh hydration retains pending tabs, merges durable, keeps active pending, no duplicates, idempotent", () => {
    const pending1 = "pending:one"
    const pending2 = "pending:two"
    const durable = {
      sessions: [{ id: "a" }, { id: "b" }],
      tabOrder: { [LOCAL]: ["b", "a"] },
      activeSessionId: "b",
    }
    const full = catalogOf("a", "b")
    const outOne = reconcile({
      localIds: [pending1],
      tabOrder: [pending1],
      active: pending1,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(outOne.nextIds).toEqual([pending1, "b", "a"])
    expect(outOne.nextActive).toBe(pending1)
    expect(outOne.nextOrder).toEqual([pending1, "b", "a"])
    expect(new Set(outOne.nextIds!).size).toBe(outOne.nextIds!.length)
    expect(durableFilteredOrder(outOne.nextOrder!)).toEqual(["b", "a"])

    const outTwo = reconcile({
      localIds: [pending1, pending2],
      tabOrder: [pending1, pending2],
      active: pending2,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(outTwo.nextIds).toEqual([pending1, pending2, "b", "a"])
    expect(outTwo.nextActive).toBe(pending2)
    expect(outTwo.nextOrder).toEqual([pending1, pending2, "b", "a"])
    expect(new Set(outTwo.nextIds!).size).toBe(outTwo.nextIds!.length)
    expect(outTwo.nextIds!.filter((id) => isPending(id))).toEqual([pending1, pending2])
    expect(durableFilteredOrder(outTwo.nextOrder!)).toEqual(["b", "a"])

    const second = reconcile({
      localIds: outTwo.nextIds!,
      tabOrder: outTwo.nextOrder,
      active: outTwo.nextActive,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(second.nextIds).toBeUndefined()
    expect(second.nextOrder).toBeUndefined()
    expect(second.nextActive).toBeUndefined()

    const repeat = reconcile({
      localIds: [pending1, pending2],
      tabOrder: [pending1, pending2],
      active: pending2,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(repeat.nextIds).toEqual(outTwo.nextIds)
    expect(repeat.nextActive).toBe(pending2)
  })

  it("fresh with pending not active chooses durable active", () => {
    const pending1 = "pending:one"
    const pending2 = "pending:two"
    const durable = {
      sessions: [{ id: "a" }, { id: "b" }],
      tabOrder: { [LOCAL]: ["b", "a"] },
      activeSessionId: "b",
    }
    const full = catalogOf("a", "b")
    const out = reconcile({
      localIds: [pending1, pending2],
      tabOrder: [pending1, pending2],
      active: undefined,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.nextIds).toEqual([pending1, pending2, "b", "a"])
    expect(out.nextActive).toBe("b")
    expect(durableFilteredOrder(out.nextOrder!)).toEqual(["b", "a"])

    const outRealActive = reconcile({
      localIds: [pending1],
      tabOrder: [pending1],
      active: "b",
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(outRealActive.nextActive).toBe("b")
  })

  it("fresh with only pending keeps pending active when durable empty", () => {
    const pending = "pending:only"
    const durable = { sessions: [] as { id: string }[] }
    const full = catalogOf()
    const out = reconcile({
      localIds: [pending],
      tabOrder: [pending],
      active: pending,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.nextIds).toEqual([pending])
    expect(out.nextActive).toBe(pending)
    expect(out.nextOrder).toEqual([pending])
    expect(durableFilteredOrder(out.nextOrder!)).toEqual([])
  })

  // Gate C — real sessionCreated ID must survive stale authoritative empty catalog
  it("real created ID absent from authoritative empty catalog remains when preserved", () => {
    const real = "ses_real123"
    const outWithout = reconcile({
      localIds: [real],
      tabOrder: [real],
      active: real,
      durable: { sessions: [{ id: real }] },
      catalog: catalogOf(),
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(outWithout.nextIds).toEqual([]) // pruned without preserve
    expect(outWithout.needsPending).toBe(true)

    const outWith = reconcile({
      localIds: [real],
      tabOrder: [real],
      active: real,
      durable: { sessions: [{ id: real }] },
      catalog: catalogOf(),
      hasMore: false,
      preserveSessionIds: [real],
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(outWith.nextIds).toBeUndefined() // preserved, no prune
    expect(outWith.needsPending).toBe(false)
  })

  it("append=false stale empty catalog does not drop protected ID", () => {
    const real = "ses_append_protect"
    // simulate sessionsLoaded with append false empty
    let catalog: Set<string> | undefined = undefined
    catalog = accumulateCatalog(catalog, [], false)
    const out = reconcile({
      localIds: [real],
      tabOrder: [real],
      active: real,
      durable: { sessions: [{ id: real }] },
      catalog,
      hasMore: false,
      preserveSessionIds: [real],
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(out.nextIds).toBeUndefined()
    expect(out.needsPending).toBe(false)
  })

  it("next authoritative catalog containing ID consumes protection and keeps ID", () => {
    const real = "ses_consume"
    const stale = catalogOf()
    const outPreserved = reconcile({
      localIds: [real],
      tabOrder: [real],
      active: real,
      durable: { sessions: [{ id: real }] },
      catalog: stale,
      hasMore: false,
      preserveSessionIds: [real],
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(outPreserved.nextIds).toBeUndefined()

    // Next catalog now includes the ID — even without preserve, it stays
    const fresh = catalogOf(real)
    const outAfter = reconcile({
      localIds: [real],
      tabOrder: [real],
      active: real,
      durable: { sessions: [{ id: real }] },
      catalog: fresh,
      hasMore: false,
      preserveSessionIds: [], // consumed, no longer needed
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(outAfter.nextIds).toBeUndefined()
    expect(outAfter.needsPending).toBe(false)
  })

  it("fresh empty still gets one pending tab (no preservation needed)", () => {
    const out = reconcile({
      localIds: [],
      tabOrder: undefined,
      active: undefined,
      durable: { sessions: [] },
      catalog: catalogOf(),
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.needsPending).toBe(true)
    expect(out.markHydrated).toBe(true)
  })

  it("close last still yields empty prune and needsPending (bottom gated externally)", () => {
    const last = "ses_last"
    const out = reconcile({
      localIds: [last],
      tabOrder: [last],
      active: last,
      durable: { sessions: [{ id: last }] },
      catalog: catalogOf(), // genuinely deleted last session
      hasMore: false,
      preserveSessionIds: [], // no in-flight protection
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(out.nextIds).toEqual([])
    expect(out.needsPending).toBe(true)
  })

  it("no state injection — reconcile does not create synthetic IDs", () => {
    const out = reconcile({
      localIds: ["a"],
      tabOrder: ["a"],
      active: "a",
      durable: { sessions: [{ id: "a" }] },
      catalog: catalogOf("a"),
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    expect(out.nextIds).toBeUndefined()
    // nextIds never contains an ID not in localIds or durable/catalog without preserve
    const withPreserve = reconcile({
      localIds: ["a"],
      tabOrder: ["a"],
      active: "a",
      durable: { sessions: [{ id: "a" }] },
      catalog: catalogOf("a"),
      hasMore: false,
      preserveSessionIds: ["injected"],
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    // preserve only keeps existing, does not add new synthetic entry
    expect(withPreserve.nextIds).toBeUndefined()
  })

  it("first durable hydration authoritative despite nonempty stale cache preserves pending", () => {
    const pending1 = "pending:keep1"
    const pending2 = "pending:keep2"
    const staleReal = "ses_stale_ghost"
    const durable = {
      sessions: [{ id: "a" }, { id: "b" }, { id: "c" }],
      tabOrder: { [LOCAL]: ["c", "b", "a"] },
      activeSessionId: "c",
    }
    const full = catalogOf("a", "b", "c")
    const staleIds = [staleReal, "a", pending1, pending2]
    const staleOrder = [staleReal, "a", pending1, pending2]
    const staleActive = pending1
    const out = reconcile({
      localIds: staleIds,
      tabOrder: staleOrder,
      active: staleActive,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.nextIds).toEqual([pending1, pending2, "c", "b", "a"])
    expect(out.nextActive).toBe(pending1)
    expect(out.nextOrder).toEqual([pending1, pending2, "c", "b", "a"])
    expect(out.markHydrated).toBe(true)
    expect(out.nextIds).not.toContain(staleReal)
    expect(out.nextIds).toContain("c")
    expect(out.nextIds).toContain("b")
    expect(durableFilteredOrder(out.nextOrder!)).toEqual(["c", "b", "a"])
  })

  it("first durable hydration authoritative replaces stale order/active and adds missing durable real", () => {
    const durable = {
      sessions: [{ id: "x" }, { id: "y" }],
      tabOrder: { [LOCAL]: ["y", "x"] },
      activeSessionId: "y",
    }
    const full = catalogOf("x", "y")
    const staleIds = ["ghost_old", "x"]
    const staleOrder = ["x", "ghost_old"]
    const out = reconcile({
      localIds: staleIds,
      tabOrder: staleOrder,
      active: "ghost_old",
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.nextIds).toEqual(["y", "x"])
    expect(out.nextActive).toBe("y")
    expect(out.nextOrder).toEqual(["y", "x"])
    expect(out.nextIds).not.toContain("ghost_old")
  })

  it("subsequent durable update after first hydration uses incremental prune not fresh merge", () => {
    const pending = "pending:keep"
    const v1 = {
      sessions: [{ id: "a" }, { id: "b" }],
      tabOrder: { [LOCAL]: ["b", "a"] },
      activeSessionId: "b",
    }
    const fullV1 = catalogOf("a", "b")
    const freshOut = reconcile({
      localIds: ["stale", pending],
      tabOrder: ["stale", pending],
      active: pending,
      durable: v1,
      catalog: fullV1,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(freshOut.nextIds).toEqual([pending, "b", "a"])
    expect(freshOut.nextActive).toBe(pending)
    expect(freshOut.markHydrated).toBe(true)
    const v2 = {
      sessions: [{ id: "a" }, { id: "b" }, { id: "c" }],
      tabOrder: { [LOCAL]: ["c", "b", "a"] },
      activeSessionId: "c",
    }
    const fullV2 = catalogOf("a", "b", "c")
    const second = reconcile({
      localIds: freshOut.nextIds!,
      tabOrder: freshOut.nextOrder,
      active: freshOut.nextActive,
      durable: v2,
      catalog: fullV2,
      hasMore: false,
      LOCAL,
      isFresh: false,
      durableHydrated: true,
    })
    // incremental prune path does not adopt newer durable order/active wholesale when local already hydrated;
    // it prunes only missing catalog entries, so c is not auto-inserted and active stays pending
    expect(second.nextIds).toBeUndefined()
    expect(second.nextOrder).toBeUndefined()
    expect(second.nextActive).toBeUndefined()
  })

  it("no workspace write loop before authoritative hydration with stale nonempty cache", () => {
    const durable = {
      sessions: [{ id: "a" }, { id: "b" }],
      tabOrder: { [LOCAL]: ["b", "a"] },
      activeSessionId: "b",
    }
    const staleIds = ["ghost", "a", "pending:1"]
    // Only durable, no catalog yet -> no change
    const noCatalog = reconcile({
      localIds: staleIds,
      tabOrder: ["ghost", "a", "pending:1"],
      active: "a",
      durable,
      catalog: undefined,
      hasMore: undefined,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(noCatalog.nextIds).toBeUndefined()
    expect(noCatalog.nextOrder).toBeUndefined()
    expect(noCatalog.markHydrated).toBe(false)
    // Only catalog, no durable -> no change
    const noDurable = reconcile({
      localIds: staleIds,
      tabOrder: ["ghost", "a", "pending:1"],
      active: "a",
      durable: undefined,
      catalog: catalogOf("a", "b"),
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(noDurable.nextIds).toBeUndefined()
    expect(noDurable.markHydrated).toBe(false)
    // Deprecated hasMore true is ignored: complete snapshot still hydrates.
    const complete = reconcile({
      localIds: staleIds,
      tabOrder: ["ghost", "a", "pending:1"],
      active: "a",
      durable,
      catalog: catalogOf("a", "b"),
      hasMore: true,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(complete.nextIds).toEqual(["pending:1", "b", "a"])
    expect(complete.markHydrated).toBe(true)
  })

  it("fresh empty durable preserves local A/B/C confirmed by catalog", () => {
    const out = reconcile({
      localIds: ["a", "b", "c"],
      tabOrder: ["a", "b", "c"],
      active: "b",
      durable: { sessions: [] },
      catalog: catalogOf("a", "b", "c"),
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.nextIds).toEqual(["a", "b", "c"])
    expect(out.nextOrder).toEqual(["a", "b", "c"])
    expect(out.nextActive).toBe("b")
    expect(out.needsPending).toBe(false)
    expect(out.markHydrated).toBe(true)
    expect(out.applyActive).toBe(false)
  })

  it("fresh empty durable preserves lone-pending + A/B/C variants", () => {
    const pending = "pending:lone"
    const durable = { sessions: [] as { id: string }[] }
    const full = catalogOf("a", "b", "c")
    const head = reconcile({
      localIds: [pending, "a", "b", "c"],
      tabOrder: [pending, "a", "b", "c"],
      active: pending,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(head.nextIds).toEqual([pending, "a", "b", "c"])
    expect(head.nextOrder).toEqual([pending, "a", "b", "c"])
    expect(head.nextActive).toBe(pending)
    expect(head.needsPending).toBe(false)
    expect(head.markHydrated).toBe(true)

    const tail = reconcile({
      localIds: ["a", "b", "c", pending],
      tabOrder: ["a", "b", "c", pending],
      active: "c",
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(tail.nextIds).toEqual(["a", "b", "c", pending])
    expect(tail.nextActive).toBe("c")
    expect(tail.needsPending).toBe(false)
    expect(tail.markHydrated).toBe(true)
  })

  it("fresh empty durable preserves via preserve when catalog empty", () => {
    const out = reconcile({
      localIds: ["a", "b", "c"],
      tabOrder: ["a", "b", "c"],
      active: "a",
      durable: { sessions: [] },
      catalog: catalogOf(),
      hasMore: false,
      preserveSessionIds: ["a", "b", "c"],
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.nextIds).toEqual(["a", "b", "c"])
    expect(out.needsPending).toBe(false)
    expect(out.markHydrated).toBe(true)
    expect(out.nextActive).toBe("a")
  })

  it("fresh empty durable active prefers pending, then valid active, then first merged", () => {
    const pending = "pending:keep"
    const durable = { sessions: [] as { id: string }[] }
    const full = catalogOf("a", "b", "c")
    const prefersPending = reconcile({
      localIds: [pending, "a", "b"],
      tabOrder: [pending, "a", "b"],
      active: pending,
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(prefersPending.nextActive).toBe(pending)

    const keepsValid = reconcile({
      localIds: [pending, "a", "b"],
      tabOrder: [pending, "a", "b"],
      active: "b",
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(keepsValid.nextActive).toBe("b")

    const fallsBack = reconcile({
      localIds: ["a", "b", "c"],
      tabOrder: ["a", "b", "c"],
      active: "ghost",
      durable,
      catalog: full,
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(fallsBack.nextIds).toEqual(["a", "b", "c"])
    expect(fallsBack.nextActive).toBe("a")
    expect(fallsBack.applyActive).toBe(true)
    expect(fallsBack.needsPending).toBe(false)
  })

  it("fresh empty durable dedupes and keeps local order", () => {
    const out = reconcile({
      localIds: ["c", "a", "c", "b", "a"],
      tabOrder: ["c", "a", "c", "b", "a"],
      active: "c",
      durable: { sessions: [] },
      catalog: catalogOf("a", "b", "c"),
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(out.nextIds).toEqual(["c", "a", "b"])
    expect(out.nextOrder).toEqual(["c", "a", "b"])
    expect(out.needsPending).toBe(false)
  })

  it("fresh empty durable prunes genuine deletion to empty + needsPending", () => {
    const pruned = reconcile({
      localIds: ["ghost"],
      tabOrder: ["ghost"],
      active: "ghost",
      durable: { sessions: [] },
      catalog: catalogOf(),
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(pruned.nextIds).toEqual([])
    expect(pruned.nextOrder).toEqual([])
    expect(pruned.nextActive).toBeUndefined()
    expect(pruned.needsPending).toBe(true)
    expect(pruned.markHydrated).toBe(true)

    const partial = reconcile({
      localIds: ["a", "deleted"],
      tabOrder: ["a", "deleted"],
      active: "a",
      durable: { sessions: [] },
      catalog: catalogOf("a"),
      hasMore: false,
      LOCAL,
      isFresh: true,
      durableHydrated: false,
    })
    expect(partial.nextIds).toEqual(["a"])
    expect(partial.nextActive).toBe("a")
    expect(partial.needsPending).toBe(false)
    expect(partial.markHydrated).toBe(true)
  })
})
