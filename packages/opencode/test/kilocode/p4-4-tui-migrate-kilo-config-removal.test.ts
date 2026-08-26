import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T13 source-removal evidence — legacy `KILO_CONFIG` effective-config input
// residue in `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts` physically
// removed (LOCK-010 canonical file authority; LOCK-009 HTTP/SSE/generated-SDK bridge
// preserved; LOCK-014 bounded removal; no performance claim per LOCK-PERF-6).
// - `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts` deleted the sole
//   legacy `if (Flag.KILO_CONFIG) files.push(Flag.KILO_CONFIG)` effective-config
//   input from `opencodeFiles`; `Flag` import retained for
//   `Flag.KILO_DISABLE_PROJECT_CONFIG` (still used) so no unused import remains.
// - Retained TUI theme/keybind migration, `ConfigPaths` discovery, canonical
//   `Config.Service` loader, `ConfigPaths`/`instruction` `KILO_CONFIG_DIR` profile
//   behavior, server health, HTTP/SSE/generated SDK, provider/catalog, custom-provider
//   lifecycle, and all existing tests are preserved per scope (only that one line
//   removed; `packages/opencode/src/config/paths.ts`, `session/instruction.ts`,
//   transport/server routes, generated SDK/OpenAPI, provider code, storage/convergence
//   untouched; row/phase/P4/LOCK-006 not marked complete).
// Spec anchors: runtime §8.1 row 1 (LOCK-010); tracker §7; matrix row 1.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 TUI migration KILO_CONFIG removal — bounded residue absent", () => {
  test("tui-migrate.ts has no KILO_CONFIG effective-config input", () => {
    const src = read("cli/cmd/tui/config/tui-migrate.ts")
    // The sole legacy injection must be absent — check the exact patterns that would
    // indicate the file-input residue.
    expect(src).not.toContain("if (Flag.KILO_CONFIG)")
    expect(src).not.toContain("Flag.KILO_CONFIG)")
    expect(src).not.toContain("Flag.KILO_CONFIG,")
    expect(src).not.toContain("Flag.KILO_CONFIG ")
    expect(src).not.toContain("files.push(Flag.KILO_CONFIG")
    // No string literal env-file reference should be introduced by the removal.
    expect(src).not.toContain('"KILO_CONFIG"')
    expect(src).not.toContain("'KILO_CONFIG'")
    // `KILO_CONFIG_DIR` is not expected in this helper — ensure no accidental carry.
    expect(src).not.toContain("KILO_CONFIG_DIR")
    // The only Flag.* that should remain is the project-config disable gate.
    expect(src).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    // Ensure Flag import is still needed and not removed as unused.
    expect(src).toContain('from "@opencode-ai/core/flag/flag"')
    expect(src).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
  })

  test("tui-migrate retains TUI theme/keybind migration and opencodeFiles discovery", () => {
    const src = read("cli/cmd/tui/config/tui-migrate.ts")
    // Core migration entry points preserved.
    expect(src).toContain("export async function migrateTuiConfig")
    expect(src).toContain("async function opencodeFiles")
    expect(src).toContain("async function backupAndStripLegacy")
    expect(src).toContain("function normalizeTui")
    // Theme/keybind/tui extraction and tui.json materialization preserved.
    expect(src).toContain('decodeTheme("theme"')
    expect(src).toContain('decodeRecord("keybinds"')
    expect(src).toContain('decodeRecord("tui"')
    expect(src).toContain("TUI_SCHEMA_URL")
    expect(src).toContain('"https://app.kilo.ai/tui.json"')
    expect(src).toContain('payload.theme')
    expect(src).toContain('payload.keybinds')
    expect(src).toContain('path.join(path.dirname(file), "tui.json")')
    expect(src).toContain("backupAndStripLegacy")
    expect(src).toContain('["theme", "keybinds", "tui"]')
    // Discovery via ConfigPaths and project findUp preserved.
    expect(src).toContain("Filesystem.findUp")
    expect(src).toContain('["kilo.json", "kilo.jsonc"]')
    expect(src).toContain("ConfigPaths.fileInDirectory")
    expect(src).toContain("Global.Path.config")
    expect(src).toContain('fileInDirectory(Global.Path.config, "kilo")')
    expect(src).toContain('fileInDirectory(dir, "kilo")')
    expect(src).toContain("unique(input.directories)")
    expect(src).toContain("unique(files)")
    expect(src).toContain("Filesystem.exists")
    // Flag disable gate preserved.
    expect(src).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(src).toContain("? []")
  })

  test("opencode src snapshot — no Flag.KILO_CONFIG remains (bounded T13 complement)", () => {
    // T13 bounded scope (LOCK-010/014/015) is only the single legacy
    // `if (Flag.KILO_CONFIG) files.push(Flag.KILO_CONFIG)` injection in
    // `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts` (proven by the
    // `tui-migrate.ts has no KILO_CONFIG effective-config input` test above).
    // This repo-wide Flag.KILO_CONFIG walk is an opportunistic snapshot guard
    // for the current Flag-named reader — it does not prove that every possible
    // raw `KILO_CONFIG` reader form is absent repository-wide (LOCK-013 truthful
    // scope). Allowed Flag residues remain `Flag.KILO_CONFIG_DIR` /
    // `Flag.KILO_DISABLE_PROJECT_CONFIG` etc.
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
    // Strip the allowed Flag.KILO_CONFIG_DIR and Flag.KILO_DISABLE_PROJECT_CONFIG
    // occurrences before checking for stray Flag.KILO_CONFIG.
    const stripped = combined
      .replaceAll("Flag.KILO_CONFIG_DIR", "__KILO_CONFIG_DIR__")
      .replaceAll("Flag.KILO_DISABLE_PROJECT_CONFIG", "__KILO_DISABLE_PROJECT_CONFIG__")
      .replaceAll("Flag.KILO_DISABLE_DEFAULT_PLUGINS", "__KILO_DISABLE_DEFAULT_PLUGINS__")
    // Also allow KILO_TUI_CONFIG which contains KILO_CONFIG as substring but is unrelated.
    const stripped2 = stripped.replaceAll("Flag.KILO_TUI_CONFIG", "__KILO_TUI_CONFIG__")
    expect(stripped2).not.toContain("Flag.KILO_CONFIG")
    // Raw "KILO_CONFIG" string literals are expected to remain in at least the
    // sandbox deny list (policy.ts); this count only verifies that expected
    // literal residue is retained, not that every possible raw `KILO_CONFIG`
    // reader form is absent repository-wide.
    expect(stripped2.split("KILO_CONFIG").length).toBeGreaterThan(1) // sandbox deny retained
  })

  test("canonical Config.Service remains authority and ignores KILO_CONFIG (LOCK-010)", () => {
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

  test("ConfigPaths and instruction KILO_CONFIG_DIR profile behavior preserved", () => {
    const paths = read("config/paths.ts")
    expect(paths).toContain("Flag.KILO_CONFIG_DIR")
    expect(paths).toContain('targets: [".kilo"]')
    expect(paths).toContain("Global.Path.config")

    const instr = read("session/instruction.ts")
    expect(instr).toContain("Flag.KILO_CONFIG_DIR")
    expect(instr).toContain("KILO_CONFIG_DIR")

    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).toContain("ConfigPaths.directories")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).toContain("migrateTuiConfig")
  })

  test("generated SDK and OpenAPI unchanged (HTTP/SSE bridge preserved per LOCK-009)", () => {
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
    // KILO_CONFIG as env override is not an OpenAPI field.
    expect(openapi).toContain("/config")
    expect(openapi).toContain("/provider")
  })

  test("sandbox deny list still contains KILO_CONFIG (safety preserved)", () => {
    const policy = read("kilocode/sandbox/policy.ts")
    expect(policy).toContain('"KILO_CONFIG"')
    expect(policy).toContain('"KILO_CONFIG_DIR"')
    expect(policy).toContain('"KILO_CONFIG_CONTENT"')
  })

  test("provider/catalog and custom-provider lifecycle untouched (LOCK-006)", () => {
    expect(existsSync(join(opencode, "kilocode/provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "provider/provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/custom-provider.ts"))).toBe(true)
    const provider = read("provider/provider.ts")
    expect(provider).toContain("const BUNDLED_PROVIDERS")
  })

  test("test-profile lists the new TUI migration removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-tui-migrate-kilo-config-removal")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-model-cache-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
    expect(profile).toContain("p4-4-provider-login-preset-removal")
    expect(profile).toContain("p4-4-provider-metadata-removal")
    expect(profile).toContain("p4-4-sdk-config-forwarding-removal")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const modelCacheIdx = profile.indexOf("p4-4-model-cache-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const loginIdx = profile.indexOf("p4-4-provider-login-preset-removal")
    const metadataIdx = profile.indexOf("p4-4-provider-metadata-removal")
    const sdkIdx = profile.indexOf("p4-4-sdk-config-forwarding-removal")
    const tuiIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(bundledIdx).toBeLessThan(managedIdx)
    expect(managedIdx).toBeLessThan(modelCacheIdx)
    expect(modelCacheIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(loginIdx)
    expect(loginIdx).toBeLessThan(metadataIdx)
    expect(metadataIdx).toBeLessThan(sdkIdx)
    expect(sdkIdx).toBeLessThan(tuiIdx)
    expect(tuiIdx).toBeLessThan(wellknownIdx)
  })
})
