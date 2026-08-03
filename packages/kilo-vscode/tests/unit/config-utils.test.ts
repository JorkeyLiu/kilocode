import { describe, it, expect } from "bun:test"
import {
  configUnsetPaths,
  ConfigState,
  deepEqual,
  deepMerge,
  mergeScopedConfig,
  newSaveID,
  pruneConfigSet,
  stripNulls,
  subtractSentDraft,
} from "../../webview-ui/src/utils/config-utils"
import type { Config } from "../../webview-ui/src/types/messages"

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("deepMerge", () => {
  it("overrides scalar values", () => {
    const target: Config = { snapshot: true }
    const source: Partial<Config> = { snapshot: false }
    expect(deepMerge(target, source)).toEqual({ snapshot: false })
  })

  it("merges nested objects recursively", () => {
    const target: Config = { agent: { code: { temperature: 0.5 } } }
    const source: Partial<Config> = { agent: { code: { steps: 10 } } }
    const result = deepMerge(target, source)
    expect(result.agent?.code?.temperature).toBe(0.5)
    expect(result.agent?.code?.steps).toBe(10)
  })

  it("preserves keys not present in source", () => {
    const target: Config = { snapshot: true, username: "alice" }
    const source: Partial<Config> = { snapshot: false }
    expect(deepMerge(target, source)).toEqual({ snapshot: false, username: "alice" })
  })

  it("replaces arrays instead of merging them", () => {
    const target: Config = { instructions: ["a", "b"] }
    const source: Partial<Config> = { instructions: ["c"] }
    expect(deepMerge(target, source)).toEqual({ instructions: ["c"] })
  })

  it("preserves explicit false values in nested agent config", () => {
    const target: Config = { agent: { code: { disable: true, hidden: true } } }
    const source: Partial<Config> = { agent: { code: { disable: false, hidden: false } } }
    const result = deepMerge(target, source)
    expect(result.agent?.code?.disable).toBe(false)
    expect(result.agent?.code?.hidden).toBe(false)
  })
})

describe("scoped config normalization", () => {
  it("preserves indexing null overrides while stripping unrelated nulls", () => {
    const target = { username: "alice", indexing: { model: "global", dimension: 1024 } } as Config
    const source = { username: null, indexing: { model: null, dimension: null } } as unknown as Partial<Config>

    expect(mergeScopedConfig(target, source)).toEqual({ indexing: { model: null, dimension: null } })
  })

  it("builds clean set and unset payloads while preserving indexing null overrides", () => {
    const patch = {
      formatter: {},
      username: null,
      indexing: {
        model: null,
        dimension: null,
        searchMinScore: undefined,
        qdrant: { apiKey: undefined },
      },
    }

    expect(pruneConfigSet(patch)).toEqual({
      formatter: {},
      indexing: { model: null, dimension: null },
    })
    expect(configUnsetPaths(patch)).toEqual([
      ["username"],
      ["indexing", "searchMinScore"],
      ["indexing", "qdrant", "apiKey"],
    ])
  })
})

describe("stripNulls", () => {
  it("removes null values", () => {
    const cfg = { snapshot: true, username: null } as unknown as Config
    expect(stripNulls(cfg)).toEqual({ snapshot: true })
  })

  it("removes undefined values", () => {
    const cfg = { snapshot: true, username: undefined } as unknown as Config
    expect(stripNulls(cfg)).toEqual({ snapshot: true })
  })

  it("strips nulls recursively in nested objects", () => {
    const cfg = { agent: { code: { temperature: 0.5, prompt: null } } } as unknown as Config
    expect(stripNulls(cfg)).toEqual({ agent: { code: { temperature: 0.5 } } })
  })
})

describe("newSaveID (LOCK-001)", () => {
  it("produces globally unique identities across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newSaveID()))
    expect(ids.size).toBe(20)
  })

  it("never produces the old provider-local counter shape", () => {
    expect(newSaveID()).not.toMatch(/^cfg-\d+$/)
  })
})

describe("subtractSentDraft (LOCK-002)", () => {
  it("drops sent paths whose value is unchanged", () => {
    const current = { snapshot: false, username: "bob" }
    const sent = { snapshot: false }
    expect(subtractSentDraft(current, sent)).toEqual({ username: "bob" })
  })

  it("keeps same-field edits made after the save was sent", () => {
    const current = { agent: { code: { temperature: 0.5 } } }
    const sent = { agent: { code: { temperature: 0.2 } } }
    expect(subtractSentDraft(current, sent)).toEqual({ agent: { code: { temperature: 0.5 } } })
  })

  it("keeps newer fields nested next to sent fields", () => {
    const current = { agent: { code: { temperature: 0.2, steps: 5 } } }
    const sent = { agent: { code: { temperature: 0.2 } } }
    expect(subtractSentDraft(current, sent)).toEqual({ agent: { code: { steps: 5 } } })
  })

  it("prunes empty parents so isDirty stays accurate", () => {
    const current = { agent: { code: { temperature: 0.2 } }, snapshot: false }
    const sent = { agent: { code: { temperature: 0.2 } }, snapshot: false }
    expect(subtractSentDraft(current, sent)).toEqual({})
  })

  it("removes null delete sentinels when the ack confirms them", () => {
    const current = { default_agent: null, username: "alice" }
    const sent = { default_agent: null }
    expect(subtractSentDraft(current, sent)).toEqual({ username: "alice" })
  })

  it("keeps a re-set value when the user re-enabled a field after sending the delete", () => {
    const current = { default_agent: "code", username: "alice" }
    const sent = { default_agent: null }
    expect(subtractSentDraft(current, sent)).toEqual({ default_agent: "code", username: "alice" })
  })

  it("keeps arrays that changed after the save was sent and drops unchanged ones", () => {
    const current = { instructions: ["a", "b", "c"], disabled_providers: ["openai"] }
    const sent = { instructions: ["a", "b"], disabled_providers: ["openai"] }
    expect(subtractSentDraft(current, sent)).toEqual({ instructions: ["a", "b", "c"] })
  })
})

describe("deepEqual", () => {
  it("compares scalars, nested objects, and arrays structurally", () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual(["a", "b"], ["a", "b"])).toBe(true)
    expect(deepEqual(["a", "b"], ["a", "c"])).toBe(false)
    expect(deepEqual({ a: { b: 1 } }, { a: { c: 1 } })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Config state machine — reproduces the actual message-handler flow
// ---------------------------------------------------------------------------

describe("ConfigState", () => {
  it("configLoaded sets config when no draft is pending", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true, username: "alice" })
    expect(s.config).toEqual({ snapshot: true, username: "alice" })
    expect(s.loading).toBe(false)
  })

  describe("configLoaded while draft is pending (the reported bug)", () => {
    it("preserves the user's pending toggle change", () => {
      const s = new ConfigState()

      // 1. Server sends initial config
      s.handleConfigLoaded({ snapshot: true, username: "alice" })
      expect(s.config.snapshot).toBe(true)

      // 2. User toggles snapshot off (but hasn't saved yet)
      s.updateConfig({ snapshot: false })
      expect(s.config.snapshot).toBe(false)
      expect(s.dirty).toBe(true)

      // 3. A configLoaded push arrives from the extension (e.g. SSE event,
      //    tab switch, or another webview triggers a config reload).
      //    The server still has snapshot: true.
      s.handleConfigLoaded({ snapshot: true, username: "alice" })

      // BUG (old code): config.snapshot would be reset to true here
      // FIX: the draft is re-applied, so the user's toggle stays false
      expect(s.config.snapshot).toBe(false)
      expect(s.config.username).toBe("alice")
      expect(s.dirty).toBe(true)
    })

    it("preserves nested draft changes across configLoaded pushes", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ agent: { code: { temperature: 0.7 } } })
      s.updateConfig({ agent: { code: { steps: 5 } } })

      // Server pushes a reload — temperature may have changed server-side
      s.handleConfigLoaded({ agent: { code: { temperature: 0.9 } } })

      expect(s.config.agent?.code?.steps).toBe(5)
      expect(s.config.agent?.code?.temperature).toBe(0.9)
    })

    it("preserves explicit false agent flags across configLoaded pushes", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ agent: { code: { disable: true, hidden: true } } })
      s.updateConfig({ agent: { code: { disable: false, hidden: false } } })

      s.handleConfigLoaded({ agent: { code: { disable: true, hidden: true } } })

      expect(s.config.agent?.code?.disable).toBe(false)
      expect(s.config.agent?.code?.hidden).toBe(false)
    })

    it("preserves clearing default_agent when the current default is hidden", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ default_agent: "code", agent: { code: { hidden: false } } })

      s.updateConfig({ agent: { code: { hidden: true } } })
      s.updateConfig({ default_agent: null })

      s.handleConfigLoaded({ default_agent: "code", agent: { code: { hidden: false } } })

      expect(s.config.agent?.code?.hidden).toBe(true)
      expect(s.config.default_agent).toBeUndefined()
    })

    it("preserves clearing default_agent when the current default is disabled", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ default_agent: "code", agent: { code: { disable: false } } })

      s.updateConfig({ agent: { code: { disable: true } } })
      s.updateConfig({ default_agent: null })

      s.handleConfigLoaded({ default_agent: "code", agent: { code: { disable: false } } })

      expect(s.config.agent?.code?.disable).toBe(true)
      expect(s.config.default_agent).toBeUndefined()
    })
  })

  describe("configUpdated while draft is pending", () => {
    it("preserves draft when update comes from another source", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ snapshot: true, username: "alice" })
      s.updateConfig({ snapshot: false })

      // Another webview (e.g. PermissionDock) saves a different setting
      s.handleConfigUpdated({ snapshot: true, username: "bob" })

      expect(s.config.snapshot).toBe(false) // draft preserved
      expect(s.config.username).toBe("bob") // server update applied
    })

    it("clears draft when update confirms our save", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ snapshot: true })
      s.updateConfig({ snapshot: false })
      s.saveConfig("s1", { snapshot: false })
      expect(s.saving).toBe(true)

      // Server confirms the write
      s.handleConfigUpdated({ snapshot: false }, "s1")

      expect(s.config.snapshot).toBe(false)
      expect(s.dirty).toBe(false)
      expect(s.saving).toBe(false)
      expect(Object.keys(s.draft).length).toBe(0)
    })

    it("clears default_agent when update confirms a null-sentinel save", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ default_agent: "code" })
      s.updateConfig({ default_agent: null })
      s.saveConfig("s1", { default_agent: null })

      // Server confirms the write by returning config without default_agent.
      s.handleConfigUpdated({}, "s1")

      expect(s.config.default_agent).toBeUndefined()
      expect(s.dirty).toBe(false)
      expect(s.saving).toBe(false)
      expect(Object.keys(s.draft).length).toBe(0)
    })

    it("preserves the null delete sentinel in the pending save payload", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ default_agent: "code" })
      s.updateConfig({ default_agent: null })

      expect(s.draft.default_agent).toBeNull()

      s.saveConfig()

      expect(s.saving).toBe(true)
      expect(s.draft.default_agent).toBeNull()
    })
  })

  describe("configSaved while a save is in-flight", () => {
    it("clears the draft after a confirmed write even if merged refresh is pending", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ agent: { code: { prompt: "Review" } } })
      s.updateConfig({ agent: { code: { prompt: null } } })
      s.saveConfig()

      s.handleConfigSaved()

      expect(s.saving).toBe(false)
      expect(s.dirty).toBe(false)
      expect(Object.keys(s.draft).length).toBe(0)
      expect(s.saved.agent?.code?.prompt).toBeUndefined()
      expect(s.config.agent?.code?.prompt).toBeUndefined()
    })
  })

  describe("configSaveFailed while a save is in-flight", () => {
    it("preserves pending null-sentinel clears so the user can retry", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ agent: { code: { prompt: "Review", temperature: 0.7 } }, default_agent: "code" })
      s.updateConfig({ agent: { code: { prompt: null, temperature: null } } })
      s.updateConfig({ default_agent: null })
      s.saveConfig()

      s.handleConfigSaveFailed({ agent: { code: { prompt: "Review", temperature: 0.7 } }, default_agent: "code" })

      expect(s.saving).toBe(false)
      expect(s.dirty).toBe(true)
      expect(s.draft.agent?.code?.prompt).toBeNull()
      expect(s.draft.agent?.code?.temperature).toBeNull()
      expect(s.draft.default_agent).toBeNull()
      expect(s.config.agent?.code?.prompt).toBeUndefined()
      expect(s.config.agent?.code?.temperature).toBeUndefined()
      expect(s.config.default_agent).toBeUndefined()
    })
  })

  it("a new save while one is in flight replaces the pending identity", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true })
    s.updateConfig({ snapshot: false })
    s.saveConfig("s1", { snapshot: false })
    s.updateConfig({ username: "bob" })
    s.saveConfig("s2", { snapshot: false, username: "bob" })

    // A stale ack for the first save must not clear the second save's draft.
    s.handleConfigUpdated({ snapshot: false }, "s1")
    expect(s.saving).toBe(true)
    expect(s.dirty).toBe(true)
    expect(s.config.username).toBe("bob")

    s.handleConfigUpdated({ snapshot: false, username: "bob" }, "s2")

    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(false)
    expect(Object.keys(s.draft).length).toBe(0)
  })

  it("ignores a stale failure for an older, superseded save", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true })
    s.updateConfig({ snapshot: false })
    s.saveConfig("s1", { snapshot: false })
    s.saveConfig("s2", { snapshot: false })

    // Save 1 fails after save 2 started — must not disturb save 2.
    s.handleConfigSaveFailed({ snapshot: true }, "s1")
    expect(s.saving).toBe(true)
    expect(s.dirty).toBe(true)

    s.handleConfigSaveFailed({ snapshot: true }, "s2")
    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(true)
    expect(s.config.snapshot).toBe(false)
  })

  it("a stale failure after a newer save with the same value keeps the draft for retry (LOCK-001)", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true })
    s.updateConfig({ snapshot: false })
    s.saveConfig("s1", { snapshot: false })
    // A second save ships with the same value while the first is in flight.
    s.saveConfig("s2", { snapshot: false })

    // Save 1 fails after save 2 started — it only releases s1's snapshot;
    // the draft stays so the still-pending s2 can be confirmed or retried.
    s.handleConfigSaveFailed({ snapshot: true }, "s1")
    expect(s.saving).toBe(true)
    expect(s.dirty).toBe(true)
    expect(s.draft.snapshot).toBe(false)

    s.handleConfigSaveFailed({ snapshot: true }, "s2")
    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(true)
    expect(s.draft.snapshot).toBe(false)
  })

  it("preserves edits made while a save is in flight", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ agent: { code: { temperature: 0.7 } } })
    s.updateConfig({ agent: { code: { temperature: 0.2 } } })
    s.saveConfig("s1", { agent: { code: { temperature: 0.2 } } })

    // User edits another field while the save is in flight.
    s.updateConfig({ agent: { code: { steps: 5 } } })

    s.handleConfigUpdated({ agent: { code: { temperature: 0.2 } } }, "s1")

    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(true)
    expect(s.draft.agent?.code?.steps).toBe(5)
    expect(s.draft.agent?.code?.temperature).toBeUndefined() // saved field dropped
    expect(s.config.agent?.code?.steps).toBe(5)
    expect(s.config.agent?.code?.temperature).toBe(0.2)
  })

  it("preserves same-field edits made after the save was sent (LOCK-002)", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ agent: { code: { temperature: 0.7 } } })
    s.updateConfig({ agent: { code: { temperature: 0.2 } } })
    s.saveConfig("s1", { agent: { code: { temperature: 0.2 } } })

    // User re-edits the same field while the save is in flight.
    s.updateConfig({ agent: { code: { temperature: 0.5 } } })

    s.handleConfigUpdated({ agent: { code: { temperature: 0.2 } } }, "s1")

    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(true)
    expect(s.draft.agent?.code?.temperature).toBe(0.5) // post-send edit survives
    expect(s.config.agent?.code?.temperature).toBe(0.5) // draft re-applied on top
  })

  it("a stale ack for a superseded save releases only bookkeeping, never the draft (LOCK-001)", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true, username: "alice" })
    s.updateConfig({ snapshot: false })
    s.saveConfig("s1", { snapshot: false })
    // A second save ships while the first is in flight.
    s.updateConfig({ username: "bob" })
    s.saveConfig("s2", { snapshot: false, username: "bob" })

    // The first (stale) ack arrives while s2 is still pending — it must NOT
    // subtract anything from the draft; s2's own ack owns that. Subtracting
    // here would clear paths the still-pending newer save re-sent.
    s.handleConfigUpdated({ snapshot: false, username: "alice" }, "s1")
    expect(s.saving).toBe(true)
    expect(s.dirty).toBe(true)
    expect(s.draft.username).toBe("bob")
    expect(s.draft.snapshot).toBe(false)

    // The second ack clears the rest.
    s.handleConfigUpdated({ snapshot: false, username: "bob" }, "s2")
    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(false)
    expect(Object.keys(s.draft).length).toBe(0)
  })

  it("a stale ack after a newer save with the same value does not clear the draft (LOCK-001)", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true })
    s.updateConfig({ snapshot: false })
    s.saveConfig("s1", { snapshot: false })
    // A second save ships with the same value while the first is in flight.
    s.saveConfig("s2", { snapshot: false })
    expect(s.saving).toBe(true)

    // The stale ack for s1 arrives while s2 is still pending. It must only
    // release s1's bookkeeping — never subtract snapshot, because s2's ack
    // (still pending) re-sent the same value and owns the subtraction.
    s.handleConfigUpdated({ snapshot: false }, "s1")
    expect(s.saving).toBe(true)
    expect(s.dirty).toBe(true)
    expect(s.draft.snapshot).toBe(false)

    s.handleConfigUpdated({ snapshot: false }, "s2")
    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(false)
    expect(Object.keys(s.draft).length).toBe(0)
  })

  it("a stale ack after a newer save with the restored old value keeps the draft (LOCK-001)", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true })
    s.updateConfig({ snapshot: false })
    s.saveConfig("s1", { snapshot: false })
    // User restores the original value and ships a second save.
    s.updateConfig({ snapshot: true })
    s.saveConfig("s2", { snapshot: true })
    expect(s.saving).toBe(true)

    // The stale s1 ack must not disturb the newer save's pending state.
    s.handleConfigUpdated({ snapshot: true }, "s1")
    expect(s.saving).toBe(true)
    expect(s.dirty).toBe(true)
    expect(s.draft.snapshot).toBe(true)

    s.handleConfigUpdated({ snapshot: true }, "s2")
    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(false)
    expect(Object.keys(s.draft).length).toBe(0)
  })

  it("releases the sent snapshot on failure but keeps the draft for retry", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true })
    s.updateConfig({ snapshot: false })
    s.saveConfig("s1", { snapshot: false })

    s.handleConfigSaveFailed({ snapshot: true }, "s1")

    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(true)
    expect(s.draft.snapshot).toBe(false)

    // A retry with a fresh identity then acks cleanly.
    s.saveConfig("s2", { snapshot: false })
    s.handleConfigUpdated({ snapshot: false }, "s2")
    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(false)
  })

  it("generates a fresh identity when saveConfig is called without one", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true })
    s.updateConfig({ snapshot: false })
    s.saveConfig()
    expect(s.pendingSaveID).toBeTruthy()
    expect(s.pendingSaveID).not.toMatch(/^cfg-\d+$/)
  })

  it("re-applies an unsaved foreign update while a save is in flight", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true, username: "alice" })
    s.updateConfig({ snapshot: false })
    s.saveConfig("s1", { snapshot: false })

    // An SSE/configUpdated from another source arrives before our ack — it
    // must not clear the draft.
    s.handleConfigUpdated({ snapshot: false, username: "bob" })

    expect(s.saving).toBe(true)
    expect(s.dirty).toBe(true)
    expect(s.config.username).toBe("bob")
    expect(s.config.snapshot).toBe(false)
  })

  it("configLoaded is ignored while save is in-flight", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true })
    s.updateConfig({ snapshot: false })
    s.saveConfig()

    // A stale configLoaded arrives during the write round-trip
    s.handleConfigLoaded({ snapshot: true })

    // Config must not revert — the save is still in flight
    expect(s.config.snapshot).toBe(false)
  })

  it("discardConfig restores server state", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ snapshot: true, username: "alice" })
    s.updateConfig({ snapshot: false })
    expect(s.dirty).toBe(true)

    s.discardConfig()

    expect(s.config.snapshot).toBe(true)
    expect(s.dirty).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Issue #9527: clearing an agent model override must unset it, not repopulate
  // -------------------------------------------------------------------------
  describe("clearing an agent model override (issue #9527)", () => {
    it("keeps null in the draft so the backend receives a delete sentinel", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ agent: { explore: { model: "anthropic/claude-sonnet-4-20250514" } } })

      // User clears the Model Override field. ModeEditView now sends `null`
      // instead of `undefined` (the fix). null is the delete sentinel that
      // patchJsonc maps to jsonc-parser's remove operation.
      s.updateConfig({ agent: { explore: { model: null } } })

      // Optimistic UI: stripNulls removes the key so the field renders empty.
      expect(s.config.agent?.explore?.model).toBeUndefined()
      expect(s.dirty).toBe(true)

      // Draft must retain the null so it survives JSON.stringify on the wire
      // and reaches patchJsonc as an explicit delete.
      expect(s.draft.agent?.explore?.model).toBeNull()
      expect(JSON.parse(JSON.stringify(s.draft))).toEqual({
        agent: { explore: { model: null } },
      })
    })

    it("undefined (the old buggy behavior) is dropped by JSON.stringify", () => {
      // Reproduction of the pre-fix bug: sending `undefined` results in an
      // empty patch on the wire, so the backend never deletes the override
      // and the next configUpdated pushes the stale model back into the UI.
      const draft = { agent: { explore: { model: undefined } } }
      expect(JSON.parse(JSON.stringify(draft))).toEqual({ agent: { explore: {} } })
    })

    it("confirms the save and drops the draft once the backend acks", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({ agent: { explore: { model: "anthropic/claude-sonnet-4-20250514" } } })
      s.updateConfig({ agent: { explore: { model: null } } })
      s.saveConfig("s1", { agent: { explore: { model: null } } })

      // Backend removed the override and pushes the stripped config back.
      s.handleConfigUpdated({ agent: { explore: {} } }, "s1")

      expect(s.config.agent?.explore?.model).toBeUndefined()
      expect(s.dirty).toBe(false)
      expect(s.saving).toBe(false)
      expect(Object.keys(s.draft).length).toBe(0)
    })
  })

  it("keeps pending drafts dirty when configUpdateFailed arrives", () => {
    const s = new ConfigState()
    s.handleConfigLoaded({ model: "test/original" })
    s.updateConfig({ model: "test/invalid" })
    s.saveConfig()

    s.handleConfigSaveFailed({ model: "test/original" })

    expect(s.saving).toBe(false)
    expect(s.dirty).toBe(true)
    expect(s.draft).toEqual({ model: "test/invalid" })
    expect(s.config).toEqual({ model: "test/invalid" })
  })

  describe("clearing an agent variant override", () => {
    it("keeps null in the draft so the backend receives a delete sentinel", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({
        agent: {
          explore: {
            model: "kilo/anthropic/claude-sonnet-4-6",
            variant: "high",
          },
        },
      })

      s.updateConfig({ agent: { explore: { variant: null } } })

      expect(s.config.agent?.explore?.variant).toBeUndefined()
      expect(s.dirty).toBe(true)
      expect(s.draft.agent?.explore?.variant).toBeNull()
      expect(JSON.parse(JSON.stringify(s.draft))).toEqual({
        agent: { explore: { variant: null } },
      })
    })
  })

  describe("agent permission patches", () => {
    it("merges nested per-agent permission patches into existing rules", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({
        agent: {
          reviewer: {
            permission: {
              read: "allow",
              edit: "deny",
            },
          },
        },
      })

      s.updateConfig({ agent: { reviewer: { permission: { bash: "ask" } } } })

      expect(s.config.agent?.reviewer?.permission).toEqual({
        read: "allow",
        edit: "deny",
        bash: "ask",
      })
      expect(s.draft.agent?.reviewer?.permission).toEqual({ bash: "ask" })
    })

    it("keeps nested permission delete sentinels in the draft", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({
        agent: {
          docs: {
            permission: {
              edit: { "*": "deny", "**/*.md": "allow" },
            },
          },
        },
      })

      s.updateConfig({ agent: { docs: { permission: { edit: { "**/*.md": null } } } } })

      expect(s.config.agent?.docs?.permission).toEqual({ edit: { "*": "deny" } })
      expect(s.draft.agent?.docs?.permission).toEqual({ edit: { "**/*.md": null } })
      expect(JSON.parse(JSON.stringify(s.draft))).toEqual({
        agent: { docs: { permission: { edit: { "**/*.md": null } } } },
      })
    })

    it("keeps tool-level permission delete sentinels in the draft", () => {
      const s = new ConfigState()
      s.handleConfigLoaded({
        agent: {
          reviewer: {
            permission: {
              read: "allow",
              bash: "deny",
            },
          },
        },
      })

      s.updateConfig({ agent: { reviewer: { permission: { bash: null } } } })

      expect(s.config.agent?.reviewer?.permission).toEqual({ read: "allow" })
      expect(s.draft.agent?.reviewer?.permission).toEqual({ bash: null })
      expect(JSON.parse(JSON.stringify(s.draft))).toEqual({
        agent: { reviewer: { permission: { bash: null } } },
      })
    })
  })
})
