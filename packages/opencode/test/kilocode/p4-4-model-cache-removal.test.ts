import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4 residual cleanup — ModelCache service physically deleted (LOCK-MODELCACHE-001)
// - `packages/opencode/src/provider/model-cache.ts` deleted
// - app runtime and server AppOptions no longer expose ModelCache injection seam
// - provider-auth lifecycle, custom-provider save/delete, Anaconda service no longer reference ModelCache
// - Generic catalog `models-api.json` / `core/src/models-dev.ts` / BUNDLED_PROVIDERS / KILO_MODEL_SCHEMA_EXTENSIONS preserved
// Spec anchors: LOCK-006, LOCK-009.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 ModelCache residual removal — file deleted", () => {
  test("provider/model-cache.ts file no longer exists", () => {
    expect(existsSync(join(opencode, "provider/model-cache.ts"))).toBe(false)
  })

  test("no production source references ModelCache", () => {
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
    expect(combined).not.toContain("ModelCache")
    expect(combined).not.toContain("@kilocode/ModelCache")
    expect(combined).not.toContain("model-cache")
  })

  test("no test source references ModelCache except this regression file's own absence checks", () => {
    let combined = ""
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
    const filtered = combined
      .split("\n")
      .filter((line) => !line.includes('not.toContain("ModelCache') && !line.includes("not.toContain('provider/model-cache"))
      .join("\n")
    expect(filtered).not.toContain('from "@/provider/model-cache"')
    expect(filtered).not.toContain('from "../../src/provider/model-cache"')
    expect(filtered).not.toContain("ModelCache.Service")
    expect(filtered).not.toContain("ModelCache.defaultLayer")
  })

  test("app runtime no longer exposes ModelCache injection seam", () => {
    const src = read("effect/app-runtime.ts")
    expect(src).not.toContain("ModelCache")
    expect(src).not.toContain("modelCache")
    expect(src).not.toContain("ModelCacheLayer")
    expect(src).toContain("buildCoreLayer")
    expect(src).toContain("makeAppLayer")
  })

  test("server AppOptions no longer exposes ModelCache injection seam", () => {
    const src = read("server/routes/instance/httpapi/server.ts")
    expect(src).not.toContain("ModelCache")
    expect(src).not.toContain("modelCache")
    expect(src).toContain("AppOptions")
    expect(src).toContain("resolveApp")
  })

  test("provider-auth lifecycle no longer references ModelCache", () => {
    const src = read("kilocode/server/provider-auth-lifecycle.ts")
    expect(src).not.toContain("ModelCache")
    expect(src).not.toContain("cache.clear")
  })

  test("custom-provider save/delete and Anaconda service no longer reference ModelCache", () => {
    expect(read("kilocode/server/custom-provider-save.ts")).not.toContain("ModelCache")
    expect(read("kilocode/server/custom-provider-delete.ts")).not.toContain("ModelCache")
    expect(read("kilocode/anaconda-desktop/service.ts")).not.toContain("ModelCache")
  })

  test("generic catalog and provider artifacts remain (LOCK-006) — updated P4.4-G2: preset catalog deleted, adapters retained", () => {
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    // P4.4-G2 deletes preset catalog per LOCK-006
    expect(existsSync(join(opencode, "kilocode/provider/models-api.json"))).toBe(false)
    expect(existsSync(join(opencode, "provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/models.ts"))).toBe(false)
    expect(existsSync(resolve(join(repo, "packages/core/src/models-dev.ts")))).toBe(false)
    const provider = read("provider/provider.ts")
    expect(provider).toContain("const BUNDLED_PROVIDERS")
    expect(provider).toContain('"@ai-sdk/openai"')
    const kilo = read("kilocode/provider/provider.ts")
    expect(kilo).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    // patchModelsDevModel was catalog-specific and removed with G2; patchConfigModel retained
    expect(kilo).toContain("patchConfigModel")
  })

  test("provider group endpoint contract remains (LOCK-009)", () => {
    const group = read("server/routes/instance/httpapi/groups/provider.ts")
    expect(group).toContain('HttpApiEndpoint.get("list"')
    expect(group).toContain('HttpApiEndpoint.get("auth"')
    expect(group).toContain('HttpApiEndpoint.post("authorize"')
    expect(group).toContain('HttpApiEndpoint.post("callback"')
  })

  test("test-profile lists the removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-model-cache-removal")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-managed-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const modelCacheIdx = profile.indexOf("p4-4-model-cache-removal")
    const providerIdx = profile.indexOf("p4-4-provider-metadata-removal")
    expect(bundledIdx).toBeGreaterThan(-1)
    expect(modelCacheIdx).toBeGreaterThan(-1)
    expect(bundledIdx).toBeLessThan(modelCacheIdx)
    expect(modelCacheIdx).toBeLessThan(providerIdx)
  })
})
