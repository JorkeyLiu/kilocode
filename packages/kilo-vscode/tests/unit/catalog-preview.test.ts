import { describe, expect, it } from "bun:test"
import { isStalePreview, mergePreview, sortPreview } from "../../webview-ui/agent-manager/catalog-preview"

function ses(id: string, updated: string, title = id) {
  return { id, title, createdAt: updated, updatedAt: updated }
}

describe("catalog preview helpers", () => {
  it("sorts updatedAt-desc with deterministic id tie-break", () => {
    const out = sortPreview([
      ses("ses_b", new Date(10).toISOString()),
      ses("ses_a", new Date(20).toISOString()),
      ses("ses_c", new Date(20).toISOString()),
    ])
    expect(out.map((s) => s.id)).toEqual(["ses_a", "ses_c", "ses_b"])
  })

  it("accumulates deltas and dedupes by id with delta winning", () => {
    const first = [ses("ses_a", new Date(5).toISOString(), "old")]
    const out = mergePreview(first, [
      ses("ses_a", new Date(9).toISOString(), "new"),
      ses("ses_b", new Date(7).toISOString()),
    ])
    expect(out.map((s) => s.id)).toEqual(["ses_a", "ses_b"])
    expect(out[0]!.title).toBe("new")
  })

  it("detects stale refresh ids", () => {
    expect(isStalePreview(undefined, 3)).toBe(false)
    expect(isStalePreview(5, 4)).toBe(true)
    expect(isStalePreview(5, 5)).toBe(false)
    expect(isStalePreview(5, 6)).toBe(false)
  })
})
