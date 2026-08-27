import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T6 source-removal evidence — preset `@kilocode/kilo-gateway` bundled
// provider loader physically removed (LOCK-006 preset-only removal; LOCK-009
// bridge preserved).
// - `packages/opencode/src/kilocode/provider/provider.ts` `KILO_BUNDLED_PROVIDERS`
//   (`"@kilocode/kilo-gateway": async () => createKilo`) and its `createKilo`
//   import plus `BundledSDK` helper are deleted.
// - `packages/opencode/src/provider/provider.ts` import and
//   `...KILO_BUNDLED_PROVIDERS` spread removed from `BUNDLED_PROVIDERS`.
// - Generic SDK loader map (`@ai-sdk/*`, openrouter, xai, etc.), custom
//   provider lifecycle, `models-api.json`, `ModelsDev` catalog
//   service, `KILO_MODEL_SCHEMA_EXTENSIONS` / `patchModelsDevModel`, and
//   provider HTTP group contract remain per LOCK-006/009 — static
//   source-presence preservation only; dynamic Kilo model resolution through
//   fallback (models.dev/custom lifecycle) is intentionally not
//   runtime-proven in this static unit (no network/package installation).
// Spec anchors: runtime §8.1 row 9 (LOCK-006); tracker §7; matrix row 9.
// This file asserts static absence of the preset loader identity and static
// source presence of retained provider/bridge surfaces; it does not claim
// P4.4 completion or dynamic model-resolution proof.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}

function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 bundled provider loader removal — preset identity absent", () => {
  test("kilocode/provider/provider.ts no longer defines KILO_BUNDLED_PROVIDERS", () => {
    const src = read("kilocode/provider/provider.ts")
    expect(src).not.toContain("KILO_BUNDLED_PROVIDERS")
    expect(src).not.toContain("createKilo")
    expect(src).not.toContain('"@kilocode/kilo-gateway": async')
    expect(src).not.toContain("'@kilocode/kilo-gateway': async")
    // The bundled helper type was only for that loader
    expect(src).not.toContain("type BundledSDK")
    // Retained: generic schema extensions and kilo-specific provider helpers
    expect(src).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    expect(src).toContain("patchModelsDevModel")
    expect(src).toContain("patchConfigModel")
    expect(src).toContain("kiloCustomLoaders")
    expect(src).toContain("patchCustomLoaderResult")
    expect(src).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    // Still imports kilo-gateway for PROMPTS/AI_SDK_PROVIDERS/KiloProvider but not createKilo
    expect(src).toContain('from "@kilocode/kilo-gateway"')
    expect(src).toContain("AI_SDK_PROVIDERS")
    expect(src).toContain("PROMPTS")
    expect(src).toContain("KiloProvider")
  })

  test("provider/provider.ts no longer injects KILO_BUNDLED_PROVIDERS", () => {
    const src = read("provider/provider.ts")
    expect(src).not.toContain("KILO_BUNDLED_PROVIDERS")
    expect(src).not.toContain("...KILO_BUNDLED_PROVIDERS")
    // Import surface for the deleted loader is gone; kilo helpers remain
    expect(src).not.toContain("KILO_BUNDLED_PROVIDERS,")
    expect(src).toContain("kiloCustomLoaders")
    expect(src).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    expect(src).toContain("patchModelsDevModel as patchKiloModel")
    // Generic loader map remains
    expect(src).toContain("const BUNDLED_PROVIDERS")
    expect(src).toContain('"@ai-sdk/openai"')
    expect(src).toContain('"@ai-sdk/anthropic"')
    expect(src).toContain('"@ai-sdk/google"')
    expect(src).toContain('"@ai-sdk/azure"')
    expect(src).toContain('"@ai-sdk/openai-compatible"')
    expect(src).toContain('"@openrouter/ai-sdk-provider"')
    expect(src).not.toContain('"@kilocode/kilo-gateway"')
  })

  test("no production source references KILO_BUNDLED_PROVIDERS", () => {
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
    expect(combined).not.toContain("KILO_BUNDLED_PROVIDERS")
    // createKilo may still appear in unrelated gateway package, but not in
    // opencode src loader definitions — the only loader reference was the
    // deleted KILO_BUNDLED_PROVIDERS entry.
    expect(combined).not.toContain('"@kilocode/kilo-gateway": async')
  })

  test("generic provider adapters and catalog artifacts remain (LOCK-006) — static source presence, not dynamic resolution proof", () => {
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/provider/models-api.json"))).toBe(true)
    expect(existsSync(join(opencode, "provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/models.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/provider/model-filter.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/model-cache.ts"))).toBe(false)
    // Provider handler now depends on catalog only (ModelCache removed from handler in P4.4-T7)
    const handler = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain("ModelsDev.Service")
    expect(handler).not.toContain("ModelCache.Service")
    expect(handler).toContain("Provider.Service")
    expect(handler).toContain("Config.Service")
    expect(handler).toContain("filterPromptTrainingModels")
    expect(handler).toContain("overlayAnacondaDesktop")
    expect(handler).toContain("Provider.toPublicInfo(item)")
    expect(handler).toContain("connected: Object.keys(connected)")
    expect(handler).toContain("failed,")
    // Custom provider lifecycle remains
    expect(existsSync(join(opencode, "kilocode/custom-provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-save.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-delete.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/provider-auth-lifecycle.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/auth.ts"))).toBe(true)
  })

  test("ModelsDev provider source remains — static source presence, not runtime fallback proof", () => {
    const models = read("provider/models.ts")
    expect(models).not.toContain("ModelCache")
    expect(models).toContain("overlay")
    expect(models).not.toContain("KILO_OPENROUTER_BASE")
    const providerSrc = read("provider/provider.ts")
    expect(providerSrc).toContain("fromModelsDevProvider")
    expect(providerSrc).toContain("ModelsDev.Service")
    expect(existsSync(join(opencode, "provider/model-cache.ts"))).toBe(false)
    // KILO constants for models snapshot remain
    expect(existsSync(join(opencode, "kilocode/provider/models-api.json"))).toBe(true)
    const kProvider = read("kilocode/provider/provider.ts")
    expect(kProvider).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    expect(kProvider).toContain("patchModelsDevModel")
  })

  test("provider group endpoint contract remains (HTTP/SSE bridge preserved per LOCK-009) — static endpoint presence", () => {
    const group = read("server/routes/instance/httpapi/groups/provider.ts")
    expect(group).toContain('HttpApiEndpoint.get("list"')
    expect(group).toContain('success: described(Provider.ListResult')
    expect(group).toContain('HttpApiEndpoint.get("auth"')
    expect(group).toContain('HttpApiEndpoint.post("authorize"')
    expect(group).toContain('HttpApiEndpoint.post("callback"')
    expect(group).toContain('root = "/provider"')
    const handler = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain('HttpApiBuilder.group(InstanceHttpApi, "provider"')
    expect(handler).toContain('.handle("list"')
    expect(handler).toContain('.handle("auth"')
    expect(handler).toContain('handleRaw("authorize"')
    expect(handler).toContain('.handle("callback"')
  })

  test("Provider schema retains optional metadata field (contract-compatible)", () => {
    const provider = read("provider/provider.ts")
    expect(provider).toContain("const ProviderMetadata = Schema.Struct")
    expect(provider).toContain("noteKey")
    expect(provider).toContain("icon")
    expect(provider).toContain("priority")
    expect(provider).toContain("metadata: optionalOmitUndefined(ProviderMetadata)")
    expect(provider).toContain("export const ListResult = Schema.Struct")
    expect(provider).toContain("all: Schema.Array(Info)")
  })

  test("test-profile lists the new removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
    expect(profile).toContain("p4-4-provider-metadata-removal")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const providerIdx = profile.indexOf("p4-4-provider-metadata-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(bundledIdx).toBeGreaterThan(-1)
    expect(managedIdx).toBeGreaterThan(-1)
    expect(primaryIdx).toBeGreaterThan(-1)
    expect(providerIdx).toBeGreaterThan(-1)
    expect(wellknownIdx).toBeGreaterThan(-1)
    expect(bundledIdx).toBeLessThan(managedIdx)
    expect(managedIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(providerIdx)
    expect(providerIdx).toBeLessThan(wellknownIdx)
  })
})
