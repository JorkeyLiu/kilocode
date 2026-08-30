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
  validateGcProof,
} from "../../script/e2e-evidence"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "e2e-evidence-test-"))
}

/** A realistic run-owned scratch + workspace with every real-completed artifact. */
function seededRun(
  root: string,
  over: { drop?: string[]; corrupt?: string[] } = {},
): {
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
  writeFileSync(
    join(scratch, "real-completed-dom-evidence"),
    JSON.stringify({ url: "vscode-webview://x", pins: [], rollback: {} }),
  )
  writeFileSync(join(scratch, "real-completed-ready"), "e2e-probe-1234")
  writeFileSync(
    join(scratch, "llm-requests.jsonl"),
    JSON.stringify({
      providerID: "e2e-local",
      modelID: "e2e-model",
      agent: "e2e-agent",
      small: false,
      sessionID: "s",
      pid: 1,
      instance: 1,
      ts: 0,
    }) + "\n",
  )
  writeFileSync(
    join(scratch, "llm-requests-real-completed.json"),
    JSON.stringify({ scenario: "real-completed", records: [] }),
  )
  writeFileSync(
    join(scratch, "llm-matrix-real-completed-final.json"),
    JSON.stringify({ phase: "real-completed-final", total: 1, violations: [] }),
  )
  writeFileSync(
    join(scratch, "rc-snap-1.json"),
    JSON.stringify({ requestedAt: "t", sessions: [], messages: {}, statuses: {} }),
  )
  writeFileSync(
    join(scratch, "rc-snap-2.json"),
    JSON.stringify({ requestedAt: "t2", sessions: [], messages: {}, statuses: {} }),
  )
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
      expect(() => validateEvidenceDestination(join(scratch, "evidence"), scratch)).toThrow(
        /inside the run-owned scratch/,
      )
      expect(() => validateEvidenceDestination(scratch, scratch)).toThrow(/inside the run-owned scratch/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a missing parent directory", () => {
    const root = tempRoot()
    try {
      expect(() => validateEvidenceDestination(join(root, "no-parent", "evidence"), undefined)).toThrow(
        /parent does not exist/,
      )
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

  it("requires the real-restart canonical-state probe diagnostic (rr-cstate.json)", () => {
    const { required, optional } = evidenceInventory(new Set(["real-restart"]))
    const rels = required.map((s) => `${s.base}:${s.rel}`)
    expect(rels).toContain("scratch:rr-cstate.json")
    expect(rels).toContain("scratch:canonical-gate.json")
    // The probe is decision-critical, not an optional extra.
    expect(optional.map((s) => s.rel)).not.toContain("rr-cstate.json")
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

function makeValidProof(): Record<string, unknown> {
  const h = "aaaaaaaaaaaaaaaa"
  const pid = 1234,
    port = 4321,
    epoch = 1
  const backend = { pid, port, epoch }
  const prePrivate = {
    pid,
    epoch,
    available: true,
    state: "open",
    protocol: { name: "kilo-private", major: 1 },
    capabilities: ["session/cancelQueued", "session/update"],
    hasSessionUpdate: true,
  }
  const openPriv = {
    pid,
    epoch,
    available: true,
    hasSessionUpdate: true,
    state: "open",
    protocol: { name: "kilo-private", major: 1 },
    capabilities: ["session/cancelQueued", "session/update"],
  }
  const ssePriv = { pid, epoch, available: true, hasSessionUpdate: true, protocol: { name: "kilo-private", major: 1 } }
  const revision = { session: 5, config: 2 }
  const sdk = { status: "succeeded", httpStatus: 200, hasData: true }
  const priv = { status: "succeeded", hasData: true }
  const at = new Date().toISOString()
  const cloneB = () => ({ pid, port, epoch })
  return {
    schema: "kilo-gc-proof/1",
    version: 1,
    scope: "real-restart Gate C: shared-backend + SDK-authoritative title + SSE same-epoch + worker-restart new-epoch",
    fixtureIdHash: h,
    sessionIdHash: h,
    titleHash: h,
    pre: {
      backend: cloneB(),
      private: { ...prePrivate, protocol: { ...prePrivate.protocol }, capabilities: [...prePrivate.capabilities] },
    },
    openTab: {
      before: {
        backend: cloneB(),
        private: { ...openPriv, protocol: { ...openPriv.protocol }, capabilities: [...openPriv.capabilities] },
      },
      after: {
        backend: cloneB(),
        private: { ...openPriv, protocol: { ...openPriv.protocol }, capabilities: [...openPriv.capabilities] },
      },
      count: 1,
      ready: true,
    },
    sse: {
      pre: { backend: cloneB(), private: { ...ssePriv, protocol: { ...ssePriv.protocol } } },
      conn: { before: cloneB(), after: cloneB(), states: [{ state: "connected", at }], connectedEvents: 1 },
      post: { backend: cloneB(), private: { ...ssePriv, protocol: { ...ssePriv.protocol } } },
    },
    titleOp: {
      opIdHash: h,
      idempotencyKeyHash: h,
      requestIdHash: h,
      sessionIdHash: h,
      titleHash: h,
      order: ["sdk", "private"],
      sdk: { ...sdk },
      private: { ...priv },
      parity: { divergence: null, details: {} },
      revision: { ...revision },
    },
    replay: { found: true, private: { ...priv }, revision: { ...revision }, titleHash: h },
    killed: { pid, port, epoch },
    postRestart: {
      backend: { pid: 5678, port: 5432, epoch: 2 },
      private: {
        pid: 5678,
        epoch: 2,
        available: true,
        hasSessionUpdate: true,
        protocol: { name: "kilo-private", major: 1 },
        state: "open",
        capabilities: ["session/cancelQueued", "session/update"],
      },
    },
    replayAfterRestart: { found: true, private: { ...priv }, revision: { ...revision }, titleHash: h },
    parity: { divergence: null, details: {} },
    collectedAt: new Date().toISOString(),
  }
}

describe("validateGcProof hardened", () => {
  it("accepts a valid proof", () => {
    expect(validateGcProof(makeValidProof())).toBeNull()
  })
  it("rejects missing nested field", () => {
    const p = makeValidProof() as Record<string, unknown>
    delete (p.pre as Record<string, unknown>).backend
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects unknown top-level field", () => {
    const p = makeValidProof() as Record<string, unknown>
    p.extra = 1
    expect(validateGcProof(p)).toContain("keys mismatch")
  })
  it("rejects unknown nested field", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;(p.pre as Record<string, unknown>).extra = 1
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects nested raw title key", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;(p.titleOp as Record<string, unknown>).title = "leak"
    expect(validateGcProof(p)).toContain("forbidden")
  })
  it("rejects malformed hash", () => {
    const p = makeValidProof() as Record<string, unknown>
    p.fixtureIdHash = "nothex"
    expect(validateGcProof(p)).toContain("16-hex")
  })
  it("rejects revision mismatch", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;(p.replay as Record<string, unknown>).revision = { session: 99, config: 2 }
    expect(validateGcProof(p)).toContain("replay.revision")
  })
  it("rejects killed epoch not equal pre", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;(p.killed as Record<string, unknown>).epoch = 999
    expect(validateGcProof(p)).toContain("killed must equal")
  })
  it("rejects postRestart epoch not greater", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.postRestart as Record<string, unknown>).backend as Record<string, unknown>).epoch = 1
    expect(validateGcProof(p)).toContain("must be >")
  })
  it("rejects SSE identity changed", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;(((p.sse as Record<string, unknown>).post as Record<string, unknown>).backend as Record<string, unknown>).pid =
      9999
    ;(((p.sse as Record<string, unknown>).post as Record<string, unknown>).private as Record<string, unknown>).pid =
      9999
    expect(validateGcProof(p)).toContain("sse pre/post backend")
  })
  it("rejects forbidden payload key", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;(p as Record<string, unknown>).payload = "x"
    const err = validateGcProof(p) as string
    expect(err.includes("forbidden") || err.includes("keys mismatch")).toBeTrue()
  })
  it("rejects order mismatch", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.titleOp as Record<string, unknown>).order as string[])[0] = "private"
    expect(validateGcProof(p)).toContain("order")
  })
})

describe("validateGcProof auditor probes closed", () => {
  it("rejects extra evil in openTab protocol", () => {
    const p = makeValidProof() as Record<string, unknown>
    const ot = (p.openTab as Record<string, unknown>).before as Record<string, unknown>
    const priv = ot.private as Record<string, unknown>
    ;(priv.protocol as Record<string, unknown>).evil = 1
    expect(validateGcProof(p)).not.toBeNull()
    expect(validateGcProof(p)).toContain("protocol")
  })
  it("rejects extra evil in SSE protocol", () => {
    const p = makeValidProof() as Record<string, unknown>
    const sse = (p.sse as Record<string, unknown>).pre as Record<string, unknown>
    const pr = (sse.private as Record<string, unknown>).protocol as Record<string, unknown>
    pr.evil = 1
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects extra evil in postRestart protocol", () => {
    const p = makeValidProof() as Record<string, unknown>
    const pr = ((p.postRestart as Record<string, unknown>).private as Record<string, unknown>).protocol as Record<
      string,
      unknown
    >
    pr.evil = 1
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects extra evil in SSE state entry", () => {
    const p = makeValidProof() as Record<string, unknown>
    const conn = (p.sse as Record<string, unknown>).conn as Record<string, unknown>
    const states = conn.states as Record<string, unknown>[]
    ;(states[0] as Record<string, unknown>).evil = 1
    expect(validateGcProof(p)).not.toBeNull()
    expect(validateGcProof(p)).toContain("keys mismatch")
  })
  it("rejects non-string capability element", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.pre as Record<string, unknown>).private as Record<string, unknown>).capabilities = [123 as unknown as string]
    expect(validateGcProof(p)).not.toBeNull()
    expect(validateGcProof(p)).toContain("must be string")
  })
  it("rejects unknown capability value", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.pre as Record<string, unknown>).private as Record<string, unknown>).capabilities = ["unknown-cap"]
    expect(validateGcProof(p)).not.toBeNull()
    expect(validateGcProof(p)).toContain("unknown capability")
  })
  it("rejects openTab unknown capability in private", () => {
    const p = makeValidProof() as Record<string, unknown>
    const ot = ((p.openTab as Record<string, unknown>).before as Record<string, unknown>).private as Record<
      string,
      unknown
    >
    ot.capabilities = ["evil-cap"]
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("valid proof passes", () => {
    expect(validateGcProof(makeValidProof())).toBeNull()
  })
})

describe("assertFixtureIdMatch (proof construction env gate)", () => {
  it("requires non-empty env fixture ID and exact match", async () => {
    const { assertFixtureIdMatch } = await import("../../script/e2e-probe-restart")
    expect(() => assertFixtureIdMatch("fid", undefined)).toThrow(/KILO_E2E_FIXTURE_ID missing/)
    expect(() => assertFixtureIdMatch("fid", "")).toThrow(/missing/)
    expect(() => assertFixtureIdMatch("", "fid")).toThrow(/fixtureId missing/)
    expect(() => assertFixtureIdMatch("a", "b")).toThrow(/!= env/)
    expect(assertFixtureIdMatch("same", "same")).toBe("same")
  })
  it("rejects missing marker version and wrong version via marker validator", async () => {
    const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const { isValidE2EScratch } = await import("../../src/util/e2e-fixture")
    const dir = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
    const saved = process.env.KILO_E2E_FIXTURE_ID
    try {
      process.env.KILO_E2E_FIXTURE_ID = "fid"
      writeFileSync(join(dir, "e2e-marker.json"), JSON.stringify({ fixtureId: "fid" }))
      expect(isValidE2EScratch(dir)).toBeFalse()
      writeFileSync(join(dir, "e2e-marker.json"), JSON.stringify({ v: 2, fixtureId: "fid" }))
      expect(isValidE2EScratch(dir)).toBeFalse()
      writeFileSync(join(dir, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId: "" }))
      process.env.KILO_E2E_FIXTURE_ID = ""
      expect(isValidE2EScratch(dir)).toBeFalse()
      process.env.KILO_E2E_FIXTURE_ID = "fid"
      writeFileSync(join(dir, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId: "fid" }))
      process.env.KILO_E2E_FIXTURE_ID = "wrong"
      expect(isValidE2EScratch(dir)).toBeFalse()
      process.env.KILO_E2E_FIXTURE_ID = "fid"
      expect(isValidE2EScratch(dir)).toBeTrue()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (saved === undefined) delete process.env.KILO_E2E_FIXTURE_ID
      else process.env.KILO_E2E_FIXTURE_ID = saved
    }
  })
  it("rejects extra marker key createdAt via exact marker validator", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const { isValidE2EScratch } = await import("../../src/util/e2e-fixture")
    const dir = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
    const saved = process.env.KILO_E2E_FIXTURE_ID
    try {
      process.env.KILO_E2E_FIXTURE_ID = "fid"
      writeFileSync(join(dir, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId: "fid", createdAt: "2026-08-30" }))
      expect(isValidE2EScratch(dir)).toBeFalse()
      writeFileSync(join(dir, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId: "fid" }))
      expect(isValidE2EScratch(dir)).toBeTrue()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (saved === undefined) delete process.env.KILO_E2E_FIXTURE_ID
      else process.env.KILO_E2E_FIXTURE_ID = saved
    }
  })
})

describe("validateGcProof exact required keys (auditor probes)", () => {
  it("rejects omission of openTab.count", () => {
    const p = makeValidProof() as Record<string, unknown>
    delete (p.openTab as Record<string, unknown>).count
    expect(validateGcProof(p)).not.toBeNull()
    expect(validateGcProof(p)).toContain("openTab")
  })
  it("rejects omission of openTab.ready", () => {
    const p = makeValidProof() as Record<string, unknown>
    delete (p.openTab as Record<string, unknown>).ready
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects omission of openTab.before.private.state", () => {
    const p = makeValidProof() as Record<string, unknown>
    const pr = ((p.openTab as Record<string, unknown>).before as Record<string, unknown>).private as Record<
      string,
      unknown
    >
    delete pr.state
    expect(validateGcProof(p)).not.toBeNull()
    expect(validateGcProof(p)).toContain("state")
  })
  it("rejects omission of openTab.before.private.protocol", () => {
    const p = makeValidProof() as Record<string, unknown>
    const pr = ((p.openTab as Record<string, unknown>).before as Record<string, unknown>).private as Record<
      string,
      unknown
    >
    delete pr.protocol
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects omission of openTab.before.private.capabilities", () => {
    const p = makeValidProof() as Record<string, unknown>
    const pr = ((p.openTab as Record<string, unknown>).before as Record<string, unknown>).private as Record<
      string,
      unknown
    >
    delete pr.capabilities
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects errorCode on successful titleOp.sdk", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.titleOp as Record<string, unknown>).sdk as Record<string, unknown>).errorCode = "x"
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects failureCode on successful titleOp.private", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.titleOp as Record<string, unknown>).private as Record<string, unknown>).failureCode = "x"
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects transportUnknown on successful titleOp.private", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.titleOp as Record<string, unknown>).private as Record<string, unknown>).transportUnknown = false
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects failureCode on successful replay.private", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.replay as Record<string, unknown>).private as Record<string, unknown>).failureCode = "x"
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects transportUnknown on successful replay.private", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.replay as Record<string, unknown>).private as Record<string, unknown>).transportUnknown = true
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects errorCode on successful replayAfterRestart.private via failureCode", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.replayAfterRestart as Record<string, unknown>).private as Record<string, unknown>).failureCode = "x"
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("rejects transportUnknown on successful replayAfterRestart.private", () => {
    const p = makeValidProof() as Record<string, unknown>
    ;((p.replayAfterRestart as Record<string, unknown>).private as Record<string, unknown>).transportUnknown = false
    expect(validateGcProof(p)).not.toBeNull()
  })
  it("auditor mutation: adding errorCode to successful titleOp.sdk is rejected", () => {
    const p = makeValidProof() as Record<string, unknown>
    const mutated = JSON.parse(JSON.stringify(p)) as Record<string, unknown>
    ;((mutated.titleOp as Record<string, unknown>).sdk as Record<string, unknown>).errorCode = "ERR"
    expect(validateGcProof(mutated)).not.toBeNull()
    expect(validateGcProof(mutated)).toContain("titleOp.sdk")
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
