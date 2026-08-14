/**
 * Tests for the derived Topic model (P1 orchestration-first navigation).
 *
 * Covers: root sessions define Topics, descendants belong via parentID,
 * activity is max member updatedAt, activity-descending order with
 * deterministic ID tie-break, orphan/missing-parent/cycle degradation to
 * independent Topics, and active-Topic resolution. All derivation is pure:
 * no session mutation, no persistence.
 */

import { describe, it, expect } from "bun:test"
import { deriveTopics, activeTopicID, type TopicLike, type TopicView } from "../../webview-ui/agent-manager/topics"

const at = (day: number, hour = 0) =>
  `2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`

function s(
  id: string,
  opts: { parentID?: string | null; title?: string; createdAt?: string; updatedAt?: string } = {},
): TopicLike {
  const day = Number(id.replace(/\D/g, "")) || 1
  return {
    id,
    parentID: opts.parentID ?? null,
    title: opts.title ?? `title-${id}`,
    createdAt: opts.createdAt ?? at(day),
    updatedAt: opts.updatedAt ?? at(day),
  }
}

function ids(topics: TopicView<TopicLike>[]): string[] {
  return topics.map((tp) => tp.id)
}

describe("deriveTopics — roots define Topics", () => {
  it("each root session defines one Topic keyed by root ID with the root title as label", () => {
    const topics = deriveTopics([s("a"), s("b")])
    expect(ids(topics).sort()).toEqual(["a", "b"])
    const tp = topics.find((t) => t.id === "a")!
    expect(tp.id).toBe("a")
    expect(tp.root.id).toBe("a")
    expect(tp.label).toBe("title-a")
    expect(tp.members.map((m) => m.id)).toEqual(["a"])
    expect(tp.hasChildren).toBe(false)
  })

  it("renaming the root session relabels the Topic (label derives from root title)", () => {
    const before = deriveTopics([s("r", { title: "Old name" })])
    expect(before[0]!.label).toBe("Old name")
    // Backend rename updates the session title; re-derivation relabels the Topic.
    const after = deriveTopics([s("r", { title: "New name" })])
    expect(after[0]!.id).toBe("r")
    expect(after[0]!.label).toBe("New name")
  })

  it("an empty title yields an empty label (UI falls back to the untitled label)", () => {
    const topics = deriveTopics([{ id: "r", title: "", parentID: null, createdAt: at(1), updatedAt: at(1) }])
    expect(topics[0]!.label).toBe("")
  })

  it("empty inventory yields no Topics", () => {
    expect(deriveTopics([])).toEqual([])
  })
})

describe("deriveTopics — descendants belong via parentID", () => {
  it("includes children and grandchildren in the root's Topic members", () => {
    const sessions = [s("r"), s("c", { parentID: "r" }), s("gc", { parentID: "c" })]
    const topics = deriveTopics(sessions)
    expect(topics).toHaveLength(1)
    const tp = topics[0]!
    expect(tp.id).toBe("r")
    expect(tp.members.map((m) => m.id)).toEqual(["r", "c", "gc"])
    expect(tp.hasChildren).toBe(true)
  })

  it("child sessions never become their own Topics", () => {
    const sessions = [s("r"), s("c", { parentID: "r" })]
    const topics = deriveTopics(sessions)
    expect(ids(topics)).toEqual(["r"])
  })
})

describe("deriveTopics — activity is max member updatedAt", () => {
  it("uses the newest member update as the Topic activity", () => {
    const sessions = [
      s("r", { createdAt: at(1), updatedAt: at(1) }),
      s("c", { parentID: "r", createdAt: at(2), updatedAt: at(5) }),
    ]
    const topics = deriveTopics(sessions)
    expect(topics[0]!.activity).toBe(at(5))
  })

  it("uses the root's own updatedAt when it is the newest member", () => {
    const sessions = [
      s("r", { createdAt: at(1), updatedAt: at(9) }),
      s("c", { parentID: "r", createdAt: at(2), updatedAt: at(5) }),
    ]
    const topics = deriveTopics(sessions)
    expect(topics[0]!.activity).toBe(at(9))
  })
})

describe("deriveTopics — deterministic order", () => {
  it("orders Topics by activity descending (most recent first)", () => {
    const sessions = [s("old", { updatedAt: at(1) }), s("new", { updatedAt: at(9) }), s("mid", { updatedAt: at(5) })]
    expect(ids(deriveTopics(sessions))).toEqual(["new", "mid", "old"])
  })

  it("breaks activity ties deterministically by ascending Topic ID", () => {
    const sessions = [s("z", { updatedAt: at(1) }), s("a", { updatedAt: at(1) }), s("m", { updatedAt: at(1) })]
    expect(ids(deriveTopics(sessions))).toEqual(["a", "m", "z"])
  })

  it("is stable across input order shuffles", () => {
    const set1 = [s("a"), s("b", { parentID: "a" }), s("c")]
    const set2 = [s("c"), s("b", { parentID: "a" }), s("a")]
    expect(ids(deriveTopics(set1))).toEqual(ids(deriveTopics(set2)))
  })
})

describe("deriveTopics — orphan and missing-parent degradation", () => {
  it("a session whose parent is absent becomes an independent Topic", () => {
    const sessions = [s("orphan", { parentID: "missing" })]
    const topics = deriveTopics(sessions)
    expect(ids(topics)).toEqual(["orphan"])
    expect(topics[0]!.members.map((m) => m.id)).toEqual(["orphan"])
  })

  it("an orphan Topic keeps its own children via parentID", () => {
    const sessions = [s("o", { parentID: "missing" }), s("c", { parentID: "o" })]
    const topics = deriveTopics(sessions)
    expect(ids(topics)).toEqual(["o"])
    expect(topics[0]!.members.map((m) => m.id)).toEqual(["o", "c"])
  })

  it("mixes orphan Topics with normal root Topics deterministically", () => {
    const sessions = [
      s("root", { createdAt: at(1), updatedAt: at(1) }),
      s("orphan", { parentID: "absent", createdAt: at(2), updatedAt: at(2) }),
    ]
    const topics = deriveTopics(sessions)
    // orphan is more recent → first
    expect(ids(topics)).toEqual(["orphan", "root"])
    expect(topics[1]!.members.map((m) => m.id)).toEqual(["root"])
  })
})

describe("deriveTopics — cycle degradation", () => {
  it("mutual cycle members each degrade to an independent single-member Topic", () => {
    const sessions = [s("a", { parentID: "b" }), s("b", { parentID: "a" })]
    const topics = deriveTopics(sessions)
    expect(ids(topics).sort()).toEqual(["a", "b"])
    for (const tp of topics) {
      expect(tp.members.map((m) => m.id)).toEqual([tp.id])
      expect(tp.hasChildren).toBe(false)
    }
  })

  it("self-referencing sessions degrade to an independent Topic", () => {
    const sessions = [s("self", { parentID: "self" })]
    const topics = deriveTopics(sessions)
    expect(ids(topics)).toEqual(["self"])
    expect(topics[0]!.members.map((m) => m.id)).toEqual(["self"])
  })

  it("cycles mix with normal roots without looping or duplication", () => {
    const sessions = [
      s("root", { createdAt: at(1), updatedAt: at(1) }),
      s("a", { parentID: "b", createdAt: at(2), updatedAt: at(2) }),
      s("b", { parentID: "a", createdAt: at(3), updatedAt: at(3) }),
    ]
    const topics = deriveTopics(sessions)
    expect(ids(topics).sort()).toEqual(["a", "b", "root"])
    const memberCount = topics.reduce((n, tp) => n + tp.members.length, 0)
    expect(memberCount).toBe(3) // every session appears exactly once across Topics
  })
})

describe("activeTopicID", () => {
  const sessions = [s("r1", { title: "One" }), s("c1", { parentID: "r1" }), s("r2", { title: "Two" })]
  const topics = deriveTopics(sessions)

  it("resolves the Topic of an active root session", () => {
    expect(activeTopicID(topics, "r1")).toBe("r1")
  })

  it("resolves the Topic of an active child session via its member closure", () => {
    expect(activeTopicID(topics, "c1")).toBe("r1")
  })

  it("returns undefined for unknown or absent active sessions", () => {
    expect(activeTopicID(topics, "nope")).toBeUndefined()
    expect(activeTopicID(topics, undefined)).toBeUndefined()
  })
})
