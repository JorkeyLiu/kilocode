import { describe, expect, it } from "bun:test"
import {
  type ModelStore,
  type ResolveEnv,
  applyModel,
  getSessionModel,
  getSelected,
} from "../../webview-ui/src/context/session-model-store"
import type { ModelSelection, Provider } from "../../webview-ui/src/types/messages"

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

function env(): ResolveEnv {
  return {
    providers,
    connected: ["kilo", "anthropic", "openai"],
    fallback: KILO_AUTO,
    getModeModel: () => null,
    getGlobalModel: () => null,
  }
}

function emptyStore(): ModelStore {
  return {
    modelSelections: {},
    sessionOverrides: {},
    sessionRecoveredModels: {},
    sessionRecoveredAgents: {},
    sessionRecoveredVariants: {},
    agentSelections: {},
    recentModels: [],
  }
}

const claude: ModelSelection = { providerID: "anthropic", modelID: "claude-sonnet-4" }
const gpt: ModelSelection = { providerID: "openai", modelID: "gpt-4.1" }
const oldModel: ModelSelection = { providerID: "openai", modelID: "gpt-3.5-turbo" } // not in catalog

describe("per-session model selection", () => {
  it("selecting a model in session A does not write per-mode globally", () => {
    const store = emptyStore()
    const e = env()

    // User picks claude in session A
    const after = applyModel(store, "code", claude, "session-a")
    const updated: ModelStore = { ...store, ...after }

    // Session A should see claude (via session override)
    expect(getSessionModel(updated, e, "session-a", "code")).toEqual(claude)

    // Session B (no override) keeps the default model.
    const sessionB = getSessionModel(updated, e, "session-b", "code")
    expect(sessionB).toEqual(KILO_AUTO)
  })

  it("each session preserves its own model independently", () => {
    let store = emptyStore()
    const e = env()

    // User picks claude in session A
    const a = applyModel(store, "code", claude, "session-a")
    store = { ...store, ...a }

    // User picks gpt in session B
    const b = applyModel(store, "code", gpt, "session-b")
    store = { ...store, ...b }

    // Both sessions should keep their own model
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(claude)
    expect(getSessionModel(store, e, "session-b", "code")).toEqual(gpt)
  })

  it("getSelected returns per-session override when session is active", () => {
    let store = emptyStore()
    const e = env()

    const a = applyModel(store, "code", claude, "session-a")
    store = { ...store, ...a }

    expect(getSelected(store, e, "session-a", "code")).toEqual(claude)
  })

  it("getSelected returns global model when no session is active", () => {
    let store = emptyStore()
    const e = env()

    // Sidebar mode (no session) — writes globally
    const result = applyModel(store, "code", claude, undefined)
    store = { ...store, ...result }

    expect(getSelected(store, e, undefined, "code")).toEqual(claude)
  })

  it("sidebar model selection writes globally and is visible to new sessions without overrides", () => {
    let store = emptyStore()
    const e = env()

    // User picks claude in sidebar (no session)
    const result = applyModel(store, "code", claude, undefined)
    store = { ...store, ...result }

    // A new session without an override should see the global model
    expect(getSessionModel(store, e, "session-new", "code")).toEqual(claude)
  })

  it("setSessionModel (compare mode) only writes per-session override", () => {
    const store = emptyStore()

    // Simulate setSessionModel — writes only to sessionOverrides
    store.sessionOverrides["session-a"] = claude
    store.sessionOverrides["session-b"] = gpt

    const e = env()
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(claude)
    expect(getSessionModel(store, e, "session-b", "code")).toEqual(gpt)
  })

  it("switching sessions preserves model selection after multiple changes", () => {
    let store = emptyStore()
    const e = env()

    // Simulate: user in session A picks claude
    let result = applyModel(store, "code", claude, "session-a")
    store = { ...store, ...result }

    // Switch to session B — picks gpt
    result = applyModel(store, "code", gpt, "session-b")
    store = { ...store, ...result }

    // Switch back to session A — picks gpt this time
    result = applyModel(store, "code", gpt, "session-a")
    store = { ...store, ...result }

    // Switch back to session B — should still have gpt
    expect(getSessionModel(store, e, "session-b", "code")).toEqual(gpt)
    // Session A was updated to gpt
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(gpt)
  })
})

describe("per-mode model memory", () => {
  it("applyModel in a session writes only to sessionOverrides", () => {
    const store = emptyStore()
    const result = applyModel(store, "code", claude, "session-a")

    expect(result.sessionOverrides["session-a"]).toEqual(claude)
    expect(result.modelSelections["code"]).toBeUndefined()
  })

  it("switching modes falls back to default after session override is cleared", () => {
    let store = emptyStore()
    const e = env()

    // User picks claude for "code" mode in session A
    const result = applyModel(store, "code", claude, "session-a")
    store = { ...store, ...result }

    // Simulate mode switch: clear session override (like selectAgent does)
    const cleared = { ...store, sessionOverrides: {} }

    expect(getSelected(cleared, e, "session-a", "code")).toEqual(KILO_AUTO)
  })

  it("different modes remember their own model independently", () => {
    let store = emptyStore()
    const e = env()

    // User picks claude for "code" globally
    let result = applyModel(store, "code", claude, undefined)
    store = { ...store, ...result }

    // User switches to "ask" mode and picks gpt globally
    result = applyModel(store, "ask", gpt, undefined)
    store = { ...store, ...result }

    // Clear session overrides (simulating mode switch)
    const cleared: ModelStore = { ...store, sessionOverrides: {} }

    // Each mode should have its own saved model
    expect(getSelected(cleared, e, undefined, "code")).toEqual(claude)
    expect(getSelected(cleared, e, undefined, "ask")).toEqual(gpt)
  })

  it("per-session override still takes priority over global modelSelections", () => {
    let store = emptyStore()
    const e = env()

    // User picks claude globally for "code"
    let result = applyModel(store, "code", claude, undefined)
    store = { ...store, ...result }

    // Session A overrides with gpt
    result = applyModel(store, "code", gpt, "session-a")
    store = { ...store, ...result }

    // Session A sees gpt (its override), not the global claude
    expect(getSelected(store, e, "session-a", "code")).toEqual(gpt)
    // Global modelSelections stays at the sidebar/default choice.
    expect(store.modelSelections["code"]).toEqual(claude)
  })

  it("applyModel without session only writes to modelSelections, not sessionOverrides", () => {
    const store = emptyStore()
    const result = applyModel(store, "code", claude, undefined)

    expect(result.modelSelections["code"]).toEqual(claude)
    expect(Object.keys(result.sessionOverrides)).toHaveLength(0)
  })

  it("clearing both session override and per-mode selection falls back to config default", () => {
    let store = emptyStore()
    // Simulate mode model set in config (getModeModel returns claude).
    const configured: ResolveEnv = {
      ...env(),
      getModeModel: (name) => (name === "code" ? claude : null),
    }

    // User picked gpt globally for "code"
    let result = applyModel(store, "code", gpt, undefined)
    store = { ...store, ...result }

    // User then overrode the session with claude
    result = applyModel(store, "code", claude, "session-a")
    store = { ...store, ...result }

    // Simulate clearModelOverride: clear both session override and per-mode selection
    const reset: ModelStore = {
      ...store,
      sessionOverrides: {},
      modelSelections: { ...store.modelSelections, code: null },
    }

    // Should fall through to the configured per-mode model (claude from config)
    expect(getSelected(reset, configured, "session-a", "code")).toEqual(claude)
  })

  it("clearing only session override but not per-mode selection leaves persisted pick visible", () => {
    let store = emptyStore()
    const e = env()

    // User picked claude globally for "code"
    const result = applyModel(store, "code", claude, undefined)
    store = { ...store, ...result }

    // User then overrode the session with gpt
    const r2 = applyModel(store, "code", gpt, "session-a")
    store = { ...store, ...r2 }

    // Simulate OLD behaviour: only clear session override, leave modelSelections intact
    const partial: ModelStore = { ...store, sessionOverrides: {} }

    // The persisted per-mode selection (claude) is still returned — this is
    // why the reset appeared to "do nothing" when config also resolved to claude.
    expect(getSelected(partial, e, "session-a", "code")).toEqual(claude)
  })

  it("switching from plan to implementation uses implementation config after clearing stale memory", () => {
    let store = emptyStore()
    const configured: ResolveEnv = {
      ...env(),
      getModeModel: (name) => (name === "code" ? gpt : name === "plan" ? claude : null),
    }

    // Old manual memory says implementation/code should use claude.
    let result = applyModel(store, "code", claude, undefined)
    store = { ...store, ...result }

    // Current plan session is using its own model.
    result = applyModel(store, "plan", claude, "session-a")
    store = { ...store, ...result, agentSelections: { "session-a": "plan" } }

    const switched: ModelStore = {
      ...store,
      agentSelections: { "session-a": "code" },
      sessionOverrides: {},
      modelSelections: { ...store.modelSelections, code: null },
    }

    expect(getSelected(switched, configured, "session-a", "code")).toEqual(gpt)
  })
})

describe("recovered model vs explicit override", () => {
  it("recovered model provides session continuity when valid", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
    }
    const e = env()

    // Recovered claude should be used for continuity
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(claude)
    expect(getSelected(store, e, "session-a", "code")).toEqual(claude)
  })

  it("explicit override wins over recovered model", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": gpt },
      sessionRecoveredModels: { "session-a": claude },
    }
    const e = env()

    // Explicit gpt should win over recovered claude
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(gpt)
    expect(getSelected(store, e, "session-a", "code")).toEqual(gpt)
  })

  it("invalid recovered model falls through to normal resolution", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": oldModel }, // not in catalog
    }
    const e = env()

    // Old model not in catalog → falls through to KILO_AUTO fallback
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(KILO_AUTO)
    expect(getSelected(store, e, "session-a", "code")).toEqual(KILO_AUTO)
  })

  it("invalid explicit override falls through to normal resolution when no recovery", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": oldModel }, // not in catalog
    }
    const e = env()

    // Invalid explicit override with no recovery → falls through to KILO_AUTO fallback
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(KILO_AUTO)
    expect(getSelected(store, e, "session-a", "code")).toEqual(KILO_AUTO)
  })

  it("invalid explicit override falls through to recovered state (BLOCKER 3 / LOCK-003)", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": oldModel }, // not in catalog
      sessionRecoveredModels: { "session-a": claude }, // valid recovery
    }
    const e = env()

    // Invalid explicit → should fall through to valid recovered, NOT skip to normal
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(claude)
    expect(getSelected(store, e, "session-a", "code")).toEqual(claude)
  })

  it("valid explicit override wins over both recovered and normal (LOCK-002)", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": gpt },
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { code: { providerID: "openai", modelID: "gpt-4.1" } },
    }
    const e = env()

    // Valid explicit gpt wins over recovered claude and global
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(gpt)
  })

  it("recovered state never alone triggers override indicator (LOCK-001)", () => {
    // LOCK-001: Recovered message model is continuity state, not explicit override.
    // It must never alone show reset X.
    // This is tested by the hasModelOverride behavior in session.tsx —
    // at the pure-logic level, recovered state does not appear in sessionOverrides.
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
    }
    // sessionOverrides is empty — no explicit override exists
    expect(store.sessionOverrides["session-a"]).toBeUndefined()
    // The pure-logic layer correctly resolves recovered as continuity
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(claude)
  })

  it("during empty catalog, recovered model falls to fallback (LOCK-001: no raw leak)", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
    }
    const emptyProviders: ResolveEnv = {
      providers: {},
      connected: [],
      fallback: KILO_AUTO,
      getModeModel: () => null,
      getGlobalModel: () => null,
    }

    // Empty catalog → validate() returns null → falls through to KILO_AUTO
    expect(getSessionModel(store, emptyProviders, "session-a", "code")).toEqual(KILO_AUTO)
  })

  it("recovered model does not affect sessions without recovery", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
    }
    const e = env()

    // Session B has no recovery → uses normal resolution
    expect(getSessionModel(store, e, "session-b", "code")).toEqual(KILO_AUTO)
    expect(getSelected(store, e, "session-b", "code")).toEqual(KILO_AUTO)
  })

  it("recovered model with global modelSelections uses recovered as override hint", () => {
    const store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: gpt },
      sessionRecoveredModels: { "session-a": claude },
    }
    const e = env()

    // Recovered claude is validated as override → wins over global gpt
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(claude)
  })

  it("invalid recovered falls through to global modelSelections", () => {
    const store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: gpt },
      sessionRecoveredModels: { "session-a": oldModel }, // not in catalog
    }
    const e = env()

    // Invalid recovered → falls through to global gpt
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(gpt)
  })

  it("recovered model with config mode model uses recovered as override hint", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
    }
    const withMode: ResolveEnv = {
      ...env(),
      getModeModel: (name) => (name === "code" ? gpt : null),
    }

    // Recovered claude is validated → wins over mode gpt
    expect(getSessionModel(store, withMode, "session-a", "code")).toEqual(claude)
  })

  it("invalid recovered falls through to config mode model", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": oldModel }, // not in catalog
    }
    const withMode: ResolveEnv = {
      ...env(),
      getModeModel: (name) => (name === "code" ? gpt : null),
    }

    // Invalid recovered → falls through to mode gpt
    expect(getSessionModel(store, withMode, "session-a", "code")).toEqual(gpt)
  })
})

describe("clearModelOverride scoping (LOCK-004)", () => {
  it("session-scoped reset deletes only session override, not global modelSelections", () => {
    let store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: claude },
      sessionOverrides: { "session-a": gpt },
    }
    const e = env()

    // Before reset: session A has explicit gpt override
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(gpt)

    // Simulate session-scoped clearModelOverride: delete only session override
    store = {
      ...store,
      sessionOverrides: {},
    }

    // After reset: session A falls through to global claude
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(claude)
    // Global modelSelections untouched
    expect(store.modelSelections["code"]).toEqual(claude)
  })

  it("session-scoped reset does not clear recovered history", () => {
    let store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": gpt },
      sessionRecoveredModels: { "session-a": claude },
    }
    const e = env()

    // Simulate session-scoped clearModelOverride: delete only session override
    store = {
      ...store,
      sessionOverrides: {},
    }

    // Recovered history preserved — continuity kicks in
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(claude)
  })
})

describe("config change preserves session state (LOCK-005)", () => {
  it("changing config model does not purge explicit session overrides", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": claude },
    }
    // Config model changed from claude to gpt — but explicit override preserved
    const envAfterChange: ResolveEnv = {
      ...env(),
      getGlobalModel: () => gpt,
    }

    // Session A still sees its explicit claude override
    expect(getSessionModel(store, envAfterChange, "session-a", "code")).toEqual(claude)
  })

  it("changing config model does not purge recovered session state", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
    }
    // Config model changed from claude to gpt — but recovered state preserved
    const envAfterChange: ResolveEnv = {
      ...env(),
      getGlobalModel: () => gpt,
    }

    // Session A still sees recovered claude continuity
    expect(getSessionModel(store, envAfterChange, "session-a", "code")).toEqual(claude)
  })

  it("session without override picks up new config model after change", () => {
    const store: ModelStore = {
      ...emptyStore(),
      // No explicit override, no recovery
    }
    const envAfterChange: ResolveEnv = {
      ...env(),
      getGlobalModel: () => gpt,
    }

    // Session without override picks up new config model gpt
    expect(getSessionModel(store, envAfterChange, "session-a", "code")).toEqual(gpt)
  })
})

describe("recovery refresh (LOCK-006)", () => {
  it("recovery always updates to newest user-message model", () => {
    let store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": gpt },
    }
    const e = env()

    // Initial recovery: gpt
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(gpt)

    // Simulate recovery update to newer model (user sent message with claude)
    store = {
      ...store,
      sessionRecoveredModels: { "session-a": claude },
    }

    // Recovery updated to claude
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(claude)
  })

  it("recovery update blocked when explicit override exists", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": gpt },
      sessionRecoveredModels: { "session-a": claude },
    }
    const e = env()

    // Explicit override wins — recovery state is ignored for resolution
    expect(getSessionModel(store, e, "session-a", "code")).toEqual(gpt)
  })
})

describe("draft promotion transfers recovered state (LOCK-007)", () => {
  it("draft-to-session promotion copies recovered state", () => {
    // Simulate draft has recovered state, promotion should transfer it
    const draftStore: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "draft-1": claude },
    }
    const e = env()

    // Draft has recovered claude
    expect(getSessionModel(draftStore, e, "draft-1", "code")).toEqual(claude)

    // After promotion: recovered state transferred to new session
    const promotedStore: ModelStore = {
      ...draftStore,
      sessionRecoveredModels: { "session-new": claude },
    }
    expect(getSessionModel(promotedStore, e, "session-new", "code")).toEqual(claude)
    // Draft entry cleaned up
    expect(promotedStore.sessionRecoveredModels["draft-1"]).toBeUndefined()
  })

  it("draft-to-session promotion copies explicit override", () => {
    const draftStore: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "draft-1": gpt },
    }
    const e = env()

    // After promotion: override transferred
    const promotedStore: ModelStore = {
      ...draftStore,
      sessionOverrides: { "session-new": gpt },
    }
    expect(getSessionModel(promotedStore, e, "session-new", "code")).toEqual(gpt)
    expect(promotedStore.sessionOverrides["draft-1"]).toBeUndefined()
  })
})

describe("empty catalog falls to fallback (LOCK-001: no raw leak)", () => {
  it("explicit override falls to fallback during empty catalog", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": oldModel },
    }
    const emptyProviders: ResolveEnv = {
      providers: {},
      connected: [],
      fallback: KILO_AUTO,
      getModeModel: () => null,
      getGlobalModel: () => null,
    }

    // Empty catalog → validate() returns null → override fails check → normal chain → KILO_AUTO
    expect(getSessionModel(store, emptyProviders, "session-a", "code")).toEqual(KILO_AUTO)
  })

  it("recovered state falls to fallback during empty catalog", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": oldModel },
    }
    const emptyProviders: ResolveEnv = {
      providers: {},
      connected: [],
      fallback: KILO_AUTO,
      getModeModel: () => null,
      getGlobalModel: () => null,
    }

    // Empty catalog → validate() returns null → recovered fails check → normal chain → KILO_AUTO
    expect(getSessionModel(store, emptyProviders, "session-a", "code")).toEqual(KILO_AUTO)
  })

  it("config model falls to fallback during empty catalog", () => {
    const store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: claude },
    }
    const emptyProviders: ResolveEnv = {
      providers: {},
      connected: [],
      fallback: KILO_AUTO,
      getModeModel: () => null,
      getGlobalModel: () => null,
    }

    // Empty catalog → normal chain validate returns null → KILO_AUTO
    expect(getSessionModel(store, emptyProviders, "session-a", "code")).toEqual(KILO_AUTO)
  })

  it("catalog arrival restores validated selection (LOCK-002: reactive)", () => {
    // Start with empty catalog — fallback active
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
    }
    const emptyProviders: ResolveEnv = {
      providers: {},
      connected: [],
      fallback: KILO_AUTO,
      getModeModel: () => null,
      getGlobalModel: () => null,
    }
    expect(getSessionModel(store, emptyProviders, "session-a", "code")).toEqual(KILO_AUTO)

    // Catalog arrives — recovered claude is now validated
    const readyProviders: ResolveEnv = {
      providers,
      connected: ["kilo", "anthropic", "openai"],
      fallback: KILO_AUTO,
      getModeModel: () => null,
      getGlobalModel: () => null,
    }
    expect(getSessionModel(store, readyProviders, "session-a", "code")).toEqual(claude)
  })
})

// ---------------------------------------------------------------------------
// Agent recovery integration — canonical single-resolver precedence
// ---------------------------------------------------------------------------

describe("agent recovery integration (single canonical resolver)", () => {
  it("uses recovered agent for model resolution when no explicit agent", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionRecoveredModels: { "session-a": claude },
    }
    // Recovered agent "plan" + recovered model claude → claude
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(claude)
  })

  it("explicit agent wins over recovered agent for model resolution", () => {
    const store: ModelStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { code: gpt },
    }
    // Explicit agent "code" → uses modelSelections["code"] = gpt
    // (explicit agent skips recovered model)
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("explicit override wins over recovered agent model", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionOverrides: { "session-a": gpt },
      sessionRecoveredModels: { "session-a": claude },
    }
    // Explicit override gpt wins over recovered model claude
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("invalid explicit override falls through to recovered model when no explicit agent", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": oldModel },
      sessionRecoveredModels: { "session-a": claude },
    }
    // Invalid explicit → no explicit agent → recovered claude applies
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(claude)
  })

  it("invalid explicit override falls through to agent normal chain when explicit agent", () => {
    const store: ModelStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionOverrides: { "session-a": oldModel },
      modelSelections: { code: gpt },
    }
    // Invalid explicit → explicit agent "code" → agent normal chain → gpt
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("recovered agent does not affect sessions without recovery", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionRecoveredModels: { "session-a": claude },
    }
    // Session B has no recovery → uses normal resolution
    expect(getSessionModel(store, env(), "session-b", "code")).toEqual(KILO_AUTO)
  })

  it("recovered plan model+variant then explicit code agent — agent normal chain wins", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { code: gpt },
    }
    // After user switches to explicit code agent: agent normal chain wins
    const withExplicit: ModelStore = {
      ...store,
      agentSelections: { "session-a": "code" },
    }
    expect(getSessionModel(withExplicit, env(), "session-a", "code")).toEqual(gpt)
  })
})

// ---------------------------------------------------------------------------
// LOCK-005: explicit agent switch / clear / override / invalid recovered
// ---------------------------------------------------------------------------

describe("canonical production resolution — explicit agent transitions", () => {
  it("LOCK-003: explicit agent B after recovering A resolves B's normal model", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { plan: claude, code: gpt },
    }
    // User explicitly selects code agent → B's normal model (gpt) wins
    const explicit: ModelStore = { ...store, agentSelections: { "session-a": "code" } }
    expect(getSessionModel(explicit, env(), "session-a", "code")).toEqual(gpt)
  })

  it("LOCK-003: clearing explicit agent restores recovered A when still valid", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { plan: claude },
    }
    // No explicit agent → recovered "plan" agent + recovered claude model
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(claude)
  })

  it("explicit model override wins regardless of agent or recovered state", () => {
    const store: ModelStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionRecoveredModels: { "session-a": claude },
      sessionOverrides: { "session-a": gpt },
      modelSelections: { code: claude, plan: claude },
    }
    // Explicit override gpt wins even though agent normal chain would give claude
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("invalid explicit override falls to explicit agent normal chain", () => {
    const oldModel: ModelSelection = { providerID: "openai", modelID: "gpt-3.5-turbo" }
    const store: ModelStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionOverrides: { "session-a": oldModel },
      modelSelections: { code: gpt },
    }
    // Invalid explicit → agent normal chain → gpt
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("invalid recovered falls to agent normal chain when explicit agent set", () => {
    const oldModel: ModelSelection = { providerID: "openai", modelID: "gpt-3.5-turbo" }
    const store: ModelStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionRecoveredModels: { "session-a": oldModel },
      modelSelections: { code: gpt },
    }
    // Invalid recovered → explicit agent → gpt
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("invalid recovered falls to default agent normal chain when no explicit", () => {
    const oldModel: ModelSelection = { providerID: "openai", modelID: "gpt-3.5-turbo" }
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": oldModel },
    }
    // Invalid recovered → default agent "code" normal chain → KILO_AUTO
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(KILO_AUTO)
  })

  it("no recovery, no explicit — uses agent normal chain", () => {
    const store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: gpt },
    }
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("recovered agent invalid but recovered model valid — uses recovered model", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "unknown" },
      sessionRecoveredModels: { "session-a": claude },
    }
    // Recovered agent "unknown" not in names → default "code"
    // But recovered model claude is still valid for "code" agent → claude
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(claude)
  })

  it("recovered agent invalid AND recovered model invalid — falls to default chain", () => {
    const oldModel: ModelSelection = { providerID: "openai", modelID: "gpt-3.5-turbo" }
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "unknown" },
      sessionRecoveredModels: { "session-a": oldModel },
    }
    // Both recovered agent and model invalid → default "code" → KILO_AUTO
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(KILO_AUTO)
  })
})

// ---------------------------------------------------------------------------
// LOCK-005: send-time selected path (getSelected)
// ---------------------------------------------------------------------------

describe("canonical production resolution — getSelected path", () => {
  it("getSelected with session: recovered model valid overrides agent normal chain", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
      sessionRecoveredModels: { "session-a": claude },
      agentSelections: { "session-a": "code" },
      modelSelections: { code: gpt },
    }
    // getSelected receives agentName as param; it checks recovered before normal chain.
    // Recovered claude is valid → claude wins over agent normal chain gpt.
    expect(getSelected(store, env(), "session-a", "code")).toEqual(claude)
  })

  it("getSelected with session: explicit override wins over recovered", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": gpt },
      sessionRecoveredModels: { "session-a": claude },
      agentSelections: { "session-a": "code" },
      modelSelections: { code: claude },
    }
    expect(getSelected(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("getSelected with session: invalid recovered falls to normal chain", () => {
    const oldModel: ModelSelection = { providerID: "openai", modelID: "gpt-3.5-turbo" }
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": oldModel },
      modelSelections: { code: gpt },
    }
    // Invalid recovered → normal chain → gpt
    expect(getSelected(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("getSelected with no session uses agent normal chain", () => {
    const store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: gpt },
    }
    // No session → agent normal chain → gpt
    expect(getSelected(store, env(), undefined, "code")).toEqual(gpt)
  })

  it("getSelected with explicit override wins", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": gpt },
      sessionRecoveredModels: { "session-a": claude },
      agentSelections: { "session-a": "code" },
      modelSelections: { code: claude },
    }
    expect(getSelected(store, env(), "session-a", "code")).toEqual(gpt)
  })
})

// ---------------------------------------------------------------------------
// LOCK-002/003/004/005: lifecycle precedence for configured / recovered /
// remembered / manual state
// ---------------------------------------------------------------------------

describe("LOCK-002 — new session starts from configured model over memory", () => {
  it("configured per-agent model beats remembered model for a fresh session", () => {
    const store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: gpt }, // remembered usage memory
    }
    const configured: ResolveEnv = {
      ...env(),
      getModeModel: (name) => (name === "code" ? claude : null),
    }

    expect(getSessionModel(store, configured, "session-new", "code")).toEqual(claude)
  })

  it("configured global model beats remembered model for a fresh session", () => {
    const store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: gpt }, // remembered usage memory
    }
    const configured: ResolveEnv = {
      ...env(),
      getGlobalModel: () => claude,
    }

    expect(getSessionModel(store, configured, "session-new", "code")).toEqual(claude)
  })

  it("remembered model applies when no configured value exists", () => {
    const store: ModelStore = {
      ...emptyStore(),
      modelSelections: { code: gpt },
    }

    expect(getSessionModel(store, env(), "session-new", "code")).toEqual(gpt)
  })
})

describe("LOCK-003 — restored session keeps its actual model over config and memory", () => {
  it("recovered model beats configured and remembered values", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { code: gpt }, // remembered
    }
    const configured: ResolveEnv = {
      ...env(),
      getModeModel: () => gpt, // configured per-agent model
    }

    expect(getSessionModel(store, configured, "session-a", "code")).toEqual(claude)
  })

  it("recovered model survives per-agent memory and config global", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionRecoveredModels: { "session-a": claude },
      modelSelections: { code: gpt },
    }
    const configured: ResolveEnv = {
      ...env(),
      getGlobalModel: () => gpt,
    }

    expect(getSessionModel(store, configured, "session-a", "code")).toEqual(claude)
  })
})

describe("LOCK-004 — switching agent resolves configured then remembered model", () => {
  it("explicit agent switch uses the target agent's configured model first", () => {
    const store: ModelStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "ask" },
      modelSelections: { ask: gpt }, // remembered for ask
    }
    const configured: ResolveEnv = {
      ...env(),
      getModeModel: (name) => (name === "ask" ? claude : null),
    }

    // Target agent ask has a configured model → it wins over ask's memory.
    expect(getSessionModel(store, configured, "session-a", "code")).toEqual(claude)
  })

  it("explicit agent switch uses the target agent's remembered model when no config", () => {
    const store: ModelStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "ask" },
      modelSelections: { ask: gpt },
    }

    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })

  it("switching agent does not resurrect the old agent's recovered model", () => {
    const store: ModelStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "ask" }, // user switched to ask
      sessionRecoveredAgents: { "session-a": "code" },
      sessionRecoveredModels: { "session-a": claude }, // used under code
      modelSelections: { ask: gpt },
    }

    // Recovered claude belonged to code; the explicit ask resolves ask's chain.
    expect(getSessionModel(store, env(), "session-a", "code")).toEqual(gpt)
  })
})

describe("LOCK-005 — manual session choice persists memory but not the next configured start", () => {
  it("manual in-session choice wins for the current session and stays a session override", () => {
    const store: ModelStore = {
      ...emptyStore(),
      sessionOverrides: { "session-a": gpt },
      modelSelections: { code: claude },
    }
    const configured: ResolveEnv = {
      ...env(),
      getModeModel: () => claude,
    }

    // Current session shows the manual choice.
    expect(getSessionModel(store, configured, "session-a", "code")).toEqual(gpt)
    // The override is session-scoped; nothing rewrote the configured tier.
    expect(configured.getModeModel("code")).toEqual(claude)
  })

  it("a later new session still starts from configured values, ignoring the manual memory", () => {
    let store: ModelStore = emptyStore()
    const configured: ResolveEnv = {
      ...env(),
      getModeModel: (name) => (name === "code" ? claude : null),
    }

    // Manual in-session pick (current session).
    let result = applyModel(store, "code", gpt, "session-a")
    store = { ...store, ...result }
    expect(getSessionModel(store, configured, "session-a", "code")).toEqual(gpt)

    // A later new session (no override, no recovery) starts from config claude.
    expect(getSessionModel(store, configured, "session-b", "code")).toEqual(claude)
  })
})
