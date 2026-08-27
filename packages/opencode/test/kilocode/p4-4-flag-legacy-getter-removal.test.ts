import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T21 + residual package (2026-08-27): dead legacy Flag entries
// physically removed (LOCK-001 P4.4 Active; no P4.5/transport/SDK expansion).
// - `packages/core/src/flag/flag.ts` deleted `KILO_CONFIG: process.env["KILO_CONFIG"]`,
//   `KILO_CONFIG_CONTENT: process.env["KILO_CONFIG_CONTENT"]`,
//   `get KILO_PERMISSION() { return process.env["KILO_PERMISSION"] }` (T21)
//   and `get KILO_TUI_CONFIG() { return process.env["KILO_TUI_CONFIG"] }` (residual package, zero production readers; canonical TUI loader preserved via T27/T30).
// - Preserved `get KILO_CONFIG_DIR()`, `Flag.KILO_CONFIG_DIR ?? Path.config`,
//   `KILO_CONFIG_DIR` sandbox deny, and ConfigPaths/files/theme/transport per LOCK-003/004.
// - No extension direct diagnostic `process.env` reads touched (out of scope).
// Spec anchors: runtime §8.1 rows 1,3,4; tracker §7; matrix rows 1,3,4 (row 2 updated for KILO_TUI_CONFIG deletion).

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4-T21 Flag legacy getter removal — dead entries absent, protected paths survive", () => {
  test("Flag definitions for KILO_CONFIG, KILO_CONFIG_CONTENT, KILO_PERMISSION, KILO_TUI_CONFIG are absent", () => {
    const src = readRepo("packages/core/src/flag/flag.ts")
    expect(src).not.toContain('KILO_CONFIG: process.env["KILO_CONFIG"]')
    expect(src).not.toContain("KILO_CONFIG: process.env")
    // KILO_CONFIG_CONTENT must be absent as Flag entry, but sandbox literal remains elsewhere
    expect(src).not.toContain('KILO_CONFIG_CONTENT: process.env["KILO_CONFIG_CONTENT"]')
    expect(src).not.toContain("KILO_CONFIG_CONTENT")
    expect(src).not.toContain("get KILO_PERMISSION")
    expect(src).not.toContain('process.env["KILO_PERMISSION"]')
    expect(src).not.toContain("KILO_PERMISSION")
    // KILO_TUI_CONFIG getter physically removed in residual package (zero production readers)
    expect(src).not.toContain("KILO_TUI_CONFIG")
    expect(src).not.toContain('process.env["KILO_TUI_CONFIG"]')
    // Protect: KILO_CONFIG_DIR getter remains exactly
    expect(src).toContain("get KILO_CONFIG_DIR()")
    expect(src).toContain('process.env["KILO_CONFIG_DIR"]')
    expect(src).toContain('return process.env["KILO_CONFIG_DIR"]')
  })

  test("no Flag.KILO_CONFIG / Flag.KILO_CONFIG_CONTENT / Flag.KILO_PERMISSION / Flag.KILO_TUI_CONFIG readers remain in opencode/src and core/src", () => {
    let combined = ""
    const flagPath = join(repo, "packages/core/src/flag/flag.ts")
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (full === flagPath) continue
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
    // Strip allowed KILO_CONFIG_DIR and other KILO_CONFIG-prefixed flags before checking stray KILO_CONFIG
    const stripped = combined
      .replaceAll("Flag.KILO_CONFIG_DIR", "__KILO_CONFIG_DIR__")
      .replaceAll("Flag.KILO_DISABLE_PROJECT_CONFIG", "__KILO_DISABLE_PROJECT_CONFIG__")
      .replaceAll("Flag.KILO_DISABLE_DEFAULT_PLUGINS", "__KILO_DISABLE_DEFAULT_PLUGINS__")
    expect(stripped).not.toContain("Flag.KILO_CONFIG")
    expect(stripped).not.toContain("Flag.KILO_PERMISSION")
    expect(stripped).not.toContain("Flag.KILO_CONFIG_CONTENT")
    expect(stripped).not.toContain("Flag.KILO_TUI_CONFIG")
    expect(stripped).not.toContain("KILO_TUI_CONFIG")
    // Protect: sandbox literals "KILO_CONFIG*" remain, so bare string check is not applicable here
    // Verify flag file itself has no remaining KILO_CONFIG definitions beyond KILO_CONFIG_DIR
    const flag = readRepo("packages/core/src/flag/flag.ts")
    const flagStripped = flag.replaceAll("KILO_CONFIG_DIR", "__DIR__")
    expect(flagStripped).not.toContain("KILO_CONFIG")
    expect(flagStripped).not.toContain("KILO_PERMISSION")
    expect(flagStripped).not.toContain("KILO_TUI_CONFIG")
  })

  test("Protected KILO_CONFIG_DIR / Global / sandbox / ConfigPaths survive — TUI canonical no KILO_CONFIG_DIR/KILO_TUI_CONFIG/migrate", () => {
    const flag = readRepo("packages/core/src/flag/flag.ts")
    expect(flag).toContain("get KILO_CONFIG_DIR()")
    expect(flag).toContain('process.env["KILO_CONFIG_DIR"]')

    const global = readRepo("packages/core/src/global.ts")
    expect(global).toContain("Flag.KILO_CONFIG_DIR ?? Path.config")
    expect(global).toContain('from "./flag/flag"')
    expect(global).toContain("config: Flag.KILO_CONFIG_DIR ?? Path.config")

    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).not.toContain("KILO_CONFIG_DIR")
    expect(tui).not.toContain("Flag.KILO_TUI_CONFIG")
    expect(tui).not.toContain("KILO_TUI_CONFIG")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(tui).not.toContain('targets: [".kilocode", ".kilo"]')
    expect(tui).not.toContain("yield* afs.up")
    expect(tui).not.toContain(".kilocode")
    expect(tui).not.toContain("ConfigPaths.directories()")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).toContain("Global.Path.config")
    expect(tui).toContain('path.join(root, ".kilo")')
    expect(tui).toContain("workspaceKiloDir")
    expect(tui).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(tui).toContain("Canonical TUI config sources")
    const kcfg = read("kilocode/tui/config.ts")
    expect(kcfg).not.toContain(".kilocode")
    expect(kcfg).not.toContain("Filesystem.findUp")

    const policy = read("kilocode/sandbox/policy.ts")
    expect(policy).toContain('"KILO_CONFIG"')
    expect(policy).toContain('"KILO_CONFIG_CONTENT"')
    expect(policy).toContain('"KILO_CONFIG_DIR"')
    expect(policy).toContain("environment: {")
    expect(policy).toContain("deny:")

    const paths = read("config/paths.ts")
    expect(paths).toContain("return unique([Global.Path.config])")
    expect(paths).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(paths).not.toContain("KILO_CONFIG_DIR")
    expect(paths).toContain("Global.Path.config")
    expect(paths).toContain('export const directories = Effect.fn("ConfigPaths.directories")(function* ()')
    expect(paths).not.toContain('targets: [".kilo"]')

    const cfg = read("config/config.ts")
    expect(cfg).not.toContain("Flag.KILO_CONFIG")
    expect(cfg).not.toContain("Flag.KILO_PERMISSION")
    expect(cfg.split("KILO_CONFIG_CONTENT").length).toBe(1)
  })

  test("Config.Service and instruction remain without legacy Flag readers — tui-migrate file absent", () => {
    const cfg = read("config/config.ts")
    expect(cfg).not.toContain("Flag.KILO_CONFIG")
    expect(cfg).not.toContain("Flag.KILO_PERMISSION")
    const instr = read("session/instruction.ts")
    expect(instr).not.toContain("Flag.KILO_CONFIG")
    expect(instr).not.toContain("Flag.KILO_PERMISSION")
    expect(instr).not.toContain("KILO_CONFIG_CONTENT")
    expect(instr).not.toContain("Flag.KILO_CONFIG_CONTENT")
    const migratePath = join(opencode, "cli/cmd/tui/config/tui-migrate.ts")
    expect(existsSync(migratePath)).toBe(false)
  })

  test("generated SDK and OpenAPI unchanged — no KILO_CONFIG_CONTENT forwarding (static, descriptive)", () => {
    const wrappers = ["packages/sdk/js/src/server.ts", "packages/sdk/js/src/v2/server.ts"]
    for (const rel of wrappers) {
      const src = readRepo(rel)
      expect(src).not.toContain("KILO_CONFIG_CONTENT")
      expect(src).not.toContain("buildConfigEnv")
      expect(src).toContain("...process.env")
      expect(src).toContain("createKiloServer")
    }
    const gen = readRepo("packages/sdk/js/src/gen/sdk.gen.ts")
    expect(gen).not.toContain("KILO_CONFIG_CONTENT")
    expect(gen).not.toContain("buildConfigEnv")
    expect(gen).toContain("createClient")
    const v2gen = readRepo("packages/sdk/js/src/v2/gen/sdk.gen.ts")
    expect(v2gen).not.toContain("KILO_CONFIG_CONTENT")
    expect(v2gen).not.toContain("buildConfigEnv")
    expect(v2gen).toContain("createClient")
    const openapi = readRepo("packages/sdk/openapi.json")
    expect(openapi).not.toContain("KILO_CONFIG_CONTENT")
    expect(openapi).not.toContain("buildConfigEnv")
    expect(openapi).toContain("/config")
    expect(openapi).toContain("/provider")
  })

  test("test-profile lists T21 regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-flag-legacy-getter-removal")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-model-cache-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
    expect(profile).toContain("p4-4-provider-login-preset-removal")
    expect(profile).toContain("p4-4-provider-metadata-removal")
    expect(profile).toContain("p4-4-sdk-config-forwarding-removal")
    expect(profile).toContain("p4-4-t16-tui-legacy-discovery")
    expect(profile).toContain("p4-4-t18-config-paths-kilo-config-dir-removal")
    expect(profile).toContain("p4-4-tui-canonical-source-removal")
    expect(profile).toContain("p4-4-tui-migrate-kilo-config-removal")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const flagIdx = profile.indexOf("p4-4-flag-legacy-getter-removal")
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const modelCacheIdx = profile.indexOf("p4-4-model-cache-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const loginIdx = profile.indexOf("p4-4-provider-login-preset-removal")
    const providerIdx = profile.indexOf("p4-4-provider-metadata-removal")
    const sdkIdx = profile.indexOf("p4-4-sdk-config-forwarding-removal")
    const t16Idx = profile.indexOf("p4-4-t16-tui-legacy-discovery")
    const t18Idx = profile.indexOf("p4-4-t18-config-paths-kilo-config-dir-removal")
    const canonicalIdx = profile.indexOf("p4-4-tui-canonical-source-removal")
    const tuiIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(bundledIdx).toBeGreaterThan(-1)
    expect(flagIdx).toBeGreaterThan(-1)
    expect(bundledIdx).toBeLessThan(flagIdx)
    expect(flagIdx).toBeLessThan(managedIdx)
    expect(managedIdx).toBeLessThan(modelCacheIdx)
    expect(modelCacheIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(loginIdx)
    expect(loginIdx).toBeLessThan(providerIdx)
    expect(providerIdx).toBeLessThan(sdkIdx)
    expect(sdkIdx).toBeLessThan(t16Idx)
    expect(t16Idx).toBeLessThan(t18Idx)
    expect(t18Idx).toBeLessThan(canonicalIdx)
    expect(canonicalIdx).toBeLessThan(tuiIdx)
    expect(tuiIdx).toBeLessThan(wellknownIdx)
  })
})
