import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { ModelCache } from "../../src/provider/model-cache"

// P4.4-T7-correction source-removal evidence — kilo/apertis dynamic fetch removed, ModelCache is clear-only (LOCK-006)
// - `packages/opencode/src/provider/model-cache.ts` is invalidation-only: only `clear(providerID)` exists,
//   no Map, no get/fetch/refresh/getFailure/failedProviders, no kilo/apertis network.
// - `packages/opencode/src/provider/models.ts` is static Core overlay only, no ModelCache import.
// - `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts` has `failed: []`, no ModelCache.
// - Static catalog `models-api.json` / `core/src/models-dev.ts` / generic BUNDLED_PROVIDERS /
//   KILO_MODEL_SCHEMA_EXTENSIONS / custom-provider clear / bridge remain per LOCK-006/009 — static
//   source-presence only; dynamic kilo/apertis resolution is removed and not runtime-proven beyond invalidation.
// Spec anchors: runtime §8.1 row 9 (LOCK-006); tracker §7; matrix row 9.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 model-cache removal — kilo/apertis dynamic fetch absent", () => {
  test("model-cache.ts is clear-only: no Map, no get/fetch/refresh/failure APIs, no network branches", () => {
    const src = read("provider/model-cache.ts")
    expect(src).not.toContain("fetchKiloModels")
    expect(src).not.toContain("@kilocode/kilo-gateway")
    expect(src).not.toContain("KiloModelsService")
    expect(src).not.toContain("kiloModelsLayer")
    expect(src).not.toContain("APERTIS_BASE_URL")
    expect(src).not.toContain("api.apertis.ai")
    expect(src).not.toContain("fetchApertisModels")
    expect(src).not.toContain("authOptions")
    expect(src).not.toContain("KILO_API_KEY")
    expect(src).not.toContain("APERTIS_API_KEY")
    expect(src).not.toContain("kilocodeToken")
    expect(src).not.toContain("HttpClient")
    expect(src).not.toContain("FetchHttpClient")
    expect(src).not.toContain("Auth.Service")
    expect(src).not.toContain("Config.Service")
    expect(src).not.toContain("new Map")
    expect(src).not.toContain("cache.get")
    expect(src).not.toContain("cache.set")
    expect(src).not.toContain("cache.has")
    expect(src).not.toContain("cache.delete")
    // removed APIs must be absent
    expect(src).not.toContain("readonly get:")
    expect(src).not.toContain("readonly fetch:")
    expect(src).not.toContain("readonly refresh:")
    expect(src).not.toContain("readonly getFailure")
    expect(src).not.toContain("readonly failedProviders")
    expect(src).not.toContain("getFailure")
    expect(src).not.toContain("failedProviders")
    // retained minimal API: only clear
    expect(src).toContain("readonly clear:")
    expect(src).toContain("clear: (providerID: string)")
    expect(src).toContain('Service extends Context.Service')
    expect(src).toContain("defaultLayer")
  })

  test("models.ts no longer injects kilo/apertis via ModelCache", () => {
    const src = read("provider/models.ts")
    expect(src).not.toContain("ModelCache")
    expect(src).not.toContain('cache.fetch("kilo"')
    expect(src).not.toContain('cache.fetch("apertis"')
    expect(src).not.toContain("cache.refresh")
    expect(src).not.toContain("providers.kilo")
    expect(src).not.toContain("providers.apertis")
    expect(src).not.toContain("KILO_OPENROUTER_BASE")
    expect(src).not.toContain("APERTIS_API_KEY")
    expect(src).not.toContain("baseURL(")
    // static wrapper preserved
    expect(src).toContain("Core.Service")
    expect(src).toContain("overlay(coreProviders)")
    expect(src).toContain("export const layer")
    expect(src).toContain("export const defaultLayer")
    expect(src).toContain("export { AI_SDK_PROVIDERS, PROMPTS }")
  })

  test("provider handler no longer uses ModelCache for failedProviders", () => {
    const src = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(src).not.toContain("ModelCache")
    expect(src).not.toContain("failedProviders")
    expect(src).not.toContain("cache.")
    expect(src).toContain('const failed: string[] = []')
    expect(src).toContain("Provider.toPublicInfo")
    expect(src).toContain("connected: Object.keys(connected)")
    expect(src).toContain("failed,")
  })

  test("no production source references kilo/apertis dynamic cache", () => {
    let combined = ""
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          walk(full)
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          combined += readFileSync(full, "utf8") + "\n"
        }
      }
    }
    walk(opencode)
    // dynamic fetch helpers must be gone from src
    expect(combined).not.toContain("fetchKiloModels")
    expect(combined).not.toContain("fetchApertisModels")
    expect(combined).not.toContain("APERTIS_BASE_URL")
    // provider/models.ts should not import ModelCache
    expect(read("provider/models.ts")).not.toContain("ModelCache")
    // handler should not import ModelCache
    expect(read("server/routes/instance/httpapi/handlers/provider.ts")).not.toContain("ModelCache")
  })

  test("no production or test source references removed ModelCache APIs except this regression file", () => {
    let combined = ""
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          walk(full)
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          combined += readFileSync(full, "utf8") + "\n"
        }
      }
    }
    walk(opencode)
    // also scan tests, excluding this file itself (which contains the absence assertions)
    const testDir = join(repo, "packages/opencode/test")
    const walkTest = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (full.endsWith("p4-4-model-cache-removal.test.ts")) continue
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          walkTest(full)
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          combined += readFileSync(full, "utf8") + "\n"
        }
      }
    }
    walkTest(testDir)
    expect(combined).not.toContain("ModelCache.Service.use((svc) => svc.get(")
    expect(combined).not.toContain("ModelCache.Service.use((svc) => svc.fetch(")
    expect(combined).not.toContain(".getFailure")
    expect(combined).not.toContain(".failedProviders")
    expect(combined).not.toContain("svc.refresh")
  })

  test("generic adapters and catalog artifacts remain (LOCK-006) — static source presence", () => {
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/provider/models-api.json"))).toBe(true)
    expect(existsSync(join(opencode, "provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/models.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/model-cache.ts"))).toBe(true)
    expect(existsSync(join(opencode, "core/src/models-dev.ts"))).toBe(false) // core is outside opencode/src
    expect(existsSync(resolve(join(repo, "packages/core/src/models-dev.ts")))).toBe(true)
    const provider = read("provider/provider.ts")
    expect(provider).toContain("const BUNDLED_PROVIDERS")
    expect(provider).toContain('"@ai-sdk/openai"')
    expect(provider).toContain('"@ai-sdk/anthropic"')
    const kilo = read("kilocode/provider/provider.ts")
    expect(kilo).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    expect(kilo).toContain("patchModelsDevModel")
  })

  test("custom-provider save/delete/auth lifecycle still uses ModelCache.clear", () => {
    expect(read("kilocode/server/custom-provider-save.ts")).toContain("ModelCache")
    expect(read("kilocode/server/custom-provider-save.ts")).toContain("modelCache.clear")
    expect(read("kilocode/server/custom-provider-delete.ts")).toContain("ModelCache")
    expect(read("kilocode/server/custom-provider-delete.ts")).toContain("modelCache.clear")
    expect(read("kilocode/server/provider-auth-lifecycle.ts")).toContain("ModelCache")
    expect(read("kilocode/server/provider-auth-lifecycle.ts")).toContain("cache.clear")
  })

  test("provider group endpoint contract remains (HTTP/SSE bridge preserved per LOCK-009)", () => {
    const group = read("server/routes/instance/httpapi/groups/provider.ts")
    expect(group).toContain('HttpApiEndpoint.get("list"')
    expect(group).toContain('success: described(Provider.ListResult')
    expect(group).toContain('HttpApiEndpoint.get("auth"')
    expect(group).toContain('HttpApiEndpoint.post("authorize"')
    expect(group).toContain('HttpApiEndpoint.post("callback"')
    const handler = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain('HttpApiBuilder.group(InstanceHttpApi, "provider"')
    expect(handler).toContain('.handle("list"')
  })

  test("test-profile lists the new removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-model-cache-removal")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-managed-removal")
    // sorted: bundled < managed < model-cache < primary < provider < wellknown
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const modelCacheIdx = profile.indexOf("p4-4-model-cache-removal")
    const providerIdx = profile.indexOf("p4-4-provider-metadata-removal")
    expect(bundledIdx).toBeGreaterThan(-1)
    expect(modelCacheIdx).toBeGreaterThan(-1)
    expect(bundledIdx).toBeLessThan(modelCacheIdx)
    expect(modelCacheIdx).toBeLessThan(providerIdx)
  })
})

describe("P4.4 model-cache invalidation API — runtime (clear-only)", () => {
  test("ModelCache service exposes only clear", async () => {
    const src = readFileSync(join(opencode, "provider/model-cache.ts"), "utf8")
    // interface should contain only clear
    expect(src).toContain("readonly clear:")
    expect(src).not.toContain("readonly get")
    expect(src).not.toContain("readonly fetch")
    expect(src).not.toContain("readonly refresh")
    expect(src).not.toContain("getFailure")
    expect(src).not.toContain("failedProviders")
    // runtime: service has only clear property
    const svc = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* ModelCache.Service
        return s
      }).pipe(Effect.provide(ModelCache.defaultLayer)),
    )
    expect(typeof svc.clear).toBe("function")
    expect((svc as unknown as Record<string, unknown>).get).toBeUndefined()
    expect((svc as unknown as Record<string, unknown>).fetch).toBeUndefined()
    expect((svc as unknown as Record<string, unknown>).refresh).toBeUndefined()
    expect((svc as unknown as Record<string, unknown>).getFailure).toBeUndefined()
    expect((svc as unknown as Record<string, unknown>).failedProviders).toBeUndefined()
  })

  test("clear is a no-op void and succeeds", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ModelCache.Service
        yield* svc.clear("test")
        yield* svc.clear("another")
        return true
      }).pipe(Effect.provide(ModelCache.defaultLayer)),
    )
    expect(result).toBe(true)
  })

  test("failing clear propagates via Effect defect channel (injectable)", async () => {
    let fail = true
    const failing = Layer.succeed(
      ModelCache.Service,
      ModelCache.Service.of({
        clear: () => (fail ? Effect.die(new Error("injected clear fail")) : Effect.void),
      }),
    )
    const result = await Effect.runPromiseExit(
      ModelCache.Service.use((svc) => svc.clear("test")).pipe(Effect.provide(failing)),
    )
    expect(result._tag).toBe("Failure")
    fail = false
    const ok = await Effect.runPromiseExit(
      ModelCache.Service.use((svc) => svc.clear("test")).pipe(Effect.provide(failing)),
    )
    expect(ok._tag).toBe("Success")
  })
})
