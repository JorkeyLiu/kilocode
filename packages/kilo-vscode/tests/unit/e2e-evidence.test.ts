import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CAPTURE_LOG,
  claimDestination,
  collectEvidence,
  EVIDENCE_READY,
  evidenceDirFromEnv,
  evidenceInventory,
  expandGlob,
  MANIFEST,
  parseFailure,
  sha256Of,
  validateEvidenceDestination,
} from "../../script/e2e-evidence"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "e2e-evidence-test-"))
}

/** A realistic run-owned scratch + workspace with every real-completed artifact. */
function seededRun(root: string, over: { drop?: string[]; corrupt?: string[] } = {}): {
  scratch: string
  workspace: string
  staging: string
} {
  const scratch = join(root, "scratch")
  const workspace = join(root, "workspace")
  const staging = join(root, "staging")
  mkdirSync(scratch, { recursive: true })
  mkdirSync(staging, { recursive: true })
  const plan = { sourceId: "s-A", customAgent: "e2e-agent", customProvider: "e2e-local", customModel: "e2e-model" }
  writeFileSync(join(scratch, "plan.json"), JSON.stringify(plan))
  writeFileSync(join(scratch, "runner-pid"), "4242")
  writeFileSync(join(scratch, "real-completed-dom-evidence"), JSON.stringify({ url: "vscode-webview://x", pins: [], rollback: {} }))
  writeFileSync(join(scratch, "real-completed-ready"), "e2e-probe-1234")
  writeFileSync(join(scratch, "llm-requests.jsonl"), JSON.stringify({ providerID: "e2e-local", modelID: "e2e-model", agent: "e2e-agent", small: false, sessionID: "s", pid: 1, instance: 1, ts: 0 }) + "\n")
  writeFileSync(join(scratch, "llm-requests-real-completed.json"), JSON.stringify({ scenario: "real-completed", records: [] }))
  writeFileSync(join(scratch, "llm-matrix-real-completed-final.json"), JSON.stringify({ phase: "real-completed-final", total: 1, violations: [] }))
  writeFileSync(join(scratch, "rc-snap-1.json"), JSON.stringify({ requestedAt: "t", sessions: [], messages: {}, statuses: {} }))
  writeFileSync(join(scratch, "rc-snap-2.json"), JSON.stringify({ requestedAt: "t2", sessions: [], messages: {}, statuses: {} }))
  const kilo = join(workspace, ".kilo")
  mkdirSync(kilo, { recursive: true })
  writeFileSync(join(kilo, "kilo.json"), JSON.stringify({ provider: {}, agent: {} }))
  mkdirSync(join(workspace, "mcp-fixture"), { recursive: true })
  writeFileSync(join(workspace, "mcp-fixture", "calls.log"), "echo:hi\n")
  writeFileSync(join(workspace, "e2e-custom-called.txt"), "echo:hello")
  writeFileSync(join(workspace, "ask.txt"), "E2E_PERMISSION_SENTINEL\n")
  writeFileSync(join(workspace, "rollback.txt"), "E2E_ROLLBACK_ORIGINAL\n")
  for (const drop of over.drop ?? []) rmSync(join(scratch, drop), { force: true })
  for (const corrupt of over.corrupt ?? []) writeFileSync(join(scratch, corrupt), "{not json")
  return { scratch, workspace, staging }
}

const realCompleted = new Set(["real-completed"])

function collect(root: string) {
  const { scratch, workspace, staging } = seededRun(root)
  return collectEvidence({
    staging,
    scratch,
    workspace,
    scenarios: realCompleted,
    fixtureId: "e2e-probe-1234",
    startedAt: Date.now() - 60_000,
    probePid: 4242,
    success: true,
    destination: resolve(join(root, "dest")),
  })
}

describe("evidenceDirFromEnv (default no-op contract)", () => {
  it("returns undefined when the env var is unset or empty (harness behaves exactly as before)", () => {
    expect(evidenceDirFromEnv({})).toBeUndefined()
    expect(evidenceDirFromEnv({ KILO_E2E_EVIDENCE_DIR: "" })).toBeUndefined()
  })

  it("resolves an explicit destination to an absolute path", () => {
    const dest = evidenceDirFromEnv({ KILO_E2E_EVIDENCE_DIR: "/tmp/evidence" })
    expect(dest).toBe("/tmp/evidence")
  })
})

describe("validateEvidenceDestination (path validation)", () => {
  it("rejects a relative destination", () => {
    expect(() => validateEvidenceDestination("relative/evidence", undefined)).toThrow(/absolute path/)
  })

  it("rejects a destination inside the run-owned scratch (deleted at cleanup)", () => {
    const root = tempRoot()
    try {
      const scratch = join(root, "scratch")
      mkdirSync(scratch, { recursive: true })
      expect(() => validateEvidenceDestination(join(scratch, "evidence"), scratch)).toThrow(/inside the run-owned scratch/)
      expect(() => validateEvidenceDestination(scratch, scratch)).toThrow(/inside the run-owned scratch/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a missing parent directory", () => {
    const root = tempRoot()
    try {
      expect(() => validateEvidenceDestination(join(root, "no-parent", "evidence"), undefined)).toThrow(/parent does not exist/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects an existing non-directory destination", () => {
    const root = tempRoot()
    try {
      const file = join(root, "evidence")
      writeFileSync(file, "x")
      expect(() => validateEvidenceDestination(file, undefined)).toThrow(/not a directory/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a non-empty existing destination (never overwrites pre-existing dirs)", () => {
    const root = tempRoot()
    try {
      const dest = join(root, "evidence")
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, "old.txt"), "keep")
      expect(() => validateEvidenceDestination(dest, undefined)).toThrow(/not empty/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("accepts an absent destination with an existing parent", () => {
    const root = tempRoot()
    try {
      expect(() => validateEvidenceDestination(join(root, "evidence"), undefined)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("accepts an empty existing destination", () => {
    const root = tempRoot()
    try {
      const dest = join(root, "evidence")
      mkdirSync(dest, { recursive: true })
      expect(() => validateEvidenceDestination(dest, undefined)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("evidenceInventory (required artifact set)", () => {
  it("requires the full real-completed decision-critical set", () => {
    const { required } = evidenceInventory(realCompleted)
    const rels = required.map((s) => `${s.base}:${s.rel}`)
    expect(rels).toContain("scratch:plan.json")
    expect(rels).toContain("scratch:runner-pid")
    expect(rels).toContain("scratch:real-completed-dom-evidence")
    expect(rels).toContain("scratch:llm-requests.jsonl")
    expect(rels).toContain("scratch:llm-requests-real-completed.json")
    expect(rels).toContain("scratch:llm-matrix-real-completed-final.json")
    expect(rels).toContain("scratch:rc-snap-*.json")
    expect(rels).toContain("workspace:.kilo/kilo.json")
    expect(rels).toContain("workspace:e2e-custom-called.txt")
    expect(rels).toContain("workspace:mcp-fixture/calls.log")
    expect(rels).toContain("workspace:ask.txt")
    expect(rels).toContain("workspace:rollback.txt")
  })

  it("synthetic scenarios require no LLM evidence (no collector store exists)", () => {
    const { required } = evidenceInventory(new Set(["tab-close"]))
    const rels = required.map((s) => `${s.base}:${s.rel}`)
    expect(rels).toContain("scratch:plan.json")
    expect(rels).toContain("scratch:tab-close-dom-evidence")
    expect(rels).not.toContain("scratch:llm-requests.jsonl")
    expect(rels).not.toContain("scratch:llm-matrix-tab-close-final.json")
  })

  it("requires the P3.2 worktree-removal decision-critical set", () => {
    const { required } = evidenceInventory(new Set(["worktree-removal"]))
    const rels = required.map((s) => `${s.base}:${s.rel}`)
    expect(rels).toContain("scratch:plan.json")
    expect(rels).toContain("scratch:runner-pid")
    expect(rels).toContain("scratch:worktree-removal-runtime-evidence")
    expect(rels).toContain("scratch:worktree-removal-dom-evidence")
    expect(rels).toContain("scratch:llm-requests.jsonl")
    expect(rels).toContain("scratch:llm-requests-worktree-removal.json")
    expect(rels).toContain("scratch:llm-matrix-worktree-removal-final.json")
    expect(rels).toContain("scratch:p32-snap-*.json")
    expect(rels).toContain("workspace:.kilo/kilo.json")
    expect(rels).toContain("workspace:rollback.txt")
  })

  it("requires the P3.3 cloud-claw-removal runtime evidence with no LLM evidence", () => {
    const { required } = evidenceInventory(new Set(["cloud-claw-removal"]))
    const rels = required.map((s) => `${s.base}:${s.rel}`)
    expect(rels).toContain("scratch:plan.json")
    expect(rels).toContain("scratch:runner-pid")
    expect(rels).toContain("scratch:cloud-claw-removal-runtime-evidence")
    // The scenario never issues model requests, so no LLM evidence is required.
    expect(rels).not.toContain("scratch:llm-requests.jsonl")
    expect(rels).not.toContain("scratch:llm-matrix-cloud-claw-removal-final.json")
    // No backend-snapshot globs exist for a pure runtime-absence scenario.
    expect(rels).not.toContain("scratch:llm-requests-cloud-claw-removal.json")
  })
})

describe("expandGlob (snapshot expansion)", () => {
  it("expands numbered snapshot files in sorted order and returns [] for zero matches", () => {
    const root = tempRoot()
    try {
      writeFileSync(join(root, "rc-snap-2.json"), "{}")
      writeFileSync(join(root, "rc-snap-1.json"), "{}")
      writeFileSync(join(root, "rc-snap-1-request"), "ok")
      expect(expandGlob(root, "rc-snap-*.json")).toEqual(["rc-snap-1.json", "rc-snap-2.json"])
      expect(expandGlob(root, "of-snap-*.json")).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("parseFailure (required-artifact malformation)", () => {
  it("passes valid JSON and JSONL, fails invalid or corrupt forms", () => {
    expect(parseFailure("plan.json", Buffer.from('{"a":1}'))).toBeNull()
    expect(parseFailure("llm-requests.jsonl", Buffer.from('{"a":1}\n{"b":2}\n'))).toBeNull()
    expect(parseFailure("plan.json", Buffer.from("{not json"))).toContain("invalid JSON")
    expect(parseFailure("plan.json", Buffer.from(""))).toContain("empty file")
    expect(parseFailure("llm-requests.jsonl", Buffer.from('{"a":1}\nbroken\n'))).toContain("corrupt JSONL line")
    expect(parseFailure("llm-requests.jsonl", Buffer.from(""))).toContain("empty JSONL store")
    expect(parseFailure("ask.txt", Buffer.from("plain text"))).toBeNull()
  })
})

describe("collectEvidence (byte-exact handoff + manifest)", () => {
  it("copies every required artifact byte-exactly, writes the manifest and evidence-ready, status complete", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededRun(root)
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realCompleted,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now() - 60_000,
        probePid: 4242,
        success: true,
        destination: join(root, "dest"),
      })
      expect(manifest.status).toBe("complete")
      expect(manifest.validated).toBe(true)
      expect(manifest.missing).toEqual([])
      expect(manifest.malformed).toEqual([])
      expect(existsSync(join(staging, EVIDENCE_READY))).toBe(true)
      expect(existsSync(join(staging, MANIFEST))).toBe(true)

      // The recorded manifest is the draft (no launcher-owned capture log yet).
      const onDisk = JSON.parse(readFileSync(join(staging, MANIFEST), "utf8"))
      expect(onDisk.captureLog).toBeNull()
      expect(onDisk.finalizedAt).toBeNull()

      // Byte-exact proof: dest file hash equals the recorded hash equals the
      // source hash (the manifest records the absolute source path).
      for (const entry of manifest.files) {
        const destBytes = readFileSync(join(staging, entry.dest))
        expect(sha256Of(destBytes)).toBe(entry.sha256)
        expect(readFileSync(entry.source).equals(destBytes)).toBe(true)
      }

      const plan = manifest.files.find((f) => f.dest === "plan.json")
      expect(plan).toBeDefined()
      expect(plan!.bytes).toBe(readFileSync(join(scratch, "plan.json")).length)
      expect(plan!.sourceRel).toBe("scratch/plan.json")

      // Workspace artifacts keep their provenance structure.
      const artifact = manifest.files.find((f) => f.dest === "workspace/e2e-custom-called.txt")
      expect(artifact).toBeDefined()
      expect(artifact!.sourceRel).toBe("workspace/e2e-custom-called.txt")
      expect(manifest.files.some((f) => f.dest === "rc-snap-1.json")).toBe(true)
      expect(manifest.files.some((f) => f.dest === "rc-snap-2.json")).toBe(true)

      expect(manifest.run.scenario).toBe("real-completed")
      expect(manifest.run.fixtureId).toBe("e2e-probe-1234")
      expect(manifest.run.success).toBe(true)
      expect(manifest.required).toContain("plan.json")
      expect(manifest.required).toContain("rc-snap-1.json")
      expect(manifest.required).toContain("workspace/e2e-custom-called.txt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails the handoff (status missing) when a required artifact is absent", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededRun(root, { drop: ["llm-requests.jsonl"] })
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realCompleted,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: join(root, "dest"),
      })
      expect(manifest.status).toBe("missing")
      expect(manifest.validated).toBe(false)
      expect(manifest.missing).toContain("llm-requests.jsonl")
      // The rest of the evidence is still preserved.
      expect(manifest.files.some((f) => f.dest === "plan.json")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails the handoff (status malformed) when a required JSON artifact does not parse", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededRun(root, { corrupt: ["plan.json"] })
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realCompleted,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: join(root, "dest"),
      })
      expect(manifest.status).toBe("malformed")
      expect(manifest.validated).toBe(false)
      expect(manifest.malformed).toContain("plan.json")
      expect(manifest.notes.some((n) => n.includes("plan.json"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails the handoff when a corrupt JSONL line is present in the required raw store", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededRun(root, { corrupt: ["llm-requests.jsonl"] })
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realCompleted,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: join(root, "dest"),
      })
      expect(manifest.status).toBe("malformed")
      expect(manifest.malformed).toContain("llm-requests.jsonl")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails the handoff when a required snapshot glob matches zero files", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededRun(root, { drop: ["rc-snap-1.json", "rc-snap-2.json"] })
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realCompleted,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: join(root, "dest"),
      })
      expect(manifest.status).toBe("missing")
      expect(manifest.missing).toContain("rc-snap-*.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("records a failed run as status failed even when every artifact is present", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededRun(root)
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realCompleted,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: false,
        destination: join(root, "dest"),
      })
      expect(manifest.status).toBe("failed")
      expect(manifest.run.success).toBe(false)
      expect(manifest.validated).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps optional artifacts out of the required inventory and preserves them when present", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededRun(root)
      writeFileSync(join(scratch, "real-completed-reopen-ready"), "fixture")
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realCompleted,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: join(root, "dest"),
      })
      expect(manifest.required).not.toContain("real-completed-reopen-ready")
      expect(manifest.files.some((f) => f.dest === "real-completed-reopen-ready")).toBe(true)
      // Absent optional artifacts never fail the handoff.
      expect(manifest.status).toBe("complete")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("staging remains the launcher-owned handoff surface: capture log and ready marker coexist", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededRun(root)
      // The launcher already wrote the capture log into the staging dir.
      writeFileSync(join(staging, CAPTURE_LOG), "[probe] run log line\n")
      collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realCompleted,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: join(root, "dest"),
      })
      expect(existsSync(join(staging, CAPTURE_LOG))).toBe(true)
      expect(readdirSync(staging)).toContain("evidence-ready")
      expect(readdirSync(staging)).toContain("manifest.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("produces one manifest entry per destination, collapsing overlapping required/optional references", () => {
    const root = tempRoot()
    try {
      const manifest = collect(root)
      // Every destination appears exactly once even though the required and
      // optional inventories overlap: the final LLM matrix is required AND
      // matched by the optional `llm-matrix-*.json` glob, and the ready marker
      // is listed twice in the optional inventory.
      const dests = manifest.files.map((f) => f.dest)
      expect(new Set(dests).size).toBe(dests.length)
      expect(dests.filter((d) => d === "llm-matrix-real-completed-final.json")).toHaveLength(1)
      expect(dests.filter((d) => d === "real-completed-ready")).toHaveLength(1)
      expect(dests).toContain("llm-matrix-real-completed-final.json")
      expect(dests).toContain("real-completed-ready")
      // The required inventory is also deduplicated.
      expect(new Set(manifest.required).size).toBe(manifest.required.length)
      expect(manifest.status).toBe("complete")
      expect(manifest.validated).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a duplicate destination that maps to conflicting sources", () => {
    const claimed = new Map<string, string>()
    expect(claimDestination(claimed, "plan.json", "/scratch/plan.json")).toBe(true)
    // An identical duplicate reference collapses (no re-copy, no second entry).
    expect(claimDestination(claimed, "plan.json", "/scratch/plan.json")).toBe(false)
    // A different source for the same destination fails clearly — the handoff
    // never silently chooses one.
    expect(() => claimDestination(claimed, "plan.json", "/workspace/plan.json")).toThrow(/conflicting evidence sources/)
    expect(() => claimDestination(claimed, "plan.json", "/scratch/other.json")).toThrow()
  })
})
