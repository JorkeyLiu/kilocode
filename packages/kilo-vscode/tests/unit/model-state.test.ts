import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import * as ModelState from "../../src/kilo-provider/model-state"

/**
 * LOCK-007 extension bridge tests: the shared model.json `variant` map is the
 * canonical cross-process variant memory; VS Code globalState entries are
 * migration input / a synchronized compatibility cache, never a
 * higher-priority independent source.
 *
 * model-state.ts caches the resolved state dir module-locally, so the whole
 * suite shares one temp state dir (deleted in afterAll).
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-model-state-"))
const stateDir = path.join(dir, "state")
fs.mkdirSync(stateDir, { recursive: true })

function client(): KiloClient {
  return {
    path: {
      get: async () => ({ data: { state: stateDir } }),
    },
  } as unknown as KiloClient
}

function file() {
  return path.join(stateDir, "model.json")
}

function writeState(input: unknown) {
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(input))
}

function readState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file(), "utf-8"))
}

function cache(initial: Record<string, string> = {}) {
  const value = { ...initial }
  return {
    value,
    read: () => value,
    write: (next: Record<string, string>) => {
      const copy = { ...next }
      Object.keys(value).forEach((k) => delete value[k])
      Object.assign(value, copy)
    },
  }
}

beforeEach(() => {
  fs.rmSync(file(), { force: true })
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("model-state variant persistence (LOCK-007)", () => {
  it("persistVariant writes agent+model and model-only keys to the shared file", async () => {
    const c = client()
    const posted: unknown[] = []
    await ModelState.handleMessage("persistVariant", { key: "agent/code/openai/gpt-4.1", value: "high" }, c, (m) =>
      posted.push(m),
    )
    await ModelState.handleMessage("persistVariant", { key: "openai/gpt-4.1", value: "medium" }, c, (m) =>
      posted.push(m),
    )

    const state = readState()
    expect(state.variant).toEqual({
      "agent/code/openai/gpt-4.1": "high",
      "openai/gpt-4.1": "medium",
    })
    expect(posted).toEqual([])
  })

  it("persistVariant keeps session-scoped keys out of the shared file", async () => {
    const c = client()
    writeState({})
    await ModelState.handleMessage(
      "persistVariant",
      { key: "session/s1/code/openai/gpt-4.1", value: "low" },
      c,
      () => undefined,
    )
    const state = readState()
    expect(state.variant ?? {}).toEqual({})
  })

  it("persistVariant keeps the globalState cache synchronized", async () => {
    const c = client()
    const compat = cache()
    await ModelState.handleMessage(
      "persistVariant",
      { key: "agent/code/openai/gpt-4.1", value: "high" },
      c,
      () => undefined,
      compat,
    )
    expect(compat.value).toEqual({ "agent/code/openai/gpt-4.1": "high" })
    expect(readState().variant).toEqual({ "agent/code/openai/gpt-4.1": "high" })
  })
})

describe("model-state variant migration (LOCK-007)", () => {
  it("migrates legacy globalState entries into the shared file and posts variantsLoaded", async () => {
    const c = client()
    const compat = cache({ "opencode-go/deepseek-v4-flash": "high" })
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    const handled = await ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never), compat)

    expect(handled).toBe(true)
    expect(readState().variant).toEqual({ "opencode-go/deepseek-v4-flash": "high" })
    expect(posted[0]?.type).toBe("variantsLoaded")
    expect(posted[0]?.variants).toEqual({ "opencode-go/deepseek-v4-flash": "high" })
    // The cache stays a synchronized compatibility cache — nothing cleared.
    expect(compat.value).toEqual({ "opencode-go/deepseek-v4-flash": "high" })
  })

  it("existing canonical entries always win; legacy never overwrites the file", async () => {
    const c = client()
    writeState({ variant: { "opencode-go/deepseek-v4-flash": "low" } })
    const compat = cache({ "opencode-go/deepseek-v4-flash": "high" })
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never), compat)

    // The canonical file entry was NOT overwritten by the stale legacy value.
    expect(readState().variant).toEqual({ "opencode-go/deepseek-v4-flash": "low" })
    // The posted variants come from the canonical file.
    expect(posted[0]?.variants).toEqual({ "opencode-go/deepseek-v4-flash": "low" })
    // The cache is synchronized to the merged (canonical-first) map.
    expect(compat.value).toEqual({ "opencode-go/deepseek-v4-flash": "low" })
  })

  it("migrates agent+model keys too and prunes session-scoped keys from the cache", async () => {
    const c = client()
    const compat = cache({
      "agent/nexus/opencode-go/deepseek-v4-flash": "high",
      "session/s1/code/opencode-go/deepseek-v4-flash": "medium",
    })
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never), compat)

    expect(readState().variant).toEqual({ "agent/nexus/opencode-go/deepseek-v4-flash": "high" })
    expect(posted[0]?.variants).toEqual({ "agent/nexus/opencode-go/deepseek-v4-flash": "high" })
    // Session keys are ephemeral local state — never rehydrated cache data —
    // so the sync prunes them instead of letting them accumulate.
    expect(compat.value["session/s1/code/opencode-go/deepseek-v4-flash"]).toBeUndefined()
    expect(compat.value["agent/nexus/opencode-go/deepseek-v4-flash"]).toBe("high")
  })

  it("requestVariants without a cache reads the canonical file only", async () => {
    const c = client()
    writeState({ variant: { "openai/gpt-4.1": "medium" } })
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never))

    expect(posted[0]?.variants).toEqual({ "openai/gpt-4.1": "medium" })
  })

  it("migration is idempotent: a second requestVariants changes nothing", async () => {
    const c = client()
    const compat = cache({ "openai/gpt-4.1": "high" })
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never), compat)
    const afterFirst = readState()
    await ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never), compat)

    expect(readState()).toEqual(afterFirst)
    expect(readState().variant).toEqual({ "openai/gpt-4.1": "high" })
    expect(compat.value).toEqual({ "openai/gpt-4.1": "high" })
    expect(posted).toHaveLength(2)
    expect(posted[1]?.variants).toEqual({ "openai/gpt-4.1": "high" })
  })

  it("concurrent requestVariants migration and persistVariant never lose either key", async () => {
    // Deterministic interleaving: both operations are serialized by the
    // module-level critical section, so the migrated legacy key and the
    // concurrently persisted key both survive in the file and the cache.
    const c = client()
    const compat = cache({ "openai/gpt-4.1": "high" })
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await Promise.all([
      ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never), compat),
      ModelState.handleMessage(
        "persistVariant",
        { key: "anthropic/claude-sonnet-4", value: "medium" },
        c,
        () => undefined,
        compat,
      ),
    ])

    expect(readState().variant).toEqual({
      "openai/gpt-4.1": "high",
      "anthropic/claude-sonnet-4": "medium",
    })
    expect(compat.value).toEqual({
      "openai/gpt-4.1": "high",
      "anthropic/claude-sonnet-4": "medium",
    })
    // The serialized migration ran before the persist, so the posted snapshot
    // carries the migrated key; the persisted key survives in file and cache.
    expect(posted[0]?.variants).toEqual({ "openai/gpt-4.1": "high" })
  })

  it("concurrent persistVariant and persistModelSelection keep both maps intact", async () => {
    const c = client()
    await Promise.all([
      ModelState.handleMessage("persistVariant", { key: "openai/gpt-4.1", value: "high" }, c, () => undefined),
      ModelState.handleMessage(
        "persistModelSelection",
        { agent: "code", providerID: "openai", modelID: "gpt-4.1" },
        c,
        () => undefined,
      ),
    ])
    const state = readState()
    expect(state.model).toEqual({ code: { providerID: "openai", modelID: "gpt-4.1" } })
    expect(state.variant).toEqual({ "openai/gpt-4.1": "high" })
  })

  it("a session-scoped persistVariant never writes the cache", async () => {
    const c = client()
    writeState({})
    const compat = cache({ "openai/gpt-4.1": "high" })
    await ModelState.handleMessage(
      "persistVariant",
      { key: "session/s1/code/openai/gpt-4.1", value: "low" },
      c,
      () => undefined,
      compat,
    )
    expect(compat.value).toEqual({ "openai/gpt-4.1": "high" })
    expect(readState().variant ?? {}).toEqual({})
  })

  it("malformed canonical file blocks destructive rewrite and posts empty variants", async () => {
    const c = client()
    fs.writeFileSync(file(), '{"variant": {"openai/gpt-4.1": "h') // truncated JSON
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never))
    // The malformed file is untouched — no synthesized empty snapshot.
    expect(fs.readFileSync(file(), "utf-8")).toBe('{"variant": {"openai/gpt-4.1": "h')
    expect(posted[0]?.variants).toEqual({})
  })

  it("malformed canonical file persistence skip is logged (LOCK-003)", async () => {
    const c = client()
    fs.writeFileSync(file(), '{"model": {') // truncated JSON
    const logs: string[] = []
    await ModelState.handleMessage(
      "persistVariant",
      { key: "openai/gpt-4.1", value: "high" },
      c,
      () => undefined,
      undefined,
      (m) => logs.push(m),
    )
    expect(fs.readFileSync(file(), "utf-8")).toBe('{"model": {')
    expect(logs.join("\n")).toContain("malformed")
  })

  it("non-ENOENT read failures never overwrite canonical state and are logged (LOCK-003)", async () => {
    const c = client()
    // A directory at the model.json path makes readFile throw EISDIR — a
    // non-ENOENT read error that must NOT look like a fresh empty document.
    fs.mkdirSync(file(), { recursive: true })
    const logs: string[] = []
    await ModelState.handleMessage(
      "persistVariant",
      { key: "openai/gpt-4.1", value: "high" },
      c,
      () => undefined,
      undefined,
      (m) => logs.push(m),
    )
    // The directory is untouched — no destructive overwrite happened.
    expect(fs.statSync(file()).isDirectory()).toBe(true)
    expect(logs.join("\n")).toContain("model.json read failed")

    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage(
      "requestVariants",
      {},
      c,
      (m) => posted.push(m as never),
      undefined,
      (m) => logs.push(m),
    )
    expect(posted[0]?.variants).toEqual({})
    // Owned cleanup: this test deliberately replaced the file with a directory.
    fs.rmSync(file(), { recursive: true, force: true })
  })

  it("ENOENT is a fresh document: creates the file and logs nothing (LOCK-003)", async () => {
    const c = client()
    const logs: string[] = []
    await ModelState.handleMessage(
      "persistVariant",
      { key: "openai/gpt-4.1", value: "high" },
      c,
      () => undefined,
      undefined,
      (m) => logs.push(m),
    )
    expect(readState().variant).toEqual({ "openai/gpt-4.1": "high" })
    expect(logs).toEqual([])
  })

  it("malformed canonical file never triggers a destructive persistVariant rewrite", async () => {
    const c = client()
    fs.writeFileSync(file(), '{"model": {') // truncated JSON
    await ModelState.handleMessage("persistVariant", { key: "openai/gpt-4.1", value: "high" }, c, () => undefined)
    expect(fs.readFileSync(file(), "utf-8")).toBe('{"model": {')
  })
})

describe("model-state model persistence (existing behavior)", () => {
  it("persistModelSelection and requestModelSelections round-trip through the file", async () => {
    const c = client()
    await ModelState.handleMessage(
      "persistModelSelection",
      { agent: "code", providerID: "openai", modelID: "gpt-4.1" },
      c,
      () => undefined,
    )
    const posted: Array<{ type: string; selections: unknown }> = []
    await ModelState.handleMessage("requestModelSelections", {}, c, (m) => posted.push(m as never))
    expect(posted[0]?.selections).toEqual({ code: { providerID: "openai", modelID: "gpt-4.1" } })
  })

  it("reset clears both the model and variant maps", async () => {
    const c = client()
    writeState({ model: { code: { providerID: "openai", modelID: "gpt-4.1" } }, variant: { "openai/gpt-4.1": "high" } })
    const posted: unknown[] = []
    await ModelState.reset(c, (m) => posted.push(m))
    const state = readState()
    expect(state.model).toEqual({})
    expect(state.variant).toEqual({})
  })

  it("reset clears the migration cache internally and requestVariants cannot resurrect values", async () => {
    const c = client()
    writeState({ model: { code: { providerID: "openai", modelID: "gpt-4.1" } }, variant: { "openai/gpt-4.1": "high" } })
    const compat = cache({ "openai/gpt-4.1": "high", "anthropic/claude-sonnet-4": "medium" })
    await ModelState.reset(c, () => undefined, compat)
    expect(compat.value).toEqual({})

    // A later requestVariants must not bring the reset values back.
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage("requestVariants", {}, c, (m) => posted.push(m as never), compat)
    expect(posted[0]?.variants).toEqual({})
    expect(readState().variant).toEqual({})
    expect(compat.value).toEqual({})
  })

  it("reset does not overwrite a malformed canonical file but clears cache and posts empty (LOCK-001)", async () => {
    const c = client()
    const raw = '{"model": {"code": {"providerID": "openai", "modelID": "gpt-4.1"}}, "variant": {"openai/gpt-4.1": "h'
    fs.writeFileSync(file(), raw) // truncated JSON
    const compat = cache({ "openai/gpt-4.1": "high", "anthropic/claude-sonnet-4": "medium" })
    const logs: string[] = []
    const posted: Array<{ type: string }> = []
    await ModelState.reset(
      c,
      (m) => posted.push(m as never),
      compat,
      (m) => logs.push(m),
    )

    // The malformed canonical file is preserved byte-for-byte for recovery/diagnosis.
    expect(fs.readFileSync(file(), "utf-8")).toBe(raw)
    // Live/cache state was still cleared and the skip was logged.
    expect(compat.value).toEqual({})
    expect(logs.join("\n")).toContain("malformed")
    // Empty UI state was reported, exactly once each.
    const types = posted.map((m) => m.type)
    expect(types).toEqual(["modelSelectionsLoaded", "variantsLoaded"])

    // A later requestVariants cannot resurrect the cleared cache values, and
    // still never rewrites the malformed file.
    const after: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage(
      "requestVariants",
      {},
      c,
      (m) => after.push(m as never),
      compat,
      (m) => logs.push(m),
    )
    expect(after[0]?.variants).toEqual({})
    expect(compat.value).toEqual({})
    expect(fs.readFileSync(file(), "utf-8")).toBe(raw)
  })

  it("reset does not overwrite canonical state on non-ENOENT read failure but clears cache (LOCK-001)", async () => {
    const c = client()
    // A directory at the model.json path makes readFile throw EISDIR — a
    // non-ENOENT read error that reset must never turn into a destructive
    // overwrite of the canonical path.
    fs.mkdirSync(file(), { recursive: true })
    const compat = cache({ "openai/gpt-4.1": "high" })
    const logs: string[] = []
    const posted: Array<{ type: string }> = []
    await ModelState.reset(
      c,
      (m) => posted.push(m as never),
      compat,
      (m) => logs.push(m),
    )

    // The directory is untouched and the failure was logged.
    expect(fs.statSync(file()).isDirectory()).toBe(true)
    expect(logs.join("\n")).toContain("model.json read failed")
    // Live/cache state cleared and empty UI state posted anyway.
    expect(compat.value).toEqual({})
    expect(posted.map((m) => m.type)).toEqual(["modelSelectionsLoaded", "variantsLoaded"])
    // Owned cleanup: this test deliberately replaced the file with a directory.
    fs.rmSync(file(), { recursive: true, force: true })
  })

  it("ENOENT reset treats the missing file as a fresh document and creates it", async () => {
    const c = client()
    const posted: unknown[] = []
    await ModelState.reset(c, (m) => posted.push(m))
    expect(readState()).toEqual({ model: {}, variant: {} })
    expect(posted.map((m) => (m as { type: string }).type)).toEqual(["modelSelectionsLoaded", "variantsLoaded"])
  })

  it("reset emits exactly one modelSelectionsLoaded and one variantsLoaded", async () => {
    const c = client()
    const posted: Array<{ type: string }> = []
    await ModelState.reset(c, (m) => posted.push(m as never))
    const types = posted.map((m) => m.type).filter((t) => t === "modelSelectionsLoaded" || t === "variantsLoaded")
    expect(types).toEqual(["modelSelectionsLoaded", "variantsLoaded"])
  })

  it("atomic writes leave no stray temp files behind", async () => {
    const c = client()
    for (let i = 0; i < 5; i++) {
      await ModelState.handleMessage("persistVariant", { key: `openai/gpt-4.${i}`, value: "high" }, c, () => undefined)
    }
    const leftovers = fs.readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  })
})
