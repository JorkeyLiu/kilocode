import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T3 source-removal evidence — unreachable legacy managed/MDM configuration
// helper physically removed (canonical authored config is only one global root
// and `<workspaceRoot>/.kilo/`; no generic managed/legacy overlay is a target
// source; permanent removal is direct with no shim).
// - `packages/opencode/src/config/managed.ts` deleted (managedConfigDir,
//   parseManagedPlist, readManagedPreferences, MANAGED_PLIST_DOMAIN).
// - No production source may reference `ConfigManaged`/`managedConfigDir`/
//   `readManagedPreferences`/`parseManagedPlist` or the `config/managed`
//   import surface after the P4.3 canonical cutover.
// - Direct obsolete tests that existed solely for the deleted helper
//   (`ConfigManaged` import and `parseManagedPlist` unit tests) are removed
//   from `packages/opencode/test/config/config.test.ts`.
// - P4.3 canonical-loader absence anchors for managed preferences remain:
//   `managedConfigDir()` and `readManagedPreferences` absent from
//   `config/config.ts` (see `p4-3-cutover.test.ts:35-38`).
// Spec anchors: runtime §8.1 row 9; P4.4 evidence matrix row 9; tracker §7 row 9.
// This file asserts absence of the helper module/import surface; it does not
// claim P4.4 completion or transport narrowing (existing HTTP/SSE bridge remains).

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}

function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 managed/MDM removal — unreachable helper physically absent", () => {
  test("helper module is deleted", () => {
    expect(existsSync(join(opencode, "config/managed.ts"))).toBe(false)
  })

  test("no production source references the helper import or symbols", () => {
    const files = ["config/config.ts", "kilocode/config/config.ts", "kilocode/config/overlay.ts", "config/paths.ts"]
    for (const file of files) {
      const src = read(file)
      expect(src, `${file} must not import config/managed`).not.toContain("config/managed")
      expect(src, `${file} must not reference ConfigManaged`).not.toContain("ConfigManaged")
      expect(src, `${file} must not reference managedConfigDir`).not.toContain("managedConfigDir")
      expect(src, `${file} must not reference readManagedPreferences`).not.toContain("readManagedPreferences")
      expect(src, `${file} must not reference parseManagedPlist`).not.toContain("parseManagedPlist")
      expect(src, `${file} must not reference MANAGED_PLIST`).not.toContain("MANAGED_PLIST")
      expect(src, `${file} must not reference ai.opencode.managed`).not.toContain("ai.opencode.managed")
    }
  })

  test("CLI source tree contains no managed helper surface", () => {
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
    expect(combined).not.toContain("from \"@/config/managed\"")
    expect(combined).not.toContain("from \"./managed\"")
    expect(combined).not.toContain("ConfigManaged")
    expect(combined).not.toContain("managedConfigDir()")
    expect(combined).not.toContain("readManagedPreferences")
    expect(combined).not.toContain("parseManagedPlist")
    expect(combined).not.toContain("MANAGED_PLIST_DOMAIN")
    // KILO_TEST_MANAGED_CONFIG_DIR is a test-only env override for the deleted
    // helper; it must not appear in production source after removal.
    expect(combined).not.toContain("KILO_TEST_MANAGED_CONFIG_DIR")
  })

  test("P4.3 canonical loader retains proven absence of managed preferences coupling", () => {
    const cfg = read("config/config.ts")
    expect(cfg).not.toContain("managedConfigDir()")
    expect(cfg).not.toContain("readManagedPreferences")
    expect(cfg).not.toContain("MANAGED_PLIST")
    expect(cfg).not.toContain("ai.opencode.managed")
    expect(cfg).not.toContain("Managed Preferences")
    // Canonical loader still uses the intended global/project roots.
    expect(cfg).toContain('path.join(Global.Path.config, "kilo.jsonc")')
    expect(cfg).toContain('".kilo", "kilo.jsonc"')
  })

  test("direct obsolete tests are removed from config.test.ts", () => {
    const cfgTest = readRepo("packages/opencode/test/config/config.test.ts")
    expect(cfgTest).not.toContain("from \"@/config/managed\"")
    expect(cfgTest).not.toContain("ConfigManaged")
    expect(cfgTest).not.toContain("parseManagedPlist")
    expect(cfgTest).not.toContain("writeManagedSettingsEffect")
    expect(cfgTest).not.toContain("KILO_TEST_MANAGED_CONFIG_DIR")
    // The generic config test suite remains.
    expect(cfgTest).toContain("Config.Service")
    expect(cfgTest).toContain("loads config with defaults")
  })

  test("test-profile lists the new removal regression", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
  })

  test("canonical-root and ConfigPaths behavior remains — TUI canonical (no KILO_CONFIG_DIR/KILO_TUI_CONFIG/migrate, no ancestor walk)", () => {
    expect(read("kilocode/config/config.ts")).toContain("canonicalRoot")
    expect(read("kilocode/config/overlay.ts")).toContain("canonicalRoot")
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
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).not.toContain("KILO_CONFIG_DIR")
    expect(tui).not.toContain("Flag.KILO_TUI_CONFIG")
    expect(tui).not.toContain("KILO_TUI_CONFIG")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(tui).not.toContain('targets: [".kilocode", ".kilo"]')
    expect(tui).not.toContain("yield* afs.up")
    expect(tui).not.toContain("ConfigPaths.directories()")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).toContain('path.join(root, ".kilo")')
    expect(tui).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(tui).toContain("Canonical TUI config sources")
    const kcfg = read("kilocode/tui/config.ts")
    expect(kcfg).not.toContain(".kilocode")
    expect(kcfg).not.toContain("Filesystem.findUp")
  })
})
