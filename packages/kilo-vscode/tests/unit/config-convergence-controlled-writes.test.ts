import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { resetVersion } from "../../src/config/materialize"
import {
  createMemoryStateAdapter,
  createMemoryWatcherAdapter,
  createMemoryEmitterFactory,
} from "../../src/config/state-adapter"
import { FakeConvergenceAdapter, PrivateConvergenceAdapter } from "../../src/config/convergence"

const MODEL_A = "anthropic/claude-sonnet-4-20250514"
const MODEL_B = "openai/gpt-4o"

let tmpDir = ""
let globalRoot = ""
let projectRoot = ""

beforeEach(() => {
  resetVersion()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-controlled-"))
  globalRoot = path.join(tmpDir, "global")
  projectRoot = path.join(tmpDir, "project")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
  fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), JSON.stringify({ model: MODEL_A }), "utf8")
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function setup(convergence?: FakeConvergenceAdapter): CanonicalConfigService {
  return setupWithSecrets(convergence).svc
}

function setupWithSecrets(convergence?: FakeConvergenceAdapter): {
  svc: CanonicalConfigService
  secrets: ReturnType<typeof createMemorySecretAdapter>
} {
  const secrets = createMemorySecretAdapter()
  const context = { secrets, subscriptions: { push: () => {} } } as never
  const svc = new CanonicalConfigService(context, {
    roots: new Roots(projectRoot, globalRoot),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
    watcherAdapter: createMemoryWatcherAdapter(),
    emitterFactory: createMemoryEmitterFactory(),
    convergence: convergence as never,
  })
  return { svc, secrets }
}

describe("controlled GUI writes with convergence fence", () => {
  test("acquire before atomic write and resolve once on success", async () => {
    const fake = new FakeConvergenceAdapter()
    fake.resolveResult = { status: "converged", outcome: "hot" }
    const svc = setup(fake)
    await svc.initialize()
    const hash = svc.getConfigHash("global")!
    const out = await svc.writeConfig("global", { model: MODEL_B }, hash)
    expect(out.ok).toBe(true)
    expect(fake.acquires.length).toBe(1)
    expect(fake.acquires[0]![0]).toMatchObject({ kind: "config", scope: "global" })
    expect(fake.resolves.length).toBe(1)
    if (out.ok) expect(out.convergence).toMatchObject({ status: "converged" })
    svc.dispose()
  })

  test("acquire failure blocks write with zero disk bytes changed", async () => {
    const fake = new FakeConvergenceAdapter()
    fake.acquireResult = { ok: false, kind: "unavailable", message: "down" }
    const svc = setup(fake)
    await svc.initialize()
    const before = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    const hash = svc.getConfigHash("global")!
    const out = await svc.writeConfig("global", { model: MODEL_B }, hash)
    expect(out.ok).toBe(false)
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")).toBe(before)
    expect(fake.resolves.length).toBe(0)
    svc.dispose()
  })

  test("resolve pending still acks persisted write with diagnostic", async () => {
    const fake = new FakeConvergenceAdapter()
    fake.resolveResult = { status: "pending", message: "runtime convergence pending" }
    const svc = setup(fake)
    await svc.initialize()
    const hash = svc.getConfigHash("global")!
    const out = await svc.writeConfig("global", { model: MODEL_B }, hash)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.convergence?.status).toBe("pending")
      expect(JSON.stringify(out)).not.toContain("runtime ready")
    }
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")).toContain(MODEL_B)
    svc.dispose()
  })

  test("composite descriptors cover both scopes in one lease; asset write fenced", async () => {
    const fake = new FakeConvergenceAdapter()
    const svc = setup(fake)
    await svc.initialize()
    const stamp = svc.stamp
    const out = await svc.writeConfigScopes(
      {
        global: { patch: { model: MODEL_B }, expectedHash: svc.getConfigHash("global")! },
        project: { patch: { default_agent: "code" }, expectedHash: svc.getConfigHash("project") ?? "absent" },
      },
      stamp,
    )
    expect(out.ok).toBe(true)
    expect(fake.acquires.length).toBe(1)
    expect(fake.acquires[0]!.length).toBe(2)
    const asset = await svc.writeAsset("agent", "helper", { name: "Helper" }, "body", "global", "absent")
    expect(asset.ok).toBe(true)
    expect(fake.acquires.length).toBe(2)
    expect(fake.acquires[1]![0]).toMatchObject({ kind: "asset", asset: "agent", scope: "global" })
    const contentHash = asset.ok ? asset.contentHash : "absent"
    const del = await svc.deleteAsset("agent", "helper", "global", contentHash)
    expect(del.ok).toBe(true)
    expect(fake.acquires.length).toBe(3)
    svc.dispose()
  })

  test("production adapter capability missing blocks write; resolve ambiguity never rewrites", async () => {
    const peer = { request: async () => ({ v: 1, unexpected: true }), hasCapability: () => false }
    const adapter = new PrivateConvergenceAdapter(() => peer, 50)
    const acquired = await adapter.acquire([{ kind: "config", scope: "global" }])
    expect(acquired.ok).toBe(false)
    const peer2 = {
      request: async (method: string, params: unknown) => {
        const id = (params as { leaseId: string }).leaseId
        if (method === "config/convergence/acquire") return { v: 1, leaseId: id, acquired: true }
        return { v: 1, leaseId: id, outcome: "mystery", scope: "global" }
      },
      hasCapability: () => true,
    }
    const adapter2 = new PrivateConvergenceAdapter(() => peer2, 50)
    const acquired2 = await adapter2.acquire([{ kind: "config", scope: "global" }])
    expect(acquired2.ok).toBe(true)
    if (acquired2.ok) {
      const state = await adapter2.resolve(acquired2.leaseId)
      expect(state.status).toBe("pending")
    }
  })

  test("resolved acquire replay fails closed with zero disk bytes (F3)", async () => {
    const fake = new FakeConvergenceAdapter()
    fake.acquireResult = { ok: false, kind: "resolved", message: "lease already resolved (noop); write blocked" }
    const svc = setup(fake)
    await svc.initialize()
    const before = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    const out = await svc.writeConfig("global", { model: MODEL_B }, svc.getConfigHash("global")!)
    expect(out.ok).toBe(false)
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")).toBe(before)
    expect(fake.resolves.length).toBe(0)
    svc.dispose()
  })

  test("acquire wire parser distinguishes acquired vs resolved (F3/F-05 strict)", async () => {
    const { parseAcquireResponse, parseResolveResponse } = await import("../../src/config/convergence")
    expect(parseAcquireResponse({ v: 1, leaseId: "l1", acquired: true }, "l1")).toEqual({ ok: true, leaseId: "l1" })
    const resolved = parseAcquireResponse(
      { v: 1, leaseId: "l1", resolved: true, outcome: "noop", scope: "global" },
      "l1",
    )
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.kind).toBe("resolved")
    const malformed = parseAcquireResponse({ v: 1 }, "l1")
    expect(malformed.ok).toBe(false)
    expect(parseAcquireResponse({ v: 1, leaseId: "l1", acquired: true, extra: 1 }, "l1").ok).toBe(false)
    expect(parseAcquireResponse({ v: 1, leaseId: "other", acquired: true }, "l1").ok).toBe(false)
    expect(parseAcquireResponse({ v: 2, leaseId: "l1", acquired: true }, "l1").ok).toBe(false)
    const failedAcquire = parseAcquireResponse(
      { v: 1, leaseId: "l1", resolved: true, outcome: "failed", scope: "global", reason: "cold commit failed", retryable: true },
      "l1",
    )
    expect(failedAcquire.ok).toBe(false)
    if (!failedAcquire.ok) expect(failedAcquire.kind).toBe("resolved")
    expect(parseResolveResponse({ v: 1, leaseId: "l1", outcome: "cold", scope: "global" }, "l1")).toEqual({
      status: "converged",
      outcome: "cold",
    })
    const failedResolve = parseResolveResponse(
      { v: 1, leaseId: "l1", outcome: "failed", scope: "global", reason: "cold commit failed", retryable: true },
      "l1",
    )
    expect(failedResolve.status).toBe("pending")
    expect(parseResolveResponse({ v: 1, leaseId: "l1", outcome: "cold", scope: "global", extra: 1 }, "l1").status).toBe(
      "pending",
    )
    expect(parseResolveResponse({ v: 1, leaseId: "other", outcome: "cold", scope: "global" }, "l1").status).toBe("pending")
  })
})

describe("withFence settlement guarantees (F1)", () => {
  test("run throw still resolves exactly once and rethrows the original", async () => {
    const { withFence } = await import("../../src/config/convergence-guard")
    const fake = new FakeConvergenceAdapter()
    const boom = new Error("disk exploded")
    let caught: unknown
    try {
      await withFence(fake, [{ kind: "config", scope: "global" }], async () => {
        throw boom
      }, (message) => ({ ok: false as const, message }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(boom)
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves).toEqual(["fake-lease"])
  })

  test("run abort-rejection still resolves exactly once and propagates", async () => {
    const { withFence } = await import("../../src/config/convergence-guard")
    const fake = new FakeConvergenceAdapter()
    const abort = new DOMException("aborted", "AbortError")
    await expect(
      withFence(fake, [{ kind: "config", scope: "global" }], async () => Promise.reject(abort), (message) => ({
        ok: false as const,
        message,
      })),
    ).rejects.toBe(abort)
    expect(fake.resolves.length).toBe(1)
  })

  test("resolve loss never masks the original run failure", async () => {
    const { withFence } = await import("../../src/config/convergence-guard")
    const fake = new FakeConvergenceAdapter()
    fake.resolveThrows = true
    const boom = new Error("run failed")
    let caught: unknown
    try {
      await withFence(fake, [{ kind: "config", scope: "global" }], async () => {
        throw boom
      }, (message) => ({ ok: false as const, message }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(boom)
    expect(fake.resolves.length).toBe(1)
  })

  test("service write failure still resolves once (invalid patch)", async () => {
    const fake = new FakeConvergenceAdapter()
    const svc = setup(fake)
    await svc.initialize()
    const out = await svc.writeConfig("global", { unknown_key: "bad" } as never, svc.getConfigHash("global")!)
    expect(out.ok).toBe(false)
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves.length).toBe(1)
    svc.dispose()
  })
})

describe("credential intent holds one fence (F9)", () => {
  test("order is acquire -> secret store -> disk write -> resolve", async () => {
    const fake = new FakeConvergenceAdapter()
    const { svc, secrets } = setupWithSecrets(fake)
    await svc.initialize()
    const order: string[] = []
    const origAcquire = fake.acquire.bind(fake)
    fake.acquire = async (d) => {
      order.push("acquire")
      return origAcquire(d)
    }
    const origResolve = fake.resolve.bind(fake)
    fake.resolve = async (id) => {
      order.push("resolve")
      return origResolve(id)
    }
    const origStore = secrets.store.bind(secrets)
    secrets.store = async (k, v) => {
      order.push("secret-store")
      return origStore(k, v)
    }
    const out = await svc.processCredentialIntent("global", "provider", "openai", "sk-new", { model: MODEL_B }, svc.getConfigHash("global")!)
    expect(out.ok).toBe(true)
    expect(order).toEqual(["acquire", "secret-store", "resolve"])
    expect(await secrets.retrieve("kilo.credentials.global.provider.openai")).toBe("sk-new")
    svc.dispose()
  })

  test("acquire failure yields zero secret and zero disk effects", async () => {
    const fake = new FakeConvergenceAdapter()
    fake.acquireResult = { ok: false, kind: "unavailable", message: "down" }
    const { svc, secrets } = setupWithSecrets(fake)
    await svc.initialize()
    let stores = 0
    const origStore = secrets.store.bind(secrets)
    secrets.store = async (k, v) => {
      stores += 1
      return origStore(k, v)
    }
    const before = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    const out = await svc.processCredentialIntent("global", "provider", "openai", "sk-new", { model: MODEL_B }, svc.getConfigHash("global")!)
    expect(out.ok).toBe(false)
    expect(stores).toBe(0)
    expect(secrets.store_.size).toBe(0)
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")).toBe(before)
    expect(fake.resolves.length).toBe(0)
    svc.dispose()
  })

  test("disk failure rolls the secret back inside the fence and still resolves", async () => {
    const fake = new FakeConvergenceAdapter()
    const { svc, secrets } = setupWithSecrets(fake)
    await svc.initialize()
    const out = await svc.processCredentialIntent(
      "global",
      "provider",
      "openai",
      "sk-new",
      { model: MODEL_B, unknown_key: "bad" },
      svc.getConfigHash("global")!,
    )
    expect(out.ok).toBe(false)
    expect(await secrets.retrieve("kilo.credentials.global.provider.openai")).toBeUndefined()
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves.length).toBe(1)
    svc.dispose()
  })

  test("credential-only noop resolves once without replay", async () => {
    const fake = new FakeConvergenceAdapter()
    const { svc, secrets } = setupWithSecrets(fake)
    await svc.initialize()
    const out = await svc.processCredentialIntent("global", "provider", "openai", "sk-new", {}, svc.getConfigHash("global")!)
    expect(out.ok).toBe(true)
    expect(await secrets.retrieve("kilo.credentials.global.provider.openai")).toBe("sk-new")
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves.length).toBe(1)
    svc.dispose()
  })
})
