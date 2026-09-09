import { describe, expect, it } from "bun:test"
import {
  createAgentDraft,
  parseAgentFloat,
  parseAgentSteps,
  type AgentDraftPatch,
} from "../../webview-ui/src/components/settings/agent-draft"
import type { AgentConfig } from "../../webview-ui/src/types/messages"

function setup() {
  const commits: Array<{ name: string; patch: AgentDraftPatch }> = []
  const draft = createAgentDraft((name, patch) => commits.push({ name, patch }))
  return { commits, draft }
}

const serverA: AgentConfig = {
  mode: "primary",
  description: "A desc",
  prompt: "A body",
  temperature: 0.5,
  top_p: 0.9,
  steps: 4,
}

const serverB: AgentConfig = {
  mode: "primary",
  description: "B desc",
  prompt: "B body",
  temperature: 0.2,
}

describe("agent draft text fields", () => {
  it("commits description/prompt deltas and reflects them in shown", () => {
    const { commits, draft } = setup()
    draft.sync({ name: "a", hash: "h1", server: serverA }, false)
    draft.setText("description", "New desc")
    draft.setText("prompt", "New body")
    expect(commits).toEqual([
      { name: "a", patch: { frontmatter: { description: "New desc" } } },
      { name: "a", patch: { frontmatter: {}, body: "New body" } },
    ])
    const shown = draft.shown(serverA)
    expect(shown.description).toBe("New desc")
    expect(shown.prompt).toBe("New body")
    expect(shown.temperature).toBe(0.5)
  })

  it("clears description on empty input per existing clear semantic", () => {
    const { commits, draft } = setup()
    draft.sync({ name: "a", hash: "h1", server: serverA }, false)
    draft.setText("description", "")
    expect(commits).toEqual([{ name: "a", patch: { frontmatter: { description: undefined } } }])
    expect(draft.shown(serverA).description).toBeUndefined()
  })

  it("commits nothing before the first sync (no agent identity)", () => {
    const { commits, draft } = setup()
    draft.setText("description", "x")
    draft.setNumeric("temperature", "0.5")
    expect(commits).toEqual([])
  })
})

describe("agent draft identity isolation", () => {
  it("switching A->B with an identical assetHash drops A's draft entirely", () => {
    const { commits, draft } = setup()
    draft.sync({ name: "a", hash: "h1", server: serverA }, false)
    draft.setText("description", "A typed")
    draft.setNumeric("temperature", "0.7")
    // Same hash, different agent: unconditional isolation.
    draft.sync({ name: "b", hash: "h1", server: serverB }, false)
    const shown = draft.shown(serverB)
    expect(shown.description).toBe("B desc")
    expect(shown.prompt).toBe("B body")
    expect(shown.temperature).toBe(0.2)
    expect(draft.text("temperature")).toBe("0.2")
    // Later commits target B with B's base.
    draft.setText("description", "B typed")
    expect(commits.at(-1)).toEqual({ name: "b", patch: { frontmatter: { description: "B typed" } } })
    expect(commits.every((c) => c.name === "a" || c === commits.at(-1))).toBe(true)
  })

  it("same-name server advance resets when idle but retains while pending", () => {
    const { commits, draft } = setup()
    draft.sync({ name: "a", hash: "h1", server: serverA }, false)
    draft.setText("description", "typed")
    const advanced: AgentConfig = { ...serverA, description: "server v2" }
    draft.sync({ name: "a", hash: "h2", server: advanced }, false)
    expect(draft.shown(advanced).description).toBe("server v2")
    expect(commits).toHaveLength(1)

    draft.setText("description", "typed again")
    draft.sync({ name: "a", hash: "h3", server: { ...serverA, description: "server v3" } }, true)
    expect(draft.shown({ ...serverA, description: "server v3" }).description).toBe("typed again")
  })
})

describe("agent draft numeric fields", () => {
  it("keeps intermediate/invalid input local without committing", () => {
    const { commits, draft } = setup()
    draft.sync({ name: "a", hash: "h1", server: serverA }, false)
    for (const raw of ["0.", "-", "+", ".", "abc", "1.2.3", "0.5x"]) {
      draft.setNumeric("temperature", raw)
    }
    expect(commits).toEqual([])
    expect(draft.text("temperature")).toBe("0.5x")
    // The displayed value stays the raw text, not a prefix-parsed number.
    expect(draft.shown(serverA).temperature).toBe(0.5)
  })

  it("commits only fully matching literals; empty clears", () => {
    const { commits, draft } = setup()
    draft.sync({ name: "a", hash: "h1", server: serverA }, false)
    draft.setNumeric("temperature", "0.75")
    draft.setNumeric("top_p", "1e-1")
    draft.setNumeric("steps", "8")
    expect(commits).toEqual([
      { name: "a", patch: { frontmatter: { temperature: 0.75 } } },
      { name: "a", patch: { frontmatter: { top_p: 0.1 } } },
      { name: "a", patch: { frontmatter: { steps: 8 } } },
    ])
    const shown = draft.shown(serverA)
    expect(shown.temperature).toBe(0.75)
    expect(shown.top_p).toBe(0.1)
    expect(shown.steps).toBe(8)

    draft.setNumeric("temperature", "   ")
    expect(commits.at(-1)).toEqual({ name: "a", patch: { frontmatter: { temperature: undefined } } })
    expect(draft.shown(serverA).temperature).toBeUndefined()
  })

  it("rejects non-positive and non-integer steps without committing", () => {
    const { commits, draft } = setup()
    draft.sync({ name: "a", hash: "h1", server: serverA }, false)
    for (const raw of ["0", "-2", "2.5", "+0"]) {
      draft.setNumeric("steps", raw)
    }
    expect(commits).toEqual([])
    expect(draft.text("steps")).toBe("+0")
  })
})

describe("agent draft generic set", () => {
  it("merges keys, strips prompt from frontmatter, and maps body", () => {
    const { commits, draft } = setup()
    draft.sync({ name: "a", hash: "h1", server: serverA }, false)
    draft.set({ model: "p/m", variant: null })
    draft.set({ prompt: "hello" })
    expect(commits).toEqual([
      { name: "a", patch: { frontmatter: { model: "p/m", variant: null } } },
      { name: "a", patch: { frontmatter: {}, body: "hello" } },
    ])
    const shown = draft.shown(serverA)
    expect(shown.model).toBe("p/m")
    expect(shown.variant).toBeNull()
    expect(shown.prompt).toBe("hello")
  })
})

describe("agent numeric parsers", () => {
  it("parseAgentFloat accepts full literals only", () => {
    expect(parseAgentFloat("0.5")).toBe(0.5)
    expect(parseAgentFloat("  1e3  ")).toBe(1000)
    expect(parseAgentFloat(".5")).toBe(0.5)
    expect(parseAgentFloat("-2")).toBe(-2)
    expect(parseAgentFloat("+3.25")).toBe(3.25)
    for (const raw of ["", "   ", "0.", "-", "+", ".", "abc", "1.2.3", "0.5x", "Infinity", "NaN", "0x10"]) {
      expect(parseAgentFloat(raw)).toBeUndefined()
    }
  })

  it("parseAgentSteps accepts positive integers only", () => {
    expect(parseAgentSteps("3")).toBe(3)
    expect(parseAgentSteps("  12 ")).toBe(12)
    for (const raw of ["", "0", "-1", "2.5", "3.0", "abc", "+0", "1e2"]) {
      expect(parseAgentSteps(raw)).toBeUndefined()
    }
  })
})
