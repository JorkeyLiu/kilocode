import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T9 source-removal evidence — handwritten SDK `KILO_CONFIG_CONTENT`
// forwarding physically removed (LOCK-010 canonical file authority; LOCK-009
// HTTP/SSE/generated-SDK bridge preserved; LOCK-006/014 bounded removal).
// - `packages/sdk/js/src/server.ts` and `packages/sdk/js/src/v2/server.ts`
//   handwritten wrappers no longer contain `mergeConfig`, `parseExistingConfig`,
//   `buildConfigEnv`, or `KILO_CONFIG_CONTENT` env forwarding.
// - Direct obsolete test `packages/sdk/js/test/server.test.ts` buildConfigEnv
//   suite removed; new SDK P4.4-T9 regression covers wrapper absence.
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
  test("handwritten SDK wrappers have no merge helpers or KILO_CONFIG_CONTENT forwarding", () => {
    const wrappers = ["packages/sdk/js/src/server.ts", "packages/sdk/js/src/v2/server.ts"]
    for (const rel of wrappers) {
      const src = readRepo(rel)
      expect(src).not.toContain("mergeConfig")
      expect(src).not.toContain("parseExistingConfig")
      expect(src).not.toContain("buildConfigEnv")
      expect(src).not.toContain("KILO_CONFIG_CONTENT")
      expect(src).not.toContain("parseExistingConfig()")
      // preserves server spawning surface and canonical config passthrough via logLevel arg
      expect(src).toContain("createKiloServer")
      expect(src).toContain("createKiloTui")
      expect(src).toContain("...process.env")
      expect(src).toContain("logLevel")
      // Config import remains for ServerOptions/TuiOptions logLevel passthrough
      expect(src).toContain('from "./gen/types.gen.js"')
      expect(src).toContain("type Config")
      // no kilocode_change marker for the removed forwarding should remain
      expect(src).not.toContain("KILO_CONFIG_CONTENT: buildConfigEnv")
    }
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

  test("SDK test suite no longer contains buildConfigEnv merging assertions", () => {
    const sdkTest = readRepo("packages/sdk/js/test/server.test.ts")
    expect(sdkTest).not.toContain('from "../src/server"')
    expect(sdkTest).not.toContain("describe(\"buildConfigEnv\"")
    expect(sdkTest).not.toContain("process.env.KILO_CONFIG_CONTENT")
    expect(sdkTest).not.toContain("originalEnv")
    // new P4.4-T9 wrapper-absence regression remains
    expect(sdkTest).toContain("KILO_CONFIG_CONTENT forwarding removed")
    expect(sdkTest).toContain("createKiloServer")
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
