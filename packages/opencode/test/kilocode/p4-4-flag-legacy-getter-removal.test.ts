import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T21 source-removal evidence — dead legacy effective-config Flag entries
// physically removed (LOCK-001 P4.4 Active; LOCK-010 KILO_CONFIG_DIR last-wins;
// LOCK-011 lifecycle; no P4.5/transport/SDK expansion).
// - `packages/core/src/flag/flag.ts` deleted `KILO_CONFIG: process.env["KILO_CONFIG"]`,
//   `KILO_CONFIG_CONTENT: process.env["KILO_CONFIG_CONTENT"]`, and
//   `get KILO_PERMISSION() { return process.env["KILO_PERMISSION"] }`.
// - Preserved `get KILO_CONFIG_DIR()`, `Flag.KILO_CONFIG_DIR ?? Path.config`,
//   TUI explicit `global -> legacy -> KILO_CONFIG_DIR` last-wins, and sandbox
//   literal deny entries `"KILO_CONFIG"`, `"KILO_CONFIG_CONTENT"`,
//   `"KILO_CONFIG_DIR"` exactly.
// - No extension direct diagnostic `process.env` reads touched (out of scope).
// Spec anchors: runtime §8.1 rows 1,3,4; tracker §7; matrix rows 1,3,4.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4-T21 Flag legacy getter removal — dead entries absent, protected paths survive", () => {
  test("Flag definitions for KILO_CONFIG, KILO_CONFIG_CONTENT, KILO_PERMISSION are absent", () => {
    const src = readRepo("packages/core/src/flag/flag.ts")
    expect(src).not.toContain('KILO_CONFIG: process.env["KILO_CONFIG"]')
    expect(src).not.toContain("KILO_CONFIG: process.env")
    // KILO_CONFIG_CONTENT must be absent as Flag entry, but sandbox literal remains elsewhere
    expect(src).not.toContain('KILO_CONFIG_CONTENT: process.env["KILO_CONFIG_CONTENT"]')
    expect(src).not.toContain("KILO_CONFIG_CONTENT")
    expect(src).not.toContain("get KILO_PERMISSION")
    expect(src).not.toContain('process.env["KILO_PERMISSION"]')
    expect(src).not.toContain("KILO_PERMISSION")
    // Protect: KILO_CONFIG_DIR getter remains exactly
    expect(src).toContain("get KILO_CONFIG_DIR()")
    expect(src).toContain('process.env["KILO_CONFIG_DIR"]')
    expect(src).toContain('return process.env["KILO_CONFIG_DIR"]')
  })

  test("no Flag.KILO_CONFIG / Flag.KILO_CONFIG_CONTENT / Flag.KILO_PERMISSION readers remain in opencode/src and core/src", () => {
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
      .replaceAll("Flag.KILO_TUI_CONFIG", "__KILO_TUI_CONFIG__")
    expect(stripped).not.toContain("Flag.KILO_CONFIG")
    expect(stripped).not.toContain("Flag.KILO_PERMISSION")
    expect(stripped).not.toContain("Flag.KILO_CONFIG_CONTENT")
    // Protect: sandbox literals "KILO_CONFIG*" remain, so bare string check is not applicable here
    // Verify flag file itself has no remaining KILO_CONFIG definitions beyond KILO_CONFIG_DIR
    const flag = readRepo("packages/core/src/flag/flag.ts")
    const flagStripped = flag.replaceAll("KILO_CONFIG_DIR", "__DIR__").replaceAll("KILO_TUI_CONFIG", "__TUI__")
    expect(flagStripped).not.toContain("KILO_CONFIG")
    expect(flagStripped).not.toContain("KILO_PERMISSION")
  })

  test("Protected KILO_CONFIG_DIR / Global / TUI / sandbox / ConfigPaths paths survive", () => {
    const flag = readRepo("packages/core/src/flag/flag.ts")
    expect(flag).toContain("get KILO_CONFIG_DIR()")
    expect(flag).toContain('process.env["KILO_CONFIG_DIR"]')

    const global = readRepo("packages/core/src/global.ts")
    expect(global).toContain("Flag.KILO_CONFIG_DIR ?? Path.config")
    expect(global).toContain('from "./flag/flag"')
    expect(global).toContain("config: Flag.KILO_CONFIG_DIR ?? Path.config")

    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).toContain("...(Flag.KILO_CONFIG_DIR ? [Flag.KILO_CONFIG_DIR] : [])")
    expect(tui).toContain("...baseDirectories.filter((dir) => dir !== Flag.KILO_CONFIG_DIR)")
    expect(tui).toContain("...legacyProjectDirs")
    expect(tui).toContain("unique([")
    expect(tui).toContain('targets: [".kilocode", ".kilo"]')
    expect(tui).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(tui).toContain('dir === Flag.KILO_CONFIG_DIR')
    expect(tui).toContain("TUI explicitly appends KILO_CONFIG_DIR last")
    expect(tui).toContain("global → legacy → env")

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

  test("Config.Service and instruction remain without legacy Flag readers", () => {
    const cfg = read("config/config.ts")
    expect(cfg).not.toContain("Flag.KILO_CONFIG")
    expect(cfg).not.toContain("Flag.KILO_PERMISSION")
    const instr = read("session/instruction.ts")
    expect(instr).not.toContain("Flag.KILO_CONFIG")
    expect(instr).not.toContain("Flag.KILO_PERMISSION")
    expect(instr).not.toContain("KILO_CONFIG_CONTENT")
    expect(instr).not.toContain("Flag.KILO_CONFIG_CONTENT")
    const migrate = read("cli/cmd/tui/config/tui-migrate.ts")
    expect(migrate).not.toContain("Flag.KILO_CONFIG")
    expect(migrate).not.toContain("Flag.KILO_PERMISSION")
    expect(migrate).not.toContain("Flag.KILO_CONFIG_CONTENT")
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
    expect(t18Idx).toBeLessThan(tuiIdx)
    expect(tuiIdx).toBeLessThan(wellknownIdx)
  })
})
