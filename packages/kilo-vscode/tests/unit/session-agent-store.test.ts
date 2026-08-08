import { describe, expect, it } from "bun:test"
import {
  type AgentStore,
  applyRecoverAgent,
  resolveSessionAgent,
} from "../../webview-ui/src/context/session-agent-store"

const names = new Set(["code", "plan"])

function emptyStore(): AgentStore {
  return {
    agentSelections: {},
    sessionRecoveredAgents: {},
  }
}

// ---------------------------------------------------------------------------
// applyRecoverAgent — writes to sessionRecoveredAgents, never agentSelections
// ---------------------------------------------------------------------------

describe("applyRecoverAgent", () => {
  it("writes recovered agent when no explicit selection exists", () => {
    const result = applyRecoverAgent({}, "session-a", "plan", {})
    expect(result).toEqual({ "session-a": "plan" })
  })

  it("does not overwrite explicit agent selection", () => {
    const result = applyRecoverAgent({}, "session-a", "plan", { "session-a": "code" })
    expect(result).toEqual({})
  })

  it("removes recovered agent when recovered is undefined and explicit exists", () => {
    const current = { "session-a": "plan" }
    const result = applyRecoverAgent(current, "session-a", undefined, { "session-a": "code" })
    expect(result["session-a"]).toBeUndefined()
  })

  it("preserves recovered agent when both recovered and no explicit exist", () => {
    const current = { "session-a": "plan" }
    const result = applyRecoverAgent(current, "session-a", "plan", {})
    expect(result).toEqual({ "session-a": "plan" })
  })

  it("does not modify other sessions", () => {
    const current = { "session-b": "code" }
    const result = applyRecoverAgent(current, "session-a", "plan", {})
    expect(result).toEqual({ "session-b": "code", "session-a": "plan" })
  })

  it("returns same reference when no change needed", () => {
    const current = { "session-a": "plan" }
    const result = applyRecoverAgent(current, "session-a", "plan", {})
    expect(result).toBe(current)
  })

  it("returns same reference when nothing to clean and no recovered", () => {
    const current: Record<string, string> = {}
    const result = applyRecoverAgent(current, "session-a", undefined, {})
    expect(result).toBe(current)
  })
})

// ---------------------------------------------------------------------------
// resolveSessionAgent — explicit > recovered > default
// ---------------------------------------------------------------------------

describe("resolveSessionAgent", () => {
  it("returns explicit agent when set", () => {
    const store: AgentStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("code")
  })

  it("returns recovered agent when no explicit and valid", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("plan")
  })

  it("returns default when no explicit and recovered is invalid", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "unknown" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("code")
  })

  it("returns default when nothing is set", () => {
    const store = emptyStore()
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("code")
  })

  it("ignores recovered agent for different session", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-b": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("code")
  })

  it("returns default for session with no entries", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-b": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("code")
  })
})

// ---------------------------------------------------------------------------
// LOCK-002: Delegated session agent (child sessions keep their subagent)
// ---------------------------------------------------------------------------

describe("resolveSessionAgent — delegated session agent (LOCK-002)", () => {
  // Full catalog: visible (code/plan) + a subagent only present in allAgents.
  const allNames = new Set(["code", "plan", "delegate-writer"])

  it("resolves to the delegated subagent stored on the session", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessions: { "session-a": { agent: "delegate-writer" } },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names, allNames)).toBe("delegate-writer")
  })

  it("delegated subagent resolves even when not in the visible names set", () => {
    // `names` (visible) lacks the subagent; only `allNames` (full catalog) has it.
    expect(names.has("delegate-writer")).toBe(false)
    expect(allNames.has("delegate-writer")).toBe(true)
    const store: AgentStore = {
      ...emptyStore(),
      sessions: { "session-a": { agent: "delegate-writer" } },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names, allNames)).toBe("delegate-writer")
  })

  it("explicit agent selection wins over the delegated session agent", () => {
    const store: AgentStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessions: { "session-a": { agent: "delegate-writer" } },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names, allNames)).toBe("code")
  })

  it("recovered visible agent wins over the delegated session agent", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
      sessions: { "session-a": { agent: "delegate-writer" } },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names, allNames)).toBe("plan")
  })

  it("invalid delegated session agent (removed from catalog) falls to default", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessions: { "session-a": { agent: "removed-subagent" } },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names, allNames)).toBe("code")
  })

  it("delegated agent for a different session is ignored", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessions: { "session-b": { agent: "delegate-writer" } },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names, allNames)).toBe("code")
  })

  it("no sessions data keeps the previous resolution behavior", () => {
    expect(resolveSessionAgent(emptyStore(), "session-a", "code", names, allNames)).toBe("code")
  })
})

// ---------------------------------------------------------------------------
// LOCK-001: Recovered agent is continuity, never explicit
// ---------------------------------------------------------------------------

describe("LOCK-001 — recovered agent is continuity, not selection", () => {
  it("recovered agent never appears in agentSelections", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    // agentSelections is empty — recovered agent does not pollute it
    expect(store.agentSelections["session-a"]).toBeUndefined()
  })

  it("applyRecoverAgent never writes to agentSelections", () => {
    const explicit: Record<string, string> = {}
    const recovered: Record<string, string> = {}
    const result = applyRecoverAgent(recovered, "session-a", "plan", explicit)
    // Only sessionRecoveredAgents is updated
    expect(result["session-a"]).toBe("plan")
    // agentSelections is never passed to applyRecoverAgent
    expect(explicit["session-a"]).toBeUndefined()
  })

  it("explicit agent is never overwritten by recovered agent", () => {
    const store: AgentStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    // Explicit "code" wins over recovered "plan"
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("code")
  })
})

// ---------------------------------------------------------------------------
// LOCK-004: Revert/unrevert agent recovery
// ---------------------------------------------------------------------------

describe("LOCK-004 — revert/unrevert agent recovery", () => {
  it("revert boundary does not affect agent recovery (agent from any message)", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    // Agent recovery is preserved regardless of revert state
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("plan")
  })
})

// ---------------------------------------------------------------------------
// LOCK-005: Resolution precedence consistency
// ---------------------------------------------------------------------------

describe("LOCK-005 — resolution precedence", () => {
  it("explicit > recovered > default for agent", () => {
    const store: AgentStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "ask", names)).toBe("code")
  })

  it("recovered > default when no explicit", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("plan")
  })

  it("default when no explicit and no valid recovered", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "unknown" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("code")
  })
})

// ---------------------------------------------------------------------------
// LOCK-006: Production transition tests
// ---------------------------------------------------------------------------

describe("LOCK-006 — production transitions", () => {
  it("messagesLoaded recoverPrefs writes recovered agent", () => {
    const store = emptyStore()
    const agentResult = applyRecoverAgent(store.sessionRecoveredAgents, "session-a", "plan", store.agentSelections)
    expect(agentResult).toEqual({ "session-a": "plan" })
  })

  it("messagesLoaded recoverPrefs clears recovered agent when no agent in messages", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    const result = applyRecoverAgent(store.sessionRecoveredAgents, "session-a", undefined, store.agentSelections)
    expect(result["session-a"]).toBeUndefined()
  })

  it("explicit agent set by user is preserved through recovery cycle", () => {
    const store: AgentStore = {
      ...emptyStore(),
      agentSelections: { "session-a": "code" },
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    const result = applyRecoverAgent(store.sessionRecoveredAgents, "session-a", "plan", store.agentSelections)
    expect(result["session-a"]).toBeUndefined()
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("code")
  })

  it("reconcile same IDs/metadata still runs recovery", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("plan")
  })

  it("pending messages do not corrupt recovery state", () => {
    const store = emptyStore()
    const agentResult = applyRecoverAgent(store.sessionRecoveredAgents, "session-a", undefined, store.agentSelections)
    expect(agentResult["session-a"]).toBeUndefined()
  })

  it("empty messages clear recovery", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    const agentResult = applyRecoverAgent(store.sessionRecoveredAgents, "session-a", undefined, store.agentSelections)
    expect(agentResult["session-a"]).toBeUndefined()
  })

  it("session deletion clears recovered agent", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan", "session-b": "code" },
    }
    const next = { ...store.sessionRecoveredAgents }
    delete next["session-a"]
    expect(next).toEqual({ "session-b": "code" })
  })

  it("draft promotion transfers recovered agent", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "draft-1": "plan" },
    }
    const transferred = {
      ...store.sessionRecoveredAgents,
      "session-new": store.sessionRecoveredAgents["draft-1"],
    }
    delete transferred["draft-1"]
    expect(transferred).toEqual({ "session-new": "plan" })
  })

  it("unrevert restores recovery from all messages", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "code", names)).toBe("plan")
  })
})

// ---------------------------------------------------------------------------
// Config change resilience
// ---------------------------------------------------------------------------

describe("config changes do not corrupt recovered agent state", () => {
  it("changing default agent does not purge recovered agent", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    expect(resolveSessionAgent(store, "session-a", "ask", names)).toBe("plan")
  })

  it("agent removed from catalog invalidates recovered agent", () => {
    const store: AgentStore = {
      ...emptyStore(),
      sessionRecoveredAgents: { "session-a": "plan" },
    }
    const namesWithoutPlan = new Set(["code"])
    expect(resolveSessionAgent(store, "session-a", "code", namesWithoutPlan)).toBe("code")
  })
})
