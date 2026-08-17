import { describe, expect, it } from "bun:test"
import { deepMergePatch, isRecord, stripNullPatch, unsetPathValues } from "../../src/util/config-patch"

describe("deepMergePatch (LOCK-003)", () => {
  it("merges nested objects recursively so siblings survive", () => {
    const base = { agent: { code: { model: "keep", temperature: 0.7 }, explore: { model: "x" } } }
    expect(deepMergePatch(base, { agent: { code: { temperature: 0.2 } } })).toEqual({
      agent: { code: { model: "keep", temperature: 0.2 }, explore: { model: "x" } },
    })
  })

  it("replaces arrays instead of merging them", () => {
    expect(deepMergePatch({ instructions: ["a"] }, { instructions: ["b"] })).toEqual({ instructions: ["b"] })
  })

  it("preserves keys not present in the patch", () => {
    expect(deepMergePatch({ snapshot: true, username: "alice" }, { snapshot: false })).toEqual({
      snapshot: false,
      username: "alice",
    })
  })

  it("merges indexing from both scopes like the old optimistic fallback", () => {
    const base = { indexing: { model: "global", dimension: 1024 } }
    expect(deepMergePatch(base, { indexing: { model: null } })).toEqual({
      indexing: { model: null, dimension: 1024 },
    })
  })
})

describe("unsetPathValues (LOCK-003)", () => {
  it("removes nested keys by path and prunes empty parents", () => {
    const base = { provider: { myprovider: { name: "My" }, openai: { name: "OpenAI" } }, snapshot: true }
    expect(unsetPathValues(base, [["provider", "myprovider"]])).toEqual({
      provider: { openai: { name: "OpenAI" } },
      snapshot: true,
    })
  })

  it("removes a top-level path entirely", () => {
    expect(unsetPathValues({ default_agent: "code", snapshot: true }, [["default_agent"]])).toEqual({
      snapshot: true,
    })
  })

  it("prunes a chain of parents when the last leaf is removed", () => {
    expect(unsetPathValues({ agent: { code: { prompt: "x", steps: 5 } } }, [["agent", "code", "prompt"]])).toEqual({
      agent: { code: { steps: 5 } },
    })
    expect(unsetPathValues({ agent: { code: { prompt: "x" } } }, [["agent", "code", "prompt"]])).toEqual({})
  })

  it("ignores paths that do not exist", () => {
    expect(unsetPathValues({ snapshot: true }, [["provider", "nope"]])).toEqual({ snapshot: true })
  })
})

describe("stripNullPatch (LOCK-003)", () => {
  it("strips null and undefined recursively", () => {
    expect(stripNullPatch({ username: null, snapshot: true, agent: { code: { prompt: null } } })).toEqual({
      snapshot: true,
      agent: { code: {} },
    })
  })

  it("strips null and undefined recursively including nested leaves", () => {
    expect(stripNullPatch({ indexing: { model: null, dimension: null, searchMinScore: undefined } })).toEqual({
      indexing: {},
    })
  })
})
describe("isRecord", () => {
  it("distinguishes records from arrays and nulls", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord("x")).toBe(false)
  })
})
