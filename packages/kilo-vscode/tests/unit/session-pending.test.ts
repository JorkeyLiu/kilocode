import { describe, expect, it } from "bun:test"
import type { ModelSelection } from "../../webview-ui/src/types/messages"
import { seedPendingChoices } from "../../webview-ui/src/context/session-pending"
import { variantKey } from "../../webview-ui/src/context/session-variant-store"

const gpt: ModelSelection = { providerID: "openai", modelID: "gpt-4.1" }

describe("seedPendingChoices (LOCK-005)", () => {
  it("writes the pending model into the target's explicit overrides", () => {
    const seeds = seedPendingChoices("draft-1", "code", { model: gpt, variant: null }, {}, {})
    expect(seeds.overrides["draft-1"]).toEqual(gpt)
    expect(seeds.variants).toEqual({})
  })

  it("writes the pending variant into the target's session-scoped key", () => {
    const seeds = seedPendingChoices("draft-1", "code", { model: null, variant: { value: "high", model: gpt } }, {}, {})
    expect(seeds.variants[variantKey(gpt, "code", "draft-1")]).toBe("high")
    expect(seeds.overrides).toEqual({})
  })

  it("replaces a stale same-target seed but keeps unrelated entries (LOCK-002)", () => {
    const seeds = seedPendingChoices(
      "draft-1",
      "code",
      { model: gpt, variant: { value: "high", model: gpt } },
      { "draft-1": { providerID: "anthropic", modelID: "claude-sonnet-4" } },
      { "agent/code/openai/gpt-4.1": "low" },
    )
    // The pending pick is the user's latest intent — it replaces the stale
    // first-seed override for the same target instead of gap-filling.
    expect(seeds.overrides["draft-1"]).toEqual(gpt)
    // Unrelated keys (other targets / memory tiers) stay untouched.
    expect(seeds.variants["agent/code/openai/gpt-4.1"]).toBe("low")
    expect(seeds.variants[variantKey(gpt, "code", "draft-1")]).toBe("high")
  })

  it("reusing a draft after a model repick prunes the stale first-seed variant", () => {
    // First send seeded model A + variant "high" into the draft; the send
    // failed, the draft is reused, and the user repicked model B. Reseeding
    // must drop A's session-scoped key so transferDraftState cannot promote
    // the stale first-seed variant alongside the new model choice.
    const stale = { [variantKey(gpt, "code", "draft-1")]: "high" }
    const seeds = seedPendingChoices(
      "draft-1",
      "code",
      { model: { providerID: "anthropic", modelID: "claude-sonnet-4" }, variant: null },
      { "draft-1": gpt },
      stale,
    )
    expect(seeds.overrides["draft-1"]).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    expect(seeds.variants[variantKey(gpt, "code", "draft-1")]).toBeUndefined()
  })

  it("reusing a draft after a variant repick replaces the same-model session key", () => {
    const seeds = seedPendingChoices(
      "draft-1",
      "code",
      { model: gpt, variant: { value: "low", model: gpt } },
      { "draft-1": gpt },
      { [variantKey(gpt, "code", "draft-1")]: "high" },
    )
    expect(seeds.overrides["draft-1"]).toEqual(gpt)
    expect(seeds.variants[variantKey(gpt, "code", "draft-1")]).toBe("low")
  })

  it("a null pending leaves the maps unchanged", () => {
    const overrides = { "draft-1": gpt }
    const variants = { [variantKey(gpt, "code", "draft-1")]: "high" }
    const seeds = seedPendingChoices("draft-1", "code", { model: null, variant: null }, overrides, variants)
    expect(seeds.overrides).toBe(overrides)
    expect(seeds.variants).toBe(variants)
  })
})
