import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
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
  validateLcProof,
  validateLcTimeline,
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

function hash16(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 16)
}

function makeValidLcProof(): Record<string, unknown> {
  const h = "aaaaaaaaaaaaaaaa"
  const pid = 1234
  const port = 4321
  const epoch = 1
  const backend = { pid, port, epoch }
  const priv = {
    pid,
    epoch,
    available: true,
    state: "open",
    protocol: { name: "kilo-private", major: 1 },
    capabilities: ["session/cancelQueued", "session/update"],
    hasSessionUpdate: true,
  }
  const revision = { session: 5, config: 2 }
  const sdk = { status: "succeeded", httpStatus: 200, hasData: true }
  const privRes = { status: "succeeded", hasData: true }
  const cloneB = () => ({ pid, port, epoch })
  const prPriv = () => ({ ...priv, protocol: { ...priv.protocol }, capabilities: [...priv.capabilities] })
  const siblingTitle = "bbbbbbbbbbbbbbbb"
  return {
    schema: "kilo-gc-lifecycle-proof/1",
    version: 1,
    scope: "real-lifecycle Gate C: UI-only lifecycle convergence with stable identity and same-key replay",
    fixtureIdHash: h,
    sessionIdHash: h,
    siblingIdHash: h,
    titleHash: h,
    siblingTitleHash: siblingTitle,
    orderHash: h,
    pre: { backend: cloneB(), private: prPriv() },
    openTab: {
      before: {
        backend: cloneB(),
        private: {
          pid,
          epoch,
          available: true,
          hasSessionUpdate: true,
          state: "open",
          protocol: { name: "kilo-private", major: 1 },
          capabilities: ["session/cancelQueued", "session/update"],
        },
      },
      after: {
        backend: cloneB(),
        private: {
          pid,
          epoch,
          available: true,
          hasSessionUpdate: true,
          state: "open",
          protocol: { name: "kilo-private", major: 1 },
          capabilities: ["session/cancelQueued", "session/update"],
        },
      },
      editorCount: 1,
      ready: true,
      loadOk: true,
      targetSessionIdHash: h,
      currentSessionIdHash: h,
      attached: true,
    },
    titleOp: {
      opIdHash: h,
      idempotencyKeyHash: h,
      requestIdHash: h,
      sessionIdHash: h,
      titleHash: h,
      order: ["sdk", "private"],
      sdk: { ...sdk },
      private: { ...privRes },
      parity: { divergence: null, details: {} },
      revision: { ...revision },
    },
    replay: {
      found: true,
      private: { ...privRes },
      revision: { ...revision },
      titleHash: h,
      opIdHash: h,
      idempotencyKeyHash: h,
      requestIdHash: h,
      sessionIdHash: h,
    },
    boundaries: {
      panelCloseReopen: {
        pre: { backend: cloneB(), private: prPriv() },
        post: { backend: cloneB(), private: prPriv() },
        orderHash: h,
        orderCount: 2,
        agentTitleHash: h,
        tabTitleHash: h,
      },
      webviewReload: {
        pre: { backend: cloneB(), private: prPriv() },
        post: { backend: cloneB(), private: prPriv() },
        orderHash: h,
        orderCount: 2,
        agentTitleHash: h,
        tabTitleHash: h,
      },
      tabCloseReopen: {
        pre: { backend: cloneB(), private: prPriv() },
        post: { backend: cloneB(), private: prPriv() },
        orderHash: h,
        orderCount: 2,
        agentTitleHash: h,
        tabTitleHash: h,
      },
      sessionSwitch: {
        pre: { backend: cloneB(), private: prPriv(), activeIdHash: h },
        post: { backend: cloneB(), private: prPriv(), activeIdHash: h },
        switched: { backend: cloneB(), private: prPriv(), activeIdHash: h },
        orderHash: h,
        orderCount: 2,
        agentTitleHash: h,
        tabTitleHash: h,
        switchedAgentTitleHash: siblingTitle,
        switchedTabTitleHash: h,
        preAgentTitleHash: h,
        preTabTitleHash: h,
      },
    },
    finalReplay: {
      found: true,
      private: { ...privRes },
      revision: { ...revision },
      titleHash: h,
      opIdHash: h,
      idempotencyKeyHash: h,
      requestIdHash: h,
      sessionIdHash: h,
    },
    parity: { divergence: null, details: {} },
    collectedAt: new Date().toISOString(),
  }
}

function makeValidTimelineEntry(ts: number, phase: string) {
  return {
    ts,
    iso: new Date(ts).toISOString(),
    phase,
    auxiliaryBar: { exists: true, visible: true, width: 300, height: 600, focusWithin: false },
    chat: { exists: true, visible: true, inputVisible: true },
    editors: { tabCount: 1, groupCount: 1, tabHashes: [hash16("tab")] },
    frames: [
      {
        urlHash: hash16("vscode-webview://a"),
        urlKind: "vscode-webview",
        pageKind: "webview",
        dataTheme: "kilo-vscode",
        hasAm: false,
        hasKiloChat: true,
        hasPrompt: true,
        hasHeader: false,
        bodyClassHash: hash16("cls"),
        bodyCategory: "kilo-welcome",
        visible: true,
      },
    ],
  }
}

function buildValidLifecycleTimeline(): unknown[] {
  const base = Date.now()
  const phases = [
    "pre-first-target-open",
    "post-first-target-open",
    "pre-panel-close",
    "post-panel-reopen",
    "pre-webview-reload",
    "post-webview-reload",
    "pre-editor-tab-close",
    "post-editor-tab-close",
    "immediately-after-lc-tab-reopen-done-before-frame-selection",
    "after-chosen-frame",
    "pre-session-switch",
    "switched-session",
    "post-session-switch",
    "final-done",
  ]
  return phases.map((p, i) => makeValidTimelineEntry(base + i * 1000, p))
}

const TRANSIENT_FORBIDDEN_LC = [
  // IPC requests + results (runner/lifecycle producer; nonce-driven)
  // private-status: request + result
  "lc-private-status-request",
  "lc-private-status.json",
  // open-tab: request + result
  "lc-open-tab-request",
  "lc-open-tab.json",
  // title: request + result
  "lc-title-request",
  "lc-title-result.json",
  // replay: request + result
  "lc-replay-request",
  "lc-replay-result.json",
  // cstate/credential/snap: requests only (results are required durable evidence)
  "lc-cstate-request",
  "lc-credseed-request",
  "lc-snap-1-request",
  "lc-snap-2-request",
  // boundary barriers: request / ready / done
  "lc-settle-request",
  "lc-settle-done",
  "lc-panel-close-request",
  "lc-panel-close-ready",
  "lc-reload-request",
  "lc-reload-ready",
  "lc-tab-close-request",
  "lc-tab-close-done",
  "lc-tab-reopen-request",
  "lc-tab-reopen-done",
  // lifecycle diagnostics (probe-local, not durable evidence)
  "lc-gc-replay.json",
  "lc-model-requests.json",
]

function seededLifecycle(
  root: string,
  over: { drop?: string[]; corrupt?: string[] } = {},
): { scratch: string; workspace: string; staging: string } {
  const scratch = join(root, "scratch")
  const workspace = join(root, "workspace")
  const staging = join(root, "staging")
  mkdirSync(scratch, { recursive: true })
  mkdirSync(staging, { recursive: true })
  const plan = { sourceId: "s-A", customAgent: "e2e-agent", customProvider: "e2e-local", customModel: "e2e-model" }
  writeFileSync(join(scratch, "plan.json"), JSON.stringify(plan))
  writeFileSync(join(scratch, "runner-pid"), "4242")
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
    join(scratch, "llm-requests-real-lifecycle.json"),
    JSON.stringify({ scenario: "real-lifecycle", records: [] }),
  )
  writeFileSync(
    join(scratch, "llm-matrix-real-lifecycle-final.json"),
    JSON.stringify({ phase: "real-lifecycle-final", total: 1, violations: [] }),
  )
  writeFileSync(
    join(scratch, "lc-snap-1.json"),
    JSON.stringify({ requestedAt: "t", sessions: [], messages: {}, statuses: {} }),
  )
  writeFileSync(
    join(scratch, "lc-snap-2.json"),
    JSON.stringify({ requestedAt: "t2", sessions: [], messages: {}, statuses: {} }),
  )
  writeFileSync(join(scratch, "canonical-gate.json"), JSON.stringify({ gate: "ok", at: new Date().toISOString() }))
  writeFileSync(
    join(scratch, "canonical-archive-before.json"),
    JSON.stringify({ before: true, ts: Date.now() }),
  )
  writeFileSync(join(scratch, "canonical-archive-after.json"), JSON.stringify({ after: true, ts: Date.now() }))
  writeFileSync(join(scratch, "lc-cstate.json"), JSON.stringify({ state: "ready", hash: hash16("cstate") }))
  writeFileSync(join(scratch, "lc-credential.json"), JSON.stringify({ provisioned: true, hash: hash16("cred") }))
  writeFileSync(join(scratch, "lc-gc-proof.json"), JSON.stringify(makeValidLcProof()))
  writeFileSync(join(scratch, "lc-layout-timeline.json"), JSON.stringify(buildValidLifecycleTimeline()))
  const kilo = join(workspace, ".kilo")
  mkdirSync(kilo, { recursive: true })
  writeFileSync(join(kilo, "kilo.jsonc"), JSON.stringify({ provider: {}, agent: {} }))
  // drops: support both scratch rels and workspace kilo.jsonc variants
  for (const drop of over.drop ?? []) {
    if (drop === ".kilo/kilo.jsonc" || drop === "workspace/.kilo/kilo.jsonc" || drop === "kilo.jsonc") {
      rmSync(join(workspace, ".kilo", "kilo.jsonc"), { force: true })
    } else if (drop.includes("*")) {
      // glob pattern drop: remove matching files
      const star = drop.indexOf("*")
      const prefix = drop.slice(0, star)
      const suffix = drop.slice(star + 1)
      if (existsSync(scratch)) {
        for (const name of readdirSync(scratch)) {
          if (name.startsWith(prefix) && name.endsWith(suffix)) rmSync(join(scratch, name), { force: true })
        }
      }
    } else {
      rmSync(join(scratch, drop), { force: true })
    }
  }
  for (const corrupt of over.corrupt ?? []) {
    if (corrupt === ".kilo/kilo.jsonc" || corrupt === "workspace/.kilo/kilo.jsonc" || corrupt === "kilo.jsonc") {
      writeFileSync(join(workspace, ".kilo", "kilo.jsonc"), "{not jsonc")
    } else {
      writeFileSync(join(scratch, corrupt), "{not json")
    }
  }
  return { scratch, workspace, staging }
}

const realCompleted = new Set(["real-completed"])
const realLifecycle = new Set(["real-lifecycle"])

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

  it("validates JSONC with comments/trailing commas via real parser and rejects malformed without leaking content", () => {
    // valid JSONC with comments and trailing comma must pass (Kilo config semantics)
    expect(parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from('// comment\n{"a":1,}\n'))).toBeNull()
    expect(parseFailure(".kilo/kilo.jsonc", Buffer.from('{"provider": {}, "agent": {},}'))).toBeNull()
    expect(parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from('{"x":1, // trailing\n "y":2,}'))).toBeNull()
    // malformed/truncated JSONC returns stable category without raw content
    const malformed1 = parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from("{not jsonc")) as string
    expect(malformed1).toContain("invalid JSONC")
    expect(malformed1).not.toContain("{not jsonc")
    expect(malformed1).not.toContain("not jsonc")
    const malformed2 = parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from("")) as string
    expect(malformed2).toContain("empty file")
    const malformed3 = parseFailure(".kilo/kilo.jsonc", Buffer.from('{"a":')) as string
    expect(malformed3).toContain("invalid JSONC")
    expect(malformed3).not.toContain('{"a":')
    // stable error: same category for different malformed inputs, no path leak beyond dest
    expect(parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from("{bad"))).toBe(
      parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from("{worse")),
    )
    // invalid JSON without content leak
    const inv = parseFailure("plan.json", Buffer.from('{not json content "secret"}')) as string
    expect(inv).toBe("invalid JSON")
    expect(inv).not.toContain("secret")
    // corrupt JSONL without content leak
    const corruptLine = JSON.stringify("secret-payload-123")
    const invJsonl = parseFailure("llm-requests.jsonl", Buffer.from(`{"a":1}\n${corruptLine.slice(1,-1)} not json\n`)) as string
    expect(invJsonl).toBe("corrupt JSONL line")
    expect(invJsonl).not.toContain("secret")
  })

  it("needsParse recognizes .jsonc as parse-required", () => {
    // .kilo/kilo.jsonc must be recognized as required parse artifact; .jsonc success allows comments
    expect(parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from('{"ok":1}'))).toBeNull()
    // ensure evidenceInventory for real-lifecycle includes .kilo/kilo.jsonc
    const { required } = evidenceInventory(new Set(["real-lifecycle"]))
    const rels = required.map((s) => `${s.base}:${s.rel}`)
    expect(rels).toContain("workspace:.kilo/kilo.jsonc")
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

describe("collectEvidence real-lifecycle (full inventory matrix)", () => {
  function collectLifecycle(root: string, over: { drop?: string[]; corrupt?: string[] } = {}) {
    const { scratch, workspace, staging } = seededLifecycle(root, over)
    return collectEvidence({
      staging,
      scratch,
      workspace,
      scenarios: realLifecycle,
      fixtureId: "e2e-probe-1234",
      startedAt: Date.now() - 60_000,
      probePid: 4242,
      success: true,
      destination: resolve(join(root, "dest")),
    })
  }

  it("seeds all required files with schema-valid minimal contents and passes complete", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededLifecycle(root)
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realLifecycle,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now() - 60_000,
        probePid: 4242,
        success: true,
        destination: resolve(join(root, "dest")),
      })
      expect(manifest.status).toBe("complete")
      expect(manifest.validated).toBe(true)
      expect(manifest.missing).toEqual([])
      expect(manifest.malformed).toEqual([])
      // required inventory contains all decision-critical artifacts
      expect(manifest.required).toContain("plan.json")
      expect(manifest.required).toContain("llm-requests.jsonl")
      expect(manifest.required).toContain("llm-requests-real-lifecycle.json")
      expect(manifest.required).toContain("llm-matrix-real-lifecycle-final.json")
      expect(manifest.required).toContain("workspace/.kilo/kilo.jsonc")
      expect(manifest.required).toContain("lc-gc-proof.json")
      expect(manifest.required).toContain("lc-layout-timeline.json")
      expect(manifest.required).toContain("canonical-gate.json")
      expect(manifest.required).toContain("lc-cstate.json")
      expect(manifest.required).toContain("lc-credential.json")
      // snapshot glob expanded
      expect(manifest.required).toContain("lc-snap-1.json")
      expect(manifest.required).toContain("lc-snap-2.json")
      // byte-exact
      for (const entry of manifest.files) {
        const destBytes = readFileSync(join(staging, entry.dest))
        expect(sha256Of(destBytes)).toBe(entry.sha256)
        expect(readFileSync(entry.source).equals(destBytes)).toBe(true)
      }
      // JSONC with comments/trailing commas still validates (allow semantics)
      const kiloBytes = readFileSync(join(workspace, ".kilo", "kilo.jsonc"))
      expect(parseFailure("workspace/.kilo/kilo.jsonc", kiloBytes)).toBeNull()
      // proof and timeline validators pass
      expect(validateLcProof(JSON.parse(readFileSync(join(scratch, "lc-gc-proof.json"), "utf8")))).toBeNull()
      expect(validateLcTimeline(JSON.parse(readFileSync(join(scratch, "lc-layout-timeline.json"), "utf8")))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("allows JSONC comments/trailing commas in required config without failing", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededLifecycle(root)
      // overwrite config with comments/trailing commas
      writeFileSync(join(workspace, ".kilo", "kilo.jsonc"), '// comment\n{"provider": {}, "agent": {},}\n')
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realLifecycle,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: resolve(join(root, "dest")),
      })
      expect(manifest.status).toBe("complete")
      expect(manifest.malformed).not.toContain("workspace/.kilo/kilo.jsonc")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  const missingMatrix: Array<{ name: string; drop: string[]; missing: string }> = [
    { name: "lc-gc-proof", drop: ["lc-gc-proof.json"], missing: "lc-gc-proof.json" },
    { name: "lc-layout-timeline", drop: ["lc-layout-timeline.json"], missing: "lc-layout-timeline.json" },
    { name: "llm-requests.jsonl", drop: ["llm-requests.jsonl"], missing: "llm-requests.jsonl" },
    { name: "scenario requests JSON", drop: ["llm-requests-real-lifecycle.json"], missing: "llm-requests-real-lifecycle.json" },
    { name: "final matrix", drop: ["llm-matrix-real-lifecycle-final.json"], missing: "llm-matrix-real-lifecycle-final.json" },
    { name: "config JSONC", drop: [".kilo/kilo.jsonc"], missing: "workspace/.kilo/kilo.jsonc" },
    { name: "zero snap glob", drop: ["lc-snap-1.json", "lc-snap-2.json"], missing: "lc-snap-*.json" },
    { name: "lc-cstate", drop: ["lc-cstate.json"], missing: "lc-cstate.json" },
    { name: "lc-credential", drop: ["lc-credential.json"], missing: "lc-credential.json" },
  ]

  for (const c of missingMatrix) {
    it(`fails missing when ${c.name} is absent`, () => {
      const root = tempRoot()
      try {
        const manifest = collectLifecycle(root, { drop: c.drop })
        expect(manifest.status).toBe("missing")
        expect(manifest.validated).toBe(false)
        expect(manifest.missing).toContain(c.missing)
        expect(manifest.missing.length).toBeGreaterThan(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it("fails missing when canonical-gate is absent", () => {
    const root = tempRoot()
    try {
      const manifest = collectLifecycle(root, { drop: ["canonical-gate.json"] })
      expect(manifest.status).toBe("missing")
      expect(manifest.missing).toContain("canonical-gate.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  const malformedMatrix: Array<{ name: string; corrupt: string[]; malformed: string }> = [
    { name: "corrupt JSONC", corrupt: [".kilo/kilo.jsonc"], malformed: "workspace/.kilo/kilo.jsonc" },
    { name: "corrupt proof", corrupt: ["lc-gc-proof.json"], malformed: "lc-gc-proof.json" },
    { name: "corrupt timeline", corrupt: ["lc-layout-timeline.json"], malformed: "lc-layout-timeline.json" },
    { name: "corrupt JSONL", corrupt: ["llm-requests.jsonl"], malformed: "llm-requests.jsonl" },
    { name: "corrupt cstate", corrupt: ["lc-cstate.json"], malformed: "lc-cstate.json" },
    { name: "corrupt credential", corrupt: ["lc-credential.json"], malformed: "lc-credential.json" },
  ]

  for (const c of malformedMatrix) {
    it(`fails malformed when ${c.name} is corrupt without leaking content`, () => {
      const root = tempRoot()
      try {
        const manifest = collectLifecycle(root, { corrupt: c.corrupt })
        expect(manifest.status).toBe("malformed")
        expect(manifest.validated).toBe(false)
        expect(manifest.malformed).toContain(c.malformed)
        // notes must be stable and not leak raw content
        const notes = manifest.notes.join("\n")
        expect(notes).toContain(c.malformed)
        expect(notes).not.toContain("{not json")
        expect(notes).not.toContain("secret")
        // error category stable, not raw slice
        if (c.malformed === "workspace/.kilo/kilo.jsonc") expect(notes).toContain("invalid JSONC")
        if (c.malformed === "llm-requests.jsonl") expect(notes).toContain("corrupt JSONL")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it("fails malformed when proof schema is invalid (still without content leak)", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededLifecycle(root)
      const badProof = makeValidLcProof() as Record<string, unknown>
      ;(badProof as Record<string, unknown>).schema = "bad-schema"
      writeFileSync(join(scratch, "lc-gc-proof.json"), JSON.stringify(badProof))
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realLifecycle,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: resolve(join(root, "dest")),
      })
      expect(manifest.status).toBe("malformed")
      expect(manifest.malformed).toContain("lc-gc-proof.json")
      expect(manifest.notes.join("\n")).not.toContain("bad-schema")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails malformed when timeline is truncated", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededLifecycle(root)
      writeFileSync(join(scratch, "lc-layout-timeline.json"), "[]")
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realLifecycle,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: resolve(join(root, "dest")),
      })
      expect(manifest.status).toBe("malformed")
      expect(manifest.malformed).toContain("lc-layout-timeline.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("optional lc-ready and lc-dom-evidence absence does not fail", () => {
    const root = tempRoot()
    try {
      const { scratch, workspace, staging } = seededLifecycle(root)
      // ensure optional files are absent (they were never seeded)
      expect(existsSync(join(scratch, "lc-ready"))).toBe(false)
      expect(existsSync(join(scratch, "lc-dom-evidence"))).toBe(false)
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realLifecycle,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: resolve(join(root, "dest")),
      })
      expect(manifest.status).toBe("complete")
      // when present, they are copied but still not required
      writeFileSync(join(scratch, "lc-ready"), "ready")
      writeFileSync(join(scratch, "lc-dom-evidence"), JSON.stringify({ ok: true }))
      // create a fresh root for second check to avoid polluting staging
      const root2 = tempRoot()
      try {
        const { scratch: sc, workspace: ws, staging: st } = seededLifecycle(root2)
        writeFileSync(join(sc, "lc-ready"), "ready")
        writeFileSync(join(sc, "lc-dom-evidence"), JSON.stringify({ ok: true }))
        const m2 = collectEvidence({
          staging: st,
          scratch: sc,
          workspace: ws,
          scenarios: realLifecycle,
          fixtureId: "e2e-probe-1234",
          startedAt: Date.now(),
          probePid: 4242,
          success: true,
          destination: resolve(join(root2, "dest2")),
        })
        expect(m2.required).not.toContain("lc-ready")
        expect(m2.required).not.toContain("lc-dom-evidence")
        expect(m2.files.some((f) => f.dest === "lc-ready")).toBe(true)
        expect(m2.files.some((f) => f.dest === "lc-dom-evidence")).toBe(true)
        expect(m2.status).toBe("complete")
      } finally {
        rmSync(root2, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("forbidden transients are absent from inventory and never copied", () => {
    const root = tempRoot()
    try {
      const { required, optional } = evidenceInventory(realLifecycle)
      const allRels = [...required, ...optional].map((s) => s.rel)
      const req = required.map((s) => s.rel)
      const opt = optional.map((s) => s.rel)

      // Locked exclusions: optional lc-ready/lc-dom-evidence and required lc-snap-*.json must NOT be forbidden
      expect(TRANSIENT_FORBIDDEN_LC).not.toContain("lc-ready")
      expect(TRANSIENT_FORBIDDEN_LC).not.toContain("lc-dom-evidence")
      expect(TRANSIENT_FORBIDDEN_LC).not.toContain("lc-snap-1.json")
      expect(TRANSIENT_FORBIDDEN_LC).not.toContain("lc-snap-2.json")
      expect(TRANSIENT_FORBIDDEN_LC).not.toContain("lc-snap-*.json")
      expect(TRANSIENT_FORBIDDEN_LC).not.toContain("lc-cstate.json")
      expect(TRANSIENT_FORBIDDEN_LC).not.toContain("lc-credential.json")
      // durable artifacts remain correctly inventoried (locked)
      expect(req).toContain("lc-snap-*.json")
      expect(req).toContain("lc-cstate.json")
      expect(req).toContain("lc-credential.json")
      expect(opt).toContain("lc-ready")
      expect(opt).toContain("lc-dom-evidence")

      // grouping: each producer category is covered (requests/results/done/ready)
      // IPC requests
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-private-status-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-open-tab-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-title-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-replay-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-cstate-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-credseed-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-snap-1-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-snap-2-request")
      // IPC results
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-private-status.json")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-open-tab.json")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-title-result.json")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-replay-result.json")
      // boundary request/ready/done
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-settle-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-settle-done")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-panel-close-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-panel-close-ready")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-reload-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-reload-ready")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-tab-close-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-tab-close-done")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-tab-reopen-request")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-tab-reopen-done")
      // diagnostics (probe-local)
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-gc-replay.json")
      expect(TRANSIENT_FORBIDDEN_LC).toContain("lc-model-requests.json")

      // pattern: all forbidden must be absent from both required and optional
      for (const trans of TRANSIENT_FORBIDDEN_LC) {
        expect(allRels).not.toContain(trans)
        expect(req).not.toContain(trans)
        expect(opt).not.toContain(trans)
        // glob check: no entry should be a prefix match for request
        expect(allRels.some((r) => r === trans || r.startsWith(trans))).toBe(false)
      }
      // also ensure no lc request pattern is present at all (llm-requests is allowed)
      expect(allRels.some((r) => r.startsWith("lc-") && r.includes("request"))).toBe(false)
      // seed transients into scratch and ensure they are not copied
      const { scratch, workspace, staging } = seededLifecycle(root)
      for (const trans of TRANSIENT_FORBIDDEN_LC) {
        writeFileSync(join(scratch, trans), "transient")
      }
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realLifecycle,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: resolve(join(root, "dest")),
      })
      for (const trans of TRANSIENT_FORBIDDEN_LC) {
        expect(manifest.files.some((f) => f.dest === trans)).toBe(false)
        expect(manifest.files.some((f) => f.source.endsWith(`/${trans}`))).toBe(false)
        expect(manifest.required).not.toContain(trans)
      }
      expect(manifest.status).toBe("complete")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("duplicate destination prevention still holds for lifecycle", () => {
    const claimed = new Map<string, string>()
    expect(claimDestination(claimed, "lc-gc-proof.json", "/scratch/lc-gc-proof.json")).toBe(true)
    expect(claimDestination(claimed, "lc-gc-proof.json", "/scratch/lc-gc-proof.json")).toBe(false)
    expect(() => claimDestination(claimed, "lc-gc-proof.json", "/other/lc-gc-proof.json")).toThrow(/conflicting/)
  })

  it("real-lifecycle inventory exact normalized required/optional sets (glob explicit)", () => {
    const { required, optional } = evidenceInventory(realLifecycle)
    const req = required.map((s) => (s.base === "workspace" ? `workspace/${s.rel}` : s.rel)).sort()
    const opt = optional.map((s) => (s.base === "workspace" ? `workspace/${s.rel}` : s.rel)).sort()
    expect(req).toEqual([
      "canonical-archive-after.json",
      "canonical-archive-before.json",
      "canonical-gate.json",
      "lc-credential.json",
      "lc-cstate.json",
      "lc-gc-proof.json",
      "lc-layout-timeline.json",
      "lc-snap-*.json",
      "llm-matrix-real-lifecycle-final.json",
      "llm-requests-real-lifecycle.json",
      "llm-requests.jsonl",
      "plan.json",
      "runner-pid",
      "workspace/.kilo/kilo.jsonc",
    ])
    expect(opt).toEqual([
      "child-phase1-done",
      "child-phase2-done",
      "child-phase2-ready",
      "lc-dom-evidence",
      "lc-ready",
      "llm-matrix-*.json",
      "ready",
      "real-completed-mcp-disconnect-done",
      "real-completed-ready",
      "real-completed-reopen-ready",
      "real-overflow-ready",
      "real-ready",
      "real-reopen-ready",
      "rr-conn.json",
      "rr-gc-*.json",
      "rr-kill.json",
      "rr-model-requests.json",
      "rr-open-tab.json",
      "rr-pin.json",
      "rr-private-status.json",
      "rr-ready",
      "rr-reconnect.json",
      "rr-reload-executed",
      "rr-reloaded",
      "rr-replay-result.json",
      "rr-title-result.json",
      "runner-alive",
      "runner-done",
      "tab-close-done",
      "topic-nav-done",
      "topic-reload-done",
      "topic-reload-frame",
      "topic-reload-ready",
      "topic-reload-start",
      "topic-reopen-done",
      "topic-reopen-ready",
      "variant-ready",
      "workspace/e2e-custom-called.txt",
    ])
  })
})

describe("hostile capability/phase values do not leak into notes", () => {
  it("validateGcProof unknown capability does not echo hostile value", () => {
    const hostile = "__HOSTILE_CAP_9f8e7d6c__"
    const p = makeValidProof() as Record<string, unknown>
    ;((p.pre as Record<string, unknown>).private as Record<string, unknown>).capabilities = [hostile]
    const err = validateGcProof(p) as string
    expect(err).not.toBeNull()
    expect(err).not.toContain(hostile)
    expect(err).toContain("unknown capability")
    // parseFailure wrapper also must not leak
    const pf = parseFailure("rr-gc-proof.json", Buffer.from(JSON.stringify(p))) as string
    expect(pf).not.toContain(hostile)
    expect(pf).toContain("unknown capability")
  })

  it("validateLcProof unknown capability does not echo hostile value", () => {
    const hostile = "__HOSTILE_CAP_LC_abcdef__"
    const p = makeValidLcProof() as Record<string, unknown>
    ;((p.pre as Record<string, unknown>).private as Record<string, unknown>).capabilities = [hostile]
    const err = validateLcProof(p) as string
    expect(err).not.toBeNull()
    expect(err).not.toContain(hostile)
    expect(err).toContain("unknown capability")
    const pf = parseFailure("lc-gc-proof.json", Buffer.from(JSON.stringify(p))) as string
    expect(pf).not.toContain(hostile)
    expect(pf).toContain("unknown capability")
  })

  it("validateLcTimeline unknown phase does not echo hostile value", () => {
    const hostile = "__HOSTILE_PHASE_XYZ123__"
    const timeline = buildValidLifecycleTimeline() as Record<string, unknown>[]
    timeline[0].phase = hostile
    const err = validateLcTimeline(timeline) as string
    expect(err).not.toBeNull()
    expect(err).not.toContain(hostile)
    expect(err).toContain("phase unknown")
    const pf = parseFailure("lc-layout-timeline.json", Buffer.from(JSON.stringify(timeline))) as string
    expect(pf).not.toContain(hostile)
    expect(pf).toContain("phase unknown")
  })

  it("collectEvidence malformed notes do not echo hostile capability/phase", () => {
    const hostileCap = "__HOSTILE_CAP_MANIFEST__"
    const hostilePhase = "__HOSTILE_PHASE_MANIFEST__"
    // hostile capability via proof
    const root1 = tempRoot()
    try {
      const { scratch, workspace, staging } = seededLifecycle(root1)
      const badProof = makeValidLcProof() as Record<string, unknown>
      ;((badProof.pre as Record<string, unknown>).private as Record<string, unknown>).capabilities = [hostileCap]
      writeFileSync(join(scratch, "lc-gc-proof.json"), JSON.stringify(badProof))
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realLifecycle,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: resolve(join(root1, "dest")),
      })
      expect(manifest.status).toBe("malformed")
      expect(manifest.malformed).toContain("lc-gc-proof.json")
      const notes = manifest.notes.join("\n")
      expect(notes).not.toContain(hostileCap)
      expect(notes).toContain("unknown capability")
    } finally {
      rmSync(root1, { recursive: true, force: true })
    }
    // hostile phase via timeline
    const root2 = tempRoot()
    try {
      const { scratch, workspace, staging } = seededLifecycle(root2)
      const timeline = buildValidLifecycleTimeline() as Record<string, unknown>[]
      timeline[0].phase = hostilePhase
      writeFileSync(join(scratch, "lc-layout-timeline.json"), JSON.stringify(timeline))
      const manifest = collectEvidence({
        staging,
        scratch,
        workspace,
        scenarios: realLifecycle,
        fixtureId: "e2e-probe-1234",
        startedAt: Date.now(),
        probePid: 4242,
        success: true,
        destination: resolve(join(root2, "dest")),
      })
      expect(manifest.status).toBe("malformed")
      expect(manifest.malformed).toContain("lc-layout-timeline.json")
      const notes = manifest.notes.join("\n")
      expect(notes).not.toContain(hostilePhase)
      expect(notes).toContain("phase unknown")
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })
})
