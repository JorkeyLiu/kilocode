import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  LOCAL,
  resolveNavigation,
  resolveTabNavigation,
  visibleSidebarIds,
} from "../../webview-ui/agent-manager/navigate"

const ROOT = path.resolve(import.meta.dir, "../..")
const AM_APP = path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx")

describe("resolveNavigation real logic", () => {
  it("up from local is none, down selects first", () => {
    expect(resolveNavigation("up", undefined, ["a", "b"])).toEqual({ action: "none" })
    expect(resolveNavigation("down", undefined, ["a", "b"])).toEqual({ action: "select", id: "a" })
  })
  it("up from first goes to LOCAL, down from last is none", () => {
    expect(resolveNavigation("up", "a", ["a", "b"])).toEqual({ action: LOCAL })
    expect(resolveNavigation("down", "b", ["a", "b"])).toEqual({ action: "none" })
  })
  it("middle navigation", () => {
    expect(resolveNavigation("down", "a", ["a", "b", "c"])).toEqual({ action: "select", id: "b" })
    expect(resolveNavigation("up", "b", ["a", "b", "c"])).toEqual({ action: "select", id: "a" })
  })
  it("bounds no-wrap", () => {
    expect(resolveNavigation("down", "c", ["a", "b", "c"])).toEqual({ action: "none" })
    expect(resolveNavigation("up", "a", ["a", "b", "c"])).toEqual({ action: LOCAL })
  })
  it("pending/current not in list is none (sidebar semantics)", () => {
    expect(resolveNavigation("down", "pending:123", ["a", "b"])).toEqual({ action: "none" })
    expect(resolveNavigation("up", "pending:123", ["a", "b"])).toEqual({ action: "none" })
  })
  it("unknown id is none", () => {
    expect(resolveNavigation("down", "unknown", ["a", "b"])).toEqual({ action: "none" })
  })
})

describe("resolveTabNavigation real logic (includes terminal/pending)", () => {
  const ids = ["ses-a", "pending:1", "terminal:1", "ses-b"]
  it("prev from middle", () => {
    expect(resolveTabNavigation("prev", "terminal:1", ids)).toEqual("pending:1")
    expect(resolveTabNavigation("prev", "pending:1", ids)).toEqual("ses-a")
  })
  it("next from middle", () => {
    expect(resolveTabNavigation("next", "pending:1", ids)).toEqual("terminal:1")
    expect(resolveTabNavigation("next", "terminal:1", ids)).toEqual("ses-b")
  })
  it("next handles pending as regular tab", () => {
    expect(resolveTabNavigation("next", "ses-a", ids)).toEqual("pending:1")
  })
  it("prev handles terminal as current", () => {
    expect(resolveTabNavigation("prev", "ses-b", ids)).toEqual("terminal:1")
  })
  it("bounds no-wrap", () => {
    expect(resolveTabNavigation("prev", "ses-a", ids)).toBeUndefined()
    expect(resolveTabNavigation("next", "ses-b", ids)).toBeUndefined()
  })
  it("normal session navigation still works", () => {
    const normal = ["a", "b", "c"]
    expect(resolveTabNavigation("next", "b", normal)).toEqual("c")
    expect(resolveTabNavigation("prev", "b", normal)).toEqual("a")
    expect(resolveTabNavigation("next", "c", normal)).toBeUndefined()
    expect(resolveTabNavigation("prev", "a", normal)).toBeUndefined()
  })
  it("unknown current is none", () => {
    expect(resolveTabNavigation("next", "unknown", ids)).toBeUndefined()
  })
  it("undefined current is none", () => {
    expect(resolveTabNavigation("next", undefined, ids)).toBeUndefined()
  })
})

describe("action wiring contract in AgentManagerApp", () => {
  it("has real implementations for four navigation commands", () => {
    const s = fs.readFileSync(AM_APP, "utf-8")
    expect(s).toContain("sessionPrevious")
    expect(s).toContain("sessionNext")
    expect(s).toContain("tabPrevious")
    expect(s).toContain("tabNext")
    // must use visibleSidebarIds + resolveNavigation for sessions (visible order)
    expect(s).toContain("visibleSidebarIds")
    expect(s).toContain("resolveNavigation")
    expect(s).toContain("resolveTabNavigation")
    // must reference tabIds() and visibleTabId() and focusTab for tabs
    expect(s).toContain("tabIds()")
    expect(s).toContain("visibleTabId()")
    expect(s).toContain("focusTab(")
    // must use LOCAL for session handling
    expect(s).toContain("LOCAL")
    // must pass expanded state to visible order
    expect(s).toContain("expanded()")
    // ensure no-op removed
    expect(s).not.toMatch(/sessionPrevious:\s*\(\)\s*=>\s*\{\}/)
    expect(s).not.toMatch(/tabPrevious:\s*\(\)\s*=>\s*\{\}/)
  })

  it("session navigation skips terminal (uses session.currentSessionID not visibleTabId)", () => {
    const s = fs.readFileSync(AM_APP, "utf-8")
    // extract sessionPrevious block
    const idx = s.indexOf("sessionPrevious")
    const block = s.slice(idx, idx + 600)
    expect(block).toContain("session.currentSessionID()")
    expect(block).not.toContain("visibleTabId")
    expect(block).not.toContain("terms.activeId")
  })

  it("tab navigation includes terminal/pending via tabIds", () => {
    const s = fs.readFileSync(AM_APP, "utf-8")
    const idx = s.indexOf("tabPrevious")
    const block = s.slice(idx, idx + 400)
    expect(block).toContain("tabIds()")
    expect(block).toContain("visibleTabId()")
    expect(block).toContain("resolveTabNavigation")
  })

  it("sidebar expansion is single-owner shared state", () => {
    const app = fs.readFileSync(AM_APP, "utf-8")
    const sidebar = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/SidebarSessionList.tsx"), "utf-8")
    // Parent owns expanded signal
    expect(app).toContain("const [expanded, setExpanded]")
    // Child receives it via props
    expect(sidebar).toContain("expanded?:")
    expect(sidebar).toContain("setExpanded?:")
    // Sidebar no longer computes dead visible order; navigation owns pure visibleSidebarIds
    expect(sidebar).not.toContain("flatVisibleIds")
    expect(sidebar).not.toContain("visibleSidebarIds")
    // App wires it through
    expect(app).toContain("expanded={expanded}")
    expect(app).toContain("setExpanded={setExpanded}")
    // No second owner — navigate defines visibleSidebarIds once
    const nav = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/navigate.ts"), "utf-8")
    const visibleCount = (nav.match(/function visibleSidebarIds/g) ?? []).length
    expect(visibleCount).toBe(1)
  })

  it("focusTab syncs tabMgr for session/pending but not terminal", () => {
    const s = fs.readFileSync(AM_APP, "utf-8")
    const idx = s.indexOf("const focusTab")
    const block = s.slice(idx, idx + 600)
    expect(block).toContain("tabMgr.select(LOCAL, id)")
    expect(block).toContain("isTerminalTabId")
    // guard must prevent terminal from touching tabMgr
    expect(block).toMatch(/if\s*\(\s*!isTerminalTabId\(id\)\)\s*tabMgr\.select/)
    expect(block).toContain("focusCurrentTab")
  })

  it("sessionPrevious/Next passes actual current even when hidden (no LOCAL mis-route)", () => {
    const s = fs.readFileSync(AM_APP, "utf-8")
    // both handlers must pass cur directly to resolveNavigation, not filtered via ids.includes
    expect(s).toContain('resolveNavigation("up", cur, ids)')
    expect(s).toContain('resolveNavigation("down", cur, ids)')
    const prevIdx = s.indexOf("sessionPrevious")
    const prevBlock = s.slice(prevIdx, prevIdx + 700)
    expect(prevBlock).not.toContain("ids.includes(cur)")
    expect(prevBlock).not.toContain("effective")
    const nextIdx = s.indexOf("sessionNext")
    const nextBlock = s.slice(nextIdx, nextIdx + 700)
    expect(nextBlock).not.toContain("ids.includes(cur)")
    expect(nextBlock).not.toContain("effective")
  })
})

describe("visibleSidebarIds respects expansion", () => {
  const base = [
    {
      id: "root",
      parentID: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-10T00:00:00.000Z",
      title: "root",
    },
    {
      id: "child",
      parentID: "root",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      title: "child",
    },
    {
      id: "grand",
      parentID: "child",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      title: "grand",
    },
    {
      id: "other",
      parentID: null,
      createdAt: "2026-01-04T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z",
      title: "other",
    },
  ] satisfies { id: string; parentID: string | null; createdAt: string; updatedAt: string; title: string }[]
  it("collapsed root hides children and grandchildren", () => {
    const ids = visibleSidebarIds(base, new Set<string>())
    expect(ids).toContain("root")
    expect(ids).toContain("other")
    expect(ids).not.toContain("child")
    expect(ids).not.toContain("grand")
  })
  it("expanded root shows direct child but not grandchild without child expanded", () => {
    const ids = visibleSidebarIds(base, new Set<string>(["root"]))
    expect(ids).toContain("root")
    expect(ids).toContain("child")
    expect(ids).not.toContain("grand")
    expect(ids.indexOf("child")).toBeGreaterThan(ids.indexOf("root"))
  })
  it("expanded root+child shows grandchild", () => {
    const ids = visibleSidebarIds(base, new Set<string>(["root", "child"]))
    expect(ids).toContain("grand")
    expect(ids.indexOf("grand")).toBeGreaterThan(ids.indexOf("child"))
  })
  it("navigation skips collapsed child", () => {
    const ids = visibleSidebarIds(base, new Set<string>())
    // ids should be [root, other] (or other, root depending on activity, but child absent)
    expect(ids).not.toContain("child")
    // resolveNavigation down from root should go to other, not child
    const first = ids[0]!
    const second = ids[1]!
    expect(resolveNavigation("down", first, ids)).toEqual({ action: "select", id: second })
    // if current is collapsed child (not in list), navigation is none
    expect(resolveNavigation("down", "child", ids)).toEqual({ action: "none" })
  })
  it("navigation includes expanded child", () => {
    const ids = visibleSidebarIds(base, new Set<string>(["root"]))
    expect(ids).toContain("child")
    const rootIdx = ids.indexOf("root")
    const childIdx = ids.indexOf("child")
    expect(childIdx).toBe(rootIdx + 1)
    expect(resolveNavigation("down", "root", ids)).toEqual({ action: "select", id: "child" })
  })
  it("group ordering still respected with expansion", () => {
    const sessions = [
      {
        id: "oldRoot",
        parentID: null,
        createdAt: "2025-12-01T00:00:00.000Z",
        updatedAt: "2025-12-01T00:00:00.000Z",
        title: "old",
      },
      {
        id: "newRoot",
        parentID: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        title: "new",
      },
      {
        id: "newChild",
        parentID: "newRoot",
        createdAt: "2026-09-01T01:00:00.000Z",
        updatedAt: "2026-09-01T01:00:00.000Z",
        title: "newChild",
      },
    ] satisfies { id: string; parentID: string | null; createdAt: string; updatedAt: string; title: string }[]
    const collapsed = visibleSidebarIds(sessions, new Set<string>())
    expect(collapsed).not.toContain("newChild")
    const expandedSet = new Set<string>(["newRoot"])
    const expandedIds = visibleSidebarIds(sessions, expandedSet)
    expect(expandedIds).toContain("newChild")
    // newRoot should be before oldRoot due to date group rank / activity
    expect(expandedIds.indexOf("newRoot")).toBeLessThan(expandedIds.indexOf("oldRoot"))
  })
  it("hidden current yields no-op both directions (not LOCAL)", () => {
    const ids = visibleSidebarIds(base, new Set<string>())
    // child is hidden when root collapsed, so both up and down from child should be none
    expect(resolveNavigation("up", "child", ids)).toEqual({ action: "none" })
    expect(resolveNavigation("down", "child", ids)).toEqual({ action: "none" })
    // grand is also hidden
    expect(resolveNavigation("up", "grand", ids)).toEqual({ action: "none" })
    expect(resolveNavigation("down", "grand", ids)).toEqual({ action: "none" })
    // hidden unknown id also none both ways
    expect(resolveNavigation("up", "unknown-hidden", ids)).toEqual({ action: "none" })
    expect(resolveNavigation("down", "unknown-hidden", ids)).toEqual({ action: "none" })
  })
})
