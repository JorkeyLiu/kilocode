/**
 * Canonical provider variant parity — ThinkingSelector gate regression.
 * Uses real materialization/validation and the production mapping helper,
 * not duplicated logic, to prove variants survive through canonical index,
 * provider payload, and webview variant resolution. Also proves immutability
 * after build and rehydrate.
 */
import { describe, expect, it, beforeEach } from "bun:test"
import { materialize, resetVersion } from "../../src/config/materialize"
import { snapshot as makeSnapshot } from "../../src/config/snapshot"
import { buildProviderIndex, mapProviderIndexToWebviewProviders, persistProviderIndex, rehydrateProviderIndex } from "../../src/config/selectors"
import type { StateAdapter } from "../../src/config/types"
import { realProjectSeed } from "../../script/e2e-restart-seed"
import { validateConfig } from "../../src/config/validate"
import { flattenModels, findModel } from "../../webview-ui/src/context/provider-utils"

beforeEach(() => resetVersion())

function seedValidatedMaterialization(port = 45659) {
  const seed = realProjectSeed(port)
  const raw = JSON.stringify(seed)
  const result = validateConfig(raw, "project", "/tmp/kilo.jsonc")
  expect(result.valid).toBe(true)
  expect(result.errors).toEqual([])
  const mat = materialize(
    {
      global: null,
      project: {
        scope: "project",
        root: "/tmp",
        raw: result.parsed!,
        provenance: { scope: "project", canonicalPath: "/tmp/kilo.jsonc", explicit: true, operator: "single" },
      },
    },
    null,
  )
  expect(mat.errors).toEqual([])
  return { seed, mat }
}

function memoryState(): StateAdapter & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) store.delete(key)
      else store.set(key, value)
    },
  }
}

describe("canonical provider variant parity", () => {
  it("buildProviderIndex retains low/medium/high variants from validated config", () => {
    const { mat } = seedValidatedMaterialization()
    const snap = makeSnapshot(mat.config)
    const idx = buildProviderIndex(snap, null)
    const entry = idx.providers.find((p) => p.id === "e2e-local")
    expect(entry).toBeDefined()
    expect(entry!.modelIds).toContain("e2e-model")
    expect(entry!.modelLabels["e2e-model"]).toBe("E2E Model")
    const variants = entry!.modelVariants["e2e-model"] as Record<string, Record<string, unknown>>
    expect(variants).toBeDefined()
    expect(Object.keys(variants!).sort()).toEqual(["high", "low", "medium"])
    expect(JSON.stringify(idx)).not.toContain("secret:")
    expect(Object.isFrozen(variants!)).toBe(true)
  })

  it("buildProviderIndex preserves per-model variant payload shapes (empty objects for low/medium/high)", () => {
    const { mat } = seedValidatedMaterialization(19531)
    const snap = makeSnapshot(mat.config)
    const idx = buildProviderIndex(snap, null)
    const entry = idx.providers.find((p) => p.id === "e2e-local")!
    const variants = entry.modelVariants["e2e-model"] as Record<string, Record<string, unknown>>
    for (const key of ["low", "medium", "high"]) {
      expect(variants[key]).toBeDefined()
      expect(typeof variants[key]).toBe("object")
      expect(Object.keys(variants[key]!)).toEqual([])
    }
  })

  it("production mapping via mapProviderIndexToWebviewProviders emits variants exactly as webview expects", () => {
    const { mat } = seedValidatedMaterialization()
    const snap = makeSnapshot(mat.config)
    const idx = buildProviderIndex(snap, null)
    const providers = mapProviderIndexToWebviewProviders(idx)
    const model = (providers["e2e-local"] as Record<string, Record<string, unknown>>).models as Record<string, Record<string, unknown>>
    expect(model["e2e-model"]).toBeDefined()
    expect((model["e2e-model"] as Record<string, unknown>).variants).toBeDefined()
    expect(Object.keys((model["e2e-model"] as Record<string, unknown>).variants as Record<string, unknown>).sort()).toEqual(["high", "low", "medium"])
    expect((providers["e2e-local"] as Record<string, unknown>).id).toBe("e2e-local")
    expect((providers["e2e-local"] as Record<string, unknown>).name).toBe("E2E Local")
  })

  it("webview provider + session variant resolution returns rows for ThinkingSelector via production mapping", () => {
    const { mat } = seedValidatedMaterialization()
    const snap = makeSnapshot(mat.config)
    const idx = buildProviderIndex(snap, null)
    const mapped = mapProviderIndexToWebviewProviders(idx)
    // Adapt mapped shape to the flattenModels input (ProviderView)
    const providers = Object.fromEntries(
      Object.entries(mapped).map(([id, view]) => [
        id,
        { id: view.id, name: view.name, models: view.models as unknown as Record<string, import("../../webview-ui/src/types/messages").ProviderModel> },
      ]),
    )
    const flat = flattenModels(providers as unknown as Record<string, import("../../webview-ui/src/types/messages").ProviderView>)
    const found = findModel(flat, { providerID: "e2e-local", modelID: "e2e-model" })
    expect(found).toBeDefined()
    expect(found!.variants).toBeDefined()
    const list = found!.variants ? Object.keys(found!.variants) : []
    expect(list.sort()).toEqual(["high", "low", "medium"])
    const rows = list
    expect(rows.length).toBeGreaterThan(0)
    expect(rows).toContain("low")
  })

  it("model without variants yields no variant rows via production mapping", () => {
    const emptySeed = {
      model: "e2e-local/e2e-model",
      provider: {
        "e2e-local": {
          name: "E2E Local",
          endpoint: "http://127.0.0.1:45659/v1",
          protocol: "openai/completions",
          credential: "secret:kilo.credentials.project.provider.e2e-local",
          models: { "e2e-model": { name: "E2E Model" } },
        },
      },
    }
    const raw = JSON.stringify(emptySeed)
    const result = validateConfig(raw, "project", "/tmp/kilo.jsonc")
    expect(result.valid).toBe(true)
    const mat = materialize(
      {
        global: null,
        project: { scope: "project", root: "/tmp", raw: result.parsed!, provenance: { scope: "project", canonicalPath: "/tmp/kilo.jsonc", explicit: true, operator: "single" } },
      },
      null,
    )
    const idx = buildProviderIndex(makeSnapshot(mat.config), null)
    const entry = idx.providers.find((p) => p.id === "e2e-local")!
    expect(entry.modelVariants["e2e-model"]).toBeUndefined()
    const providers = mapProviderIndexToWebviewProviders(idx)
    const models = (providers["e2e-local"] as { models: Record<string, Record<string, unknown>> }).models
    expect(models["e2e-model"]!.variants).toBeUndefined()
  })

  it("buildProviderIndex variant data is deeply immutable (entry, map, nested, array, index)", () => {
    const { mat } = seedValidatedMaterialization()
    const snap = makeSnapshot(mat.config)
    const idx = buildProviderIndex(snap, null)
    const entry = idx.providers.find((p) => p.id === "e2e-local")!
    const variants = entry.modelVariants["e2e-model"] as Record<string, Record<string, unknown>>
    // Frozen checks
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.modelVariants)).toBe(true)
    expect(Object.isFrozen(entry.modelIds)).toBe(true)
    expect(Object.isFrozen(entry.modelLabels)).toBe(true)
    expect(Object.isFrozen(variants)).toBe(true)
    for (const payload of Object.values(variants)) {
      expect(Object.isFrozen(payload)).toBe(true)
    }
    expect(Object.isFrozen(idx.providers)).toBe(true)
    expect(Object.isFrozen(idx)).toBe(true)
    // Mutation attempts must not succeed (throw in strict mode or silently fail)
    expect(() => {
      ;(entry as unknown as Record<string, unknown>).id = "mutated"
    }).toThrow()
    expect(entry.id).toBe("e2e-local")
    expect(() => {
      ;(variants as Record<string, unknown>).injected = {}
    }).toThrow()
    expect((variants as Record<string, unknown>).injected).toBeUndefined()
    expect(() => {
      ;(entry.modelVariants as Record<string, unknown>)["e2e-model"] = {}
    }).toThrow()
    expect(entry.modelVariants["e2e-model"]).toBe(variants)
    expect(() => {
      ;(idx.providers as unknown as unknown[]).push(entry)
    }).toThrow()
    expect(idx.providers.length).toBe(1)
  })

  it("rehydrated provider index variant data remains deeply immutable and production mapping still emits variants", async () => {
    const { mat } = seedValidatedMaterialization()
    const snap = makeSnapshot(mat.config)
    const idx = buildProviderIndex(snap, null)
    const state = memoryState()
    await persistProviderIndex(state, idx)
    const rehydrated = rehydrateProviderIndex(state)
    expect(rehydrated).not.toBeNull()
    const entry = rehydrated!.providers.find((p) => p.id === "e2e-local")!
    const variants = entry.modelVariants["e2e-model"] as Record<string, Record<string, unknown>>
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.modelVariants)).toBe(true)
    expect(Object.isFrozen(variants)).toBe(true)
    for (const payload of Object.values(variants)) {
      expect(Object.isFrozen(payload)).toBe(true)
    }
    expect(Object.isFrozen(rehydrated!.providers)).toBe(true)
    expect(Object.isFrozen(rehydrated!)).toBe(true)
    expect(() => {
      ;(variants as Record<string, unknown>).evil = {}
    }).toThrow()
    expect((variants as Record<string, unknown>).evil).toBeUndefined()
    expect(() => {
      ;(entry as unknown as Record<string, unknown>).displayName = "evil"
    }).toThrow()
    expect(entry.displayName).toBe("E2E Local")
    // Production mapping still emits variants after rehydrate
    const providers = mapProviderIndexToWebviewProviders(rehydrated!)
    const models = (providers["e2e-local"] as { models: Record<string, Record<string, unknown>> }).models
    expect(models["e2e-model"]!.variants).toBeDefined()
    expect(Object.keys(models["e2e-model"]!.variants as Record<string, unknown>).sort()).toEqual(["high", "low", "medium"])
  })

  it("rehydrated backfill for legacy persisted index without modelVariants is frozen and mappable", async () => {
    const state = memoryState()
    // Simulate legacy persisted index without modelVariants (before parity)
    const legacy = {
      version: 1,
      materializationVersion: 1,
      materializationHash: "legacy-hash",
      diagnostics: { invalid: false, stale: false, conflicts: [], provenance: {} },
      providers: [
        {
          id: "legacy-provider",
          hasCredential: false,
          displayName: "Legacy Provider",
          modelIds: ["legacy-model"],
          modelLabels: { "legacy-model": "Legacy Model" },
          // intentionally no modelVariants
        },
      ],
      selectedId: null,
      timestamp: Date.now(),
    }
    // Store raw legacy shape (cast to bypass type)
    state.store.set("kilo.canonicalIndex.providers", legacy as unknown)
    const rehydrated = rehydrateProviderIndex(state as StateAdapter)
    expect(rehydrated).not.toBeNull()
    const entry = rehydrated!.providers[0]!
    expect(entry.modelVariants).toBeDefined()
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.modelVariants)).toBe(true)
    expect(Object.isFrozen(entry.modelIds)).toBe(true)
    expect(() => {
      ;(entry.modelVariants as Record<string, unknown>)["x"] = {}
    }).toThrow()
    const providers = mapProviderIndexToWebviewProviders(rehydrated!)
    expect(providers["legacy-provider"].models["legacy-model"].variants).toBeUndefined()
  })
})
