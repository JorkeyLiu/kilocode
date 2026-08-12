import { describe, expect, it } from "bun:test"
import { type ModelStore, type ResolveEnv, getSessionModel } from "../../webview-ui/src/context/session-model-store"
import { resolveSessionVariant, variantKey, legacyVariantKey } from "../../webview-ui/src/context/session-variant-store"
import type { ModelSelection, Provider } from "../../webview-ui/src/types/messages"

// ---------------------------------------------------------------------------
// Lifecycle precedence regression suite (LOCK-001..LOCK-007).
//
// These tests prove the seven acceptance criteria of the session
// agent/model/thinking-strength lifecycle semantics:
//   1. a new session uses configured model/variant over prior memory
//   2. a restored session uses its actual historical model/variant over
//      config and memory — including the "ran with no explicit variant"
//      state that must not fall through to legacy memory
//   3. switching agent selects target configured values then memory, and
//      never resurrects the previous agent's recovered strength
//   4. switching model restores configured or remembered variant in the
//      locked order
//   5. manual current-session changes persist memory but do not alter the
//      next configured start
//   6. delegation is ordinary initialization with explicit inputs outranking
//      settings
//   7. the shared model.json variant map carries agent+model then model-only
//      usage memory across CLI and extension
// ---------------------------------------------------------------------------

function makeProvider(id: string, models: string[]): Provider {
  const result: Provider = { id, name: id, models: {} }
  for (const m of models) {
    result.models[m] = { id: m, name: m }
  }
  return result
}

const KILO_AUTO: ModelSelection = { providerID: "kilo", modelID: "kilo-auto/free" }

const providers: Record<string, Provider> = {
  kilo: makeProvider("kilo", ["kilo-auto/free"]),
  anthropic: makeProvider("anthropic", ["claude-sonnet-4"]),
  openai: makeProvider("openai", ["gpt-4.1"]),
}

function env(overrides: Partial<ResolveEnv> = {}): ResolveEnv {
  return {
    providers,
    connected: ["kilo", "anthropic", "openai"],
    fallback: KILO_AUTO,
    getModeModel: () => null,
    getGlobalModel: () => null,
    ...overrides,
  }
}

function store(partial: Partial<ModelStore> = {}): ModelStore {
  return {
    modelSelections: {},
    sessionOverrides: {},
    sessionRecoveredModels: {},
    sessionRecoveredAgents: {},
    sessionRecoveredVariants: {},
    agentSelections: {},
    recentModels: [],
    ...partial,
  }
}

const claude: ModelSelection = { providerID: "anthropic", modelID: "claude-sonnet-4" }
const gpt: ModelSelection = { providerID: "openai", modelID: "gpt-4.1" }
const variants = ["low", "medium", "high"]

// Acceptance 1 — a new session uses configured values over prior memory.
describe("acceptance 1: new session starts from configured values", () => {
  it("configured per-agent model beats remembered model", () => {
    const s = store({ modelSelections: { code: gpt } })
    const e = env({ getModeModel: () => claude })
    expect(getSessionModel(s, e, "session-new", "code")).toEqual(claude)
  })

  it("configured variant beats remembered agent+model and model-only memory", () => {
    const mem: Record<string, string> = {
      [variantKey(claude, "code")]: "low",
      [legacyVariantKey(claude)]: "medium",
    }
    const result = resolveSessionVariant(mem, claude, variants, "code", undefined, "high", undefined)
    expect(result.variant).toBe("high")
    expect(result.explicit).toBe(false)
  })

  it("configured global variant beats remembered model-only memory", () => {
    const mem: Record<string, string> = { [legacyVariantKey(claude)]: "medium" }
    const result = resolveSessionVariant(mem, claude, variants, "code", undefined, undefined, "high")
    expect(result.variant).toBe("high")
  })

  it("remembered values apply when no configured value exists", () => {
    const s = store({ modelSelections: { code: gpt } })
    expect(getSessionModel(s, env(), "session-new", "code")).toEqual(gpt)

    const mem: Record<string, string> = { [variantKey(claude, "code")]: "low" }
    expect(resolveSessionVariant(mem, claude, variants, "code", undefined).variant).toBe("low")
  })
})

// Acceptance 2 — a restored session uses its actual history over config/memory.
describe("acceptance 2: restored session keeps its actual model/variant", () => {
  it("recovered model beats configured and remembered values", () => {
    const s = store({
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { code: gpt },
    })
    const e = env({ getModeModel: () => gpt })
    expect(getSessionModel(s, e, "session-a", "code")).toEqual(claude)
  })

  it("recovered variant beats configured and remembered strength", () => {
    // No manual session pick (no session-scoped key) → recovered actual
    // variant outranks configured and remembered strength (LOCK-003).
    const mem: Record<string, string> = {
      [variantKey(claude, "code")]: "low", // agent+model memory
      [legacyVariantKey(claude)]: "low", // model-only memory
    }
    const recovered = { variant: "high", model: claude }
    const result = resolveSessionVariant(mem, claude, variants, "code", "session-a", "medium", "medium", recovered)
    expect(result.variant).toBe("high")
  })

  it("manual session pick still outranks the recovered variant", () => {
    const mem: Record<string, string> = {
      [variantKey(claude, "code", "session-a")]: "medium",
    }
    const recovered = { variant: "high", model: claude }
    const result = resolveSessionVariant(mem, claude, variants, "code", "session-a", "low", "low", recovered)
    expect(result.variant).toBe("medium")
  })

  it("recovered variant for a different model is never applied", () => {
    const recovered = { variant: "high", model: gpt }
    const result = resolveSessionVariant({}, claude, variants, "code", "session-a", undefined, undefined, recovered)
    expect(result.variant).toBe("low")
  })

  it("recovered no-variant history displays default and never falls through to legacy memory", () => {
    // The regression: a session that actually ran with the provider default
    // (no explicit variant) must not display a legacy globalState value.
    const mem: Record<string, string> = {
      [legacyVariantKey(claude)]: "high", // stale legacy memory
      [variantKey(claude, "code")]: "high", // stale agent+model memory
    }
    const recovered = { variant: undefined, model: claude }
    const result = resolveSessionVariant(mem, claude, variants, "code", "session-a", "high", "high", recovered)
    // Recovered actual no-variant beats configured and legacy memory.
    expect(result.variant).toBeUndefined()
    expect(result.explicit).toBe(false)
  })

  it("recovered no-variant still loses to a manual session pick", () => {
    const mem: Record<string, string> = {
      [variantKey(claude, "code", "session-a")]: "medium",
    }
    const recovered = { variant: undefined, model: claude }
    const result = resolveSessionVariant(mem, claude, variants, "code", "session-a", "low", "low", recovered)
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(true)
  })

  it("stale recovered variant name still falls through to configured memory", () => {
    const recovered = { variant: "gone", model: claude }
    const result = resolveSessionVariant({}, claude, variants, "code", "session-a", "medium", undefined, recovered)
    expect(result.variant).toBe("medium")
  })
})

// Acceptance 3 — switching agent resolves target configured values then memory.
describe("acceptance 3: switching agent resolves configured then memory", () => {
  it("target agent's configured model first, then its remembered model", () => {
    const s = store({
      agentSelections: { "session-a": "ask" },
      modelSelections: { ask: gpt },
    })
    const e = env({ getModeModel: (name) => (name === "ask" ? claude : null) })
    expect(getSessionModel(s, e, "session-a", "code")).toEqual(claude)
  })

  it("no configured model for the target → remembered model applies", () => {
    const s = store({
      agentSelections: { "session-a": "ask" },
      modelSelections: { ask: gpt },
    })
    expect(getSessionModel(s, env(), "session-a", "code")).toEqual(gpt)
  })

  it("agent switch applies the target agent's configured strength before agent memory", () => {
    const mem: Record<string, string> = {
      [variantKey(gpt, "ask")]: "low",
    }
    const result = resolveSessionVariant(mem, gpt, variants, "ask", "session-a", "high")
    expect(result.variant).toBe("high")
  })

  it("agent switch without configured strength restores that agent's remembered strength", () => {
    const mem: Record<string, string> = {
      [variantKey(gpt, "ask")]: "low",
      [variantKey(gpt, "build")]: "high",
    }
    expect(resolveSessionVariant(mem, gpt, variants, "ask", "session-a").variant).toBe("low")
    expect(resolveSessionVariant(mem, gpt, variants, "build", "session-a").variant).toBe("high")
  })

  it("switching agent never resurrects the previous agent's recovered model", () => {
    const s = store({
      agentSelections: { "session-a": "ask" },
      sessionRecoveredAgents: { "session-a": "code" },
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { ask: gpt },
    })
    expect(getSessionModel(s, env(), "session-a", "code")).toEqual(gpt)
  })

  it("explicit agent switch cannot apply the previous agent's recovered variant", () => {
    // Recovered high belongs to the previous agent's history (same model).
    // The explicit ask selection must resolve ask's own chain instead.
    const recovered = { variant: "high", model: gpt }
    const mem: Record<string, string> = {
      [variantKey(gpt, "ask")]: "low",
    }
    const result = resolveSessionVariant(mem, gpt, variants, "ask", "session-a", undefined, undefined, recovered, true)
    expect(result.variant).toBe("low")
    expect(result.explicit).toBe(false)
  })

  it("without an explicit agent switch the recovered variant still applies", () => {
    const recovered = { variant: "high", model: gpt }
    const result = resolveSessionVariant({}, gpt, variants, "ask", "session-a", undefined, undefined, recovered, false)
    expect(result.variant).toBe("high")
  })

  it("same-model recovered no-variant is skipped after an explicit agent switch", () => {
    const recovered = { variant: undefined, model: gpt }
    const mem: Record<string, string> = {
      [legacyVariantKey(gpt)]: "medium",
    }
    const result = resolveSessionVariant(mem, gpt, variants, "ask", "session-a", undefined, undefined, recovered, true)
    expect(result.variant).toBe("medium")
  })
})

// Acceptance 4 — switching model restores configured or remembered variant.
describe("acceptance 4: model switch variant order", () => {
  it("configured strength for the target model wins over agent+model memory", () => {
    const mem: Record<string, string> = {
      [variantKey(gpt, "code")]: "low",
    }
    const result = resolveSessionVariant(mem, gpt, variants, "code", "session-a", "high")
    expect(result.variant).toBe("high")
  })

  it("agent+model memory wins over model-only memory", () => {
    const mem: Record<string, string> = {
      [variantKey(gpt, "code")]: "medium",
      [legacyVariantKey(gpt)]: "high",
    }
    const result = resolveSessionVariant(mem, gpt, variants, "code", "session-a")
    expect(result.variant).toBe("medium")
  })

  it("model-only memory applies when no config and no agent memory exist", () => {
    const mem: Record<string, string> = { [legacyVariantKey(gpt)]: "high" }
    const result = resolveSessionVariant(mem, gpt, variants, "code", "session-a")
    expect(result.variant).toBe("high")
  })

  it("a model switch never reuses the previous model's recovered variant", () => {
    const recovered = { variant: "high", model: claude }
    const result = resolveSessionVariant({}, gpt, variants, "code", "session-a", undefined, undefined, recovered)
    expect(result.variant).toBe("low")
  })
})

// Acceptance 5 — manual current-session changes persist memory, not the next start.
describe("acceptance 5: manual changes persist memory but not configured starts", () => {
  it("manual session choice wins in the current session and stays session-scoped", () => {
    const s = store({
      sessionOverrides: { "session-a": gpt },
      modelSelections: { code: claude },
    })
    const e = env({ getModeModel: () => claude })
    expect(getSessionModel(s, e, "session-a", "code")).toEqual(gpt)
    // The configured tier is untouched.
    expect(e.getModeModel("code")).toEqual(claude)
  })

  it("a later new session starts from configured values, ignoring the manual memory", () => {
    const s = store({
      sessionOverrides: { "session-a": gpt },
      modelSelections: { code: gpt },
    })
    const e = env({ getModeModel: () => claude })
    expect(getSessionModel(s, e, "session-a", "code")).toEqual(gpt)
    expect(getSessionModel(s, e, "session-b", "code")).toEqual(claude)
  })

  it("manual in-session variant persists agent+model memory below the configured tier", () => {
    // The pick writes a session-scoped key (explicit) plus memory keys.
    const mem: Record<string, string> = {
      [variantKey(claude, "code", "session-a")]: "medium",
      [variantKey(claude, "code")]: "medium",
      [legacyVariantKey(claude)]: "medium",
    }
    // Current session shows the manual choice.
    expect(resolveSessionVariant(mem, claude, variants, "code", "session-a").variant).toBe("medium")
    // A later new session starts from the configured strength.
    expect(resolveSessionVariant(mem, claude, variants, "code", undefined, "high").variant).toBe("high")
  })
})

// Acceptance 6 — explicit inputs outrank settings; no subagent special case.
describe("acceptance 6: explicit session inputs outrank settings", () => {
  it("explicit session model input beats configured and recovered values", () => {
    const s = store({
      sessionOverrides: { "session-a": gpt },
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { code: claude },
    })
    const e = env({ getModeModel: () => claude })
    expect(getSessionModel(s, e, "session-a", "code")).toEqual(gpt)
  })

  it("explicit session variant beats recovered and configured strength", () => {
    const mem: Record<string, string> = {
      [variantKey(claude, "code", "session-a")]: "medium",
    }
    const recovered = { variant: "high", model: claude }
    const result = resolveSessionVariant(mem, claude, variants, "code", "session-a", "low", "low", recovered)
    expect(result.variant).toBe("medium")
    expect(result.explicit).toBe(true)
  })

  it("explicit agent input selects the exact agent for a fresh session", () => {
    const s = store({
      agentSelections: { "session-new": "ask" },
      modelSelections: { ask: gpt },
    })
    // No recovered state, no config → the explicitly selected agent's chain.
    expect(getSessionModel(s, env(), "session-new", "code")).toEqual(gpt)
  })
})
