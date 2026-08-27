import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T13 source-removal evidence — legacy `KILO_CONFIG` effective-config input
// residue in `packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts` physically
// removed. P4.4-T24 bounded removal — obsolete legacy source-file rewrite/backup
// behavior (`backupAndStripLegacy`, `*.tui-migration.bak`, `applyEdits`/`modify`,
// `access`/`constants.W_OK`) removed while legacy-to-`tui.json` materialization
// (`migrateTuiConfig`, `normalizeTui`, `TUI_SCHEMA_URL`, theme/keybinds/tui
// extraction, `tui.json` payload, target-exists guard) remains.

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
    expect(src).not.toContain("if (Flag.KILO_CONFIG)")
    expect(src).not.toContain("Flag.KILO_CONFIG)")
    expect(src).not.toContain("Flag.KILO_CONFIG,")
    expect(src).not.toContain("Flag.KILO_CONFIG ")
    expect(src).not.toContain("files.push(Flag.KILO_CONFIG")
    expect(src).not.toContain('"KILO_CONFIG"')
    expect(src).not.toContain("'KILO_CONFIG'")
    expect(src).not.toContain("KILO_CONFIG_DIR")
    expect(src).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(src).toContain('from "@opencode-ai/core/flag/flag"')
    expect(src).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
  })

  test("tui-migrate has no backup or source rewrite helpers (T24 bounded removal)", () => {
    const src = read("cli/cmd/tui/config/tui-migrate.ts")
    expect(src).not.toContain("backupAndStripLegacy")
    expect(src).not.toContain(".tui-migration.bak")
    expect(src).not.toContain("tui-migration.bak")
    expect(src).not.toContain("applyEdits")
    expect(src).not.toContain("modify")
    // still uses jsonc-parser parse, but not applyEdits/modify
    expect(src).toContain("parse as parseJsonc")
    expect(src).toContain('from "jsonc-parser"')
    expect(src).not.toContain("access(")
    expect(src).not.toContain("constants.W_OK")
    expect(src).not.toContain('from "fs/promises"')
    expect(src).not.toContain("stripped")
    expect(src).not.toContain("backup")
    expect(src).not.toContain("stripped tui keys")
    expect(src).not.toContain("tui config migrated but source file was not stripped")
  })

  test("tui-migrate retains TUI theme/keybind migration and opencodeFiles discovery", () => {
    const src = read("cli/cmd/tui/config/tui-migrate.ts")
    expect(src).toContain("export async function migrateTuiConfig")
    expect(src).toContain("async function opencodeFiles")
    expect(src).toContain("function normalizeTui")
    expect(src).not.toContain("async function backupAndStripLegacy")
    expect(src).toContain('decodeTheme("theme"')
    expect(src).toContain('decodeRecord("keybinds"')
    expect(src).toContain('decodeRecord("tui"')
    expect(src).toContain("TUI_SCHEMA_URL")
    expect(src).toContain('"https://app.kilo.ai/tui.json"')
    expect(src).toContain("payload.theme")
    expect(src).toContain("payload.keybinds")
    expect(src).toContain('path.join(path.dirname(file), "tui.json")')
    expect(src).toContain("targetExists")
    expect(src).toContain("Filesystem.exists(target)")
    expect(src).toContain("if (targetExists) continue")
    expect(src).toContain("Filesystem.write(target")
    expect(src).toContain('migrated tui config')
    expect(src).toContain("Filesystem.findUp")
    expect(src).toContain('["kilo.json", "kilo.jsonc"]')
    expect(src).toContain("ConfigPaths.fileInDirectory")
    expect(src).toContain("Global.Path.config")
    expect(src).toContain('fileInDirectory(Global.Path.config, "kilo")')
    expect(src).toContain('fileInDirectory(dir, "kilo")')
    expect(src).toContain("unique(input.directories)")
    expect(src).toContain("unique(files)")
    expect(src).toContain("Filesystem.exists")
    expect(src).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(src).toContain("? []")
  })

  test("opencode src snapshot — no Flag.KILO_CONFIG remains (bounded T13 complement) — KILO_TUI_CONFIG also not effective", () => {
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
    const stripped = combined
      .replaceAll("Flag.KILO_CONFIG_DIR", "__KILO_CONFIG_DIR__")
      .replaceAll("Flag.KILO_DISABLE_PROJECT_CONFIG", "__KILO_DISABLE_PROJECT_CONFIG__")
      .replaceAll("Flag.KILO_DISABLE_DEFAULT_PLUGINS", "__KILO_DISABLE_DEFAULT_PLUGINS__")
      .replaceAll("Flag.KILO_TUI_CONFIG", "__KILO_TUI_CONFIG__")
    // After T27-correction, no effective reader for Flag.KILO_CONFIG or Flag.KILO_TUI_CONFIG remains in TUI/opencode src
    // Only Flag definitions and Global/sandbox literals remain
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).not.toContain("Flag.KILO_TUI_CONFIG")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(stripped).not.toContain("Flag.KILO_CONFIG")
    expect(stripped.split("KILO_CONFIG").length).toBeGreaterThan(1)
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

  test("ConfigPaths and TUI canonical — no KILO_CONFIG_DIR/KILO_TUI_CONFIG/migrate, no ancestor walk; instruction absent", () => {
    const paths = read("config/paths.ts")
    expect(paths).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(paths).not.toContain("KILO_CONFIG_DIR")
    expect(paths).toContain("Global.Path.config")
    expect(paths).toContain('return unique([Global.Path.config])')
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

    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).not.toContain("KILO_CONFIG_DIR")
    expect(tui).not.toContain("Flag.KILO_TUI_CONFIG")
    expect(tui).not.toContain("KILO_TUI_CONFIG")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(tui).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(tui).not.toContain('targets: [".kilocode", ".kilo"]')
    expect(tui).not.toContain('targets: [".kilo"')
    expect(tui).not.toContain("yield* afs.up")
    expect(tui).not.toContain("ConfigPaths.directories()")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).not.toContain("...(Flag.KILO_CONFIG_DIR ? [Flag.KILO_CONFIG_DIR] : [])")
    expect(tui).toContain('path.join(root, ".kilo")')
    expect(tui).toContain("workspaceKiloDir")
    // kilocode tui config-console also canonical
    const kcfg = read("kilocode/tui/config.ts")
    expect(kcfg).not.toContain(".kilocode")
    expect(kcfg).not.toContain("Filesystem.findUp")
  })

  test("generated SDK and OpenAPI unchanged (HTTP/SSE bridge preserved)", () => {
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

  test("provider/catalog and custom-provider lifecycle untouched", () => {
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
