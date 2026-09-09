import { describe, expect, it } from "bun:test"
import {
  composeScopePatch,
  deepMergePatch,
  isRecord,
  stripNullPatch,
  unsetPathValues,
} from "../../src/util/config-patch"

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

describe("composeScopePatch", () => {
  const gui = (key: string) => key !== "$schema"

  it("merges nested patch leaves so siblings survive", () => {
    const base = { permission: { read: "allow", bash: "ask" }, model: "custom/model" }
    expect(composeScopePatch(base, { permission: { bash: "deny" } }, [], gui)).toEqual({
      permission: { read: "allow", bash: "deny" },
    })
  })

  it("replaces arrays and scalars wholesale", () => {
    expect(composeScopePatch({ instructions: ["a"] }, { instructions: ["b", "c"] }, [], gui)).toEqual({
      instructions: ["b", "c"],
    })
    expect(composeScopePatch({ permission: { read: "allow" } }, { permission: "deny" }, [], gui)).toEqual({
      permission: "deny",
    })
  })

  it("deletes only the targeted nested leaf", () => {
    const base = { permission: { read: "allow", bash: "ask" } }
    expect(composeScopePatch(base, {}, [["permission", "bash"]], gui)).toEqual({
      permission: { read: "allow" },
    })
  })

  it("prunes the top-level key when its last leaf is unset", () => {
    expect(composeScopePatch({ permission: { bash: "ask" } }, {}, [["permission", "bash"]], gui)).toEqual({
      permission: undefined,
    })
  })

  it("omits untouched keys so the service keeps file content", () => {
    const base = { permission: { read: "allow" }, model: "custom/model" }
    expect(composeScopePatch(base, { model: "custom/next" }, [], gui)).toEqual({ model: "custom/next" })
  })

  it("combines nested set and unset in one scope", () => {
    const base = {
      model_variant_overrides: { "openai/gpt-4": "thinking", "anthropic/claude": "default" },
    }
    expect(
      composeScopePatch(
        base,
        { model_variant_overrides: { "openai/gpt-4": "fast" } },
        [["model_variant_overrides", "anthropic/claude"]],
        gui,
      ),
    ).toEqual({ model_variant_overrides: { "openai/gpt-4": "fast" } })
  })

  it("drops prototype-pollution keys in patch and unsets without polluting", () => {
    const base = { permission: { read: "allow" } }
    const out = composeScopePatch(
      base,
      { permission: { bash: "deny", __proto__: { polluted: true } } } as Record<string, unknown>,
      [["__proto__", "polluted"], ["permission", "__proto__"], ["permission", "constructor"]],
      gui,
    )
    expect(out).toEqual({ permission: { read: "allow", bash: "deny" } })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("ignores non-field top-level keys and malformed paths", () => {
    const base = { model: "custom/model" }
    expect(
      composeScopePatch(
        base,
        { $schema: "https://example.com/schema", model: "custom/next" } as Record<string, unknown>,
        [[], ["$schema"], ["model", ""], "model" as unknown as string[]],
        gui,
      ),
    ).toEqual({ model: "custom/next" })
  })
})
