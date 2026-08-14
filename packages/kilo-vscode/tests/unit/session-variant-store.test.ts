import { describe, expect, it } from "bun:test"
import {
  getVariant,
  legacyVariantKey,
  mergeLoadedVariants,
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

    expect(sessionVariants(store, "session-a")).toEqual({ "code/anthropic/claude-sonnet-4": "medium" })
  })

  it("finds only variant keys for the requested session", () => {
    const store: Record<string, string> = {}

    store[variantKey(model, "code", "pending-local-1")] = "medium"
    store[variantKey(model, "code", "pending-local-2")] = "high"

    expect(sessionVariantKeys(store, "pending-local-1")).toEqual([
      "session/pending-local-1/code/anthropic/claude-sonnet-4",
    ])
  })
})

describe("configured variant fallback", () => {
  it("uses overrideVariant when no stored selection exists", () => {
    const store: Record<string, string> = {}

    expect(getVariant(store, model, variants, "code", undefined, "high")).toBe("high")
  })

  it("configured overrideVariant beats remembered agent memory (LOCK-002/004)", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code")] = "low"

    expect(getVariant(store, model, variants, "code", undefined, "high")).toBe("high")
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

  it("configured override and global beat remembered legacy memory (LOCK-002)", () => {
    const store: Record<string, string> = { "anthropic/claude-sonnet-4": "medium" }

    expect(getVariant(store, model, variants, "code", "session-a", "high", "low")).toBe("high")
  })

  it("prefers session variant over both override and global", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "high"

    expect(getVariant(store, model, variants, "code", "session-a", "low", "medium")).toBe("high")
  })

  it("configured override and global beat agent memory (LOCK-004)", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code")] = "medium"

    expect(getVariant(store, model, variants, "code", undefined, "high", "low")).toBe("high")
  })
})

// ---------------------------------------------------------------------------
// LOCK-005: override updates must not clear global variant fields
// ---------------------------------------------------------------------------

describe("override updates preserve global variant (LOCK-005)", () => {
  it("global variant takes precedence over remembered per-model memory", () => {
    const store: Record<string, string> = {}
    // Remembered per-model memory is "low", configured global variant "high"
    store[variantKey(model, "code")] = "low"

    // Configured global variant wins over remembered memory (LOCK-002/004)
    expect(getVariant(store, model, variants, "code", undefined, undefined, "high")).toBe("high")
  })

  it("global variant is used when no memory exists", () => {
    const store: Record<string, string> = {}
    // No memory — global variant "high" should be used

    expect(getVariant(store, model, variants, "code", undefined, undefined, "high")).toBe("high")
  })

  it("clearing remembered memory falls back to global variant", () => {
    // Simulate: user had a remembered variant, then it was removed
    const store: Record<string, string> = {}

    // Global variant "medium" should now be used
    expect(getVariant(store, model, variants, "code", undefined, undefined, "medium")).toBe("medium")
  })

  it("setting remembered memory does not affect global variant field", () => {
    // LOCK-005: setting usage memory must NOT clear the global variant config.
    // The memory is stored independently; the global field stays configured.
    const store: Record<string, string> = {}
    // Simulate: user sets remembered "low" for current model
    store[variantKey(model, "code")] = "low"

    // Resolution prefers the configured global variant "high"...
    expect(getVariant(store, model, variants, "code", undefined, undefined, "high")).toBe("high")
    // ...but the remembered memory entry is preserved in the store for
    // agents/models without a configured variant.
    expect(store[variantKey(model, "code")]).toBe("low")
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
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, {
      variant: "medium",
      model,
    })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("explicit selection wins over recovered variant", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "high"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, {
      variant: "low",
      model,
    })
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(true)
  })

  it("recovered variant wins over config override", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "low", undefined, {
      variant: "medium",
      model,
    })
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
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "medium", undefined, {
      variant: "invalid",
      model,
    })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("invalid config override falls through to global variant", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "invalid", "high")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("empty variants returns undefined variant", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, [], "code", "session-a", undefined, undefined, {
      variant: "medium",
      model,
    })
    expect(result.variant).toBeUndefined()
    expect(result.explicit).toBe(false)
  })

  it("recovered variant for different model is ignored", () => {
    const store: Record<string, string> = {}
    const otherModel: ModelSelection = { providerID: "openai", modelID: "gpt-4.1" }
    // Recovered variant "medium" is for otherModel, not model — model mismatch
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, {
      variant: "medium",
      model: otherModel,
    })
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

  it("agent store memory is not explicit", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code")] = "high"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("legacy store memory is not explicit", () => {
    const store: Record<string, string> = { "anthropic/claude-sonnet-4": "medium" }
    const result = resolveSessionVariant(store, model, variants, "code", "session-a")
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
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
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, {
      variant: "medium",
      model,
    })
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
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, {
      variant: "medium",
      model,
    })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("explicit wins over recovered", () => {
    const store: Record<string, string> = {}
    store[variantKey(model, "code", "session-a")] = "high"
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, undefined, {
      variant: "low",
      model,
    })
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(true)
  })

  it("recovered beats config override when no explicit", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "low", undefined, {
      variant: "high",
      model,
    })
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("invalid recovered falls to config override", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "medium", undefined, {
      variant: "invalid",
      model,
    })
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("invalid recovered falls to global variant", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", undefined, "high", {
      variant: "invalid",
      model,
    })
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("both invalid recovered and override fall to variants[0]", () => {
    const store: Record<string, string> = {}
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "invalid1", undefined, {
      variant: "invalid2",
      model,
    })
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })

  it("LOCK-003: recovered no-variant state blocks legacy memory fall-through", () => {
    // The concrete regression: a session that actually ran default must not
    // display a stale legacy globalState "high" value.
    const store: Record<string, string> = {
      "anthropic/claude-sonnet-4": "high", // legacy model-only memory
      [variantKey(model, "code")]: "high", // agent+model memory
    }
    const recovered = { variant: undefined, model }
    const result = resolveSessionVariant(store, model, variants, "code", "session-a", "high", "high", recovered)
    expect(result.variant).toBeUndefined()
    expect(result.explicit).toBe(false)
  })

  it("LOCK-004: explicit agent switch skips the previous agent's recovered variant", () => {
    const store: Record<string, string> = {
      [variantKey(model, "code")]: "medium", // target agent's memory
    }
    const recovered = { variant: "high", model }
    // explicitAgent=true: the recovered high belonged to the previous agent.
    const result = resolveSessionVariant(
      store,
      model,
      variants,
      "code",
      "session-a",
      undefined,
      undefined,
      recovered,
      true,
    )
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("LOCK-004: without an explicit agent the recovered variant still applies", () => {
    const store: Record<string, string> = {
      [variantKey(model, "code")]: "medium",
    }
    const recovered = { variant: "high", model }
    const result = resolveSessionVariant(
      store,
      model,
      variants,
      "code",
      "session-a",
      undefined,
      undefined,
      recovered,
      false,
    )
    expect(result.variant).toBe("high")
  })
})

// ---------------------------------------------------------------------------
// LOCK-002: Per-model variant memory — last-used variant restored on switch
// ---------------------------------------------------------------------------

describe("per-model variant memory (LOCK-002)", () => {
  it("restores the remembered variant of the switched-to model instead of variants[0]", () => {
    // Model A memory "low" and model B memory "high" were picked earlier in
    // different contexts. Resolving B must return B's memory, not variants[0].
    const store: Record<string, string> = {
      "anthropic/claude-sonnet-4": "low",
      "openai/gpt-4.1": "high",
    }
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("does not leak model A's memory into model B", () => {
    const store: Record<string, string> = { "anthropic/claude-sonnet-4": "low" }
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a")
    expect(result.variant).toBe("low") // variants[0]
    expect(result.explicit).toBe(false)
  })

  it("explicit session selection beats per-model memory", () => {
    const store: Record<string, string> = { "openai/gpt-4.1": "high" }
    store[variantKey(gpt, "code", "session-a")] = "low"
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a")
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(true)
  })

  it("explicit agent+model memory beats per-model memory", () => {
    const store: Record<string, string> = { "openai/gpt-4.1": "high" }
    store[variantKey(gpt, "code")] = "medium"
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a")
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("stale memory not in the model's variant list is skipped for config fallback", () => {
    const store: Record<string, string> = { "openai/gpt-4.1": "ultra" }
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a", undefined, "medium")
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("stale memory with no config falls through to variants[0]", () => {
    const store: Record<string, string> = { "openai/gpt-4.1": "ultra" }
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a")
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Agent-scoped tier (LOCK-002): per (agent, model) variant memory
// ---------------------------------------------------------------------------

describe("per-agent variant memory (LOCK-002)", () => {
  it("restores the per-agent remembered variant when switching agents", () => {
    const store: Record<string, string> = {
      "agent/build/openai/gpt-4.1": "low",
      "agent/ask/openai/gpt-4.1": "high",
    }
    expect(resolveSessionVariant(store, gpt, variants, "build")).toEqual({ variant: "low", explicit: false })
    expect(resolveSessionVariant(store, gpt, variants, "ask")).toEqual({ variant: "high", explicit: false })
  })

  it("restores the per-agent remembered variant inside a session context", () => {
    const store: Record<string, string> = {
      "agent/build/openai/gpt-4.1": "low",
      "agent/ask/openai/gpt-4.1": "high",
    }
    expect(resolveSessionVariant(store, gpt, variants, "build", "session-a").variant).toBe("low")
    expect(resolveSessionVariant(store, gpt, variants, "ask", "session-a").variant).toBe("high")
  })

  it("session key still beats agent+model memory", () => {
    const store: Record<string, string> = { "agent/build/openai/gpt-4.1": "low" }
    store[variantKey(gpt, "build", "session-a")] = "high"
    const result = resolveSessionVariant(store, gpt, variants, "build", "session-a")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(true)
  })

  it("LOCK-001: session-scoped picks are keyed per agent — agent B never sees agent A's session pick", () => {
    // Regression: the session key previously had no agent component
    // (`session/{sid}/{provider}/{model}`), so A's in-session pick hit for
    // every agent and shadowed the agent tier. Each agent's session pick
    // must resolve independently.
    const store: Record<string, string> = {}
    store[variantKey(gpt, "build", "session-a")] = "low" // agent A picks low
    store[variantKey(gpt, "ask", "session-a")] = "high" // agent B picks high
    expect(resolveSessionVariant(store, gpt, variants, "ask", "session-a")).toEqual({ variant: "high", explicit: true })
    expect(resolveSessionVariant(store, gpt, variants, "build", "session-a")).toEqual({
      variant: "low",
      explicit: true,
    })
  })

  it("LOCK-001: one agent's session pick does not shadow the other agent's agent+model memory", () => {
    // Regression: with the old agent-less session key, A's session pick was
    // read first for B too, making B's agent+model memory unreachable.
    const store: Record<string, string> = {
      "agent/ask/openai/gpt-4.1": "high", // agent B's remembered agent+model value
    }
    store[variantKey(gpt, "build", "session-a")] = "low" // agent A's session pick
    // B resolves to its own agent+model memory, not A's session pick.
    expect(resolveSessionVariant(store, gpt, variants, "ask", "session-a")).toEqual({
      variant: "high",
      explicit: false,
    })
    // A resolves to its own session pick.
    expect(resolveSessionVariant(store, gpt, variants, "build", "session-a")).toEqual({
      variant: "low",
      explicit: true,
    })
  })

  it("LOCK-001: transferVariants preserves the per-agent dimension of session keys", () => {
    const store: Record<string, string> = { "session/pending-local-1/build/openai/gpt-4.1": "low" }
    const transferred = transferVariants(store, "pending-local-1", "session-a")
    expect(transferred).toEqual({ "session/session-a/build/openai/gpt-4.1": "low" })
    Object.assign(store, transferred)
    expect(resolveSessionVariant(store, gpt, variants, "build", "session-a").variant).toBe("low")
    // The transferred pick stays out of the other agent's resolution path.
    expect(resolveSessionVariant(store, gpt, variants, "ask", "session-a").variant).toBe("low") // variants[0]
  })

  it("agent+model memory beats model-only legacy memory", () => {
    const store: Record<string, string> = {
      "openai/gpt-4.1": "medium",
      "agent/build/openai/gpt-4.1": "high",
    }
    const result = resolveSessionVariant(store, gpt, variants, "build", "session-a")
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("a new agent with no agent memory falls back to the model-only legacy memory", () => {
    const store: Record<string, string> = { "openai/gpt-4.1": "medium" }
    const result = resolveSessionVariant(store, gpt, variants, "fresh-agent", "session-a")
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("stale agent memory not in the model's variant list is skipped for config fallback", () => {
    const store: Record<string, string> = { "agent/build/openai/gpt-4.1": "ultra" }
    const result = resolveSessionVariant(store, gpt, variants, "build", "session-a", undefined, "medium")
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(false)
  })

  it("stale agent memory with no config falls through to variants[0]", () => {
    const store: Record<string, string> = { "agent/build/openai/gpt-4.1": "ultra" }
    const result = resolveSessionVariant(store, gpt, variants, "build", "session-a")
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Recovery-readiness gate (LOCK-006): a restored session whose history has
// not been recovered yet must not resolve remembered strength tiers.
// ---------------------------------------------------------------------------

describe("recovery-readiness gate (LOCK-006)", () => {
  it("not ready: agent+model and model-only memory are skipped", () => {
    const store: Record<string, string> = {
      [variantKey(gpt, "code")]: "medium", // agent+model memory
      [legacyVariantKey(gpt)]: "high", // model-only memory
    }
    const result = resolveSessionVariant(
      store,
      gpt,
      variants,
      "code",
      "session-a",
      undefined,
      undefined,
      undefined,
      false,
      false,
    )
    expect(result.variant).toBe("low") // variants[0] fallback
    expect(result.explicit).toBe(false)
  })

  it("ready: memory tiers resolve normally", () => {
    const store: Record<string, string> = {
      [variantKey(gpt, "code")]: "medium",
      [legacyVariantKey(gpt)]: "high",
    }
    const result = resolveSessionVariant(store, gpt, variants, "code", "session-a")
    expect(result.variant).toBe("medium")
  })

  it("not ready still resolves an explicit session-scoped pick", () => {
    const store: Record<string, string> = {
      [variantKey(gpt, "code", "session-a")]: "medium",
      [legacyVariantKey(gpt)]: "high",
    }
    const result = resolveSessionVariant(
      store,
      gpt,
      variants,
      "code",
      "session-a",
      undefined,
      undefined,
      undefined,
      false,
      false,
    )
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(true)
  })

  it("not ready still resolves configured override and global variants", () => {
    const store: Record<string, string> = {
      [legacyVariantKey(gpt)]: "high",
    }
    const result = resolveSessionVariant(
      store,
      gpt,
      variants,
      "code",
      "session-a",
      "medium",
      "low",
      undefined,
      false,
      false,
    )
    expect(result.variant).toBe("medium")
  })

  it("not ready with no config falls through to variants[0], never to stale memory", () => {
    const store: Record<string, string> = {
      [legacyVariantKey(gpt)]: "high", // the stale legacy value that must not display
    }
    const result = resolveSessionVariant(
      store,
      gpt,
      variants,
      "code",
      "session-a",
      undefined,
      undefined,
      undefined,
      false,
      false,
    )
    expect(result.variant).toBe("low")
  })
})

function legacyKey(sel: ModelSelection) {
  return `${sel.providerID}/${sel.modelID}`
}

// ---------------------------------------------------------------------------
// LOCK-004: variantsLoaded replace semantics — reset clears live memory
// ---------------------------------------------------------------------------

describe("mergeLoadedVariants (LOCK-004)", () => {
  it("an empty payload removes persistent agent/model and legacy memory but keeps session picks", () => {
    const current = {
      [variantKey(gpt, "code")]: "low", // agent+model memory
      [legacyVariantKey(gpt)]: "medium", // model-only legacy memory
      [variantKey(gpt, "code", "session-a")]: "high", // live session pick
    }
    const merged = mergeLoadedVariants(current, {})
    expect(merged[variantKey(gpt, "code")]).toBeUndefined()
    expect(merged[legacyVariantKey(gpt)]).toBeUndefined()
    expect(merged[variantKey(gpt, "code", "session-a")]).toBe("high")
  })

  it("installs the loaded persistent snapshot wholesale", () => {
    const current = { [variantKey(gpt, "code")]: "low" }
    const merged = mergeLoadedVariants(current, { [variantKey(model, "code")]: "high" })
    expect(merged[variantKey(gpt, "code")]).toBeUndefined()
    expect(merged[variantKey(model, "code")]).toBe("high")
  })

  it("empty current and empty payload stays empty", () => {
    expect(mergeLoadedVariants({}, {})).toEqual({})
  })
})
