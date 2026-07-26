import { describe, expect, it } from "bun:test"
import { ConfigState } from "../../webview-ui/src/utils/config-utils"
import { agentPatch } from "../../webview-ui/src/components/settings/agent-behaviour-patches"
import type { Config } from "../../webview-ui/src/types/messages"

function makeState(initial: Config) {
  const state = new ConfigState()
  state.handleConfigLoaded(initial)
  state.draft = {}
  state.dirty = false
  return state
}

describe("agent config draft minimality", () => {
  it("single field edit emits only that field under target agent in draft", () => {
    const state = makeState({
      agent: {
        myagent: { model: "x", prompt: "old", description: "keep" },
        other: { model: "y", prompt: "other" },
      },
    })

    state.updateConfig(agentPatch("myagent", { prompt: "new" }))

    expect(state.draft).toEqual({ agent: { myagent: { prompt: "new" } } })
  })

  it("single field edit merges into config without touching unrelated agents", () => {
    const state = makeState({
      agent: {
        myagent: { model: "x", prompt: "old", description: "keep" },
        other: { model: "y", prompt: "other" },
      },
    })

    state.updateConfig(agentPatch("myagent", { prompt: "new" }))

    expect(state.config.agent?.myagent).toEqual({ model: "x", prompt: "new", description: "keep" })
    expect(state.config.agent?.other).toEqual({ model: "y", prompt: "other" })
  })

  it("two sequential edits compose in the draft via deep merge", () => {
    const state = makeState({
      agent: { myagent: { model: "x", prompt: "old" } },
    })

    state.updateConfig(agentPatch("myagent", { prompt: "new" }))
    state.updateConfig(agentPatch("myagent", { temperature: 0.7 }))

    expect(state.draft).toEqual({ agent: { myagent: { prompt: "new", temperature: 0.7 } } })
  })

  it("null value preserved as delete sentinel in draft", () => {
    const state = makeState({
      agent: { myagent: { variant: "high", model: "x" } },
    })

    state.updateConfig(agentPatch("myagent", { variant: null }))

    expect(state.draft).toEqual({ agent: { myagent: { variant: null } } })
    // Config strips null via stripNulls
    expect(state.config.agent?.myagent).toEqual({ model: "x" })
  })

  it("false value preserved in draft (not stripped)", () => {
    const state = makeState({
      agent: { myagent: { hidden: true } },
    })

    state.updateConfig(agentPatch("myagent", { hidden: false }))

    expect(state.draft).toEqual({ agent: { myagent: { hidden: false } } })
    expect(state.config.agent?.myagent?.hidden).toBe(false)
  })

  it("undefined value preserved in draft for unset semantics", () => {
    const state = makeState({
      agent: { myagent: { description: "old", model: "x" } },
    })

    state.updateConfig(agentPatch("myagent", { description: undefined }))

    // draft contains undefined — deepMerge preserves it
    expect(state.draft).toEqual({ agent: { myagent: { description: undefined } } })
    // Config strips undefined via stripNulls
    expect(state.config.agent?.myagent).toEqual({ model: "x" })
  })

  it("permission patch nests correctly under target agent", () => {
    const state = makeState({
      agent: {
        myagent: { model: "x", permission: { file_read: "allow" } },
        other: { model: "y" },
      },
    })

    state.updateConfig(agentPatch("myagent", { permission: { file_read: "deny", file_write: "ask" } }))

    expect(state.draft).toEqual({
      agent: { myagent: { permission: { file_read: "deny", file_write: "ask" } } },
    })
    expect(state.config.agent?.other).toEqual({ model: "y" })
  })

  it("create (new agent) emits only the new agent entry", () => {
    const state = makeState({
      agent: { existing: { model: "x", prompt: "keep" } },
    })

    state.updateConfig(agentPatch("newagent", { mode: "primary", prompt: "hello" }))

    expect(state.draft).toEqual({ agent: { newagent: { mode: "primary", prompt: "hello" } } })
    expect(state.config.agent?.existing).toEqual({ model: "x", prompt: "keep" })
  })

  it("import emits only the target agent entry", () => {
    const state = makeState({
      agent: { existing: { model: "x" } },
    })

    const imported = { mode: "primary" as const, prompt: "from file", description: "imported" }
    state.updateConfig(agentPatch("imported_agent", imported))

    expect(state.draft).toEqual({ agent: { imported_agent: imported } })
    expect(state.config.agent?.existing).toEqual({ model: "x" })
  })

  it("edit on native agent does not spread other agents into draft", () => {
    const state = makeState({
      agent: {
        code: { prompt: "base prompt", model: "x" },
        plan: { prompt: "plan prompt" },
      },
    })

    state.updateConfig(agentPatch("code", { prompt: "override" }))

    // Draft contains ONLY the changed field for the target agent
    expect(state.draft).toEqual({ agent: { code: { prompt: "override" } } })
    // Other agent untouched in config
    expect(state.config.agent?.plan).toEqual({ prompt: "plan prompt" })
  })

  it("multiple edits across different agents keep each agent minimal", () => {
    const state = makeState({
      agent: {
        a: { model: "x" },
        b: { model: "y" },
      },
    })

    state.updateConfig(agentPatch("a", { prompt: "a-prompt" }))
    state.updateConfig(agentPatch("b", { prompt: "b-prompt" }))

    expect(state.draft).toEqual({
      agent: { a: { prompt: "a-prompt" }, b: { prompt: "b-prompt" } },
    })
  })

  it("false toggle composes with previous edit", () => {
    const state = makeState({
      agent: { myagent: { hidden: false, disable: false } },
    })

    state.updateConfig(agentPatch("myagent", { hidden: true }))
    state.updateConfig(agentPatch("myagent", { disable: true }))

    expect(state.draft).toEqual({ agent: { myagent: { hidden: true, disable: true } } })
    expect(state.config.agent?.myagent).toEqual({ hidden: true, disable: true })
  })
})
