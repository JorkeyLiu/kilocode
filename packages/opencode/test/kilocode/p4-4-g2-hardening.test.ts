import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { ConfigProtection } from "../../src/kilocode/permission/config-paths"
import { KilocodePaths } from "../../src/kilocode/paths"
import * as ConfigPaths from "../../src/config/paths"
import { resolveConfigPath } from "../../src/cli/cmd/mcp"
import * as Evaluator from "../../src/permission/evaluator"
import { tmpdir } from "../fixture/fixture"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"

// --- ConfigProtection legacy/canonical boundaries ---

describe("P4.4-G2 ConfigProtection legacy/canonical hardening", () => {
  test("hasGlobSyntax rejects legacy opencode/kilocode without glob and detects globs", () => {
    expect(ConfigProtection.hasGlobSyntax(".kilo/foo.md")).toBe(false)
    expect(ConfigProtection.hasGlobSyntax(".kilocode/foo.md")).toBe(false)
    expect(ConfigProtection.hasGlobSyntax("opencode.json")).toBe(false)
    expect(ConfigProtection.hasGlobSyntax("*.kilo/foo")).toBe(true)
    expect(ConfigProtection.hasGlobSyntax("foo?.md")).toBe(true)
    expect(ConfigProtection.hasGlobSyntax("foo[abc].md")).toBe(true)
    expect(ConfigProtection.hasGlobSyntax("foo{a,b}.md")).toBe(true)
    expect(ConfigProtection.hasGlobSyntax("foo/b[ar]/baz")).toBe(true)
  })

  test("isLexicalSkillWildcard detects skill/skills glob and ignores non-skill globs", () => {
    // positive - lexical skill detection even when dir does not exist
    expect(ConfigProtection.isLexicalSkillWildcard("/tmp/x/skills/demo/*")).toBe(true)
    expect(ConfigProtection.isLexicalSkillWildcard("skills/demo/**")).toBe(true)
    expect(ConfigProtection.isLexicalSkillWildcard("/a/b/skill/foo/*.md")).toBe(true)
    expect(ConfigProtection.isLexicalSkillWildcard("/a/b/skills/foo/file?.txt")).toBe(true)
    // negative - non-skill globs not lexical skill
    expect(ConfigProtection.isLexicalSkillWildcard("/tmp/outside/file*.txt")).toBe(false)
    expect(ConfigProtection.isLexicalSkillWildcard(".kilo/foo.md")).toBe(false)
    expect(ConfigProtection.isLexicalSkillWildcard("kilo.json")).toBe(false)
    // no glob => not wildcard even if skill segment present
    expect(ConfigProtection.isLexicalSkillWildcard("/a/b/skills/foo/file.txt")).toBe(false)
    expect(ConfigProtection.hasLexicalSkillWildcard(["/tmp/outside/*.txt", ".kilo/foo.md"])).toBe(false)
    expect(ConfigProtection.hasLexicalSkillWildcard(["/tmp/x/skills/demo/*"])).toBe(true)
  })

  test("normalizePath and isRelative handle nested .kilo and traversal", () => {
    expect(ConfigProtection.normalizePath(".kilo//foo.md")).toBe(".kilo/foo.md")
    expect(ConfigProtection.normalizePath("a/./b/../c/.kilo/foo.md")).toBe("a/c/.kilo/foo.md")
    expect(ConfigProtection.isRelative(".kilo/foo.md")).toBe(true)
    expect(ConfigProtection.isRelative("a/b/.kilo/foo.md")).toBe(true)
    expect(ConfigProtection.isRelative("a/.kilocode/foo.md")).toBe(false)
    expect(ConfigProtection.isRelative("src/.kilo/plans/foo.md")).toBe(false)
    expect(ConfigProtection.isRelative(".kilo/plans/foo.md")).toBe(false)
    expect(ConfigProtection.isRelative("packages/sub/.kilo/foo.md")).toBe(true)
    expect(ConfigProtection.isRelative("nested/.kilo/plans/nested.md")).toBe(false)
  })

  test("isProtectedPath handles absolute vs relative, legacy not protected", async () => {
    await using tmp = await tmpdir()
    const absKilo = path.join(tmp.path, ".kilo", "foo.md")
    await fs.mkdir(path.dirname(absKilo), { recursive: true })
    await Bun.write(absKilo, "x")
    // absolute under tmp not global, but relative checks still apply via isRelative for ".kilo/..."
    expect(ConfigProtection.isProtectedPath(".kilo/foo.md")).toBe(true)
    expect(ConfigProtection.isProtectedPath(".kilocode/foo.md")).toBe(false)
    expect(ConfigProtection.isProtectedPath("opencode.json")).toBe(false)
    expect(ConfigProtection.isProtectedPath("kilo.json")).toBe(true)
    // absolute non-config not protected
    expect(ConfigProtection.isProtectedPath("/tmp/some/file.txt")).toBe(false)
    // absolute under Global.Path.config is protected
    expect(ConfigProtection.isProtectedPath(path.join(Global.Path.config, "kilo.jsonc"))).toBe(true)
  })

  test("canonicalKey resolves relative against base and deduplicates physical", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    const rel = ".kilo/foo.md"
    const abs = path.join(tmp.path, ".kilo", "foo.md")
    const keyRel = ConfigProtection.canonicalKey(rel, tmp.path)
    const keyAbs = ConfigProtection.canonicalKey(abs, tmp.path)
    expect(keyRel).toBe(keyAbs)
    // same relative in different base yields different identity
    await using tmp2 = await tmpdir()
    await fs.mkdir(path.join(tmp2.path, ".kilo"), { recursive: true })
    const keyOther = ConfigProtection.canonicalKey(rel, tmp2.path)
    expect(keyRel).not.toBe(keyOther)
    // absolute always posix normalized
    expect(keyAbs).not.toContain("\\")
  })

  test("isRequest handles comma-joined apply_patch filepath and files[].filePath/movePath", () => {
    // comma-joined relative patterns via metadata.filepath
    expect(
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: [],
        metadata: { filepath: "src/app.ts, .kilo/foo.md, .kilocode/bar.md" },
      }),
    ).toBe(true)
    expect(
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: [],
        metadata: { filepath: ".kilocode/foo.md" },
      }),
    ).toBe(false)
    // files[] with absolute filePath inside Global.Path.config
    expect(
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: [],
        metadata: { files: [{ filePath: path.join(Global.Path.config, "kilo.jsonc") }] },
      }),
    ).toBe(true)
    expect(
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: [],
        metadata: { files: [{ filePath: "/tmp/outside/file.txt" }] },
      }),
    ).toBe(false)
    expect(
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: [],
        metadata: { files: [{ movePath: path.join(Global.Path.config, "skills", "x", "SKILL.md") }] },
      }),
    ).toBe(true)
    // mixed filePath + movePath
    expect(
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: [],
        metadata: {
          files: [
            { filePath: "src/index.ts" },
            { movePath: ".kilo/foo.md" },
          ],
        },
      }),
    ).toBe(true)
  })

  test("isRequest respects external_directory read access bypass and filepath gate", () => {
    const cfg = path.join(Global.Path.config, "skills", "x", "*")
    // bash read-only bypass via metadata.access === read
    expect(
      ConfigProtection.isRequest({
        permission: "external_directory",
        patterns: [cfg],
        metadata: { access: "read" },
      }),
    ).toBe(false)
    // file-tool with filepath still bypasses even though pattern is protected
    expect(
      ConfigProtection.isRequest({
        permission: "external_directory",
        patterns: [cfg],
        metadata: { filepath: path.join(Global.Path.config, "file.txt") },
      }),
    ).toBe(false)
    // non-config external_directory with empty metadata not protected
    expect(
      ConfigProtection.isRequest({
        permission: "external_directory",
        patterns: ["/tmp/proj/*"],
        metadata: {},
      }),
    ).toBe(false)
  })

  test("isAbsolute with symlink to global config converges", async () => {
    await using real = await tmpdir()
    await fs.mkdir(path.join(real.path, "kilo"), { recursive: true })
    const realFile = path.join(real.path, "kilo", "kilo.jsonc")
    await Bun.write(realFile, "{}")
    await using linkBase = await tmpdir()
    const link = path.join(linkBase.path, "link-kilo")
    await fs.symlink(path.join(real.path, "kilo"), link, process.platform === "win32" ? "junction" : "dir")
    const prev = Global.Path.config
    try {
      ;(Global.Path as { config: string }).config = path.join(real.path, "kilo")
      const viaLink = path.join(link, "kilo.jsonc")
      expect(ConfigProtection.isAbsolute(viaLink)).toBe(true)
      expect(ConfigProtection.isAbsolute(path.join(linkBase.path, "other", "file.txt"))).toBe(false)
    } finally {
      ;(Global.Path as { config: string }).config = prev
    }
  })

  test("globalSkillPattern rejects non-absolute and mismatched roots", async () => {
    // non-absolute pattern cannot resolve to global skill
    expect(
      ConfigProtection.globalSkillPattern({ permission: "external_directory", patterns: ["skills/demo/*"] }),
    ).toBeUndefined()
    expect(ConfigProtection.isGlobalSkillRequest({ permission: "external_directory", patterns: ["skills/demo/*"] })).toBe(false)
    // external_directory required
    await using tmp = await tmpdir()
    const prev = Global.Path.config
    try {
      ;(Global.Path as { config: string }).config = tmp.path
      await fs.mkdir(path.join(tmp.path, "skills", "demo"), { recursive: true })
      const abs = path.join(tmp.path, "skills", "demo", "*")
      expect(ConfigProtection.globalSkillPattern({ permission: "edit", patterns: [abs] })).toBeUndefined()
      // mismatched second skill within same request should reject
      const other = path.join(tmp.path, "skills", "other", "*")
      await fs.mkdir(path.join(tmp.path, "skills", "other"), { recursive: true })
      expect(ConfigProtection.isGlobalSkillRequest({ permission: "external_directory", patterns: [abs, other] })).toBe(false)
    } finally {
      ;(Global.Path as { config: string }).config = prev
    }
  })
})

// --- Evaluator legacy/canonical boundaries ---

describe("P4.4-G2 permission evaluator canonical hardening", () => {
  const ws = "/tmp/ws-g2"

  function req(pattern: string, permission = "edit", extra: Partial<Evaluator.Request> = {}): Evaluator.Request {
    return {
      permission,
      patterns: [pattern],
      permissionRequestId: "per_g2",
      operationId: "permission:per_g2",
      sessionID: "sess_g2",
      agent: "agent-g2",
      workspaceRoot: ws,
      ...extra,
    }
  }

  test("canonicalForPermission preserves glob, canonicalizes file-bearing without glob", () => {
    expect(Evaluator.canonicalForPermission("*.env", "read", ws)).toBe("*.env")
    expect(Evaluator.canonicalForPermission("skills/demo/*", "external_directory", ws)).toBe("skills/demo/*")
    expect(Evaluator.canonicalForPermission("bash", "bash", ws)).toBe("bash")
    // file-bearing without glob resolves absolute under ws (physical symlink /tmp -> /private/tmp on darwin allowed)
    const rel = "kilo.json"
    const canon = Evaluator.canonicalForPermission(rel, "edit", ws)
    expect(canon.endsWith("/kilo.json")).toBe(true)
    expect(canon).toContain("ws-g2")
    expect(Evaluator.canonicalForPermission("foo[bar].txt", "edit", ws)).toBe("foo[bar].txt")
  })

  test("buildCanonicalTargets deduplicates via canonical and respects metadata", () => {
    const base = Evaluator.buildCanonicalTargets({ permission: "edit", patterns: [".kilo/foo.md", path.join(ws, ".kilo", "foo.md")] }, ws)
    expect(base.length).toBe(1)
    const withFilepath = Evaluator.buildCanonicalTargets(
      { permission: "edit", patterns: [".kilo/foo.md"], metadata: { filepath: `${path.join(ws, ".kilo", "foo.md")}, .kilo/foo.md` } },
      ws,
    )
    expect(withFilepath.length).toBe(1)
    const withFiles = Evaluator.buildCanonicalTargets(
      {
        permission: "edit",
        patterns: ["src/a.ts"],
        metadata: { files: [{ filePath: path.join(ws, ".kilo", "foo.md") }, { movePath: path.join(ws, ".kilo", "foo.md") }] },
      },
      ws,
    )
    expect(withFiles.some((p) => p.endsWith(".kilo/foo.md"))).toBe(true)
    // non-file permission preserves literal (bash)
    const bash = Evaluator.buildCanonicalTargets({ permission: "bash", patterns: ["npm install"] }, ws)
    expect(bash).toEqual(["npm install"])
  })

  test("hasWildcardPattern vs hasGlobSyntaxPattern distinction", () => {
    expect(Evaluator.hasWildcardPattern("*.txt")).toBe(true)
    expect(Evaluator.hasWildcardPattern("foo?.txt")).toBe(true)
    // hasWildcardPattern checks [*?[]{}] same as hasGlobSyntax - both true for any glob
    expect(Evaluator.hasGlobSyntaxPattern("foo?.txt")).toBe(true)
    expect(Evaluator.hasGlobSyntaxPattern("foo{a,b}.txt")).toBe(true)
    expect(Evaluator.hasWildcardPattern("kilo.json")).toBe(false)
  })

  test("isProtectedForCeiling mutating set and external_directory skill wildcard", () => {
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "write")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "bash")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "external_directory")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "read")).toBe(false)
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "task")).toBe(false)
    // external_directory skill wildcard always ceiling even without file protection
    expect(Evaluator.isProtectedForCeiling("skills/demo/*", ws, "external_directory")).toBe(true)
    expect(Evaluator.isProtectedForCeiling("/tmp/a/skills/demo/*", ws, "external_directory")).toBe(true)
    expect(Evaluator.isProtectedForCeiling("/tmp/a/skills/demo/**", ws, "external_directory")).toBe(true)
    // non-mutating external_directory without skill wildcard still uses protected path if under .kilo
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", ws, "external_directory")).toBe(true)
    expect(Evaluator.isProtectedForCeiling("/tmp/outside/file.txt", ws, "external_directory")).toBe(false)
  })

  test("evaluator ceiling b for mutating protected and c for read env are distinct", () => {
    // mutating protected .kilo file => ceiling b
    const rEdit = req(".kilo/foo.md", "edit")
    const layersEdit: Evaluator.LayerInput[] = [{ kind: "global", sourceKind: "global-file", canonicalPath: "/tmp/global", ruleset: [{ permission: "edit", pattern: "*", action: "allow" }] }]
    const outEdit = Evaluator.evaluate({ request: rEdit, layers: layersEdit, approvals: [], allowEverything: false })
    expect(outEdit.result).toBe("ask-ceiling")
    expect(outEdit.ceilingId).toBe("(b)")
    // read env file with broad allow => ceiling c
    const rRead = req("secret.env", "read")
    const layersRead: Evaluator.LayerInput[] = [{ kind: "global", sourceKind: "global-file", canonicalPath: "/tmp/global", ruleset: [{ permission: "read", pattern: "*", action: "allow" }] }]
    const outRead = Evaluator.evaluate({ request: rRead, layers: layersRead, approvals: [], allowEverything: false })
    expect(outRead.result).toBe("ask-ceiling")
    expect(outRead.ceilingId).toBe("(c)")
    // read under .kilo is not ceiling b (read is not mutating) but env still triggers c when broad
    const envKilo = path.join(ws, ".kilo", "secret.env")
    const reqKiloRead: Evaluator.Request = { ...rRead, patterns: [envKilo], targets: [Evaluator.canonicalForPermission(envKilo, "read", ws)] }
    const outKiloRead = Evaluator.evaluate({ request: reqKiloRead, layers: layersRead, approvals: [], allowEverything: false })
    expect(outKiloRead.result).toBe("ask-ceiling")
    expect(outKiloRead.ceilingId).toBe("(c)")
  })

  test("hard deny absolute survives mode-filtered layer and provenance ceiling-a", () => {
    const r = req("/tmp/ws-g2/outside.txt", "external_directory")
    const hard = [{ permission: "*", pattern: "*", action: "deny" as const }]
    const layers: Evaluator.LayerInput[] = [{ kind: "global", sourceKind: "global-file", canonicalPath: "/tmp/global", ruleset: [{ permission: "external_directory", pattern: "*", action: "allow" }] }]
    const out = Evaluator.evaluate({ request: r, layers, approvals: [], allowEverything: true, hardDenyRuleset: hard })
    expect(out.result).toBe("deny")
    expect(out.provenance.decisive.ceilingId).toBe("(a)")
    // winningRule filtering: mode deny alone should not grant deny via layer
    const r2 = req("/tmp/file.txt", "external_directory")
    const layers2: Evaluator.LayerInput[] = [{ kind: "global", sourceKind: "global-file", canonicalPath: "/tmp/global", ruleset: [{ permission: "*", pattern: "*", action: "deny" }] }]
    const out2 = Evaluator.evaluate({ request: r2, layers: layers2, approvals: [], allowEverything: false })
    expect(out2.result).toBe("ask")
  })

  test("approval exactness rejects globs, star sessionID, and cross-permission", () => {
    const ws2 = "/workspace"
    const r = { permission: "edit", patterns: [path.join(ws2, "kilo.json")], targets: [path.join(ws2, "kilo.json")], permissionRequestId: "per_app", operationId: "permission:per_app", sessionID: "sess_app", agent: "agent-a", workspaceRoot: ws2 } as Evaluator.Request
    const layers: Evaluator.LayerInput[] = [{ kind: "global", sourceKind: "global-file", canonicalPath: "/tmp/global", ruleset: [{ permission: "edit", pattern: "*", action: "allow" }] }]
    const globAp: Evaluator.Approval = { kind: "session", patterns: ["*"], permission: "edit", sessionID: "sess_app", agent: "agent-a" }
    const outGlob = Evaluator.evaluate({ request: r, layers, approvals: [globAp], allowEverything: false })
    expect(outGlob.result).toBe("ask-ceiling")
    const starSid: Evaluator.Approval = { kind: "session", patterns: [path.join(ws2, "kilo.json")], permission: "edit", sessionID: "*", agent: "agent-a" }
    const outStar = Evaluator.evaluate({ request: r, layers, approvals: [starSid], allowEverything: false })
    expect(outStar.result).toBe("ask-ceiling")
    const crossPerm: Evaluator.Approval = { kind: "session", patterns: [path.join(ws2, "kilo.json")], permission: "read", sessionID: "sess_app", agent: "agent-a" }
    const outCross = Evaluator.evaluate({ request: r, layers, approvals: [crossPerm], allowEverything: false })
    expect(outCross.result).toBe("ask-ceiling")
  })

  test("workspaceRoot undefined lexical .kilo handling vs defined", () => {
    expect(Evaluator.isProtectedForCeiling(".kilo/foo.md", undefined, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling("a/b/.kilo/foo.md", undefined, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling(".kilocode/foo.md", undefined, "edit")).toBe(false)
    expect(Evaluator.isProtectedForCeiling("kilo.json", undefined, "edit")).toBe(true)
    expect(Evaluator.isProtectedForCeiling("opencode.json", undefined, "edit")).toBe(false)
  })
})

// --- MCP canonical path hardening ---

describe("P4.4-G2 MCP canonical path hardening", () => {
  test("project resolve prefers jsonc over json when both exist and ignores legacy", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
        await Bun.write(path.join(dir, ".kilo", "kilo.json"), JSON.stringify({ mcp: {} }))
        await Bun.write(path.join(dir, ".kilo", "kilo.jsonc"), JSON.stringify({ mcp: {} }))
        // legacy that must be ignored
        await fs.mkdir(path.join(dir, ".kilocode"), { recursive: true })
        await Bun.write(path.join(dir, ".kilocode", "kilo.jsonc"), JSON.stringify({ mcp: {} }))
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ mcp: {} }))
      },
    })
    const picked = await resolveConfigPath(tmp.path, false)
    expect(picked).toBe(path.join(tmp.path, ".kilo", "kilo.jsonc"))
    expect(picked).not.toContain(".kilocode")
  })

  test("project resolve defaults to .kilo/kilo.jsonc when none exists and does not walk parents", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
        await Bun.write(path.join(dir, ".kilo", "kilo.jsonc"), JSON.stringify({ mcp: { s: { type: "local", command: ["echo"] } } }))
        const nested = path.join(dir, "a", "b")
        await fs.mkdir(nested, { recursive: true })
      },
    })
    const nested = path.join(tmp.path, "a", "b")
    const pickedNested = await resolveConfigPath(nested, false)
    // should default to nested's own canonical, not parent's found file
    expect(pickedNested).toBe(path.join(nested, ".kilo", "kilo.jsonc"))
    const rootPicked = await resolveConfigPath(tmp.path, false)
    expect(rootPicked).toBe(path.join(tmp.path, ".kilo", "kilo.jsonc"))
  })

  test("global resolve prefers kilo.jsonc over kilo.json and ignores opencode/legacy", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "kilo.json"), JSON.stringify({ mcp: {} }))
        await Bun.write(path.join(dir, "kilo.jsonc"), JSON.stringify({ mcp: {} }))
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ mcp: {} }))
        await Bun.write(path.join(dir, "opencode.jsonc"), JSON.stringify({ mcp: {} }))
        await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
        await Bun.write(path.join(dir, ".kilo", "kilo.jsonc"), JSON.stringify({ mcp: {} }))
      },
    })
    const picked = await resolveConfigPath(tmp.path, true)
    expect(picked).toBe(path.join(tmp.path, "kilo.jsonc"))
    expect(path.basename(picked)).not.toContain("opencode")
    // when only kilo.json exists, picks kilo.json
    await using tmp2 = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "kilo.json"), JSON.stringify({ mcp: {} }))
      },
    })
    const picked2 = await resolveConfigPath(tmp2.path, true)
    expect(picked2).toBe(path.join(tmp2.path, "kilo.json"))
    // when none exists, defaults to kilo.jsonc
    await using tmp3 = await tmpdir()
    const picked3 = await resolveConfigPath(tmp3.path, true)
    expect(picked3).toBe(path.join(tmp3.path, "kilo.jsonc"))
  })

  test("project fallback when only kilo.json exists picks json and remains canonical", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
        await Bun.write(path.join(dir, ".kilo", "kilo.json"), JSON.stringify({ mcp: {} }))
      },
    })
    const picked = await resolveConfigPath(tmp.path, false)
    expect(picked).toBe(path.join(tmp.path, ".kilo", "kilo.json"))
    expect(path.basename(picked)).toBe("kilo.json")
    expect(picked).not.toContain(".kilocode")
    expect(path.basename(picked)).not.toBe("opencode.json")
  })
})

// --- KilocodePaths and ConfigPaths canonical hardening ---

describe("P4.4-G2 KilocodePaths / ConfigPaths canonical hardening", () => {
  test("globalDirs is canonical .kilo only and respects HOME override", async () => {
    const dirs = KilocodePaths.globalDirs()
    expect(dirs.length).toBe(1)
    expect(dirs[0].endsWith(".kilo")).toBe(true)
    expect(dirs.some((d) => d.endsWith(".kilocode"))).toBe(false)
    // HOME override path
    await using tmp = await tmpdir()
    const prevHome = process.env.HOME
    const prevUser = process.env.USERPROFILE
    process.env.HOME = tmp.path
    delete process.env.USERPROFILE
    try {
      const overridden = KilocodePaths.globalDirs()
      expect(overridden[0]).toBe(path.join(tmp.path, ".kilo"))
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome
      else delete process.env.HOME
      if (prevUser !== undefined) process.env.USERPROFILE = prevUser
      else delete process.env.USERPROFILE
    }
  })

  test("skillDirectories walk up from projectDir to worktreeRoot for .kilo only", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const rootSkill = path.join(dir, ".kilo", "skills", "root-skill")
        await fs.mkdir(rootSkill, { recursive: true })
        await Bun.write(path.join(rootSkill, "SKILL.md"), "# root")
        const nested = path.join(dir, "packages", "nested")
        const nestedSkill = path.join(nested, ".kilo", "skills", "nested-skill")
        await fs.mkdir(nestedSkill, { recursive: true })
        await Bun.write(path.join(nestedSkill, "SKILL.md"), "# nested")
        // legacy nested must be ignored
        const legacy = path.join(nested, ".kilocode", "skills", "legacy")
        await fs.mkdir(legacy, { recursive: true })
        await Bun.write(path.join(legacy, "SKILL.md"), "# legacy")
      },
    })
    const nestedPath = path.join(tmp.path, "packages", "nested")
    const all = await KilocodePaths.skillDirectories({ projectDir: nestedPath, worktreeRoot: tmp.path, skipGlobalPaths: true })
    expect(all.length).toBe(2)
    expect(all.some((d) => d.includes("nested"))).toBe(true)
    expect(all.some((d) => !d.includes("nested") && d.endsWith(".kilo"))).toBe(true)
    expect(all.some((d) => d.includes(".kilocode"))).toBe(false)
    // when worktreeRoot equals projectDir, only that dir's .kilo discovered
    const single = await KilocodePaths.skillDirectories({ projectDir: nestedPath, worktreeRoot: nestedPath, skipGlobalPaths: true })
    expect(single.length).toBe(1)
    expect(single[0]).toBe(path.join(nestedPath, ".kilo"))
  })

  test("ConfigPaths.fileInDirectory and directories are canonical", async () => {
    expect(ConfigPaths.fileInDirectory("/tmp/proj", "tui")).toEqual([path.join("/tmp/proj", "tui.json"), path.join("/tmp/proj", "tui.jsonc")])
    expect(ConfigPaths.fileInDirectory("/tmp/proj", "kilo")).toEqual([path.join("/tmp/proj", "kilo.json"), path.join("/tmp/proj", "kilo.jsonc")])
    // directories is global-only and does not require FS layer
    const dirs = await Effect.runPromise(ConfigPaths.directories())
    expect(dirs).toEqual([Global.Path.config])
    expect(dirs.some((d) => d.includes(".kilocode"))).toBe(false)
  })

  test("ConfigPaths.files walks and reverses order", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
        await Bun.write(path.join(dir, "kilo.jsonc"), "{}")
        const nested = path.join(dir, "a", "b")
        await fs.mkdir(nested, { recursive: true })
        await Bun.write(path.join(nested, "kilo.json"), "{}")
        // legacy fixture: .kilocode dir with kilo files must be ignored — files only targets `${name}.json[c]` under walked dirs
        await fs.mkdir(path.join(dir, ".kilocode"), { recursive: true })
        await Bun.write(path.join(dir, ".kilocode", "kilo.jsonc"), "{}")
        await fs.mkdir(path.join(nested, ".kilocode"), { recursive: true })
        await Bun.write(path.join(nested, ".kilocode", "kilo.json"), "{}")
        await Bun.write(path.join(dir, "opencode.json"), "{}")
      },
    })
    const nested = path.join(tmp.path, "a", "b")
    // files requires FSUtil + NodeFileSystem; provide both
    const { NodeFileSystem } = await import("@effect/platform-node")
    const found = await Effect.runPromise(
      ConfigPaths.files("kilo", nested, tmp.path).pipe(Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer)),
    )
    expect(found).toEqual([path.join(tmp.path, "kilo.jsonc"), path.join(nested, "kilo.json")])
    expect(found.some((f) => f.includes(".kilocode"))).toBe(false)
    expect(found.some((f) => f.includes("opencode.json"))).toBe(false)
    expect(found.length).toBe(2)
  })
})
