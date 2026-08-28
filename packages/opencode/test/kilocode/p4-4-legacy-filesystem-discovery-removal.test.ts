import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import os from "node:os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { KilocodePaths } from "../../src/kilocode/paths"
import { ConfigProtection } from "../../src/kilocode/permission/config-paths"
import * as Evaluator from "../../src/permission/evaluator"
import { provideTestInstance, tmpdir } from "../fixture/fixture"
import { getKiloProjectId } from "../../src/kilocode/project-id"
import { resolveConfigPath } from "../../src/cli/cmd/mcp"

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

  test("behavioral: KILO_CONFIG_DIR -> Global.Path.config override resolves at runtime", async () => {
    const origEnv = process.env.KILO_CONFIG_DIR
    const tmp = mkdtempSync(path.join(os.tmpdir(), "kilo-config-dir-test-"))
    try {
      process.env.KILO_CONFIG_DIR = tmp
      // Flag getter reads env live
      expect(Flag.KILO_CONFIG_DIR).toBe(tmp)
      // Global.make uses Flag.KILO_CONFIG_DIR ?? Path.config
      const made = Global.make()
      expect(made.config).toBe(tmp)
      // Path.config itself remains XDG, but make() override is the effective authority
      expect(made.config).not.toBe(Global.Path.config)
    } finally {
      if (origEnv === undefined) delete process.env.KILO_CONFIG_DIR
      else process.env.KILO_CONFIG_DIR = origEnv
      rmSync(tmp, { recursive: true, force: true })
      // restore check: after cleanup Flag returns to original
      expect(Flag.KILO_CONFIG_DIR).toBe(origEnv ?? undefined)
    }
  })

  test("behavioral: sandbox deny protects Global.Path.config and KILO envs at runtime", async () => {
    const { profile } = await import("../../src/kilocode/sandbox/policy")
    const ctx = { directory: "/tmp/proj", worktree: "/tmp/proj", project: { id: "test" } as any }
    const p = profile(ctx as any)
    // filesystem denyWrite must include Global.Path.config sandbox root
    const denyPaths = p.filesystem.denyWrite.map((r: any) => r.path)
    expect(denyPaths).toContain(Global.Path.config)
    // environment deny must include KILO_CONFIG_DIR and related
    expect(p.environment.deny).toContain("KILO_CONFIG_DIR")
    expect(p.environment.deny).toContain("KILO_CONFIG")
    expect(p.environment.deny).toContain("KILO_CONFIG_CONTENT")
    // allowWrite must include Global.Path.config as writable (sandbox allows with denyWrite overlay)
    const allowPaths = p.filesystem.allowWrite.map((r: any) => r.path)
    expect(allowPaths).toContain(Global.Path.config)
  })

  test("behavioral: evaluator protects canonical .kilo but not legacy .kilocode/.opencode", async () => {
    const ws = "/tmp/ws-proj"
    // mutating permissions: edit/write/bash/external_directory are protected
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(".kilocode/foo.md", ws, "edit")).toBe(false)
    expect(Evaluator.isProtectedForCeiling(".kilo/package-lock.json", ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(".kilocode/package-lock.json", ws, "edit")).toBe(false)
    // opencode.json at root should no longer be protected (canonical only kilo.json[kilo.jsonc])
    expect(Evaluator.isProtectedForCeiling("kilo.json", ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling("opencode.json", ws, "edit")).toBe(false)
    expect(Evaluator.isProtectedForCeiling("opencode.jsonc", ws, "edit")).toBe(false)
    // non-mutating read is never protected
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "read")).toBe(false)
    // global protected: ~/.kilo is protected, ~/.kilocode is not
    const home = os.homedir()
    const globalKilo = path.join(home, ".kilo", "kilo.jsonc")
    const globalKilocode = path.join(home, ".kilocode", "kilo.jsonc")
    expect(Evaluator.isProtectedForCeiling(globalKilo, ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(globalKilocode, ws, "edit")).toBe(false)
    // Global.Path.config is protected
    const globalConfigFile = path.join(Global.Path.config, "kilo.jsonc")
    expect(Evaluator.isProtectedForCeiling(globalConfigFile, ws, "edit")).toBe(true)
    // Plans under .kilo are exempt
    expect(Evaluator.isProtectedForCeiling(".kilo/plans/foo.md", ws, "edit")).toBe(false)
  })

  test("behavioral: evaluator evaluate asks on canonical .kilo, allows legacy .kilocode", () => {
    const ws = "/tmp/ws-proj"
    const baseReq = (pattern: string) => ({
      permission: "edit" as const,
      patterns: [pattern],
      targets: [Evaluator.canonicalForPermission(pattern, "edit", ws)],
      permissionRequestId: "per_test",
      operationId: "permission:per_test",
      sessionID: "ses_test",
      agent: "test",
      workspaceRoot: ws,
    })
    const layers: Evaluator.LayerInput[] = [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }]
    const canon = Evaluator.evaluate({ request: baseReq(".kilo/foo.md") as any, layers, approvals: [], allowEverything: false })
    expect(canon.result).toBe("ask-ceiling")
    expect(canon.ceilingId).toBe("(b)")
    const legacy = Evaluator.evaluate({ request: baseReq(".kilocode/foo.md") as any, layers, approvals: [], allowEverything: false })
    expect(legacy.result).toBe("ask")
    expect(legacy.ceilingId).toBeNull()
    const opencodeRoot = Evaluator.evaluate({ request: baseReq("opencode.json") as any, layers, approvals: [], allowEverything: false })
    expect(opencodeRoot.result).toBe("ask")
  })

  test("behavioral: evaluator workspace .kilo/plans exempt even when workspace overlaps global config root", () => {
    const home = os.homedir()
    const ws = home
    // absolute workspace .kilo/plans must be exempt even though ~/.kilo is global protected root
    expect(Evaluator.isProtectedForCeiling(path.join(home, ".kilo", "plans", "foo.md"), ws, "edit")).toBe(false)
    expect(Evaluator.isProtectedForCeiling(path.join(home, ".kilo", "plans", "nested", "bar.md"), ws, "edit")).toBe(false)
    // relative .kilo/plans with overlapping workspace also exempt
    expect(Evaluator.isProtectedForCeiling(".kilo/plans/foo.md", ws, "edit")).toBe(false)
    // canonical .kilo file still protected under overlap
    expect(Evaluator.isProtectedForCeiling(path.join(home, ".kilo", "foo.md"), ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(path.join(home, ".kilo", "kilo.jsonc"), ws, "edit")).toBe(true)
    // Global.Path.config file remains protected (non-plans)
    expect(Evaluator.isProtectedForCeiling(path.join(Global.Path.config, "kilo.jsonc"), ws, "edit")).toBe(true)
    // evaluator evaluate: plans should not trigger ceiling even under overlap
    const baseReq = (pattern: string) => ({
      permission: "edit" as const,
      patterns: [pattern],
      targets: [Evaluator.canonicalForPermission(pattern, "edit", ws)],
      permissionRequestId: "per_overlap",
      operationId: "permission:per_overlap",
      sessionID: "ses_test",
      agent: "test",
      workspaceRoot: ws,
    })
    const layers: Evaluator.LayerInput[] = [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }]
    const plansOverlap = Evaluator.evaluate({ request: baseReq(path.join(home, ".kilo", "plans", "foo.md")) as any, layers, approvals: [], allowEverything: false })
    expect(plansOverlap.result).toBe("ask")
    expect(plansOverlap.ceilingId).toBeNull()
    const kiloOverlap = Evaluator.evaluate({ request: baseReq(path.join(home, ".kilo", "foo.md")) as any, layers, approvals: [], allowEverything: false })
    expect(kiloOverlap.result).toBe("ask-ceiling")
    expect(kiloOverlap.ceilingId).toBe("(b)")
  })

  test("behavioral: global ~/.kilo/plans protected outside workspace, workspace .kilo/plans exempt", async () => {
    const home = os.homedir()
    await using tmp = await tmpdir()
    const ws = tmp.path
    expect(ws).not.toBe(home)
    // global ~/.kilo/plans remains protected when workspace is elsewhere
    expect(Evaluator.isProtectedForCeiling(path.join(home, ".kilo", "plans", "foo.md"), ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(path.join(home, ".kilo", "plans", "nested", "bar.md"), ws, "edit")).toBe(true)
    // workspace-local .kilo/plans is exempt
    expect(Evaluator.isProtectedForCeiling(path.join(ws, ".kilo", "plans", "foo.md"), ws, "edit")).toBe(false)
    expect(Evaluator.isProtectedForCeiling(".kilo/plans/foo.md", ws, "edit")).toBe(false)
    // non-plans global remains protected for completeness
    expect(Evaluator.isProtectedForCeiling(path.join(home, ".kilo", "foo.md"), ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(path.join(Global.Path.config, "kilo.jsonc"), ws, "edit")).toBe(true)
    // legacy plans never protected
    expect(Evaluator.isProtectedForCeiling(path.join(home, ".kilocode", "plans", "foo.md"), ws, "edit")).toBe(false)
    // evaluator ceiling: global plans triggers class-b, workspace plans does not
    const baseReq = (pattern: string) => ({
      permission: "edit" as const,
      patterns: [pattern],
      targets: [Evaluator.canonicalForPermission(pattern, "edit", ws)],
      permissionRequestId: "per_global_plans",
      operationId: "permission:per_global_plans",
      sessionID: "ses_test",
      agent: "test",
      workspaceRoot: ws,
    })
    const layers: Evaluator.LayerInput[] = [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }]
    const globalPlans = Evaluator.evaluate({ request: baseReq(path.join(home, ".kilo", "plans", "foo.md")) as any, layers, approvals: [], allowEverything: false })
    expect(globalPlans.result).toBe("ask-ceiling")
    expect(globalPlans.ceilingId).toBe("(b)")
    const wsPlans = Evaluator.evaluate({ request: baseReq(path.join(ws, ".kilo", "plans", "foo.md")) as any, layers, approvals: [], allowEverything: false })
    expect(wsPlans.result).toBe("ask")
    expect(wsPlans.ceilingId).toBeNull()
    const wsRelative = Evaluator.evaluate({ request: baseReq(".kilo/plans/foo.md") as any, layers, approvals: [], allowEverything: false })
    expect(wsRelative.result).toBe("ask")
    expect(wsRelative.ceilingId).toBeNull()
  })

  test("behavioral: MCP resolver chooses canonical .kilo and never legacy even if legacy exists", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // create legacy files that should be ignored
        await Bun.$`mkdir -p ${path.join(dir, ".kilocode")}`.quiet()
        await Bun.write(path.join(dir, ".kilocode", "kilo.jsonc"), JSON.stringify({ mcp: {} }))
        await Bun.write(path.join(dir, ".kilocode", "opencode.json"), JSON.stringify({ mcp: {} }))
        await Bun.$`mkdir -p ${path.join(dir, ".kilo")}`.quiet()
        await Bun.write(path.join(dir, ".kilo", "opencode.jsonc"), JSON.stringify({ mcp: {} }))
        // also create root opencode that should be ignored
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ mcp: {} }))
        await Bun.write(path.join(dir, "kilo.json"), JSON.stringify({ mcp: {} }))
      },
    })
    // No canonical .kilo/kilo.jsonc exists yet -> resolver should default to canonical, not legacy
    const fallback = await resolveConfigPath(tmp.path, false)
    expect(fallback).toBe(path.join(tmp.path, ".kilo", "kilo.jsonc"))
    expect(fallback).not.toContain("/.kilocode/")
    expect(path.basename(fallback)).not.toContain("opencode")
    // Create canonical file -> resolver must pick it
    await Bun.write(path.join(tmp.path, ".kilo", "kilo.jsonc"), JSON.stringify({ mcp: { s: { type: "local", command: ["echo"] } } }))
    const canonical = await resolveConfigPath(tmp.path, false)
    expect(canonical).toBe(path.join(tmp.path, ".kilo", "kilo.jsonc"))
    // Local fallback: when only .kilo/kilo.json exists, resolver picks .kilo/kilo.json (canonical .json fallback)
    await using ltmp = await tmpdir({
      init: async (dir) => {
        await Bun.$`mkdir -p ${path.join(dir, ".kilo")}`.quiet()
        await Bun.write(path.join(dir, ".kilo", "kilo.json"), JSON.stringify({ mcp: {} }))
      },
    })
    const lFallback = await resolveConfigPath(ltmp.path, false)
    expect(lFallback).toBe(path.join(ltmp.path, ".kilo", "kilo.json"))
    expect(path.basename(lFallback)).not.toContain("opencode")
    expect(path.basename(lFallback)).toBe("kilo.json")
    // Global resolver: ignore opencode, pick kilo.json when jsonc absent
    await using gtmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ mcp: {} }))
        await Bun.write(path.join(dir, "kilo.json"), JSON.stringify({ mcp: {} }))
      },
    })
    const gFallback = await resolveConfigPath(gtmp.path, true)
    expect(gFallback).toBe(path.join(gtmp.path, "kilo.json"))
    expect(path.basename(gFallback)).not.toContain("opencode")
    expect(path.basename(gFallback)).toBe("kilo.json")
    // create kilo.jsonc and test priority prefers jsonc
    await Bun.write(path.join(gtmp.path, "kilo.jsonc"), JSON.stringify({ mcp: {} }))
    const gCanonical = await resolveConfigPath(gtmp.path, true)
    expect(gCanonical).toBe(path.join(gtmp.path, "kilo.jsonc"))
    expect(path.basename(gCanonical)).not.toContain("opencode")
  })

  test("test-profile lists new regression in sorted order", () => {
    const profile = readFileSync(join(repo, "packages/opencode/script/kilocode/test-profile.ts"), "utf8")
    expect(profile).toContain("p4-4-legacy-filesystem-discovery-removal")
  })
})
