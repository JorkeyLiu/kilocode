import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T23 source-removal evidence — obsolete preset-Kilo presence
// invalidation helper physically removed (LOCK-008; LOCK-001 P4.4 Active;
// LOCK-002/005/006/007 preserved).
// - `packages/opencode/src/kilocode/server/provider-auth-lifecycle.ts` deleted
//   `KiloViewers` import and `invalidatePresence` helper (preset-only
//   `providerID === "kilo"` invalidation branch).
// - `packages/opencode/src/server/routes/instance/httpapi/handlers/control.ts`
//   removed `invalidatePresence` import and the two guarded
//   `providerID === "kilo"` calls (authSet/authRemove).
// - `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts`
//   removed `invalidatePresence` import and the single guarded
//   `providerID === "kilo"` call (callback).
// - Generic lifecycle preserved: `invalidateAfterProviderAuthChange`,
//   rollback/fence and disabled-provider semantics,
//   `ConfigRollbackFailed`, `withColdMutation`, `cleanupDisabled`,
//   `disabled_providers`; `KiloViewers` service/layer and all other KILO
//   identifier logic untouched; `presence/service.ts`, `effect/app-runtime.ts`,
//   SDK/OpenAPI, TUI/migration remain unchanged per LOCK-005/007.
// Spec anchors: tracker §7 row 9 / matrix row 9 provider residue;
// LOCK-008 scope is only preset `invalidatePresence` helper + 3 branches.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4-T23 presence invalidation removal — preset helper absent, generic lifecycle preserved", () => {
  test("provider-auth-lifecycle has no KiloViewers import nor invalidatePresence helper", () => {
    const src = read("kilocode/server/provider-auth-lifecycle.ts")
    expect(src).not.toContain("KiloViewers")
    expect(src).not.toContain("invalidatePresence")
    expect(src).not.toContain("kilocode/presence/service")
    expect(src).not.toContain("presence/service")
    expect(src).not.toContain("invalidateAuth")
    // helper export must be gone
    expect(src).not.toContain("export const invalidatePresence")
    expect(src).not.toContain('KiloServer.invalidatePresence')
  })

  test("control and provider handlers have no invalidatePresence import or kilo guard", () => {
    const control = read("server/routes/instance/httpapi/handlers/control.ts")
    expect(control).not.toContain("invalidatePresence")
    expect(control).not.toContain('providerID === "kilo"')
    expect(control).not.toContain("=== \"kilo\"")
    expect(control).not.toContain("KiloViewers")
    // generic lifecycle remains
    expect(control).toContain("invalidateAfterProviderAuthChange")
    expect(control).toContain("from \"@/kilocode/server/provider-auth-lifecycle\"")
    expect(control).toContain("auth.set")
    expect(control).toContain("auth.remove")
    expect(control).toContain("cleanupDisabled: true")
    // authRemove intentionally does NOT request cleanup — exactly one true remains
    expect((control.match(/cleanupDisabled/g) ?? []).length).toBe(1)

    const provider = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(provider).not.toContain("invalidatePresence")
    expect(provider).not.toContain('providerID === "kilo"')
    expect(provider).not.toContain("=== \"kilo\"")
    expect(provider).not.toContain("KiloViewers")
    expect(provider).toContain("invalidateAfterProviderAuthChange")
    expect(provider).toContain("from \"@/kilocode/server/provider-auth-lifecycle\"")
    expect(provider).toContain("svc.callback")
    expect(provider).toContain("cleanupDisabled: true")
    expect((provider.match(/cleanupDisabled/g) ?? []).length).toBe(1)
  })

  test("no production opencode source contains invalidatePresence", () => {
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
    expect(combined).not.toContain("invalidatePresence")
  })

  test("generic auth lifecycle primitives remain", () => {
    const lifecycle = read("kilocode/server/provider-auth-lifecycle.ts")
    expect(lifecycle).toContain("export const invalidateAfterProviderAuthChange")
    expect(lifecycle).toContain('Effect.fn("KiloServer.invalidateAfterProviderAuthChange")')
    expect(lifecycle).not.toContain("ModelCache")
    expect(lifecycle).not.toContain("cache.clear")
    expect(lifecycle).toContain("ConfigRollbackFailed")
    expect(lifecycle).toContain("withColdMutation")
    expect(lifecycle).toContain("cleanupDisabled")
    expect(lifecycle).toContain("disabled_providers")
    expect(lifecycle).toContain("Auth.snapshotFile")
    expect(lifecycle).toContain("Auth.restoreFile")
    expect(lifecycle).toContain("restoreTarget")
    expect(lifecycle).not.toContain("ModelCache.Service")
    expect(lifecycle).toContain("FSUtil.Service")
    expect(lifecycle).toContain("Config.Service")
    expect(lifecycle).toContain("KilocodeConfig")
    expect(lifecycle).toContain("configDiscoveryGlobalKey")
    expect(lifecycle).toContain("invalidateAfterProviderAuthChange")
    // provider handler retains generic provider surface (G2: ModelsDev/overlay removed)
    const provider = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(provider).toContain("ProviderAuth.Service")
    expect(provider).not.toContain("ModelsDev.Service")
    expect(provider).toContain("filterPromptTrainingModels")
    expect(provider).not.toContain("overlayAnacondaDesktop")
    expect(provider).toContain("Provider.toPublicInfo")
    const control = read("server/routes/instance/httpapi/handlers/control.ts")
    expect(control).toContain("Auth.Service")
    expect(control).toContain("Log.create")
  })

  test("KiloViewers service/layer and AppLayer provisioning preserved", () => {
    const presence = read("kilocode/presence/service.ts")
    expect(presence).toContain("export namespace KiloViewers")
    expect(presence).toContain("class Service extends Context.Service")
    expect(presence).toContain("export const layer")
    expect(presence).toContain("defaultLayer")
    expect(presence).toContain("update")
    expect(presence).toContain("invalidateAuth")
    expect(presence).toContain("visibleUnion")
    expect(presence).toContain("EventServiceClient")
    // auth lookup for kilo remains independently used
    expect(presence).toContain('auth.get("kilo")')
    expect(presence).toContain("KILO_API_KEY")
    expect(presence).toContain("KILO_EVENT_SERVICE_URL")

    const runtime = readRepo("packages/opencode/src/effect/app-runtime.ts")
    expect(runtime).toContain("KiloViewers")
    expect(runtime).toContain("KiloViewers.defaultLayer")
    expect(runtime).toContain("kilocode/presence/service")

    // provider-auth-lifecycle no longer pulls KiloViewers, but presence service still provides it
    const lifecycle = read("kilocode/server/provider-auth-lifecycle.ts")
    expect(lifecycle).not.toContain("KiloViewers")
  })

  test("other KILO identifier handling untouched per LOCK-008 scope", () => {
    // presence/service still handles kilo auth token extraction
    const presence = read("kilocode/presence/service.ts")
    expect(presence).toContain('auth.get("kilo")')
    // kilocode provider schema extensions still present (not removed in this unit)
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    const kiloProvider = read("kilocode/provider/provider.ts")
    expect(kiloProvider).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    // models-api snapshot deleted in G2 — absence preserved, custom paths remain
    expect(existsSync(join(opencode, "kilocode/provider/models-api.json"))).toBe(false)
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    expect(kiloProvider).toContain("patchConfigModel")
    // custom-provider still via generic lifecycle, model-cache deleted
    expect(existsSync(join(opencode, "kilocode/server/provider-auth-lifecycle.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/model-cache.ts"))).toBe(false)
  })

  test("presence service file untouched per scope (no endpoint/contract change)", () => {
    const presence = read("kilocode/presence/service.ts")
    // file retains full service surface, not deleted
    expect(presence.length).toBeGreaterThan(1000)
    expect(presence).toContain("export namespace KiloViewers")
    expect(existsSync(join(opencode, "kilocode/presence/service.ts"))).toBe(true)
    // SDK/OpenAPI unchanged — no presence endpoint to regenerate
    const sdkGen = readRepo("packages/sdk/js/src/gen/sdk.gen.ts")
    expect(sdkGen).toContain("createClient")
    const openapi = readRepo("packages/sdk/openapi.json")
    expect(openapi).toContain("/provider")
  })

  test("test-profile lists new presence regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-presence-invalidation-removal")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-flag-legacy-getter-removal")
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-model-cache-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
    expect(profile).toContain("p4-4-provider-login-preset-removal")
    expect(profile).toContain("p4-4-provider-metadata-removal")
    expect(profile).toContain("p4-4-sdk-config-forwarding-removal")
    expect(profile).toContain("p4-4-t16-tui-legacy-discovery")
    expect(profile).toContain("p4-4-t18-config-paths-kilo-config-dir-removal")
    expect(profile).toContain("p4-4-tui-migrate-kilo-config-removal")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const flagIdx = profile.indexOf("p4-4-flag-legacy-getter-removal")
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const modelCacheIdx = profile.indexOf("p4-4-model-cache-removal")
    const presenceIdx = profile.indexOf("p4-4-presence-invalidation-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const loginIdx = profile.indexOf("p4-4-provider-login-preset-removal")
    const providerIdx = profile.indexOf("p4-4-provider-metadata-removal")
    const sdkIdx = profile.indexOf("p4-4-sdk-config-forwarding-removal")
    const t16Idx = profile.indexOf("p4-4-t16-tui-legacy-discovery")
    const t18Idx = profile.indexOf("p4-4-t18-config-paths-kilo-config-dir-removal")
    const tuiIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(bundledIdx).toBeLessThan(flagIdx)
    expect(flagIdx).toBeLessThan(managedIdx)
    expect(managedIdx).toBeLessThan(modelCacheIdx)
    expect(modelCacheIdx).toBeLessThan(presenceIdx)
    expect(presenceIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(loginIdx)
    expect(loginIdx).toBeLessThan(providerIdx)
    expect(providerIdx).toBeLessThan(sdkIdx)
    expect(sdkIdx).toBeLessThan(t16Idx)
    expect(t16Idx).toBeLessThan(t18Idx)
    expect(t18Idx).toBeLessThan(tuiIdx)
    expect(tuiIdx).toBeLessThan(wellknownIdx)
  })
})
