import { describe, expect, it } from "bun:test"
import {
  agentPatch,
  selectedAgentNumberOverrideValue,
  selectedAgentTextOverrideValue,
  selectedDefaultAgentValue,
  shouldClearDefaultAgentWhenAgentBecomesUnavailable,
} from "../../webview-ui/src/components/settings/agent-behaviour-patches"

describe("agentPatch", () => {
  it("wraps a config fragment under the named agent — no extra keys", () => {
    const patch = agentPatch("code", { prompt: "override" })
    expect(patch).toEqual({ agent: { code: { prompt: "override" } } })
    expect(Object.keys(patch)).toEqual(["agent"])
    expect(Object.keys(patch.agent!)).toEqual(["code"])
  })

  it("preserves null delete sentinels", () => {
    const patch = agentPatch("plan", { variant: null })
    expect(patch).toEqual({ agent: { plan: { variant: null } } })
  })

  it("preserves false booleans", () => {
    const patch = agentPatch("code", { hidden: false })
    expect(patch).toEqual({ agent: { code: { hidden: false } } })
  })

  it("preserves nested permission objects", () => {
    const patch = agentPatch("code", { permission: { file_read: "allow", file_write: "deny" } })
    expect(patch).toEqual({
      agent: { code: { permission: { file_read: "allow", file_write: "deny" } } },
    })
  })

  it("never spreads full agent map — only the named agent entry", () => {
    const patch = agentPatch("code", { prompt: "new" })
    // The only top-level key is 'agent', and it contains exactly one entry
    expect(Object.keys(patch)).toEqual(["agent"])
    expect(Object.keys(patch.agent!)).toHaveLength(1)
  })
})

describe("selectedAgentTextOverrideValue", () => {
  it("maps an empty text field value to a null delete sentinel", () => {
    expect(selectedAgentTextOverrideValue("")).toBeNull()
  })

  it("preserves a non-empty text override", () => {
    expect(selectedAgentTextOverrideValue("Review code")).toBe("Review code")
  })
})

describe("selectedAgentNumberOverrideValue", () => {
  it("maps a blank numeric field value to a null delete sentinel", () => {
    expect(selectedAgentNumberOverrideValue("", parseFloat)).toBeNull()
  })

  it("preserves a valid numeric override", () => {
    expect(selectedAgentNumberOverrideValue("0.7", parseFloat)).toBe(0.7)
  })

  it("keeps invalid non-empty numeric input out of the persisted patch", () => {
    expect(selectedAgentNumberOverrideValue("abc", parseFloat)).toBeUndefined()
  })
})

describe("selectedDefaultAgentValue", () => {
  it("maps an empty dropdown value to a null delete sentinel", () => {
    expect(selectedDefaultAgentValue("")).toBeNull()
  })

  it("preserves a non-empty agent selection", () => {
    expect(selectedDefaultAgentValue("code")).toBe("code")
  })
})

describe("shouldClearDefaultAgentWhenAgentBecomesUnavailable", () => {
  it("clears when the current default agent becomes unavailable", () => {
    expect(shouldClearDefaultAgentWhenAgentBecomesUnavailable(true, "code", "code")).toBe(true)
  })

  it("does not clear when toggling a non-default agent", () => {
    expect(shouldClearDefaultAgentWhenAgentBecomesUnavailable(true, "code", "plan")).toBe(false)
  })

  it("does not clear when the agent remains available", () => {
    expect(shouldClearDefaultAgentWhenAgentBecomesUnavailable(false, "code", "code")).toBe(false)
  })
})
