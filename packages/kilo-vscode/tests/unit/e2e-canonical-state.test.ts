/**
 * Focused unit tests for the KILO_E2E_FIXTURE-gated canonical state snapshot
 * (CanonicalConfigService.fixtureStateSnapshot, served through the
 * extension.ts fixture bridge as kilo-code.new.e2eFixture.canonicalState):
 * real temp dirs + real materialization — the read-only facts the real-restart
 * harness needs to distinguish readiness-never-opened from ready-but-empty.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { resetVersion } from "../../src/config/materialize"
import {
  createMemoryStateAdapter,
  createMemoryEmitterFactory,
} from "../../src/config/state-adapter"
import { CanonicalConfigService } from "../../src/config/service"
import { REAL_AGENT_ASSETS, realProjectSeed } from "../../script/e2e-restart-seed"
import { parseOwnedCredentialRef } from "../../src/config/types"

let tmpDir: string
let globalRoot: string
let projectRoot: string

beforeEach(() => {
  resetVersion()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p41-cstate-test-"))
  globalRoot = path.join(tmpDir, "xdg-config", "kilo")
  projectRoot = path.join(tmpDir, "workspace")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
  process.env.KILO_E2E_FIXTURE = "1"
})

afterEach(() => {
  delete process.env.KILO_E2E_FIXTURE
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createService(): CanonicalConfigService {
  return new CanonicalConfigService({ secrets: createMemorySecretAdapter() } as never, {
    roots: new Roots(projectRoot, globalRoot),
    secretAdapter: createMemorySecretAdapter(),
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
    emitterFactory: createMemoryEmitterFactory(),
  })
}

function seedGlobalAgents(): void {
  const agentDir = path.join(globalRoot, "agent")
  fs.mkdirSync(agentDir, { recursive: true })
  for (const asset of REAL_AGENT_ASSETS) {
    fs.writeFileSync(
      path.join(agentDir, `${asset.id}.md`),
      ["---", `displayName: ${asset.displayName}`, `description: ${asset.description}`, "mode: primary", "---", "", `You are ${asset.displayName}.`, ""].join("\n"),
      "utf-8",
    )
  }
}

function seedProjectProvider(port: number): string {
  const canonicalFile = path.join(projectRoot, ".kilo", "kilo.jsonc")
  fs.writeFileSync(canonicalFile, JSON.stringify(realProjectSeed(port), null, 2), "utf-8")
  return canonicalFile
}

describe("CanonicalConfigService.fixtureStateSnapshot (fixture gate)", () => {
  it("throws when the fixture env is absent", async () => {
    delete process.env.KILO_E2E_FIXTURE
    const service = createService()
    expect(() => service.fixtureStateSnapshot()).toThrow(/requires KILO_E2E_FIXTURE/)
    service.dispose()
  })

  it("reports ready state, provider ids, agent ids, and asset scan counts after a clean init", async () => {
    seedGlobalAgents()
    const canonicalFile = seedProjectProvider(45659)
    const service = createService()
    await service.initialize()

    const snap = service.fixtureStateSnapshot()
    expect(snap.globalRoot).toBe(globalRoot)
    expect(snap.projectRoot).toBe(projectRoot)
    expect(snap.materializationReady).toBe(true)
    expect(snap.successfulMaterializationStamp).not.toBeNull()
    expect(snap.lastMaterializationError).toBeNull()

    // The seeded project-scope provider is visible in the derived index with
    // its model — the waitForModelSelected(e2e-local/e2e-model) precondition.
    expect(snap.providerIndex).toMatchObject({
      size: 1,
      ids: ["e2e-local"],
    })
    expect(snap.providerIndex?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: "e2e-local", hasCredential: false })]))
    expect(snap.providerIndex?.connected).toEqual([])
    expect(snap.defaultModel).toBe("e2e-local/e2e-model")
    expect(snap.defaultSelection).toEqual({ providerID: "e2e-local", modelID: "e2e-model" })
    expect(service.providerIndex?.providers[0]?.modelIds).toContain("e2e-model")

    expect(snap.agentIndex?.size).toBe(REAL_AGENT_ASSETS.length)
    for (const asset of REAL_AGENT_ASSETS) {
      expect(snap.agentIndex?.ids).toContain(asset.id)
    }

    const agent = snap.assetScan.find((d) => d.dir === "agent" && d.scope === "global")
    expect(agent?.entries).toBe(REAL_AGENT_ASSETS.length)
    expect(agent?.errors).toBe(0)
    // The project config file itself is not an error source; every summary row is clean.
    for (const dir of snap.assetScan) {
      expect(dir.errors).toBe(0)
    }
    expect(fs.existsSync(canonicalFile)).toBe(true)
    service.dispose()
  })

  it("captures the last materialization error and reports not-ready on invalid init", async () => {
    fs.writeFileSync(
      path.join(projectRoot, ".kilo", "kilo.jsonc"),
      JSON.stringify({ provider: { "e2e-local": { baseURL: "http://127.0.0.1:9/v1", apiKey: "plaintext" } } }, null, 2),
      "utf-8",
    )
    const service = createService()
    await service.initialize()

    const snap = service.fixtureStateSnapshot()
    expect(snap.materializationReady).toBe(false)
    expect(snap.successfulMaterializationStamp).toBeNull()
    expect(snap.lastMaterializationError).not.toBeNull()
    service.dispose()
  })

  it("lastMaterializationError stays null through a clean lifecycle without errors", async () => {
    const service = createService()
    await service.initialize()
    expect(service.lastMaterializationError).toBeNull()
    expect(service.materializationReady).toBe(true)
    service.dispose()
  })
})

describe("realProjectSeed (canonical contract)", () => {
  it("contains top-level model and strict project credential ref with closed provider shape", () => {
    const seed = realProjectSeed(19531)
    expect(seed.model).toBe("e2e-local/e2e-model")
    const prov = (seed.provider as Record<string, Record<string, unknown>>)["e2e-local"]!
    expect(prov.credential).toBe("secret:kilo.credentials.project.provider.e2e-local")
    expect(parseOwnedCredentialRef(prov.credential as string)).toEqual({ scope: "project", kind: "provider", id: "e2e-local" })
    // No plaintext apiKey/options in kilo.jsonc — closed shape is name/endpoint/protocol/models/credential only.
    expect(prov.apiKey).toBeUndefined()
    expect((prov as Record<string, unknown>).options).toBeUndefined()
    expect((prov as Record<string, unknown>).baseURL).toBeUndefined()
  })
})

describe("seedFixtureProviderCredential (real SecretStorage convergence)", () => {
  it("before seeding hasCredential false and connected empty; after seeding hasCredential true, connected and defaultSelection correct, variants resolvable, no secret leak", async () => {
    seedGlobalAgents()
    seedProjectProvider(45659)
    const service = createService()
    await service.initialize()

    // Before seeding: materialized but no credential — provider not connected.
    let snap = service.fixtureStateSnapshot()
    expect(snap.materializationReady).toBe(true)
    expect(snap.providerIndex?.entries.find((e) => e.id === "e2e-local")?.hasCredential).toBe(false)
    expect(snap.providerIndex?.connected).toEqual([])
    expect(snap.defaultModel).toBe("e2e-local/e2e-model")
    expect(snap.defaultSelection).toEqual({ providerID: "e2e-local", modelID: "e2e-model" })
    // Variant list is present even before credential (model shape independent of credential).
    expect(service.providerIndex?.providers[0]?.modelIds).toContain("e2e-model")

    const result = await service.seedFixtureProviderCredential("e2e-local", "e2e-fixture-key")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`seed failed: ${result.reason}`)
    expect(result.hasCredential).toBe(true)
    expect(result.connected).toContain("e2e-local")
    expect(result.defaultModel).toBe("e2e-local/e2e-model")
    expect(result.defaultSelection).toEqual({ providerID: "e2e-local", modelID: "e2e-model" })
    // Never leaks the secret value.
    expect(JSON.stringify(result)).not.toContain("e2e-fixture-key")

    snap = service.fixtureStateSnapshot()
    expect(snap.materializationReady).toBe(true)
    expect(snap.providerIndex?.entries.find((e) => e.id === "e2e-local")?.hasCredential).toBe(true)
    expect(snap.providerIndex?.connected).toContain("e2e-local")
    expect(snap.defaultModel).toBe("e2e-local/e2e-model")
    expect(snap.defaultSelection).toEqual({ providerID: "e2e-local", modelID: "e2e-model" })
    expect(JSON.stringify(snap)).not.toContain("e2e-fixture-key")

    // Variant list can resolve — the seeded model carries low/medium/high variants.
    const provRecord = (service.snapshot!.config.value.provider as Record<string, Record<string, unknown>>)["e2e-local"]! as Record<string, Record<string, unknown>>
    const modelRec = (provRecord.models as Record<string, Record<string, unknown>>)["e2e-model"]!
    expect(Object.keys(modelRec.variants as Record<string, unknown>)).toEqual(expect.arrayContaining(["low", "medium", "high"]))

    service.dispose()
  })

  it("is fixture-gated and does not leak value", async () => {
    seedGlobalAgents()
    seedProjectProvider(45659)
    const service = createService()
    await service.initialize()
    delete process.env.KILO_E2E_FIXTURE
    await expect(service.seedFixtureProviderCredential()).rejects.toThrow(/requires KILO_E2E_FIXTURE/)
    expect(() => service.fixtureStateSnapshot()).toThrow(/requires KILO_E2E_FIXTURE/)
    // Restore for afterEach cleanup assertion and dispose
    process.env.KILO_E2E_FIXTURE = "1"
    service.dispose()
  })
})

describe("seedFixtureProviderCredential cold-start bounded wait", () => {
  it("waits boundedly for project hash when initially null then converges (cold start race)", async () => {
    seedGlobalAgents()
    seedProjectProvider(45659)
    const service = createService()
    // Cold start: on-disk kilo.jsonc present but service not yet materialized — hash is null and not ready
    expect(service.getConfigHash("project")).toBeNull()
    expect(service.materializationReady).toBe(false)
    const start = Date.now()
    // Start seeding before materialization (mimics extension.ts fire-and-forget initialize + runner seeding)
    const seedPromise = service.seedFixtureProviderCredential("e2e-local", "e2e-fixture-key")
    // Delay initial materialization like the real fire-and-forget window
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    const initPromise = service.initialize()
    const result = await seedPromise
    await initPromise
    const elapsed = Date.now() - start
    // Proves bounded wait: without the wait fix this would have failed with "no project config hash"
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`seed failed: ${result.reason}`)
    expect(result.connected).toContain("e2e-local")
    expect(result.defaultModel).toBe("e2e-local/e2e-model")
    // Bounded wait occurred — not immediate failure and not an arbitrary long sleep (50ms cadence, 10s max)
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(5000)
    // Ordering preserved: secret stored, then identity rewrite converged, no plaintext leak
    expect(JSON.stringify(result)).not.toContain("e2e-fixture-key")
    const snap = service.fixtureStateSnapshot()
    expect(snap.providerIndex?.entries.find((e) => e.id === "e2e-local")?.hasCredential).toBe(true)
    service.dispose()
  })

  it("remains fast when initial materialization already completed", async () => {
    seedGlobalAgents()
    seedProjectProvider(45659)
    const service = createService()
    await service.initialize()
    expect(service.getConfigHash("project")).not.toBeNull()
    expect(service.materializationReady).toBe(true)
    const start = Date.now()
    const result = await service.seedFixtureProviderCredential("e2e-local", "e2e-fixture-key")
    const elapsed = Date.now() - start
    expect(result.ok).toBe(true)
    // Fast path — no bounded wait when hash already present
    expect(elapsed).toBeLessThan(2000)
    service.dispose()
  })

  it("fails precisely when project config hash never appears (missing config) — never synthesizes", async () => {
    seedGlobalAgents()
    // Do not seed project provider — project kilo.jsonc absent (genuine missing)
    const service = createService()
    await service.initialize()
    expect(service.getConfigHash("project")).toBeNull()
    expect(service.materializationReady).toBe(true)
    const start = Date.now()
    const result = await service.seedFixtureProviderCredential("e2e-local", "e2e-fixture-key")
    const elapsed = Date.now() - start
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("should have failed")
    expect(result.reason).toContain("no project config hash")
    // Never synthesizes hash or overwrites user data — file still absent, hash still null
    expect(service.getConfigHash("project")).toBeNull()
    expect(fs.existsSync(path.join(projectRoot, ".kilo", "kilo.jsonc"))).toBe(false)
    // Precise failure is bounded/cancellable — with readiness already true the missing case fails quickly, not after 10s
    expect(elapsed).toBeLessThan(2000)
    service.dispose()
  })

  it("cancels bounded hash wait on disposal", async () => {
    seedGlobalAgents()
    seedProjectProvider(45659)
    const service = createService()
    // Hash is null and not ready — seed will enter bounded poll
    expect(service.getConfigHash("project")).toBeNull()
    const promise = service.seedFixtureProviderCredential("e2e-local", "e2e-fixture-key")
    // Dispose before hash can appear — wait must be cancellable/clear
    setTimeout(() => service.dispose(), 60)
    const result = await promise
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("should have been disposed")
    expect(result.reason).toContain("disposed")
  })
})
