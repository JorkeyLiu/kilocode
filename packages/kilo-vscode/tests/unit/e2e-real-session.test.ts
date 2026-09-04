import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { needsCanonicalStorage } from "../../script/e2e-canonical"
import { evidenceInventory } from "../../script/e2e-evidence"
import { isLoopbackProviderBaseURL, prepareRealSession, selectProviderBaseURL } from "../../script/e2e-probe"
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

describe("real-session provider URL selection (hang server seam)", () => {
  it("selects the run-owned hang URL for real-session", () => {
    expect(selectProviderBaseURL(new Set(["real-session"]), 41234, undefined)).toBe("http://127.0.0.1:41234/v1")
  })

  it("fails closed to undefined for real-session without a hang port (no fallback)", () => {
    expect(selectProviderBaseURL(new Set(["real-session"]), undefined, undefined)).toBeUndefined()
    expect(selectProviderBaseURL(new Set(["real-session"]), undefined, 42345)).toBeUndefined()
  })

  it("selects the lifecycle model URL for real-lifecycle on its own port", () => {
    expect(selectProviderBaseURL(new Set(["real-lifecycle"]), undefined, 42345)).toBe(
      "http://127.0.0.1:42345/v1",
    )
    expect(selectProviderBaseURL(new Set(["real-lifecycle"]), undefined, undefined)).toBeUndefined()
  })

  it("prefers the real-session hang URL when both ports are present", () => {
    expect(selectProviderBaseURL(new Set(["real-session", "real-lifecycle"]), 41234, 42345)).toBe(
      "http://127.0.0.1:41234/v1",
    )
  })

  it("selects no URL for real-restart and ordinary scenarios (restart owns its relaunch path)", () => {
    expect(selectProviderBaseURL(new Set(["real-restart"]), 41234, 42345)).toBeUndefined()
    expect(selectProviderBaseURL(new Set(["tab-close"]), 41234, 42345)).toBeUndefined()
    expect(selectProviderBaseURL(new Set(["all"]), 41234, 42345)).toBeUndefined()
  })

  it("selected run-owned URLs pass the fail-closed loopback guard", () => {
    const session = selectProviderBaseURL(new Set(["real-session"]), 41234, undefined)
    const lifecycle = selectProviderBaseURL(new Set(["real-lifecycle"]), undefined, 42345)
    expect(isLoopbackProviderBaseURL(session)).toBe(true)
    expect(isLoopbackProviderBaseURL(lifecycle)).toBe(true)
    expect(isLoopbackProviderBaseURL("http://localhost:80/v1")).toBe(true)
    expect(isLoopbackProviderBaseURL("https://127.0.0.1:443/v1")).toBe(true)
  })

  it("non-loopback or invalid URLs fail closed", () => {
    const bad = [
      "http://example.com/v1",
      "http://127.0.0.1:41234/v2",
      "http://127.0.0.1:41234/v1?x=1",
      "http://192.168.1.1:41234/v1",
      "http://127.0.0.1:41234/chat/completions",
      "",
      "undefined/chat/completions",
    ]
    for (const url of bad) expect(isLoopbackProviderBaseURL(url)).toBe(false)
    expect(isLoopbackProviderBaseURL(undefined)).toBe(false)
  })

  it("launchVSCode gates KILO_E2E_PROVIDER_BASE_URL through the loopback guard", () => {
    const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe.ts"), "utf8")
    expect(src).toContain("KILO_E2E_PROVIDER_BASE_URL")
    expect(src).toContain("isLoopbackProviderBaseURL(providerBaseURL)")
    expect(src).toContain("selectProviderBaseURL(scenarios, hang?.port, lifecycleModel?.port)")
  })
})

describe("prepareRealSession failure path (hang listener cleanup)", () => {
  it("closes the hang listener and rethrows the seed error", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "e2e-rs-fail-"))
    try {
      const workspace = join(scratch, "workspace")
      const sentinel = new Error("seed boom")
      let closed = 0
      let err: unknown
      try {
        await prepareRealSession(workspace, true, {
          createHang: async () => ({ port: 41234, close: async () => void (closed += 1) }),
          seed: () => {
            throw sentinel
          },
        })
      } catch (e) {
        err = e
      }
      expect(err).toBe(sentinel)
      expect(closed).toBe(1)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("leaves the hang listener open on seed success (outer tail owns close)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "e2e-rs-ok-"))
    try {
      const workspace = join(scratch, "workspace")
      let closed = 0
      const hang = await prepareRealSession(workspace, true, {
        createHang: async () => ({ port: 41234, close: async () => void (closed += 1) }),
        seed: () => ({ configFile: "cfg", canonicalFile: "canon" }),
      })
      expect(hang?.port).toBe(41234)
      expect(closed).toBe(0)
      await hang?.close()
      expect(closed).toBe(1)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("creates no listener when real is false", async () => {
    let created = 0
    const out = await prepareRealSession("unused", false, {
      createHang: async () => {
        created += 1
        return { port: 1, close: async () => {} }
      },
      seed: () => ({ configFile: "cfg", canonicalFile: "canon" }),
    })
    expect(out).toBeUndefined()
    expect(created).toBe(0)
  })
})
