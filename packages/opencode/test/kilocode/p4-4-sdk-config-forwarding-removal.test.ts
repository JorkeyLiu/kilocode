import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T9 source-removal evidence — handwritten SDK `KILO_CONFIG_CONTENT`
// forwarding physically removed (LOCK-010 canonical file authority; LOCK-009
// HTTP/SSE/generated-SDK bridge preserved; LOCK-006/014 bounded removal).
// - Retired launch helpers `packages/sdk/js/src/server.ts` and
//   `packages/sdk/js/src/v2/server.ts` (`createKiloServer`/`createKiloTui`,
//   `createKilo` wrappers, `launch('kilo')`) plus `src/process.ts` removed:
//   they hardcoded the retired `kilo` binary with no override and are unrelated
//   to the extension-owned private `kilo-serve` runtime.
// - Direct obsolete test `packages/sdk/js/test/server.test.ts` and legacy
//   `packages/sdk/js/example/example.ts` removed with them.
// - Generated SDK (`packages/sdk/js/src/gen/*`, `v2/gen/*`) and OpenAPI
//   (`packages/sdk/openapi.json`) unchanged; HTTP/SSE transport contracts,
//   custom-provider/plugin/auth, sandbox deny list, canonical config loader
//   remain per LOCK-006/009/010.
// Spec anchors: runtime §8.1 row 3 (LOCK-010); tracker §7; matrix row 3/10/11.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 SDK wrapper KILO_CONFIG_CONTENT forwarding removal — handwritten surface absent", () => {
  test("retired SDK launch helpers are absent (no server/tui spawn surface)", () => {
    for (const rel of [
      "packages/sdk/js/src/server.ts",
      "packages/sdk/js/src/v2/server.ts",
      "packages/sdk/js/src/process.ts",
    ]) {
      expect(existsSync(join(repo, rel))).toBe(false)
    }
    // no launcher symbols, retired binary spawn, or wrapper env forwarding remain
    // in the handwritten SDK surface (generated src/gen excluded)
    let combined = ""
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          if (entry.name === "gen") continue
          walk(full)
        } else if (entry.name.endsWith(".ts")) {
          combined += readFileSync(full, "utf8") + "\n"
        }
      }
    }
    walk(join(repo, "packages/sdk/js/src"))
    expect(combined).not.toContain("createKiloServer")
    expect(combined).not.toContain("createKiloTui")
    expect(combined).not.toContain("ServerOptions")
    expect(combined).not.toContain("TuiOptions")
    expect(combined).not.toContain("cross-spawn")
    expect(combined).not.toContain("mergeConfig")
    expect(combined).not.toContain("parseExistingConfig")
    expect(combined).not.toContain("buildConfigEnv")
    expect(combined).not.toContain("KILO_CONFIG_CONTENT")
    // client entry remains the only handwritten surface, without server re-export
    const index = readRepo("packages/sdk/js/src/index.ts")
    expect(index).toContain("./client.js")
    expect(index).not.toContain("./server.js")
    expect(index).not.toContain("createKiloServer")
    const v2index = readRepo("packages/sdk/js/src/v2/index.ts")
    expect(v2index).toContain("./client.js")
    expect(v2index).not.toContain("./server.js")
    expect(v2index).not.toContain("createKiloServer")
    // package exports expose no server subpath
    const pkg = JSON.parse(readRepo("packages/sdk/js/package.json"))
    expect(pkg.exports["./server"]).toBeUndefined()
    expect(pkg.exports["./v2/server"]).toBeUndefined()
    expect(pkg.exports["."]).toBeDefined()
    expect(pkg.exports["./client"]).toBeDefined()
  })

  test("no production opencode source references SDK wrapper buildConfigEnv helpers", () => {
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
    expect(combined).not.toContain("buildConfigEnv")
    // SDK wrapper helpers are handwritten SDK only; opencode src should not contain them
    expect(combined).not.toContain("parseExistingConfig")
    // opencode's own KILO_CONFIG_CONTENT handling is only sandbox deny, not loader
    const cfg = read("config/config.ts")
    expect(cfg.split("KILO_CONFIG_CONTENT").length).toBe(1)
  })

  test("retired SDK launcher test and example are absent (client regression remains)", () => {
    expect(existsSync(join(repo, "packages/sdk/js/test/server.test.ts"))).toBe(false)
    expect(existsSync(join(repo, "packages/sdk/js/example/example.ts"))).toBe(false)
    // client regression preserved
    expect(existsSync(join(repo, "packages/sdk/js/test/config-preservation.test.ts"))).toBe(true)
    const client = readRepo("packages/sdk/js/src/client.ts")
    expect(client).toContain("createKiloClient")
    const v2client = readRepo("packages/sdk/js/src/v2/client.ts")
    expect(v2client).toContain("createKiloClient")
  })

  test("generated SDK and OpenAPI unchanged (HTTP/SSE bridge preserved per LOCK-009)", () => {
    // handwritten wrappers are not generated; generated SDK must not contain wrapper helpers
    const gen = readRepo("packages/sdk/js/src/gen/sdk.gen.ts")
    expect(gen).not.toContain("buildConfigEnv")
    expect(gen).not.toContain("KILO_CONFIG_CONTENT")
    expect(gen).toContain("createClient")

    const v2gen = readRepo("packages/sdk/js/src/v2/gen/sdk.gen.ts")
    expect(v2gen).not.toContain("buildConfigEnv")
    expect(v2gen).not.toContain("KILO_CONFIG_CONTENT")
    expect(v2gen).toContain("createClient")

    const genTypes = readRepo("packages/sdk/js/src/gen/types.gen.ts")
    expect(genTypes).toContain("export type Config")
    const v2Types = readRepo("packages/sdk/js/src/v2/gen/types.gen.ts")
    expect(v2Types).toContain("export type Config")

    const openapi = readRepo("packages/sdk/openapi.json")
    expect(openapi).not.toContain("KILO_CONFIG_CONTENT")
    expect(openapi).not.toContain("buildConfigEnv")
    // provider/config endpoints remain
    expect(openapi).toContain("/provider")
    expect(openapi).toContain("/config")
  })

  test("canonical Config.Service remains authority and ignores KILO_CONFIG_CONTENT (LOCK-010)", () => {
    const cfg = read("config/config.ts")
    expect(cfg).not.toContain("Flag.KILO_CONFIG_CONTENT")
    expect(cfg.split("KILO_CONFIG_CONTENT").length).toBe(1)
    expect(cfg).not.toContain("process.env.KILO_CONFIG_CONTENT")
    // canonical loader remains
    expect(cfg).toContain('path.join(Global.Path.config, "kilo.jsonc")')
    expect(cfg).toContain('".kilo", "kilo.jsonc"')
    expect(cfg).toContain("ConfigAgent.load")
    expect(cfg).toContain("canonicalRoot")

    const kilo = read("kilocode/config/config.ts")
    expect(kilo).toContain('KILO_CONFIG_FILES = ["kilo.jsonc"]')
    expect(kilo).toContain('KILO_DIR_SUFFIXES = [".kilo"]')

    const overlay = read("kilocode/config/overlay.ts")
    expect(overlay).toContain('const files = ["kilo.jsonc"]')
  })

  test("sandbox deny list still contains KILO_CONFIG_CONTENT (safety preserved per LOCK-010 scope)", () => {
    const policy = read("kilocode/sandbox/policy.ts")
    expect(policy).toContain('"KILO_CONFIG_CONTENT"')
    expect(policy).toContain('"KILO_CONFIG"')
    expect(policy).toContain('"KILO_CONFIG_DIR"')
    expect(policy).toContain("environment: {")
    expect(policy).toContain("deny:")
    // filesystem deny still present
    expect(policy).toContain("SandboxStore.root")
    expect(policy).toContain("SandboxPreference.root")

    const policyTest = readRepo("packages/opencode/test/kilocode/sandbox/policy.test.ts")
    expect(policyTest).toContain('"KILO_CONFIG_CONTENT"')
  })

  test("custom-provider/plugin/auth paths untouched (LOCK-006)", () => {
    expect(existsSync(join(opencode, "kilocode/custom-provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-save.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-delete.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/provider.ts"))).toBe(true)
    const provider = read("provider/provider.ts")
    expect(provider).toContain("const BUNDLED_PROVIDERS")
  })

  test("test-profile lists the new SDK forwarding removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-sdk-config-forwarding-removal")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-flag-legacy-getter-removal")
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-model-cache-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
    expect(profile).toContain("p4-4-provider-login-preset-removal")
    expect(profile).toContain("p4-4-provider-metadata-removal")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const flagIdx = profile.indexOf("p4-4-flag-legacy-getter-removal")
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const modelCacheIdx = profile.indexOf("p4-4-model-cache-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const loginIdx = profile.indexOf("p4-4-provider-login-preset-removal")
    const metadataIdx = profile.indexOf("p4-4-provider-metadata-removal")
    const sdkIdx = profile.indexOf("p4-4-sdk-config-forwarding-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(bundledIdx).toBeLessThan(flagIdx)
    expect(flagIdx).toBeLessThan(managedIdx)
    expect(managedIdx).toBeLessThan(modelCacheIdx)
    expect(modelCacheIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(loginIdx)
    expect(loginIdx).toBeLessThan(metadataIdx)
    expect(metadataIdx).toBeLessThan(sdkIdx)
    expect(sdkIdx).toBeLessThan(wellknownIdx)
  })
})
