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
import { PrivateConvergenceAdapter } from "../../src/config/convergence"
import { withFence } from "../../src/config/convergence-guard"

const MODEL_A = "anthropic/claude-sonnet-4-20250514"
const MODEL_B = "openai/gpt-4o"

let tmpDir = ""
let globalRoot = ""
let projectRoot = ""

beforeEach(() => {
  resetVersion()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-prod-"))
  globalRoot = path.join(tmpDir, "global")
  projectRoot = path.join(tmpDir, "project")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
  fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), JSON.stringify({ model: MODEL_A }), "utf8")
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function setup(adapter: unknown): CanonicalConfigService {
  const secrets = createMemorySecretAdapter()
  const context = { secrets, subscriptions: { push: () => {} } } as never
  return new CanonicalConfigService(context, {
    roots: new Roots(projectRoot, globalRoot),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
    watcherAdapter: createMemoryWatcherAdapter(),
    emitterFactory: createMemoryEmitterFactory(),
    convergence: adapter as never,
  })
}

describe("production convergence adapter (fail-closed, pending, no rewrite)", () => {
  test("capability missing blocks write with zero bytes changed", async () => {
    const peer = { request: async () => ({ v: 1 }), hasCapability: () => false }
    const adapter = new PrivateConvergenceAdapter(() => peer, 50)
    const svc = setup(adapter)
    await svc.initialize()
    const before = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    const out = await svc.writeConfig("global", { model: MODEL_B }, svc.getConfigHash("global")!)
    expect(out.ok).toBe(false)
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")).toBe(before)
    svc.dispose()
  })

  test("acquire timeout blocks write with zero bytes changed", async () => {
    const peer = {
      request: async () => new Promise(() => {}),
      hasCapability: () => true,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer, 20)
    const svc = setup(adapter)
    await svc.initialize()
    const before = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    const out = await svc.writeConfig("global", { model: MODEL_B }, svc.getConfigHash("global")!)
    expect(out.ok).toBe(false)
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")).toBe(before)
    svc.dispose()
  })

  test("resolve response loss still acks persisted write with pending diagnostic and no rewrite", async () => {
    let writes = 0
    const peer = {
      request: async (method: string, params: unknown) => {
        if (method === "config/convergence/acquire")
          return { v: 1, leaseId: (params as { leaseId: string }).leaseId, acquired: true }
        writes += 1
        throw new Error("transport loss after persist")
      },
      hasCapability: () => true,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer, 50)
    const svc = setup(adapter)
    await svc.initialize()
    const out = await svc.writeConfig("global", { model: MODEL_B }, svc.getConfigHash("global")!)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.convergence?.status).toBe("pending")
      expect(JSON.stringify(out)).toContain("pending")
    }
    const persisted = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    expect(persisted).toContain(MODEL_B)
    expect(writes).toBe(1)
    const afterResolve = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    expect(afterResolve).toBe(persisted)
    svc.dispose()
  })

  test("resolve ambiguous outcome is pending and never rewrites", async () => {
    const peer = {
      request: async (method: string) => {
        if (method === "config/convergence/acquire") return { v: 1, acquired: true }
        return { v: 1, outcome: "mystery" }
      },
      hasCapability: () => true,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer, 50)
    const resolved = await adapter.resolve("lease-1")
    expect(resolved.status).toBe("pending")
  })

  test("epoch change between acquire and resolve is pending without fallback", async () => {
    let epoch = 1
    const peer = {
      request: async (method: string, params: unknown) => {
        const id = (params as { leaseId: string }).leaseId
        if (method === "config/convergence/acquire") return { v: 1, leaseId: id, acquired: true }
        return { v: 1, leaseId: id, outcome: "cold", scope: "global" }
      },
      hasCapability: () => true,
      getEpoch: () => epoch,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer, 50)
    const acquired = await adapter.acquire([{ kind: "config", scope: "global" }])
    expect(acquired.ok).toBe(true)
    epoch = 2
    if (acquired.ok) {
      const state = await adapter.resolve(acquired.leaseId)
      expect(state.status).toBe("pending")
    }
  })

  test("resolve uses the captured peer, never the replacement (F11)", async () => {
    const callsA: string[] = []
    const callsB: string[] = []
    const peerA = {
      request: async (method: string, params: unknown) => {
        callsA.push(method)
        const id = (params as { leaseId: string }).leaseId
        if (method === "config/convergence/acquire") return { v: 1, leaseId: id, acquired: true }
        return { v: 1, leaseId: id, outcome: "cold", scope: "global" }
      },
      hasCapability: () => true,
      getEpoch: () => 1,
    }
    const peerB = {
      request: async (method: string, params: unknown) => {
        callsB.push(method)
        const id = (params as { leaseId: string }).leaseId
        return { v: 1, leaseId: id, outcome: "cold", scope: "global" }
      },
      hasCapability: () => true,
      getEpoch: () => 1,
    }
    let current: unknown = peerA
    const adapter = new PrivateConvergenceAdapter(() => current as never, 50)
    const acquired = await adapter.acquire([{ kind: "config", scope: "global" }])
    expect(acquired.ok).toBe(true)
    // Runtime replaced after persist: the new runtime must not serve this lease.
    current = peerB
    if (acquired.ok) {
      const state = await adapter.resolve(acquired.leaseId)
      expect(state.status).toBe("pending")
    }
    expect(callsA).toEqual(["config/convergence/acquire"])
    expect(callsB).toEqual([])
  })

  test("backend resolved replay fails the acquire closed (F3, production adapter)", async () => {
    const peer = {
      request: async (method: string, params: unknown) => {
        const id = (params as { leaseId: string }).leaseId
        if (method === "config/convergence/acquire")
          return { v: 1, leaseId: id, resolved: true, outcome: "noop", scope: "global" }
        return { v: 1, leaseId: id, outcome: "noop", scope: "global" }
      },
      hasCapability: () => true,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer, 50)
    const svc = setup(adapter)
    await svc.initialize()
    const before = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    const out = await svc.writeConfig("global", { model: MODEL_B }, svc.getConfigHash("global")!)
    expect(out.ok).toBe(false)
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")).toBe(before)
    svc.dispose()
  })

  test("withFence resolve throw still returns persisted ok with pending (guard-level)", async () => {
    const adapter = {
      acquire: async () => ({ ok: true as const, leaseId: "l1" }),
      resolve: async () => {
        throw new Error("loss")
      },
    }
    const before = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")
    void before
    const out = await withFence(
      adapter,
      [{ kind: "config", scope: "global" }],
      async () => {
        fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), JSON.stringify({ model: MODEL_B }), "utf8")
        return { ok: true as const }
      },
      (message) => ({ ok: false as const, message }),
    )
    expect(out.ok).toBe(true)
    expect(out.convergence?.status).toBe("pending")
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf8")).toContain(MODEL_B)
  })
})
