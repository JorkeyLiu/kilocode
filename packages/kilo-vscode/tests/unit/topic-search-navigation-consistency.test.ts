/**
 * Bounded Topic navigation consistency unit.
 *
 * Search (buildSidebarSearch) and navigation (visibleSidebarIds) derive the
 * same authoritative Topic projection as the sidebar (deriveTopics): root
 * identity/title, max member updatedAt descending with deterministic ID
 * tie-break, orphan/missing-parent/cycle independent. Date-group labels are
 * presentation-only and never reorder. Malformed timestamps normalize safely.
 * Uses production helpers only — no invented persistence/API/mutation.
 */

import { describe, expect, it } from "bun:test"
import type { SessionInfo } from "../../webview-ui/src/types/messages"
import { deriveTopics } from "../../webview-ui/agent-manager/topics"
import { buildSidebarSearch, sortSidebarSearch } from "../../webview-ui/agent-manager/sidebar-search"
import { visibleSidebarIds } from "../../webview-ui/agent-manager/navigate"
import { sortPreview } from "../../webview-ui/agent-manager/catalog-preview"

const ses = (
  id: string,
  opts: { parentID?: string | null; title?: string; createdAt?: string; updatedAt?: string } = {},
): SessionInfo => ({
  id,
  title: opts.title ?? id,
  parentID: opts.parentID ?? null,
  createdAt: opts.createdAt ?? "2026-01-01T00:00:00.000Z",
  updatedAt: opts.updatedAt ?? "2026-01-01T00:00:00.000Z",
})

const search = (local: SessionInfo[]) =>
  buildSidebarSearch({
    local,
    localLabel: "local",
    localBranch: "main",
    untitled: "Untitled",
    pending: (id) => id.startsWith("pending:"),
    status: () => "idle",
    busy: () => false,
    localBusy: false,
  })

const topicIDs = (local: SessionInfo[]) => deriveTopics(local).map((t) => t.id)
const searchIDs = (local: SessionInfo[]) =>
  search(local)
    .filter((i) => i.kind === "session")
    .map((i) => (i as { sessionId: string }).sessionId)

describe("topic navigation consistency — same authoritative projection", () => {
  it("search and navigation share Topic identity, order, and max-member activity", () => {
    const local = [
      ses("r1", { title: "One", updatedAt: "2026-06-01T00:00:00.000Z" }),
      ses("c1", { title: "Child", parentID: "r1", updatedAt: "2026-06-05T00:00:00.000Z" }),
      ses("r2", { title: "Two", updatedAt: "2026-06-03T00:00:00.000Z" }),
    ]
    const topics = deriveTopics(local)
    // Max member activity: r1 Topic (06-05) before r2 (06-03).
    expect(topics.map((t) => t.id)).toEqual(["r1", "r2"])
    expect(topics[0]!.activity).toBe("2026-06-05T00:00:00.000Z")
    expect(topics[0]!.label).toBe("One")
    expect(searchIDs(local)).toEqual(["r1", "r2"])
    // Navigation expands the same Topics in the same order (roots collapsed).
    expect(visibleSidebarIds(local, new Set())).toEqual(["r1", "r2"])
    // Expanded navigation keeps Topic order then depth-first members.
    expect(visibleSidebarIds(local, new Set(["r1"]))).toEqual(["r1", "c1", "r2"])
  })

  it("orphan and missing-parent components stay independent in search and navigation", () => {
    const local = [ses("root", { updatedAt: "2026-06-01T00:00:00.000Z" }), ses("orphan", { parentID: "absent", updatedAt: "2026-06-02T00:00:00.000Z" })]
    expect(topicIDs(local)).toEqual(["orphan", "root"])
    expect(searchIDs(local)).toEqual(["orphan", "root"])
    expect(visibleSidebarIds(local, new Set())).toEqual(["orphan", "root"])
    // Orphan keeps its own children.
    const nested = [ses("o", { parentID: "missing" }), ses("c", { parentID: "o" })]
    expect(topicIDs(nested)).toEqual(["o"])
    expect(searchIDs(nested)).toEqual(["o"])
    expect(visibleSidebarIds(nested, new Set(["o"]))).toEqual(["o", "c"])
  })

  it("cycle components degrade to independent Topics in search and navigation", () => {
    const local = [ses("a", { parentID: "b" }), ses("b", { parentID: "a" })]
    expect(topicIDs(local).sort()).toEqual(["a", "b"])
    expect(searchIDs(local).sort()).toEqual(["a", "b"])
    const nav = visibleSidebarIds(local, new Set())
    expect([...nav].sort()).toEqual(["a", "b"])
    expect(nav).toHaveLength(2)
  })

  it("activity ties break deterministically by ascending Topic ID (no locale compare)", () => {
    const local = [ses("z", { updatedAt: "2026-06-01T00:00:00.000Z" }), ses("a", { updatedAt: "2026-06-01T00:00:00.000Z" }), ses("m", { updatedAt: "2026-06-01T00:00:00.000Z" })]
    expect(topicIDs(local)).toEqual(["a", "m", "z"])
    expect(searchIDs(local)).toEqual(["a", "m", "z"])
    expect(visibleSidebarIds(local, new Set())).toEqual(["a", "m", "z"])
    // Search sort helper itself is deterministic and locale-independent.
    const items = search(local).filter((i) => i.kind === "session")
    const sorted = [...items].sort(sortSidebarSearch)
    expect(sorted.map((i) => i.key)).toEqual(["session:a", "session:m", "session:z"])
  })

  it("search visibility includes member titles and IDs without creating child items", () => {
    const local = [ses("r", { title: "Root name" }), ses("c", { title: "UniqueChildTitle", parentID: "r" })]
    const items = search(local)
    expect(items.filter((i) => i.kind === "session")).toHaveLength(1)
    const topic = items[0]!
    expect(topic.search).toContain("Root name")
    expect(topic.search).toContain("UniqueChildTitle")
    expect(topic.search).toContain("c")
  })

  it("deterministic order is stable across input shuffles for Topics, search, and navigation", () => {
    const set1 = [ses("a"), ses("b", { parentID: "a" }), ses("c", { updatedAt: "2026-06-02T00:00:00.000Z" })]
    const set2 = [ses("c", { updatedAt: "2026-06-02T00:00:00.000Z" }), ses("b", { parentID: "a" }), ses("a")]
    expect(topicIDs(set1)).toEqual(topicIDs(set2))
    expect(searchIDs(set1)).toEqual(searchIDs(set2))
    expect(visibleSidebarIds(set1, new Set(["a"]))).toEqual(visibleSidebarIds(set2, new Set(["a"])))
  })

  it("malformed timestamps normalize safely (no throw, no NaN sort) across helpers", () => {
    const local = [ses("good", { updatedAt: "2026-06-05T00:00:00.000Z" }), { ...ses("bad", { title: "Bad" }), updatedAt: "not-a-date", createdAt: "also-bad" }]
    expect(() => deriveTopics(local)).not.toThrow()
    expect(() => search(local)).not.toThrow()
    expect(() => visibleSidebarIds(local, new Set())).not.toThrow()
    expect(() => sortPreview(local)).not.toThrow()
    // Malformed sorts as oldest.
    expect(topicIDs(local)).toEqual(["good", "bad"])
    expect(searchIDs(local)).toEqual(["good", "bad"])
    expect(visibleSidebarIds(local, new Set())).toEqual(["good", "bad"])
    expect(sortPreview(local).map((s) => s.id)).toEqual(["good", "bad"])
  })

  it("preview stays a flat recency sort and never derives Topics", () => {
    const local = [ses("r", { title: "Root" }), ses("c", { title: "Child", parentID: "r", updatedAt: "2026-06-09T00:00:00.000Z" })]
    // Preview sorts sessions flat by updatedAt (child first) — not a Topic projection.
    expect(sortPreview(local).map((s) => s.id)).toEqual(["c", "r"])
    // Topics keep the thread together with max activity.
    expect(topicIDs(local)).toEqual(["r"])
    expect(deriveTopics(local)[0]!.activity).toBe("2026-06-09T00:00:00.000Z")
  })
})
