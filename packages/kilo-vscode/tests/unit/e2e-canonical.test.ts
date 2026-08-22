import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  archiveMutationError,
  assertArchiveStable,
  canonicalDataRoot,
  canonicalDbPath,
  collectArchiveState,
  deriveArchiveFor,
  isIsolatedDataRoot,
  isValidArchiveID,
  isValidUUID,
  parseCutoverOutput,
  prepareCanonicalRun,
  validateGateEvidence,
  _parseGateJsonForTest,
  _resolveGateHelperForTest,
} from "../../script/e2e-canonical"
import { repoRootFrom } from "../../script/p0-bench/repo-root"

describe("canonicalDataRoot / canonicalDbPath", () => {
  it("derives an isolated path strictly inside the scratch", () => {
    const scratch = "/tmp/kilo-e2e-abc123"
    expect(canonicalDataRoot(scratch)).toBe(join(scratch, "xdg-data", "kilo"))
    expect(canonicalDbPath(scratch)).toBe(join(scratch, "xdg-data", "kilo", "kilo.db"))
    expect(isIsolatedDataRoot(scratch, canonicalDataRoot(scratch))).toBe(true)
    expect(isIsolatedDataRoot(scratch, "/tmp/other/kilo")).toBe(false)
    expect(isIsolatedDataRoot(scratch, "/Users/jorkeyliu/.local/share/kilo")).toBe(false)
  })

  it("deriveArchiveFor matches core deriveArchive layout", () => {
    const root = "/tmp/kilo-e2e-xyz/xdg-data/kilo"
    const { parent, base, archiveRoot, p4 } = deriveArchiveFor(root)
    expect(parent).toBe("/tmp/kilo-e2e-xyz/xdg-data")
    expect(base).toBe("kilo")
    expect(archiveRoot).toBe("/tmp/kilo-e2e-xyz/xdg-data/kilo-archive")
    expect(p4).toBe("/tmp/kilo-e2e-xyz/xdg-data/kilo-archive/p4.2")
  })
})

describe("isValidArchiveID / isValidUUID", () => {
  it("accepts the canonical forms and rejects bad inputs", () => {
    expect(isValidArchiveID("20260821T211526Z-12345678-1234-1234-1234-123456789abc")).toBe(true)
    expect(isValidArchiveID("bad-id")).toBe(false)
    expect(isValidUUID("12345678-1234-1234-1234-123456789abc")).toBe(true)
    expect(isValidUUID("not-a-uuid")).toBe(false)
  })
})

describe("parseCutoverOutput", () => {
  it("parses the hidden CLI JSON line and validates the archiveID", () => {
    const stdout = JSON.stringify({ ok: true, op: "cutover", archiveID: "20260821T211526Z-12345678-1234-1234-1234-123456789abc", archivePath: "/tmp/a" })
    const parsed = parseCutoverOutput(stdout)
    expect(parsed.archiveID).toBe("20260821T211526Z-12345678-1234-1234-1234-123456789abc")
    expect(parsed.archivePath).toBe("/tmp/a")
  })

  it("finds the JSON among extra lines and rejects an invalid archiveID", () => {
    const bad = JSON.stringify({ ok: true, op: "cutover", archiveID: "bad", archivePath: "/tmp/a" })
    expect(() => parseCutoverOutput(`log line\n${bad}\n`)).toThrow(/invalid archiveID/)
    expect(() => parseCutoverOutput("")).toThrow(/empty/)
    expect(() => parseCutoverOutput("not json\n")).toThrow(/missing ok archiveID/)
  })
})

describe("validateGateEvidence", () => {
  function validGate(): Record<string, unknown> {
    return {
      identity: { uuid: "12345678-1234-1234-1234-123456789abc", schema_version: "1", cutover_archive_id: "20260821T211526Z-12345678-1234-1234-1234-123456789abc" },
      autoVacuum: 2,
      zeroState: {
        session: 0,
        message: 0,
        part: 0,
        todo: 0,
        session_message: 0,
        session_input: 0,
        session_context_epoch: 0,
        session_share: 0,
        event: 0,
        event_sequence: 0,
        session_changefeed: 0,
        retention_obligation: 0,
        session_changefeed_state_count: 1,
        storage_identity_count: 1,
        session_changefeed_state: { retained_rows: 0, retained_bytes: 0 },
      },
      family: { session_diff: 0, session_diff_base: 0, session_share: 0 },
    }
  }

  it("accepts a valid gate and rejects the zero-state failures", () => {
    expect(validateGateEvidence(validGate())).toBeUndefined()
    const bad = validGate()
    ;(bad.zeroState as Record<string, unknown>).session = 1
    expect(validateGateEvidence(bad)).toContain("session=1")
  })

  it("rejects missing identity and wrong autoVacuum", () => {
    expect(validateGateEvidence(null)).toContain("not an object")
    expect(validateGateEvidence({})).toContain("identity.uuid invalid")
    expect(validateGateEvidence({ identity: {}, zeroState: {}, family: {} })).toContain("identity.uuid invalid")
    const g = validGate()
    g.autoVacuum = 1
    expect(validateGateEvidence(g)).toContain("autoVacuum")
  })
})

describe("collectArchiveState / archiveMutationError", () => {
  it("collects archive ids and detects mtime mutation", () => {
    const scratch = mkdtempSync(join(tmpdir(), "e2e-canonical-test-"))
    try {
      const dataRoot = join(scratch, "xdg-data", "kilo")
      mkdirSync(join(dataRoot, "storage"), { recursive: true })
      const { p4 } = deriveArchiveFor(dataRoot)
      mkdirSync(p4, { recursive: true })
      const id = "20260821T211526Z-12345678-1234-1234-1234-123456789abc"
      const archive = join(p4, id)
      mkdirSync(archive, { recursive: true })
      writeFileSync(join(archive, "manifest.json"), JSON.stringify({ version: 1 }))
      const before = collectArchiveState(dataRoot)
      expect(before.archiveCount).toBe(1)
      expect(before.archives[0]!.id).toBe(id)
      // No mutation: after copy should be stable
      const afterStable = collectArchiveState(dataRoot)
      expect(archiveMutationError(before, afterStable)).toBeUndefined()
      // Mutate mtime
      const afterMutated = { ...afterStable, archives: afterStable.archives.map((a) => ({ ...a, mtimeMs: a.mtimeMs + 1000 })) }
      expect(archiveMutationError(before, afterMutated)).toContain("mtime changed")
      // Mutate count
      const extra = join(p4, "20260821T211527Z-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
      mkdirSync(extra, { recursive: true })
      writeFileSync(join(extra, "manifest.json"), "{}")
      const afterCount = collectArchiveState(dataRoot)
      expect(archiveMutationError(before, afterCount)).toContain("count changed")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("fails when cutover/rollback markers appear after the run", () => {
    const scratch = mkdtempSync(join(tmpdir(), "e2e-canonical-test-"))
    try {
      const dataRoot = join(scratch, "xdg-data", "kilo")
      mkdirSync(dataRoot, { recursive: true })
      const { parent, base, p4 } = deriveArchiveFor(dataRoot)
      mkdirSync(parent, { recursive: true })
      mkdirSync(p4, { recursive: true })
      const id = "20260821T211526Z-12345678-1234-1234-1234-123456789abc"
      const archive = join(p4, id)
      mkdirSync(archive, { recursive: true })
      writeFileSync(join(archive, "manifest.json"), JSON.stringify({ version: 1 }))
      const before = collectArchiveState(dataRoot)
      expect(before.archiveCount).toBe(1)
      writeFileSync(join(parent, `.cutover-${base}.marker.json`), "{}")
      const after = collectArchiveState(dataRoot)
      expect(archiveMutationError(before, after)).toContain("cutover marker")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("fails explicitly when before archive count is zero", () => {
    const scratch = mkdtempSync(join(tmpdir(), "e2e-canonical-test-"))
    try {
      const dataRoot = join(scratch, "xdg-data", "kilo")
      mkdirSync(dataRoot, { recursive: true })
      const before = collectArchiveState(dataRoot)
      expect(before.archiveCount).toBe(0)
      const after = collectArchiveState(dataRoot)
      expect(archiveMutationError(before, after)).toContain("archive count before is 0")
      expect(archiveMutationError(before, after)).toContain("at least one archive")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("assertArchiveStable fails when before archive count is zero", () => {
    const scratch = mkdtempSync(join(tmpdir(), "e2e-canonical-test-"))
    try {
      const dataRoot = join(scratch, "xdg-data", "kilo")
      mkdirSync(dataRoot, { recursive: true })
      const before = collectArchiveState(dataRoot)
      writeFileSync(join(scratch, "canonical-archive-before.json"), JSON.stringify(before))
      expect(() => assertArchiveStable(scratch, dataRoot)).toThrow(/archive count before is 0/)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe("isIsolatedDataRoot normalized isolation", () => {
  it("rejects prefix attacks and handles normalization", () => {
    const scratch = "/tmp/kilo-e2e-abc123"
    expect(isIsolatedDataRoot(scratch, "/tmp/kilo-e2e-abc123/xdg-data/kilo")).toBe(true)
    expect(isIsolatedDataRoot(scratch, "/tmp/kilo-e2e-abc123")).toBe(true)
    expect(isIsolatedDataRoot(scratch, "/tmp/kilo-e2e-abc1232/xdg-data/kilo")).toBe(false)
    expect(isIsolatedDataRoot(scratch, "/tmp/kilo-e2e-abc123-evil")).toBe(false)
    expect(isIsolatedDataRoot(scratch, "/tmp/kilo-e2e-abc12")).toBe(false)
    expect(isIsolatedDataRoot(scratch, "/tmp/other/kilo")).toBe(false)
    // Trailing slash and dot segments should still be isolated after resolve
    expect(isIsolatedDataRoot(scratch + "/", scratch + "/xdg-data/kilo")).toBe(true)
    expect(isIsolatedDataRoot(scratch, scratch + "/./xdg-data/kilo")).toBe(true)
  })
})

describe("monorepo root → hidden CLI entry", () => {
  it("resolves the real hidden CLI entry from the package root", () => {
    // The launcher pins KILO_E2E_ROOT to the PACKAGE root
    // (packages/kilo-vscode); the hidden cutover CLI entry must resolve from
    // the MONOREPO root two levels up — the first full real-restart run
    // failed on packages/kilo-vscode/packages/opencode/src/index.ts.
    const pkg = resolve(import.meta.dirname, "../..")
    const entry = join(repoRootFrom(pkg), "packages/opencode/src/index.ts")
    expect(existsSync(entry)).toBe(true)
  })

  it("wires the monorepo root into canonical setup inside the post-scratch guarded region", () => {
    const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe.ts"), "utf8")
    expect(src).toContain("const repoRoot = repoRootFrom(root)")
    expect(src).toContain("prepareCanonicalRun({ scenarios, scratch, repoRoot, realRestart: needsCanonicalStorage(scenario) })")
    // The canonical module owns the fresh-root + cutover gate; the probe only
    // forwards the monorepo root and the canonical predicate (real-restart + real-session).
    const canonicalSrc = readFileSync(join(import.meta.dirname, "../../script/e2e-canonical.ts"), "utf8")
    expect(canonicalSrc).toContain("ensureFreshCanonicalRoot({ scratch: opts.scratch, repoRoot: opts.repoRoot })")
    expect(canonicalSrc).toContain("needsCanonicalStorage")
    // Contract: scratch creation → guarded region → canonical setup. Every
    // failure after mkdtempSync must flow through the cleanup tail, so the
    // canonical call may not sit before the try block again.
    const scratchAt = src.indexOf('mkdtempSync(join(tmpdir(), "kilo-e2e-"))')
    const guardAt = src.indexOf("try {", scratchAt)
    const canonicalAt = src.indexOf("prepareCanonicalRun({ scenarios, scratch, repoRoot")
    expect(scratchAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(scratchAt)
    expect(canonicalAt).toBeGreaterThan(guardAt)
  })
})

describe("gate helper JSON parsing (Node-compatible subprocess)", () => {
  it("parses valid gate JSON and rejects empty/invalid/non-object", () => {
    const helper = "e2e-canonical-gate.ts"
    const valid = JSON.stringify({ identity: {}, autoVacuum: 2, zeroState: {}, family: {} })
    const parsed = _parseGateJsonForTest(valid, helper)
    expect(parsed.autoVacuum).toBe(2)
    expect(() => _parseGateJsonForTest("", helper)).toThrow(/empty output/)
    expect(() => _parseGateJsonForTest("not json", helper)).toThrow(/invalid JSON/)
    expect(() => _parseGateJsonForTest("[]", helper)).toThrow(/non-object/)
    expect(() => _parseGateJsonForTest("null", helper)).toThrow(/non-object/)
  })

  it("resolves gate helper without shell interpolation and exists on disk", () => {
    const p = _resolveGateHelperForTest()
    expect(p).toContain("e2e-canonical-gate.ts")
    const raw = readFileSync(p, "utf8")
    expect(raw).toContain("bun:sqlite")
    // Helper must be invoked via spawnSync arg array, not shell interpolation
    const caller = readFileSync(join(import.meta.dirname, "../../script/e2e-canonical.ts"), "utf8")
    expect(caller).toContain('spawnSync("bun"')
    expect(caller).toContain('["run"')
  })

  it("Node path never imports bun:sqlite (spawn array only)", () => {
    const caller = readFileSync(join(import.meta.dirname, "../../script/e2e-canonical.ts"), "utf8")
    expect(caller).not.toContain('import("bun:sqlite")')
    expect(caller).not.toContain("from \"bun:sqlite\"")
    // It must use spawnSync with argument arrays (no shell string)
    expect(caller).toContain('spawnSync("bun"')
    expect(caller).toContain('["run"')
  })
})

describe("prepareCanonicalRun global root seeding gate", () => {
  const fakeRoot = "/tmp/kilo-e2e-nonexistent-repo"
  const realRoot = repoRootFrom(resolve(import.meta.dirname, "../.."))

  it("seeds the hermetic global canonical root for real-* scenarios", async () => {
    for (const name of ["real-session", "real-completed", "real-overflow", "real-restart"]) {
      const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-prepcanonical-"))
      try {
        // real-session and real-restart also allocate the fresh canonical DB;
        // use the real monorepo root so the hidden cutover can run. The other
        // real-* scenarios only seed the global root and never touch the DB.
        const needs = name === "real-session" || name === "real-restart"
        const root = needs ? realRoot : fakeRoot
        await prepareCanonicalRun({ scenarios: new Set([name]), scratch, repoRoot: root, realRestart: false })
        expect(existsSync(join(scratch, "xdg-config", "kilo", "node_modules"))).toBe(true)
        expect(existsSync(join(scratch, "xdg-config", "kilo", "agent", "e2e-agent.md"))).toBe(true)
        if (needs) {
          expect(existsSync(join(scratch, "canonical-gate.json"))).toBe(true)
          expect(existsSync(join(scratch, "canonical-archive-before.json"))).toBe(true)
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }
  }, 30000)

  it("never seeds for non-real scenarios and never touches paths outside scratch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-prepcanonical-"))
    try {
      await prepareCanonicalRun({ scenarios: new Set(["tab-close"]), scratch, repoRoot: fakeRoot, realRestart: false })
      expect(existsSync(join(scratch, "xdg-config"))).toBe(false)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
