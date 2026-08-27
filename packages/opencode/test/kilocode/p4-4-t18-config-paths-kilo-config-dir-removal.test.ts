import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T18 source-removal evidence — bounded ConfigPaths KILO_CONFIG_DIR removal
// P4.4 canonical update: TUI also no longer reads KILO_CONFIG_DIR — only Global and sandbox retain it.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4-T18 ConfigPaths KILO_CONFIG_DIR removal — TUI canonical", () => {
  test("ConfigPaths.directories has no KILO_CONFIG_DIR reader — only Global.Path.config", () => {
    const src = read("config/paths.ts")
    expect(src).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(src).not.toContain("KILO_CONFIG_DIR")
    expect(src).not.toContain('from "@opencode-ai/core/flag/flag"')
    expect(src).not.toContain("Flag.")
    expect(src).toContain('from "@opencode-ai/core/global"')
    expect(src).toContain("Global.Path.config")
    expect(src).toContain("return unique([Global.Path.config])")
    expect(src).not.toContain('targets: [".kilo"]')
    expect(src).not.toContain('targets: [".kilocode"')
    expect(src).not.toContain("Global.Path.home")
    expect(src).not.toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(src).not.toContain("void directory")
    expect(src).not.toContain("void worktree")
    expect(src).not.toContain("canonicalRoot")
    expect(src).toContain("export const files")
    expect(src).toContain("export const directories")
    expect(src).toContain("fileInDirectory")
    expect(src).toContain('export const directories = Effect.fn("ConfigPaths.directories")(function* ()')
  })

  test("TUI has no KILO_CONFIG_DIR/KILO_TUI_CONFIG/migrate or legacy directory walk — canonical only", () => {
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).not.toContain("KILO_CONFIG_DIR")
    expect(tui).not.toContain("Flag.KILO_TUI_CONFIG")
    expect(tui).not.toContain("KILO_TUI_CONFIG")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(tui).not.toContain('targets: [".kilocode"')
    expect(tui).not.toContain('targets: [".kilo"')
    expect(tui).not.toContain("yield* afs.up")
    expect(tui).not.toContain(".kilocode")
    expect(tui).not.toContain("ConfigPaths.directories()")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).toContain("Global.Path.config")
    expect(tui).toContain('path.join(root, ".kilo")')
    expect(tui).toContain("workspaceKiloDir")
    expect(tui).toContain("workspaceDirs")
    expect(tui).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    // Canonical comment present, precedence absent
    expect(tui).toContain("Canonical TUI config sources")
    expect(tui).not.toContain("TUI explicitly appends KILO_CONFIG_DIR")
  })

  test("opencode src has no Flag.KILO_CONFIG_DIR/KILO_TUI_CONFIG direct reader (only flag/global/sandbox literal)", () => {
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
    // KILO_CONFIG_DIR should have zero effective readers (only Global/sandbox/Flag definition)
    const flagCount = (combined.match(/Flag\.KILO_CONFIG_DIR/g) ?? []).length
    expect(flagCount).toBe(0)
    const tuiCount = (combined.match(/Flag\.KILO_TUI_CONFIG/g) ?? []).length
    expect(tuiCount).toBe(0)
    const policyContent = read("kilocode/sandbox/policy.ts")
    expect(policyContent).toContain('"KILO_CONFIG_DIR"')
    for (const file of ["config/config.ts", "config/paths.ts", "session/instruction.ts", "skill/index.ts", "kilocode/config/config.ts", "kilocode/config/overlay.ts", "cli/cmd/tui/config/tui.ts"]) {
      const src = read(file)
      expect(src, `${file} must not contain Flag.KILO_CONFIG_DIR`).not.toContain("Flag.KILO_CONFIG_DIR")
    }
  })

  test("Global.Path.config KILO_CONFIG_DIR override and sandbox deny-list untouched (LOCK-003)", () => {
    const globalSrc = readRepo("packages/core/src/global.ts")
    expect(globalSrc).toContain("config: Flag.KILO_CONFIG_DIR ?? Path.config")
    expect(globalSrc).toContain('from "./flag/flag"')
    const flagSrc = readRepo("packages/core/src/flag/flag.ts")
    expect(flagSrc).toContain("get KILO_CONFIG_DIR()")
    expect(flagSrc).toContain('process.env["KILO_CONFIG_DIR"]')
    const policy = read("kilocode/sandbox/policy.ts")
    expect(policy).toContain('"KILO_CONFIG"')
    expect(policy).toContain('"KILO_CONFIG_DIR"')
    expect(policy).toContain('"KILO_CONFIG_CONTENT"')
  })

  test("Config.Service and instruction remain without KILO_CONFIG_DIR (LOCK-001)", () => {
    const cfg = read("config/config.ts")
    expect(cfg).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(cfg).not.toContain("KILO_CONFIG_DIR")
    expect(cfg.split("KILO_CONFIG_CONTENT").length).toBe(1)
    const instr = read("session/instruction.ts")
    expect(instr).not.toContain("Flag.KILO_CONFIG_DIR")
    expect(instr).not.toContain("KILO_CONFIG_DIR")
  })

  test("ConfigPaths files/fileInDirectory APIs preserved and TUI callers intact — no migrate, no TUI_CONFIG", () => {
    const paths = read("config/paths.ts")
    expect(paths).toContain("export const files")
    expect(paths).toContain("fileInDirectory")
    expect(paths).toContain('path.join(dir, `${name}.json`)')
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).not.toContain("ConfigPaths.files")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(tui).not.toContain("KILO_TUI_CONFIG")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).toContain('ConfigPaths.fileInDirectory(Global.Path.config, "tui")')
    expect(tui).toContain('ConfigPaths.fileInDirectory(root, "tui")')
    const skill = read("skill/index.ts")
    expect(skill).toContain("config.directories()")
  })

  test("TUI canonical precedence — workspace .kilo only, no env/migrate last-wins", () => {
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).toContain("Canonical TUI config sources")
    expect(tui).not.toContain("TUI explicitly appends KILO_CONFIG_DIR last")
    expect(tui).not.toContain("KILO_TUI_CONFIG")
    expect(tui).not.toContain("migrateTuiConfig")
    expect(tui).not.toContain("global → legacy → env")
    expect(tui).not.toContain('dir.endsWith(".kilo")')
    expect(tui).not.toContain('dir.endsWith(".kilocode")')
    expect(tui).not.toContain('dir === Flag.KILO_CONFIG_DIR')
    expect(tui).toContain("workspaceKiloDir")
    expect(tui).toContain("workspaceDirs")
  })

  test("test-profile lists T18 regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-t18-config-paths-kilo-config-dir-removal")
    expect(profile).toContain("p4-4-t16-tui-legacy-discovery")
    expect(profile).toContain("p4-4-tui-canonical-source-removal")
    expect(profile).toContain("p4-4-tui-migrate-kilo-config-removal")
    const t16Idx = profile.indexOf("p4-4-t16-tui-legacy-discovery")
    const t18Idx = profile.indexOf("p4-4-t18-config-paths-kilo-config-dir-removal")
    const canonicalIdx = profile.indexOf("p4-4-tui-canonical-source-removal")
    const tuiMigrateIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    expect(t16Idx).toBeLessThan(t18Idx)
    expect(t18Idx).toBeLessThan(canonicalIdx)
    expect(canonicalIdx).toBeLessThan(tuiMigrateIdx)
  })

  test("ConfigPaths.directories runtime is global-only even with KILO_CONFIG_DIR set — direct behavioral coverage (LOCK-001)", async () => {
    const { Effect } = await import("effect")
    const { Global } = await import("@opencode-ai/core/global")
    const { ConfigPaths } = await import("../../src/config/paths")
    const profile = `/tmp/kilo-config-dir-t18-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const previous = process.env["KILO_CONFIG_DIR"]
    const dirs = await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env["KILO_CONFIG_DIR"] = profile
          return previous
        }),
        () => ConfigPaths.directories(),
        (prev) =>
          Effect.sync(() => {
            if (prev === undefined) delete process.env["KILO_CONFIG_DIR"]
            else process.env["KILO_CONFIG_DIR"] = prev
          }),
      ),
    )
    expect(dirs).toEqual([Global.Path.config])
    expect(dirs).not.toContain(profile)
    expect(dirs.length).toBe(1)
    const { Flag } = await import("@opencode-ai/core/flag/flag")
    if (previous === undefined) expect(Flag.KILO_CONFIG_DIR).toBeUndefined()
    else expect(Flag.KILO_CONFIG_DIR).toBe(previous)
    expect(process.env["KILO_CONFIG_DIR"]).toBe(previous)
  })
})
