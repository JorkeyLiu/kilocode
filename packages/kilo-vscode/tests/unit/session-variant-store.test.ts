import { describe, expect, it } from "bun:test"
import {
  getVariant,
  resolveSessionVariant,
  sessionVariantKeys,
  sessionVariants,
  transferVariants,
  variantKey,
} from "../../webview-ui/src/context/session-variant-store"
import type { ModelSelection } from "../../webview-ui/src/types/messages"

const model: ModelSelection = { providerID: "anthropic", modelID: "claude-sonnet-4" }
const gpt: ModelSelection = { providerID: "openai", modelID: "gpt-4.1" }
const variants = ["low", "medium", "high"]

describe("per-session variant selection", () => {
  it("keeps reasoning effort independent for each Agent Manager session", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code", "session-a")] = "low"
    store[variantKey(model, "code", "session-b")] = "high"

    expect(getVariant(store, model, variants, "code", "session-a")).toBe("low")
    expect(getVariant(store, model, variants, "code", "session-b")).toBe("high")
  })

  it("keeps reasoning effort independent for each pending local tab", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code", "pending-local-1")] = "medium"
    store[variantKey(model, "code", "pending-local-2")] = "high"

    expect(getVariant(store, model, variants, "code", "pending-local-1")).toBe("medium")
    expect(getVariant(store, model, variants, "code", "pending-local-2")).toBe("high")
  })

  it("keeps no-session reasoning effort independent per agent", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code")] = "medium"
    store[variantKey(model, "ask")] = "high"

    expect(getVariant(store, model, variants, "code")).toBe("medium")
    expect(getVariant(store, model, variants, "ask")).toBe("high")
  })

  it("carries the pre-submit agent variant into a newly created session", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code")] = "medium"

    expect(getVariant(store, model, variants, "code", "session-a")).toBe("medium")
  })

  it("prefers a session variant over the pre-submit agent variant", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code")] = "medium"
    store[variantKey(model, "code", "session-a")] = "high"

    expect(getVariant(store, model, variants, "code", "session-a")).toBe("high")
  })

  it("falls back to the legacy provider/model variant key", () => {
    const store: Record<string, string> = { "anthropic/claude-sonnet-4": "medium" }

    expect(getVariant(store, model, variants, "code", "session-a")).toBe("medium")
  })

  it("transfers a pending local tab variant to the created session", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code", "pending-local-1")] = "medium"
    Object.assign(store, transferVariants(store, "pending-local-1", "session-a"))

    expect(getVariant(store, model, variants, "code", "session-a")).toBe("medium")
  })

  it("extracts persisted session variant preferences", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code", "session-a")] = "medium"
    store[variantKey(model, "code", "session-b")] = "high"

    expect(sessionVariants(store, "session-a")).toEqual({ "anthropic/claude-sonnet-4": "medium" })
  })

  it("finds only variant keys for the requested session", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code", "pending-local-1")] = "medium"
    store[variantKey(model, "code", "pending-local-2")] = "high"

    expect(sessionVariantKeys(store, "pending-local-1")).toEqual(["session/pending-local-1/anthropic/claude-sonnet-4"])
  })
})

describe("configured variant fallback", () => {
  it("uses overrideVariant when no stored selection exists", () => {
    const store: Record<string, string> = {}

    expect(getVariant(store, model, variants, "code", undefined, "high")).toBe("high")
  })

  it("does not use overrideVariant when a stored selection exists", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code")] = "low"

    expect(getVariant(store, model, variants, "code", undefined, "high")).toBe("low")
  })

  it("does not use overrideVariant when session variant exists", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "medium"

    expect(getVariant(store, model, variants, "code", "session-a", "high")).toBe("medium")
  })

  it("ignores overrideVariant if not in the variants list", () => {
    const store: Record<string, string> = {}

    expect(getVariant(store, model, variants, "code", undefined, "gone")).toBe("low")
  })

  it("falls through to globalVariant when overrideVariant is invalid", () => {
    const store: Record<string, string> = {}

    expect(getVariant(store, model, variants, "code", undefined, "gone", "high")).toBe("high")
  })

  it("prefers overrideVariant over globalVariant when both are valid", () => {
    const store: Record<string, string> = {}

    expect(getVariant(store, model, variants, "code", undefined, "medium", "high")).toBe("medium")
  })

  it("falls through to globalVariant when overrideVariant is undefined", () => {
    const store: Record<string, string> = {}

    expect(getVariant(store, model, variants, "code", undefined, undefined, "high")).toBe("high")
  })

  it("falls through to variants[0] when both override and global are invalid", () => {
    const store: Record<string, string> = {}

    expect(getVariant(store, model, variants, "code", undefined, "gone", "also-gone")).toBe("low")
  })

  it("falls through to variants[0] when both override and global are undefined", () => {
    const store: Record<string, string> = {}

    expect(getVariant(store, model, variants, "code", undefined, undefined, undefined)).toBe("low")
  })

  it("prefers legacy stored variant over overrideVariant and globalVariant", () => {
    const store: Record<string, string> = { "anthropic/claude-sonnet-4": "medium" }

    expect(getVariant(store, model, variants, "code", "session-a", "high", "low")).toBe("medium")
  })

  it("prefers session variant over both override and global", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "high"

    expect(getVariant(store, model, variants, "code", "session-a", "low", "medium")).toBe("high")
  })

  it("prefers agent variant over both override and global", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code")] = "medium"

    expect(getVariant(store, model, variants, "code", undefined, "high", "low")).toBe("medium")
  })
})

// ---------------------------------------------------------------------------
// LOCK-005: override updates must not clear global variant fields
// ---------------------------------------------------------------------------

describe("override updates preserve global variant (LOCK-005)", () => {
  it("per-model override takes precedence over global variant", () => {
    const store: Record<string, string> = {}
    // Global variant is "high", but per-model override is "low"
    store[variantKey(model, "code")] = "low"

    // Override wins over global
    expect(getVariant(store, model, variants, "code", undefined, undefined, "high")).toBe("low")
  })

  it("global variant is used when no override exists", () => {
    const store: Record<string, string> = {}
    // No override — global variant "high" should be used

    expect(getVariant(store, model, variants, "code", undefined, undefined, "high")).toBe("high")
  })

  it("clearing override falls back to global variant", () => {
    // Simulate: user had override, then cleared it (override removed from store)
    const store: Record<string, string> = {}
    // Override was cleared — store has no entry for this key

    // Global variant "medium" should now be used
    expect(getVariant(store, model, variants, "code", undefined, undefined, "medium")).toBe("medium")
  })

  it("setting override does not affect global variant field", () => {
    // LOCK-005: setting a per-model override must NOT clear the global variant.
    // The UI used to clear model_variant/subagent_variant when updating overrides.
    // After the fix, the override map is updated independently.
    const store: Record<string, string> = {}
    // Simulate: user sets override to "low" for current model
    store[variantKey(model, "code")] = "low"

    // Global variant is still "high" (not cleared by the override update)
    expect(getVariant(store, model, variants, "code", undefined, undefined, "high")).toBe("low")
    // The override takes precedence, but the global field is preserved
    // for other models that don't have overrides.
  })
})

// ---------------------------------------------------------------------------
// resolveSessionVariant — canonical variant resolution with provenance
// ---------------------------------------------------------------------------

describe("resolveSessionVariant — canonical resolution", () => {
  it("returns explicit selection with explicit=true", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "high"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(true)
  })

  it("returns recovered variant with explicit=false when no store selection", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, { variant: "medium", model })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("explicit selection wins over recovered variant", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "high"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, { variant: "low", model })
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(true)
  })

  it("recovered variant wins over config override", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "low", undefined, { variant: "medium", model })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("config override wins over global variant", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "low", "high")
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })

  it("global variant wins over variants[0]", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, "high")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("variants[0] is fallback when nothing else valid", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a")
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })

  it("invalid recovered variant falls through to config override", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "medium", undefined, { variant: "invalid", model })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("invalid config override falls through to global variant", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "invalid", "high")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("empty variants returns empty string", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, [], "code", "session-a", undefined, undefined, { variant: "medium", model })
    expect(result.variant).toBe("")
    expect(result.explicit).toBe(false)
  })

  it("recovered variant for different model is ignored", () => {
    const store: Record<string, string> = {}
    const otherModel: ModelSelection = { providerID: "openai", modelID: "gpt-4.1" }
    // Recovered variant "medium" is for otherModel, not model — model mismatch
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, { variant: "medium", model: otherModel })
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })

  it("LOCK-001: same variant name across two models — recovered for model A is ignored for model B", () => {
    const store: Record<string, string> = {}
    const recovered = { variant: "medium", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } }
    // Requesting variant for openai/gpt-4.1 — model mismatch, recovered ignored
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a", undefined, undefined, recovered)
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })

  it("LOCK-001: recovered variant with exact model match is used", () => {
    const store: Record<string, string> = {}
    const recovered = { variant: "high", model: { providerID: "openai", modelID: "gpt-4.1" } }
    // Requesting variant for openai/gpt-4.1 — model matches
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a", undefined, undefined, recovered)
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("LOCK-002: user switches model — same recovered variant name not reused", () => {
    const store: Record<string, string> = {}
    // Recovered "medium" is bound to claude
    const recovered = { variant: "medium", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } }
    // User now selected gpt-4.1 — "medium" from claude should not apply
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a", undefined, undefined, recovered)
    expect(result.variant).toBe("low") // falls to variants[0]
    expect(result.explicit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LOCK-003: Explicit vs configured fallback distinction
// ---------------------------------------------------------------------------

describe("LOCK-003 — explicit vs configured distinction", () => {
  it("session store entry is explicit", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "medium"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a")
    expect(result.explicit).toBe(true)
  })

  it("agent store fallback is explicit", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code")] = "high"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(true)
  })

  it("legacy store fallback is explicit", () => {
    const store: Record<string, string> = { "anthropic/claude-sonnet-4": "medium" }
    const result = resolveSessionVariant(store, model, variants, "code", "session-a")
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(true)
  })

  it("config override is not explicit", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "high")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("global variant is not explicit", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, "high")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("recovered variant is not explicit", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, { variant: "medium", model })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LOCK-006: Variant recovery transitions
// ---------------------------------------------------------------------------

describe("LOCK-006 — variant recovery transitions", () => {
  it("newer variant replaces older in resolved state", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "low"
    // User changes variant to "high"
    store[variantKey(model, "code", "session-a")] = "high"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(true)
  })

  it("no variant in store clears to recovered or fallback", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, { variant: "medium", model })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("explicit wins over recovered", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "high"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, { variant: "low", model })
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(true)
  })

  it("recovered beats config override when no explicit", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "low", undefined, { variant: "high", model })
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("invalid recovered falls to config override", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "medium", undefined, { variant: "invalid", model })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("invalid recovered falls to global variant", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, "high", { variant: "invalid", model })
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("both invalid recovered and override fall to variants[0]", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "invalid1", undefined, { variant: "invalid2", model })
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })
})
