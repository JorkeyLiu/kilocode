import { describe, expect, it } from "bun:test"
import { applySnapshot, mergeParts, sameParts } from "../../webview-ui/src/context/session-parts"
import type { Part } from "../../webview-ui/src/types/messages"

function text(id: string, value: string, time: { start?: number; end?: number } = {}): Part {
  return { id, messageID: "m1", type: "text", text: value, time: { start: time.start ?? 1, end: time.end } }
}

function reason(id: string, value: string, time: { start?: number; end?: number } = {}): Part {
  return { id, messageID: "m1", type: "reasoning", text: value, time: { start: time.start ?? 1, end: time.end } }
}

function tool(id: string): Part {
  return { id, messageID: "m1", type: "tool", tool: "bash", state: { status: "pending", input: {} } }
}

function value(parts: Part[], id: string) {
  const part = parts.find((item) => item.id === id)
  if (!part || (part.type !== "text" && part.type !== "reasoning")) return
  return (part as { text: string }).text
}

describe("mergeParts / token-ordered strict snapshot", () => {
  it("pre-token local longer prefix is corrected by an open snapshot (no prefix heuristic)", () => {
    const parts = mergeParts([text("p1", "Recommendation: approve with notes")], [text("p1", "Recommendation")], 7)
    expect(value(parts, "p1")).toBe("Recommendation")
  })

  it("reasoning parts share the strict same-ID rule", () => {
    const parts = mergeParts([reason("p1", "longer local reasoning")], [reason("p1", "short")], 3)
    expect(value(parts, "p1")).toBe("short")
  })

  it("completed snapshot wins over longer local text", () => {
    const parts = mergeParts(
      [text("p1", "Recommendation: approve with notes")],
      [text("p1", "Recommendation", { end: 2 })],
      9,
    )
    expect(value(parts, "p1")).toBe("Recommendation")
  })

  it("drops local-only tail pending capture replay (no duplication)", () => {
    const parts = mergeParts(
      [text("p1", "tool done", { end: 2 }), text("p2", "live tail", { start: 20 })],
      [text("p1", "tool done", { end: 2 })],
      4,
    )
    expect(parts.map((part) => part.id)).toEqual(["p1"])
  })

  it("snapshot repairs heal removals while local-only parts drop", () => {
    const parts = mergeParts([text("p1", "server", { end: 2 }), tool("p2")], [text("p1", "server", { end: 2 })], 5)
    expect(parts.map((part) => part.id)).toEqual(["p1"])
  })

  it("token value is never used as a time.start comparator", () => {
    // Same token, wildly different wall-clock starts: result is identical.
    const a = mergeParts([text("p1", "local", { start: 1 }), text("p9", "tail", { start: 1 })], [text("p1", "snap")], 2)
    const b = mergeParts(
      [text("p1", "local", { start: 999999 }), text("p9", "tail", { start: 999999 })],
      [text("p1", "snap")],
      2,
    )
    expect(a.map((p) => p.id)).toEqual(["p1"])
    expect(b.map((p) => p.id)).toEqual(["p1"])
    expect(value(a, "p1")).toBe("snap")
  })

  it("applySnapshot sorts by id and ignores local state", () => {
    const parts = applySnapshot([text("p2", "b"), text("p1", "a")])
    expect(parts.map((p) => p.id)).toEqual(["p1", "p2"])
  })
})

describe("mergeParts / legacy no-token merge", () => {
  it("retains prefix heuristic only when no token is present", () => {
    const parts = mergeParts([text("p1", "hello world")], [text("p1", "hello")])
    expect(value(parts, "p1")).toBe("hello world")
  })
})

describe("sameParts", () => {
  it("accepts equal hydrated and snapshot parts", () => {
    expect(sameParts([text("p1", "done", { end: 2 })], [text("p1", "done", { end: 2 })])).toBe(true)
  })

  it("rejects same-count snapshots with different ids, text, or completion state", () => {
    expect(sameParts([text("p1", "done", { end: 2 })], [text("p2", "done", { end: 2 })])).toBe(false)
    expect(sameParts([text("p1", "live")], [text("p1", "server")])).toBe(false)
    expect(sameParts([text("p1", "done")], [text("p1", "done", { end: 2 })])).toBe(false)
  })
})
