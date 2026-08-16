import { describe, expect, it } from "bun:test"
import type { SessionInfo } from "../../webview-ui/src/types/messages"
import { buildSidebarSearch } from "../../webview-ui/agent-manager/sidebar-search"
import { buildShortcutCategories } from "../../webview-ui/agent-manager/shortcuts"

const session = (id: string, title: string, updatedAt: string, parentID?: string): SessionInfo => ({
  id,
  title,
  parentID,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt,
})

const build = (overrides?: Partial<Parameters<typeof buildSidebarSearch>[0]>) =>
  buildSidebarSearch({
    local: [
      session("local-session", "Local investigation", "2026-06-05T00:00:00.000Z"),
      session("recent-session", "Review search UI", "2026-06-03T00:00:00.000Z"),
      session("busy-session", "Build grouped search", "2026-06-02T00:00:00.000Z"),
      session("other-session", "Other session", "2026-06-04T00:00:00.000Z"),
    ],
    localLabel: "local",
    localBranch: "main",
    untitled: "Untitled",
    pending: (id) => id.startsWith("pending:"),
    status: (id) => (id === "busy-session" ? "busy" : "idle"),
    busy: () => false,
    localBusy: false,
    ...overrides,
  })

describe("buildSidebarSearch", () => {
  it("indexes local root sessions and excludes child and pending tabs", () => {
    const items = build({
      local: [
        session("session", "Build grouped search", "2026-06-02T00:00:00.000Z"),
        session("pending:1", "New Session", "2026-06-03T00:00:00.000Z"),
        session("child", "Subagent", "2026-06-04T00:00:00.000Z", "session"),
      ],
    })

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      kind: "session",
      sessionId: "session",
      location: "local",
      meta: ["local"],
    })
    expect(items[0]?.search).toContain("Build grouped search local")
    expect(items[1]).toMatchObject({ kind: "local", title: "local", meta: ["main"], count: 1 })
    expect(items.find((item) => item.kind === "session")).toBeDefined()
    expect(items.find((item) => item.sessionId === "pending:1")).toBeUndefined()
    expect(items.find((item) => item.sessionId === "child")).toBeUndefined()
  })

  it("ranks attention and progress before recency within each result group", () => {
    const items = build()

    expect(items.map((item) => item.key)).toEqual([
      "session:busy-session",
      "session:local-session",
      "session:other-session",
      "session:recent-session",
      "local",
    ])
    expect(items[0]).toMatchObject({ state: "busy", updatedAt: "2026-06-02T00:00:00.000Z" })
    expect(items[1]).toMatchObject({ location: "local", meta: ["local"] })
    expect(items[4]).toMatchObject({ kind: "local", title: "local", count: 4 })
  })

  it("shows the local context with a busy state when local sessions are busy", () => {
    const items = build({ localBusy: true, status: () => "busy" })

    expect(items.find((item) => item.kind === "local")).toMatchObject({
      title: "local",
      state: "busy",
      count: 4,
    })
  })

  it("avoids repeating the local label when it matches the session title", () => {
    const items = build({
      local: [session("owned", "local", "2026-06-02T00:00:00.000Z")],
    })

    expect(items[0]).toMatchObject({ kind: "session", title: "local", meta: ["local"] })
  })
})

describe("Agent Manager shortcut map", () => {
  it("includes sidebar search in the quick-switch section", () => {
    const categories = buildShortcutCategories({ search: "⌘F", jumpTo1: "⌘1" }, (key) => key)
    expect(categories[0]?.shortcuts[0]).toEqual({
      label: "agentManager.sidebarSearch.label",
      binding: "⌘F",
    })
  })

  it("includes open pull request in the sidebar section", () => {
    const categories = buildShortcutCategories({ openPR: "⌘⇧R" }, (key) => key)
    expect(categories[1]?.shortcuts).toContainEqual({
      label: "agentManager.shortcuts.openPR",
      binding: "⌘⇧R",
    })
  })
})
