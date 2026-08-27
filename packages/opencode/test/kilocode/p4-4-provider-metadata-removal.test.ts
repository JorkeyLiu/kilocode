import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T5 source-removal evidence — preset provider display metadata enrichment
// physically removed (LOCK-006 preset-only removal; LOCK-009 bridge preserved).
// - `packages/opencode/src/kilocode/provider/metadata.ts` deleted
//   (providerMetadata → noteKey/icon/priority preset mapping).
// - `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts`
//   import and `metadata: providerMetadata(item.id)` enrichment removed;
//   provider listing (`all`/`connected`/`default`/`failed`) and aggregation
//   (auth/model/config dependencies, endpoint wiring) retained.
// - Direct obsolete test `packages/opencode/test/kilocode/provider-metadata.test.ts`
//   deleted; this file is the focused absence/preservation regression.
// - Optional `providerMetadata` contract field remains (Provider.Info.metadata
//   optional in OpenAPI/SDK) and must stay contract-compatible when omitted;
//   webview `provider-catalog.ts` generic `icon`/`noteKey`/`synthetic` fallback
//   remains while preset `priority`/`popularity` fallback was removed by P4.4-T20.
// - Generic provider adapters, custom-provider save/delete/validation,
//   provider model/catalog loaders, auth lifecycle, and HTTP/SSE/generated SDK
//   bridge are preserved per LOCK-006/009.
// Spec anchors: runtime §8.1 row 9 (LOCK-006); tracker §7; matrix row 9.
// This file asserts absence of the preset enrichment and presence of the
// retained provider endpoint/generic/custom bridges; it does not claim P4.4
// completion.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}

function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 provider metadata removal — preset display metadata absent", () => {
  test("preset metadata helper module is deleted", () => {
    expect(existsSync(join(opencode, "kilocode/provider/metadata.ts"))).toBe(false)
  })

  test("direct obsolete provider-metadata.test.ts is deleted", () => {
    expect(existsSync(join(repo, "packages/opencode/test/kilocode/provider-metadata.test.ts"))).toBe(false)
  })

  test("no production source references kilocode/provider/metadata import surface", () => {
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
    expect(combined).not.toContain("kilocode/provider/metadata")
    expect(combined).not.toContain("providerMetadata(item.id)")
    expect(combined).not.toContain("from \"@/kilocode/provider/metadata\"")
    // The generic Provider schema field `metadata` is intentionally retained
    // (optional field on Provider.Info), so a bare `metadata` token may remain
    // in provider/provider.ts and the handler's Provider.toPublicInfo usage.
  })

  test("provider handler no longer enriches with preset metadata but retains listing wiring", () => {
    const handler = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).not.toContain("providerMetadata")
    expect(handler).not.toContain("kilocode/provider/metadata")
    // Enrichment removal — no spread plus metadata field
    expect(handler).not.toContain("metadata: providerMetadata")
    // Retained: provider listing aggregates all/connected/default/failed
    expect(handler).toContain("Provider.toPublicInfo(item)")
    expect(handler).toContain("all: Object.values(validProviders).map")
    expect(handler).toContain("connected: Object.keys(connected)")
    expect(handler).toContain("failed,")
    expect(handler).toContain("default: Provider.defaultModelIDs")
    // Retained dependencies: auth/model/config and endpoint wiring (ModelCache removed from handler in P4.4-T7)
    expect(handler).toContain("Config.Service")
    expect(handler).toContain("Provider.Service")
    expect(handler).toContain("ProviderAuth.Service")
    expect(handler).not.toContain("ModelCache.Service")
    expect(handler).toContain("ModelsDev.Service.use")
    expect(handler).toContain('HttpApiBuilder.group(InstanceHttpApi, "provider"')
    expect(handler).toContain('.handle("list"')
    expect(handler).toContain('.handle("auth"')
    expect(handler).toContain('handleRaw("authorize"')
    expect(handler).toContain('.handle("callback"')
  })

  test("Provider schema retains optional metadata field (contract-compatible when omitted)", () => {
    const provider = read("provider/provider.ts")
    // The optional display metadata struct is intentionally preserved for
    // contract compatibility — removal is only the preset enrichment.
    expect(provider).toContain("const ProviderMetadata = Schema.Struct")
    expect(provider).toContain("noteKey")
    expect(provider).toContain("icon")
    expect(provider).toContain("priority")
    expect(provider).toContain("metadata: optionalOmitUndefined(ProviderMetadata)")
    // ListResult shape is preserved
    expect(provider).toContain("export const ListResult = Schema.Struct")
    expect(provider).toContain("all: Schema.Array(Info)")
    expect(provider).toContain("connected: Schema.Array")
    expect(provider).toContain("failed: Schema.Array")
  })

  test("provider group endpoint contract remains (HTTP/SSE bridge preserved per LOCK-009)", () => {
    const group = read("server/routes/instance/httpapi/groups/provider.ts")
    expect(group).toContain('HttpApiEndpoint.get("list"')
    expect(group).toContain('success: described(Provider.ListResult')
    expect(group).toContain('HttpApiEndpoint.get("auth"')
    expect(group).toContain('HttpApiEndpoint.post("authorize"')
    expect(group).toContain('HttpApiEndpoint.post("callback"')
    expect(group).toContain('root = "/provider"')
  })

  test("generated OpenAPI keeps Provider metadata optional (not required) — contract unchanged", () => {
    const spec = readRepo("packages/sdk/openapi.json")
    const parsed = JSON.parse(spec)
    const schema = parsed.components?.schemas?.Provider
    expect(schema).toBeTruthy()
    expect(schema.properties.metadata).toBeTruthy()
    expect(schema.properties.metadata.type).toBe("object")
    // Optional: must not be in required array
    expect(schema.required).toEqual(expect.arrayContaining(["id", "name", "source", "env", "options", "models"]))
    expect(schema.required).not.toContain("metadata")
    expect(schema.required).not.toContain("providerMetadata")
  })

  test("generated SDK keeps Provider metadata optional (bridge preserved)", () => {
    const types = readRepo("packages/sdk/js/src/v2/gen/types.gen.ts")
    // Fragment-scoped to the Provider type — must not pass merely because
    // an unrelated generated type contains `metadata?:`.
    expect(types).toMatch(
      /export type Provider = \{\s*id: string[\s\S]*?metadata\?:\s*\{\s*noteKey\?: string[\s\S]*?icon\?: string[\s\S]*?priority\?: number/s,
    )
  })

  test("generic provider adapters and custom-provider paths remain (LOCK-006)", () => {
    // Bundled/provider catalog artifacts are intentionally retained in this unit
    // provider/model-cache.ts is deleted (LOCK-MODELCACHE-001) — no ModelCache boundary remains
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/provider/models-api.json"))).toBe(true)
    expect(existsSync(join(opencode, "provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/models.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/provider/model-filter.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/model-cache.ts"))).toBe(false)
    // Custom provider save/delete/validation remain
    expect(existsSync(join(opencode, "kilocode/custom-provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-save.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-delete.ts"))).toBe(true)
    // Auth lifecycle remains
    expect(existsSync(join(opencode, "kilocode/server/provider-auth-lifecycle.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/auth.ts"))).toBe(true)
    // Handler still uses generic adapters
    const handler = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain("filterPromptTrainingModels")
    expect(handler).toContain("Provider.fromModelsDevProvider")
    expect(handler).toContain("overlayAnacondaDesktop")
  })

  test("webview provider-catalog fallback remains (missing metadata handled)", () => {
    const catalog = readRepo("packages/kilo-vscode/webview-ui/src/components/settings/provider-catalog.ts")
    // Generic fallback when metadata is absent: synthetic icon retained; preset priority/catalog removed (T20 alphabetical)
    expect(catalog).toContain("provider.metadata?.icon")
    expect(catalog).toContain("provider.metadata?.noteKey")
    expect(catalog).toContain('return "synthetic"')
    expect(catalog).toContain("validIcon")
    expect(catalog).toContain("a.name.localeCompare(b.name)")
    expect(catalog).not.toContain("FALLBACK_PROVIDER_IDS")
    expect(catalog).not.toContain("PROVIDER_PRIORITY")
    expect(catalog).not.toContain("provider.metadata?.priority")
    expect(catalog).not.toContain("isPopularProvider")
    expect(catalog).not.toContain("providerOrderIndex")
  })

  test("test-profile lists the new removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-provider-metadata-removal")
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const providerIdx = profile.indexOf("p4-4-provider-metadata-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(managedIdx).toBeGreaterThan(-1)
    expect(primaryIdx).toBeGreaterThan(-1)
    expect(providerIdx).toBeGreaterThan(-1)
    expect(wellknownIdx).toBeGreaterThan(-1)
    expect(managedIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(providerIdx)
    expect(providerIdx).toBeLessThan(wellknownIdx)
  })
})
