import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { KilocodePaths } from "../../src/kilocode/paths"
import { ConfigProtection } from "../../src/kilocode/permission/config-paths"
import { provideTestInstance, tmpdir } from "../fixture/fixture"
import { getKiloProjectId } from "../../src/kilocode/project-id"

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))
function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}

describe("P4.4 legacy filesystem discovery removal — .kilocode/.opencode absence, .kilo canonical", () => {
  test("static: paths.ts has no .kilocode fallback (canonical .kilo only)", () => {
    const p = read("kilocode/paths.ts")
    expect(p).not.toContain(".kilocode")
    expect(p).not.toContain('".kilocode"')
    expect(p).toContain('".kilo"')
    expect(p).toContain("globalDirs(): string[]")
    expect(p).toContain('return [path.join(home(), ".kilo")]')
    expect(p).toContain('for (const target of [".kilo"] as const)')
    expect(p).not.toContain('for (const target of [".kilocode"')
    expect(p).toContain("skillDirectories")
  })

  test("static: project-id.ts has no .kilocode fallback (canonical .kilo only)", () => {
    const pid = read("kilocode/project-id.ts")
    expect(pid).not.toContain(".kilocode")
    expect(pid).not.toContain('".kilocode"')
    expect(pid).toContain('path.join(directory, ".kilo", "config.json")')
    expect(pid).toContain("getProjectIdFromConfig")
    expect(pid).toContain("resolveProjectId")
    // Should not contain loop over [".kilo", ".kilocode"]
    expect(pid).not.toContain('[".kilo", ".kilocode"]')
    expect(pid).toContain("canonical only")
  })

  test("static: permission/config-paths.ts has no .kilocode (canonical .kilo only)", () => {
    const perm = read("kilocode/permission/config-paths.ts")
    expect(perm).not.toContain('".kilocode/"')
    expect(perm).toContain('CONFIG_DIRS = [".kilo/"]')
    expect(perm).toContain("canonical only")
    expect(perm).not.toContain('CONFIG_DIRS = [".kilo/", ".kilocode/"]')
    // isAbsolute should reference canonical global dir comment
    expect(perm).toContain("// ~/.kilo/ (canonical global dir)")
    expect(perm).not.toContain("legacy global dirs")
  })

  test("static: kilocode/config/config.ts effective isConfigDir is canonical .kilo only", () => {
    const cfg = read("kilocode/config/config.ts")
    expect(cfg).toContain('dir.endsWith(".kilo")')
    expect(cfg).toContain("KILO_DIR_SUFFIXES = [\".kilo\"]")
    expect(cfg).toContain("AGENT_PATTERNS")
    // notification helper remains but is explicitly non-effective (reference-only)
    expect(cfg).toContain("detectOpencodeConfig")
    expect(cfg).toContain("Kilo no longer falls back to opencode configuration")
  })

  test("static: theme.tsx .kilocode retained per LOCK-004 (separate product surface)", () => {
    const theme = read("cli/cmd/tui/context/theme.tsx")
    expect(theme).toContain('[".kilocode", ".kilo"]')
  })

  test("runtime: globalDirs returns canonical .kilo only", () => {
    const dirs = KilocodePaths.globalDirs()
    expect(dirs).toHaveLength(1)
    expect(dirs[0].endsWith(".kilo")).toBe(true)
    expect(dirs.some((d) => d.endsWith(".kilocode"))).toBe(false)
  })

  test("runtime: skillDirectories ignores .kilocode (canonical .kilo only)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const legacy = path.join(dir, ".kilocode", "skills", "legacy-skill")
        await Bun.write(path.join(legacy, "SKILL.md"), "# Legacy")
        await Bun.$`mkdir -p ${path.join(dir, ".kilo", "skills", "canonical-skill")}`.quiet()
        await Bun.write(path.join(dir, ".kilo", "skills", "canonical-skill", "SKILL.md"), "# Canonical")
      },
    })
    const result = await KilocodePaths.skillDirectories({
      projectDir: tmp.path,
      worktreeRoot: tmp.path,
      skipGlobalPaths: true,
    })
    // Only .kilo should be discovered
    expect(result.some((d) => d.endsWith(".kilocode"))).toBe(false)
    expect(result.some((d) => d.endsWith(".kilo"))).toBe(true)
    expect(result.length).toBe(1)
  })

  test("runtime: ConfigProtection.isRelative ignores .kilocode (canonical .kilo only)", () => {
    expect(ConfigProtection.isRelative(".kilo/foo")).toBe(true)
    expect(ConfigProtection.isRelative(".kilo/plans/foo")).toBe(false)
    expect(ConfigProtection.isRelative(".kilocode/foo")).toBe(false)
    expect(ConfigProtection.isRelative("a/.kilocode/foo")).toBe(false)
    expect(ConfigProtection.isRelative(".kilo/package-lock.json")).toBe(true)
    expect(ConfigProtection.isRelative(".kilocode/package-lock.json")).toBe(false)
  })

  test("runtime: ConfigProtection.isRequest ignores .kilocode (canonical .kilo only)", () => {
    expect(ConfigProtection.isRequest({ permission: "edit", patterns: [".kilo/foo.md"] })).toBe(true)
    expect(ConfigProtection.isRequest({ permission: "edit", patterns: [".kilocode/foo.md"] })).toBe(false)
    expect(ConfigProtection.isRequest({ permission: "edit", patterns: [".kilo/package-lock.json"] })).toBe(true)
    expect(ConfigProtection.isRequest({ permission: "edit", patterns: [".kilocode/package-lock.json"] })).toBe(false)
  })

  test("runtime: project-id ignores .kilocode/config.json (canonical .kilo only)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.$`mkdir -p ${path.join(dir, ".kilocode")}`.quiet()
        await Bun.write(path.join(dir, ".kilocode", "config.json"), JSON.stringify({ project: { id: "legacy-id" } }))
      },
    })
    const id = await provideTestInstance({ directory: tmp.path, fn: () => getKiloProjectId() })
    expect(id).toBeUndefined()
  })

  test("runtime: project-id prefers .kilo/config.json and git fallback, not .kilocode", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.$`mkdir -p ${path.join(dir, ".kilo")}`.quiet()
        await Bun.write(path.join(dir, ".kilo", "config.json"), JSON.stringify({ project: { id: "canonical-id" } }))
        await Bun.$`mkdir -p ${path.join(dir, ".kilocode")}`.quiet()
        await Bun.write(path.join(dir, ".kilocode", "config.json"), JSON.stringify({ project: { id: "legacy-id" } }))
        await Bun.$`git remote add origin https://github.com/Kilo-Org/handbook.git`.cwd(dir).quiet()
      },
    })
    const id = await provideTestInstance({ directory: tmp.path, fn: () => getKiloProjectId() })
    expect(id).toBe("canonical-id")
  })

  test("preservation: KILO_CONFIG_DIR -> Global.Path.config override and sandbox deny remain", () => {
    const flag = readFileSync(join(repo, "packages/core/src/flag/flag.ts"), "utf8")
    expect(flag).toContain("get KILO_CONFIG_DIR()")
    const global = readFileSync(join(repo, "packages/core/src/global.ts"), "utf8")
    expect(global).toContain("Flag.KILO_CONFIG_DIR")
    const policy = read("kilocode/sandbox/policy.ts")
    expect(policy).toContain('"KILO_CONFIG_DIR"')
    expect(policy).toContain('"KILO_CONFIG"')
    expect(Global.Path.config.length).toBeGreaterThan(0)
  })

  test("test-profile lists new regression in sorted order", () => {
    const profile = readFileSync(join(repo, "packages/opencode/script/kilocode/test-profile.ts"), "utf8")
    expect(profile).toContain("p4-4-legacy-filesystem-discovery-removal")
  })
})
