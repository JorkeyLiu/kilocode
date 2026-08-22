import { describe, expect, it } from "bun:test"
import { resolvePromptAgent, resolveSessionAgent } from "../../webview-ui/src/context/session-agent-store"
import { seedPendingChoices } from "../../webview-ui/src/context/session-pending"
import { resolveSessionVariant, variantKey } from "../../webview-ui/src/context/session-variant-store"

const names = new Set(["e2e-agent", "e2e-agent-b", "code"])
const all = new Set(["e2e-agent", "e2e-agent-b", "code"])

describe("resolvePromptAgent LOCK-004", () => {
  it("explicit pending equal to served default is sent (Session B)", () => {
    const store = { agentSelections: {} as Record<string, string>, sessionRecoveredAgents: {} }
    const pending: string | null = "e2e-agent-b"
    const def = "e2e-agent-b"
    const result = resolvePromptAgent(store, pending, def, names, all, undefined)
    expect(result).toBe("e2e-agent-b")
  })

  it("explicit pending non-default remains sent", () => {
    const store = { agentSelections: {} as Record<string, string>, sessionRecoveredAgents: {} }
    const pending: string | null = "e2e-agent"
    const def = "e2e-agent-b"
    const result = resolvePromptAgent(store, pending, def, names, all, undefined)
    expect(result).toBe("e2e-agent")
  })

  it("no explicit selection preserves omission when resolved equals default", () => {
    const store = { agentSelections: {} as Record<string, string>, sessionRecoveredAgents: {} }
    const pending: string | null = null
    const def = "e2e-agent-b"
    const result = resolvePromptAgent(store, pending, def, names, all, undefined)
    expect(result).toBeUndefined()
  })

  it("explicit session/draft selection equal to default is sent", () => {
    const store = {
      agentSelections: { "draft-1": "e2e-agent-b" } as Record<string, string>,
      sessionRecoveredAgents: {},
    }
    const pending: string | null = "e2e-agent-b"
    const def = "e2e-agent-b"
    const result = resolvePromptAgent(store, pending, def, names, all, "draft-1")
    expect(result).toBe("e2e-agent-b")
  })

  it("non-explicit session with recovered/default equality still omits", () => {
    const store = {
      agentSelections: {} as Record<string, string>,
      sessionRecoveredAgents: { "sess-1": "e2e-agent-b" } as Record<string, string>,
    }
    const def = "e2e-agent-b"
    // resolveSessionAgent would return recovered e2e-agent-b, but prompt should omit because not explicit
    const result = resolvePromptAgent(store, null, def, names, all, "sess-1")
    expect(result).toBeUndefined()
  })

  it("explicit session non-default remains sent", () => {
    const store = {
      agentSelections: { "sess-1": "e2e-agent" } as Record<string, string>,
      sessionRecoveredAgents: {},
    }
    const def = "e2e-agent-b"
    const result = resolvePromptAgent(store, null, def, names, all, "sess-1")
    expect(result).toBe("e2e-agent")
  })

  it("preserves existing default omission for non-explicit and non-default alias", () => {
    const store = {
      agentSelections: {} as Record<string, string>,
      sessionRecoveredAgents: {},
    }
    const def = "code"
    // When pending is null and default is code, omission
    expect(resolvePromptAgent(store, null, def, names, all, undefined)).toBeUndefined()
    // When explicit recovered is not present, but resolved would be default via fallback, still omit
    expect(resolvePromptAgent(store, null, def, names, all, "unknown-sess")).toBeUndefined()
  })
})

describe("Session B pending flow with High variant", () => {
  it("explicit pending agent equal to default plus High variant keeps both", () => {
    const pendingAgent: string | null = "e2e-agent-b"
    const pendingModel = { providerID: "e2e-local", modelID: "e2e-model" }
    const pendingVariant = { value: "high", model: pendingModel }
    const draft = "draft-b"
    // Seed as sendMessage does: store.agentSelections[draft] ?? selectedAgentName()
    const agentSelections: Record<string, string> = {}
    const overrides: Record<string, { providerID: string; modelID: string }> = {}
    const variants: Record<string, string> = {}
    // Simulate agentDrafts.seed + seedPendingChoices sequencing
    const pending = pendingAgent
    if (pending) agentSelections[draft] = pending
    const seeds = seedPendingChoices(
      draft,
      agentSelections[draft] ?? pendingAgent!,
      { model: pendingModel, variant: pendingVariant },
      overrides,
      variants,
    )
    const nextOverrides = seeds.overrides
    const nextVariants = seeds.variants
    // Verify seeded state
    expect(agentSelections[draft]).toBe("e2e-agent-b")
    expect(nextOverrides[draft]).toEqual(pendingModel)
    expect(nextVariants[variantKey(pendingModel, "e2e-agent-b", draft)]).toBe("high")

    // Prompt agent should be explicit default
    const store = { agentSelections, sessionRecoveredAgents: {} }
    const def = "e2e-agent-b"
    const promptAgent = resolvePromptAgent(store, pendingAgent, def, names, all, draft)
    expect(promptAgent).toBe("e2e-agent-b")

    // Variant resolution for that draft scope: explicit session-scoped choice wins
    const variantList = ["low", "medium", "high"]
    const sel = pendingModel
    const resolved = resolveSessionVariant(
      nextVariants,
      sel,
      variantList,
      "e2e-agent-b",
      draft,
      undefined,
      undefined,
      undefined,
      false,
      true,
    )
    expect(resolved.variant).toBe("high")
    expect(resolved.explicit).toBe(true)
  })

  it("no-explicit pending keeps variant fallback but omits agent", () => {
    const pendingAgent: string | null = null
    const def = "e2e-agent-b"
    const store = { agentSelections: {} as Record<string, string>, sessionRecoveredAgents: {} }
    const promptAgent = resolvePromptAgent(store, pendingAgent, def, names, all, undefined)
    expect(promptAgent).toBeUndefined()
    // Without seeded variant, resolution falls through to configured/default tiers, not explicit
    const sel = { providerID: "e2e-local", modelID: "e2e-model" }
    const variantList = ["low", "medium", "high"]
    const resolved = resolveSessionVariant({}, sel, variantList, def, undefined, undefined, undefined, undefined, false, true)
    expect(resolved.variant).toBe("low")
  })
})

describe("resolveSessionAgent explicit vs recovered parity", () => {
  it("explicit still wins over recovered even when equal to default", () => {
    const store = {
      agentSelections: { "s1": "e2e-agent-b" },
      sessionRecoveredAgents: { "s1": "e2e-agent" },
    }
    const resolved = resolveSessionAgent(store, "s1", "e2e-agent-b", names, all)
    expect(resolved).toBe("e2e-agent-b")
    // prompt should send explicit even though equals default
    expect(resolvePromptAgent(store, null, "e2e-agent-b", names, all, "s1")).toBe("e2e-agent-b")
  })
})
