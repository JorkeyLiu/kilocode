import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T18 source-removal evidence — bounded ConfigPaths KILO_CONFIG_DIR removal
// with TUI-owned explicit compatibility preserved (LOCK-001/002/003).
// - `packages/opencode/src/config/paths.ts` ConfigPaths.directories() no longer
//   imports/reads Flag.KILO_CONFIG_DIR; now returns only unique([Global.Path.config]).
// - `packages/opencode/src/cli/cmd/tui/config/tui.ts` explicitly appends
//   Flag.KILO_CONFIG_DIR after global + enabled legacy dirs only when set,
//   preserving exact global → legacy → KILO_CONFIG_DIR last-wins precedence
//   via unique([...baseFilteredNotEnv, ...legacyProjectDirs, ...env]) .
// - TUI remains the sole retained direct reader in opencode/src; Global.Path.config
//   override and sandbox deny-list remain untouched per LOCK-003.
// - Config.Service, instruction, and other opencode consumers remain without
//   KILO_CONFIG_DIR reader per LOCK-001.
// Spec anchors: runtime §8.1 row 2; tracker §7; matrix row 2.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4-T18 ConfigPaths KILO_CONFIG_DIR removal — TUI-owned compatibility", () => {
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

  test("TUI explicitly appends KILO_CONFIG_DIR after global + legacy — last-wins preserved", () => {
    const tui = read("cli/cmd/tui/config/tui.ts")
    // Must retain gated legacy discovery
    expect(tui).toContain('targets: [".kilocode", ".kilo"]')
    expect(tui).toContain("Flag.KILO_DISABLE_PROJECT_CONFIG")
    expect(tui).toContain("yield* afs.up")
    expect(tui).toContain("ConfigPaths.directories()")
    // Must explicitly append KILO_CONFIG_DIR last
    expect(tui).toContain("Flag.KILO_CONFIG_DIR")
    expect(tui).toContain("...(Flag.KILO_CONFIG_DIR ? [Flag.KILO_CONFIG_DIR] : [])")
    // Must filter baseDirectories to move global==env dup to last-wins position
    expect(tui).toContain("...baseDirectories.filter((dir) => dir !== Flag.KILO_CONFIG_DIR)")
    // Merged order must be global → legacy → env (last wins) via unique
    expect(tui).toContain("unique([")
    expect(tui).toContain("...legacyProjectDirs")
    // The second baseDirectories.filter for env should NOT remain — replaced by explicit optional env
    expect(tui).not.toContain("...baseDirectories.filter((dir) => dir === Flag.KILO_CONFIG_DIR)")
    // Comment must reflect T18 reality — global from ConfigPaths, optional KILO_CONFIG_DIR is TUI-appended after legacy discovery
    expect(tui).toContain("global is from ConfigPaths")
    expect(tui).toContain("optional KILO_CONFIG_DIR directory is TUI-appended after legacy discovery")
    expect(tui).toContain("TUI explicitly appends KILO_CONFIG_DIR last")
    // Other KILO_CONFIG_DIR uses retained (dirs filter, trusted plugin)
    expect(tui).toContain('dir === Flag.KILO_CONFIG_DIR')
  })

  test("opencode src KILO_CONFIG_DIR direct reader is TUI-only (plus sandbox deny)", () => {
    // Walk opencode src for Flag.KILO_CONFIG_DIR occurrences — allowed only in tui.ts and flag/global/sandbox
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
    // ConfigPaths must not appear in combined as Flag reader — we already proved file absence, but also ensure no stray opencode import
    const tuiContent = read("cli/cmd/tui/config/tui.ts")
    const policyContent = read("kilocode/sandbox/policy.ts")
    // Count occurrences of Flag.KILO_CONFIG_DIR in combined — should be only tui.ts
    const flagCount = (combined.match(/Flag\.KILO_CONFIG_DIR/g) ?? []).length
    const tuiCount = (tuiContent.match(/Flag\.KILO_CONFIG_DIR/g) ?? []).length
    expect(flagCount).toBe(tuiCount)
    expect(flagCount).toBeGreaterThan(0)
    // Also ensure sandbox deny is separate literal "KILO_CONFIG_DIR" not Flag reader
    expect(policyContent).toContain('"KILO_CONFIG_DIR"')
    // Ensure other critical files have no Flag reader
    for (const file of ["config/config.ts", "config/paths.ts", "session/instruction.ts", "skill/index.ts", "kilocode/config/config.ts", "kilocode/config/overlay.ts"]) {
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

  test("ConfigPaths files/fileInDirectory APIs preserved and callers intact", () => {
    const paths = read("config/paths.ts")
    expect(paths).toContain("export const files")
    expect(paths).toContain("fileInDirectory")
    expect(paths).toContain('path.join(dir, `${name}.json`)')
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).toContain("ConfigPaths.files")
    expect(tui).toContain("ConfigPaths.fileInDirectory")
    expect(tui).toContain('ConfigPaths.fileInDirectory(Global.Path.config, "tui")')
    const skill = read("skill/index.ts")
    expect(skill).toContain("config.directories()")
  })

  test("TUI precedence comment and dirs filtering remain coherent", () => {
    const tui = read("cli/cmd/tui/config/tui.ts")
    expect(tui).toContain("TUI explicitly appends KILO_CONFIG_DIR last")
    expect(tui).toContain("global → legacy → env")
    // dirs filter retains KILO_CONFIG_DIR alongside .kilo/.kilocode
    expect(tui).toContain('dir.endsWith(".kilo")')
    expect(tui).toContain('dir.endsWith(".kilocode")')
    expect(tui).toContain('dir === Flag.KILO_CONFIG_DIR')
  })

  test("test-profile lists T18 regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-t18-config-paths-kilo-config-dir-removal")
    expect(profile).toContain("p4-4-t16-tui-legacy-discovery")
    expect(profile).toContain("p4-4-tui-migrate-kilo-config-removal")
    const t16Idx = profile.indexOf("p4-4-t16-tui-legacy-discovery")
    const t18Idx = profile.indexOf("p4-4-t18-config-paths-kilo-config-dir-removal")
    const tuiMigrateIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    expect(t16Idx).toBeLessThan(t18Idx)
    expect(t18Idx).toBeLessThan(tuiMigrateIdx)
  })

  test("ConfigPaths.directories runtime is global-only even with KILO_CONFIG_DIR set — direct behavioral coverage (LOCK-001)", async () => {
    const { Effect } = await import("effect")
    const { Global } = await import("@opencode-ai/core/global")
    const { ConfigPaths } = await import("../../src/config/paths")
    const profile = `/tmp/kilo-config-dir-t18-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const previous = process.env["KILO_CONFIG_DIR"]
    // Use existing safe flag/global test setup pattern — acquireUseRelease with scoped cleanup, no mock of implementation logic
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
    // Direct runtime assertion: exact [Global.Path.config], not containing env
    expect(dirs).toEqual([Global.Path.config])
    expect(dirs).not.toContain(profile)
    expect(dirs.length).toBe(1)
    // Verify no environment leakage — Flag getter sees restored value
    const { Flag } = await import("@opencode-ai/core/flag/flag")
    if (previous === undefined) expect(Flag.KILO_CONFIG_DIR).toBeUndefined()
    else expect(Flag.KILO_CONFIG_DIR).toBe(previous)
    expect(process.env["KILO_CONFIG_DIR"]).toBe(previous)
  })
})
