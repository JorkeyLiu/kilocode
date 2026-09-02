import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4 residual-removal package (one cohesive unit): dead TUI migration helper
// `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts` physically removed
// and unused `Flag.KILO_TUI_CONFIG` getter removed. Canonical TUI loader
// `cli/cmd/tui/config/tui.ts` (global -> direct root -> <workspaceRoot>/.kilo via
// T27/T30) preserved; KILO_CONFIG_DIR bridge, sandbox, ConfigPaths.files,
// theme.tsx, and global transport untouched per LOCK-002/003/004.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 TUI migration helper removal — file and Flag.KILO_TUI_CONFIG absent, canonical preserved", () => {
  test("tui-migrate.ts file is absent (dead helper physically removed)", () => {
    const migratePath = join(opencode, "cli/cmd/tui/config/tui-migrate.ts")
    expect(existsSync(migratePath)).toBe(false)
  })

  test("no Flag.KILO_TUI_CONFIG definition or reader remains in Flag/core/opencode src", () => {
    const flag = readRepo("packages/core/src/flag/flag.ts")
    expect(flag).not.toContain("KILO_TUI_CONFIG")
    expect(flag).not.toContain('process.env["KILO_TUI_CONFIG"]')
    expect(flag).toContain("get KILO_CONFIG_DIR()")
    expect(flag).toContain('process.env["KILO_CONFIG_DIR"]')

    // Production opencode src has no Flag.KILO_TUI_CONFIG reader
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
    walk(join(repo, "packages/core/src"))
    // Strip allowed KILO_CONFIG_DIR variants before checking stray KILO_TUI_CONFIG
    const stripped = combined
      .replaceAll("Flag.KILO_CONFIG_DIR", "__KILO_CONFIG_DIR__")
      .replaceAll("Flag.KILO_DISABLE_PROJECT_CONFIG", "__KILO_DISABLE_PROJECT_CONFIG__")
      .replaceAll("Flag.KILO_DISABLE_DEFAULT_PLUGINS", "__KILO_DISABLE_DEFAULT_PLUGINS__")
    expect(stripped).not.toContain("KILO_TUI_CONFIG")
    expect(stripped).not.toContain("migrateTuiConfig")
    expect(stripped).not.toContain("tui-migrate")
  })

  test("tui.ts has no migrate import/call and no KILO_TUI_CONFIG/KILO_CONFIG_DIR legacy readers — canonical only", () => {
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(tui).not.toContain("tui-migrate")
    expect(tui).not.toContain("Flag.KILO_TUI_CONFIG")
    expect(tui).not.toContain("KILO_TUI_CONFIG")
    expect(tui).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).not.toContain("KILO_CONFIG_DIR")
    expect(tui).not.toContain('targets: [".kilocode", ".kilo"]')
    expect(tui).not.toContain('targets: [".kilo"')
    expect(tui).not.toContain("yield* afs.up")
    expect(tui).not.toContain("ConfigPaths.directories()")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).toContain('path.join(root, ".kilo")')
    expect(tui).toContain("workspaceKiloDir")
    expect(tui).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(tui).toContain("Global.Path.config")
    expect(tui).toContain("Canonical TUI config sources")
  })

  test("canonical Config.Service remains authority and ignores KILO_CONFIG", () => {
    const cfg = read("config/config.ts")
    expect(cfg).not.toContain("Flag.KILO_CONFIG ")
    expect(cfg).not.toContain("Flag.KILO_CONFIG)")
    expect(cfg).not.toContain("Flag.KILO_CONFIG,")
    expect(cfg.split("KILO_CONFIG_CONTENT").length).toBe(1)
    expect(cfg).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(cfg).toContain('path.join(Global.Path.config, "kilo.jsonc")')
    expect(cfg).toContain('".kilo", "kilo.jsonc"')
    expect(cfg).toContain("canonicalRoot")

    const kilo = read("kilocode/config/config.ts")
    expect(kilo).toContain('KILO_CONFIG_FILES = ["kilo.jsonc"]')
    expect(kilo).toContain('KILO_DIR_SUFFIXES = [".kilo"]')
  })

  test("ConfigPaths and instruction remain without KILO_CONFIG_DIR/KILO_TUI_CONFIG/migrate, no ancestor walk", () => {
    const paths = read("config/paths.ts")
    expect(paths).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(paths).not.toContain("KILO_CONFIG_DIR")
    expect(paths).toContain("Global.Path.config")
    expect(paths).toContain("return unique([Global.Path.config])")
    expect(paths).not.toContain('targets: [".kilo"]')
    expect(paths.split('targets: [".kilo"]').length - 1).toBe(0)
    expect(paths).not.toContain("Global.Path.home")
    expect(paths).not.toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(paths).not.toContain("void directory")
    expect(paths).toContain("export const files")
    expect(paths).toContain("fileInDirectory")
    expect(paths).toContain('export const directories = Effect.fn("ConfigPaths.directories")(function* ()')

    const instr = read("session/instruction.ts")
    expect(instr).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(instr).not.toContain("KILO_CONFIG_DIR")

    const kcfg = read("kilocode/tui/config.ts")
    expect(kcfg).not.toContain(".kilocode")
    expect(kcfg).not.toContain("Filesystem.findUp")
  })

  test("generated SDK/OpenAPI static absence of KILO_CONFIG_CONTENT (static preservation anchor — no KILO_CONFIG_CONTENT in generated files)", () => {
    const gen = readRepo("packages/sdk/js/src/gen/sdk.gen.ts")
    expect(gen).not.toContain("KILO_CONFIG_CONTENT")
    expect(gen).not.toContain("Flag.KILO_CONFIG")
    expect(gen).toContain("createClient")

    const v2gen = readRepo("packages/sdk/js/src/v2/gen/sdk.gen.ts")
    expect(v2gen).not.toContain("KILO_CONFIG_CONTENT")
    expect(v2gen).not.toContain("Flag.KILO_CONFIG")
    expect(v2gen).toContain("createClient")

    const openapi = readRepo("packages/sdk/openapi.json")
    expect(openapi).not.toContain("KILO_CONFIG_CONTENT")
    expect(openapi).toContain("/config")
    expect(openapi).toContain("/provider")
  })

  test("sandbox deny list still contains KILO_CONFIG (safety preserved)", () => {
    const policy = read("kilocode/sandbox/policy.ts")
    expect(policy).toContain('"KILO_CONFIG"')
    expect(policy).toContain('"KILO_CONFIG_DIR"')
    expect(policy).toContain('"KILO_CONFIG_CONTENT"')
  })

  test("provider/catalog custom-provider files present and BUNDLED_PROVIDERS retained (static source-presence anchor)", () => {
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/custom-provider.ts"))).toBe(true)
    const provider = read("provider/provider.ts")
    expect(provider).toContain("const BUNDLED_PROVIDERS")
  })

  test("test-profile lists the TUI migration removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-tui-migrate-kilo-config-removal")
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
    expect(profile).toContain("p4-4-tui-canonical-source-removal")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const flagIdx = profile.indexOf("p4-4-flag-legacy-getter-removal")
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const modelCacheIdx = profile.indexOf("p4-4-model-cache-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const loginIdx = profile.indexOf("p4-4-provider-login-preset-removal")
    const metadataIdx = profile.indexOf("p4-4-provider-metadata-removal")
    const sdkIdx = profile.indexOf("p4-4-sdk-config-forwarding-removal")
    const t16Idx = profile.indexOf("p4-4-t16-tui-legacy-discovery")
    const t18Idx = profile.indexOf("p4-4-t18-config-paths-kilo-config-dir-removal")
    const canonicalIdx = profile.indexOf("p4-4-tui-canonical-source-removal")
    const tuiIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(bundledIdx).toBeLessThan(flagIdx)
    expect(flagIdx).toBeLessThan(managedIdx)
    expect(managedIdx).toBeLessThan(modelCacheIdx)
    expect(modelCacheIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(loginIdx)
    expect(loginIdx).toBeLessThan(metadataIdx)
    expect(metadataIdx).toBeLessThan(sdkIdx)
    expect(sdkIdx).toBeLessThan(t16Idx)
    expect(t16Idx).toBeLessThan(t18Idx)
    expect(t18Idx).toBeLessThan(canonicalIdx)
    expect(canonicalIdx).toBeLessThan(tuiIdx)
    expect(tuiIdx).toBeLessThan(wellknownIdx)
  })
})
