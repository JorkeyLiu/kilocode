import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { needsCanonicalStorage } from "../../script/e2e-canonical"
import { evidenceInventory } from "../../script/e2e-evidence"
import { realProjectSeed } from "../../script/e2e-restart-seed"
import { CONFIG_FILENAME } from "../../src/config/paths"

describe("needsCanonicalStorage predicate (canonical gate coverage)", () => {
  it("is true for real-restart and real-session, false for others", () => {
    expect(needsCanonicalStorage(new Set(["real-restart"]))).toBe(true)
    expect(needsCanonicalStorage(new Set(["real-session"]))).toBe(true)
    expect(needsCanonicalStorage(new Set(["real-completed"]))).toBe(false)
    expect(needsCanonicalStorage(new Set(["tab-close"]))).toBe(false)
    expect(needsCanonicalStorage(new Set(["all"]))).toBe(false)
    expect(needsCanonicalStorage(new Set(["real-restart", "real-session"]))).toBe(true)
  })

  it("probe string predicate mirrors the Set predicate (static check)", () => {
    const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe.ts"), "utf8")
    expect(src).toContain("export function needsCanonicalStorage(value: string)")
    expect(src).toContain('parseScenarios(value).has("real-restart")')
    expect(src).toContain('parseScenarios(value).has("real-session")')
  })
})

describe("real-session canonical project seed", () => {
  it("realProjectSeed produces valid canonical provider shape with hang port", () => {
    const port = 41234
    const seed = realProjectSeed(port) as Record<string, unknown>
    expect(seed.model).toBe("e2e-local/e2e-model")
    const provider = (seed.provider as Record<string, unknown>)["e2e-local"] as Record<string, unknown>
    expect(provider.name).toBe("E2E Local")
    expect(provider.endpoint).toBe(`http://127.0.0.1:${port}/v1`)
    expect(provider.protocol).toBe("openai")
    expect(provider.credential).toBe("secret:kilo.credentials.project.provider.e2e-local")
    const models = provider.models as Record<string, unknown>
    const m = models["e2e-model"] as Record<string, unknown>
    expect((m.variants as Record<string, unknown>)).toEqual({ low: {}, medium: {}, high: {} })
  })

  it("writing canonical project file produces parseable JSONC with credential ref and no secret", () => {
    const scratch = mkdtempSync(join(tmpdir(), "e2e-rs-seed-"))
    try {
      const workspace = join(scratch, "workspace")
      mkdirSync(join(workspace, ".kilo"), { recursive: true })
      const port = 42345
      const canonicalFile = join(workspace, ".kilo", CONFIG_FILENAME)
      writeFileSync(canonicalFile, JSON.stringify(realProjectSeed(port), null, 2))
      expect(existsSync(canonicalFile)).toBe(true)
      const parsed = JSON.parse(readFileSync(canonicalFile, "utf8")) as Record<string, unknown>
      const provider = (parsed.provider as Record<string, unknown>)["e2e-local"] as Record<string, unknown>
      // Must be secret ref, never plaintext apiKey
      expect(String(provider.credential)).toContain("secret:")
      expect(JSON.stringify(parsed)).not.toContain("e2e-fixture-key")
      expect(String(provider.endpoint)).toContain(String(port))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("workspace guard is required (mirrors restart seed) and probe writes it", () => {
    const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe.ts"), "utf8")
    // prepareRealSession must write the canonical file and the dependency guard
    expect(src).toContain("realProjectSeed(hang.port)")
    expect(src).toContain(CONFIG_FILENAME)
    expect(src).toContain("node_modules")
    expect(src).toContain("package-lock.json")
    expect(src).toContain("@kilocode/plugin")
  })
})

describe("evidenceInventory for real-session (canonical gate/state/archive)", () => {
  it("requires canonical-gate, archive-before/after, rs-cstate, rs-credential, and workspace kilo.jsonc", () => {
    const { required, optional } = evidenceInventory(new Set(["real-session"]))
    const rels = required.map((s) => `${s.base}:${s.rel}`)
    expect(rels).toContain("scratch:canonical-gate.json")
    expect(rels).toContain("scratch:canonical-archive-before.json")
    expect(rels).toContain("scratch:canonical-archive-after.json")
    expect(rels).toContain("scratch:rs-cstate.json")
    expect(rels).toContain("scratch:rs-credential.json")
    expect(rels).toContain("workspace:.kilo/kilo.jsonc")
    // It also keeps the backend kilo.json required via the generic real set
    expect(rels).toContain("workspace:.kilo/kilo.json")
    // rs- files are required, not optional
    expect(optional.map((s) => s.rel)).not.toContain("rs-cstate.json")
    expect(optional.map((s) => s.rel)).not.toContain("rs-credential.json")
  })

  it("keeps real-restart required inventory unchanged", () => {
    const { required } = evidenceInventory(new Set(["real-restart"]))
    const rels = required.map((s) => `${s.base}:${s.rel}`)
    expect(rels).toContain("scratch:rr-cstate.json")
    expect(rels).toContain("scratch:rr-credential.json")
    expect(rels).toContain("scratch:canonical-gate.json")
    // real-restart must not suddenly require rs- files
    expect(rels).not.toContain("scratch:rs-cstate.json")
    expect(rels).not.toContain("scratch:rs-credential.json")
  })
})

describe("real-session lifecycle ordering (gate/credential/state before first panel action)", () => {
  it("probes canonical gate, credential, and state BEFORE the agent-list assertion", () => {
    const probeSrc = readFileSync(join(import.meta.dirname, "../../script/e2e-probe.ts"), "utf8")
    const funcAt = probeSrc.indexOf("async function assertRealSessionLifecycle")
    expect(funcAt).toBeGreaterThan(-1)
    const body = probeSrc.slice(funcAt, funcAt + 8000)
    const gateAt = body.indexOf('"canonical-gate.json"')
    const credAt = body.indexOf('"rs-credential.json"')
    const cstateAt = body.indexOf("requestRsCanonicalState")
    const agentAt = body.indexOf("await waitForAgentOption(frame, plan.customAgentLabel, timeout)")
    expect(gateAt).toBeGreaterThan(-1)
    expect(credAt).toBeGreaterThan(gateAt)
    expect(cstateAt).toBeGreaterThan(credAt)
    expect(agentAt).toBeGreaterThan(cstateAt)
  })

  it("runner seeds rs-credential before real-ready and services rs- markers", () => {
    const runnerSrc = readFileSync(join(import.meta.dirname, "../e2e/runner.ts"), "utf8")
    const seedAt = runnerSrc.indexOf('writeFileSync(join(scratch, "rs-credential.json")')
    const readyAt = runnerSrc.indexOf('writeFileSync(join(scratch, "real-ready")')
    expect(seedAt).toBeGreaterThan(-1)
    expect(readyAt).toBeGreaterThan(seedAt)
    expect(runnerSrc).toContain('"kilo-code.new.e2eFixture.seedCredential"')
    expect(runnerSrc).toContain("rs-cstate-request")
    expect(runnerSrc).toContain("rs-cstate.json")
    expect(runnerSrc).toContain("rs-credseed-request")
    expect(runnerSrc).toContain("rs-credential.json")
  })
})
