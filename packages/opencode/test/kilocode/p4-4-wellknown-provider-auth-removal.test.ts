import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T4 source-removal evidence — legacy `.well-known/opencode` remote-auth
// discovery URL-login branch physically removed from CLI provider login
// (LOCK-006 provider/org/cloud source removal).
// - `packages/opencode/src/cli/cmd/providers.ts:324-347` args.url branch
//   containing `.well-known/opencode` fetch and Process.spawn auth command
//   is deleted; `ProvidersLoginCommand` no longer accepts a positional url
//   and no longer fetches or executes a remote well-known auth command.
// - Stale well-known intercept helpers removed from
//   `packages/opencode/test/config/config.test.ts` (remoteConfigClient,
//   wellKnownAuth, json helper).
// - P4.3 canonical-loader absence anchors for well-known remain:
//   `.well-known/opencode` absent from `config/config.ts` (see
//   `p4-3-cutover.test.ts:35-38`).
// - Generic provider login (api-key/plugin/custom-provider) and canonical
//   effective config remain untouched; HTTP/SSE/generated-SDK bridge remains.
// Spec anchors: runtime §8.1 row 9; P4.4 evidence matrix row 9; tracker §7 row 9.
// This file asserts absence of the CLI well-known discovery surface; it does
// not claim P4.4 completion or transport narrowing.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}

function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 well-known provider auth removal — legacy URL discovery absent", () => {
  test("ProvidersLoginCommand no longer contains well-known discovery branch", () => {
    const src = read("cli/cmd/providers.ts")
    expect(src).not.toContain(".well-known/opencode")
    expect(src).not.toContain(".well-known")
    expect(src).not.toContain("wellknown")
    expect(src).not.toContain("wellKnown")
    // The old branch fetched `<url>/.well-known/opencode` and spawned its
    // returned auth command; neither surface may remain in the login handler.
    expect(src).not.toContain("fetch(`${url}/.well-known")
    expect(src).not.toContain("wellknown.auth.command")
    expect(src).not.toContain("wellknown.auth.env")
    // `args.url` was the branch condition; no positional url handling remains.
    expect(src).not.toContain("args.url")
    expect(src).not.toContain('command: "login [url]"')
    expect(src).toContain('command: "login"')
    // Process.spawn and node:stream/consumers/text were only used for the
    // well-known auth command execution.
    expect(src).not.toContain('from "@/util/process"')
    expect(src).not.toContain('from "node:stream/consumers"')
    expect(src).not.toContain("Process.spawn")
  })

  test("CLI source tree contains no well-known provider auth surface", () => {
    let combined = ""
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          walk(full)
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          // Only assert CLI login surface; auth storage type `wellknown` remains
          // in `src/auth` for persisted credential compatibility, and
          // `.well-known/skills` is an unrelated skills discovery path.
          if (full.endsWith("cli/cmd/providers.ts")) {
            combined += readFileSync(full, "utf8") + "\n"
          }
        }
      }
    }
    walk(join(opencode, "cli/cmd"))
    expect(combined).not.toContain(".well-known/opencode")
    expect(combined).not.toContain("wellknown.auth")
  })

  test("stale well-known intercept helpers are removed from config.test.ts", () => {
    const cfgTest = readRepo("packages/opencode/test/config/config.test.ts")
    expect(cfgTest).not.toContain(".well-known/opencode")
    expect(cfgTest).not.toContain("wellKnownAuth")
    expect(cfgTest).not.toContain("remoteConfigClient")
    expect(cfgTest).not.toContain("wellKnown(")
    // The generic config test suite remains.
    expect(cfgTest).toContain("Config.Service")
    expect(cfgTest).toContain("loads config with defaults")
  })

  test("test-profile lists the new removal regression sorted with existing P4.4 tests", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    // Existing P4.4 tests remain registered.
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
    // Sorted order within the kilo group (managed < primary < wellknown)
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(managedIdx).toBeGreaterThan(-1)
    expect(primaryIdx).toBeGreaterThan(-1)
    expect(wellknownIdx).toBeGreaterThan(-1)
    expect(managedIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(wellknownIdx)
  })

  test("P4.3 canonical loader retains proven absence of well-known coupling", () => {
    const cfg = read("config/config.ts")
    expect(cfg).not.toContain(".well-known/opencode")
    expect(cfg).not.toContain("managedConfigDir()")
    expect(cfg).not.toContain("readManagedPreferences")
    // Canonical loader still uses the intended global/project roots.
    expect(cfg).toContain('path.join(Global.Path.config, "kilo.jsonc")')
    expect(cfg).toContain('".kilo", "kilo.jsonc"')
  })

  test("generic provider login behavior remains", () => {
    const src = read("cli/cmd/providers.ts")
    // Core login command and helpers remain.
    expect(src).toContain("ProvidersLoginCommand")
    expect(src).toContain("handlePluginAuth")
    expect(src).toContain("resolvePluginProviders")
    expect(src).toContain("Select provider")
    expect(src).toContain("Enter your API key")
    expect(src).toContain("Enter provider id")
    // Plugin and custom provider paths remain.
    expect(src).toContain("plugin.auth")
    expect(src).toContain("Other")
    // Auth storage still supports api/oauth types via put/set.
    expect(src).toContain('type: "api"')
    expect(src).toContain('type: "oauth"')
    expect(src).toContain("authSvc.set")
    expect(src).toContain("authSvc.remove")
    // Legacy HTTP/SSE/generated SDK bridge is not narrowed by this unit
    // (LOCK-009); provider login now uses Config.Service/Plugin only (ModelsDev removed in G2).
    expect(src).toContain("Config.Service")
    expect(src).toContain("Plugin.Service")
    expect(src).not.toContain("ModelsDev.Service")
  })
})
