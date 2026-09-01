import { describe, expect, test } from "bun:test"
import { decideNewSessionCandidates, tabStates } from "../../script/e2e-probe-dom"
import type { Frame } from "@playwright/test"

function mockFrame(containers: Array<{ id: string; label: string }>): Frame {
  const doc = {
    querySelectorAll: (sel: string) => {
      if (sel === ".am-tab-sortable") {
        return containers.map((c) => ({
          getAttribute: (name: string) => (name === "data-tab-id" ? c.id : null),
          querySelector: (q: string) => {
            if (q === ".am-tab-label") return { textContent: c.label }
            return null
          },
        }))
      }
      return []
    },
  }
  return {
    evaluate: async (fn: () => unknown) => {
      const prev = (globalThis as unknown as { document?: unknown }).document
      ;(globalThis as unknown as { document: unknown }).document = doc
      try {
        return (fn as () => unknown)()
      } finally {
        if (prev === undefined) delete (globalThis as unknown as { document?: unknown }).document
        else (globalThis as unknown as { document: unknown }).document = prev
      }
    },
  } as unknown as Frame
}

describe("tabStates unlabeled enumeration", () => {
  test("enumerates every .am-tab-sortable[data-tab-id] regardless of label", async () => {
    const frame = mockFrame([
      { id: "a", label: "Alpha" },
      { id: "b", label: "" },
      { id: "c", label: "Charlie" },
    ])
    const states = await tabStates(frame)
    expect(states.map((s) => s.id)).toEqual(["a", "b", "c"])
    expect(states.find((s) => s.id === "b")?.label).toBe("")
  })
  test("excludes containers without id", async () => {
    const frame = mockFrame([
      { id: "", label: "NoID" },
      { id: "x", label: "X" },
    ])
    const states = await tabStates(frame)
    expect(states.map((s) => s.id)).toEqual(["x"])
  })
})

describe("New session action pure decision (tab-bar vs empty vs hidden vs ambiguous)", () => {
  test("tab-bar semantic button: single visible role candidate picked", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: true }],
      fallbackCandidates: [{ visible: false }],
    })
    expect("pick" in res && res.pick).toBe("role")
  })
  test("empty primary Button: single visible role candidate picked (no fallback needed)", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: true }],
      fallbackCandidates: [],
    })
    expect("pick" in res && res.pick).toBe("role")
  })
  test("hidden candidate: role present but not visible fails closed", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: false }],
      fallbackCandidates: [],
    })
    expect("error" in res).toBeTrue()
    expect((res as { error: string }).error).toContain("no visible")
  })
  test("ambiguous fail: two visible role candidates fails closed", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: true }, { visible: true }],
      fallbackCandidates: [],
    })
    expect("error" in res).toBeTrue()
    expect((res as { error: string }).error).toContain("ambiguous")
  })
})
