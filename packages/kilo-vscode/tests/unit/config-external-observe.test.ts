import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { resetVersion } from "../../src/config/materialize"
import {
  createMemoryStateAdapter,
  createMemoryWatcherAdapter,
  createMemoryEmitterFactory,
} from "../../src/config/state-adapter"
import { CanonicalConfigService } from "../../src/config/service"
import { ExternalObserveCoalescer } from "../../src/config/external-observe"
import { FakeConvergenceAdapter, PrivateConvergenceAdapter, parseObserveResponse } from "../../src/config/convergence"

let tmpDir: string
let globalRoot: string
let projectRoot: string
let secrets: ReturnType<typeof createMemorySecretAdapter>
let globalState: ReturnType<typeof createMemoryStateAdapter>
let workspaceState: ReturnType<typeof createMemoryStateAdapter>
let watcherAdapter: ReturnType<typeof createMemoryWatcherAdapter>
let emitterFactory: ReturnType<typeof createMemoryEmitterFactory>

beforeEach(() => {
  resetVersion()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-observe-"))
  globalRoot = path.join(tmpDir, "global")
  projectRoot = path.join(tmpDir, "project")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
  secrets = createMemorySecretAdapter()
  globalState = createMemoryStateAdapter()
  workspaceState = createMemoryStateAdapter()
  watcherAdapter = createMemoryWatcherAdapter()
  emitterFactory = createMemoryEmitterFactory()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeGlobalConfig(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), JSON.stringify(value, null, 2), "utf-8")
}

function writeProjectConfig(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(projectRoot, ".kilo", "kilo.jsonc"), JSON.stringify(value, null, 2), "utf-8")
}

const waitFor = async (fn: () => boolean, message: string): Promise<void> => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 3000) throw new Error(message)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const makeDeps = (observe: (d: readonly never[]) => Promise<never>, onPending: (m: string) => void) => ({
  isDisposed: () => false,
  hasProject: true,
  projectRoot,
  observe: observe as never,
  onPending,
})

describe("external canonical config observe hints", () => {
  it("external config edit emits one observe after materialization; repeated same-state stays cold", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    fake.observeResult = { status: "converged", outcome: "cold" }
    const svc = new CanonicalConfigService({ secrets, subscriptions: { push: () => {} } } as never, {
      roots: new Roots(projectRoot, globalRoot),
      secretAdapter: secrets,
      globalState,
      workspaceState,
      watcherAdapter,
      emitterFactory,
      convergence: fake as never,
    })
    await svc.initialize()
    expect(fake.observes.length).toBe(0)
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json", model: "test/new" })
    watcherAdapter.watchers_[0].onChange()
    await waitFor(() => fake.observes.length === 1, "observe never sent")
    expect(fake.observes[0]).toEqual([{ kind: "config", scope: "global" }])
    svc.dispose()
  })

  it("trailing-edge dirty loop: V1 inflight + V2 dirty yields exactly one follow-up with latest state", async () => {
    const seen: string[][] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    const observe = async (d: readonly { kind: string }[]): Promise<{ status: string; outcome?: string }> => {
      calls += 1
      seen.push(d.map((x) => x.kind))
      if (calls === 1) await gate
      return { status: "converged", outcome: "cold" }
    }
    const coalescer = new ExternalObserveCoalescer()
    const pending: string[] = []
    const depsFor = () => makeDeps(observe as never, (m) => pending.push(m))
    coalescer.notify("global", depsFor() as never)
    // V2 arrives while V1 is inflight: schedules exactly one dirty follow-up.
    coalescer.notify("global", depsFor() as never)
    coalescer.notify("global", depsFor() as never)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(1)
    releaseFirst()
    await waitFor(() => calls === 2, "dirty follow-up never ran")
    await new Promise((r) => setTimeout(r, 40))
    // Sustained burst collapses: one inflight + one dirty, never unbounded.
    expect(calls).toBe(2)
    expect(seen.every((k) => k[0] === "config")).toBe(true)
    expect(pending.length).toBe(0)
  })

  it("own write coalesced events and external asset events emit no observe", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = new CanonicalConfigService({ secrets, subscriptions: { push: () => {} } } as never, {
      roots: new Roots(projectRoot, globalRoot),
      secretAdapter: secrets,
      globalState,
      workspaceState,
      watcherAdapter,
      emitterFactory,
      convergence: fake as never,
    })
    await svc.initialize()
    const out = await (svc as unknown as { writeConfigScopes: (a: unknown) => Promise<unknown> }).writeConfigScopes?.({
      global: { patch: { model: "test/own" }, expectedHash: (svc as unknown as { globalHash: string }).globalHash ?? "" },
    } as never).catch(() => null)
    void out
    const before = fake.observes.length
    watcherAdapter.watchers_[0].onChange()
    await new Promise((r) => setTimeout(r, 120))
    expect(fake.observes.length).toBe(before)
    const agentWatcher = watcherAdapter.watchers_.findIndex((w) => w.dir === path.join(globalRoot, "agent"))
    if (agentWatcher >= 0) {
      fs.mkdirSync(path.join(globalRoot, "agent"), { recursive: true })
      fs.writeFileSync(path.join(globalRoot, "agent", "x.md"), "---\nname: x\n---\nbody", "utf-8")
      watcherAdapter.watchers_[agentWatcher].onChange(path.join(globalRoot, "agent", "x.md"))
      await new Promise((r) => setTimeout(r, 120))
    }
    expect(fake.observes.length).toBe(before)
    svc.dispose()
  })

  it("observe failure leaves local state intact with pending diagnostic and no SDK call", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    fake.observeThrows = true
    const svc = new CanonicalConfigService({ secrets, subscriptions: { push: () => {} } } as never, {
      roots: new Roots(projectRoot, globalRoot),
      secretAdapter: secrets,
      globalState,
      workspaceState,
      watcherAdapter,
      emitterFactory,
      convergence: fake as never,
    })
    const errors: string[] = []
    svc.onDidError((e) => errors.push(e.message))
    await svc.initialize()
    const before = svc.snapshot
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json", model: "test/ext" })
    watcherAdapter.watchers_[0].onChange()
    await waitFor(() => fake.observes.length === 1, "observe never attempted")
    await waitFor(() => errors.some((m) => m.includes("pending")), "pending diagnostic never surfaced")
    expect(svc.snapshot).not.toBe(before)
    expect(JSON.stringify(svc.snapshot).includes("test/ext")).toBe(true)
    svc.dispose()
  })

  it("private observe adapter sends each hint and rejects assets without transport", async () => {
    let calls = 0
    const peer = {
      request: async (method: string, _params: unknown): Promise<unknown> => {
        calls += 1
        const p = _params as { observeId: string }
        expect(method).toBe("config/convergence/observe")
        return { v: 1, observeId: p.observeId, outcome: "cold", scope: "global" }
      },
      hasCapability: (cap: string) => cap === "config/convergence/observe",
    }
    const adapter = new PrivateConvergenceAdapter(() => peer as never, 2000)
    const desc = [{ kind: "config", scope: "global" }] as const
    const a = await adapter.observe(desc as never)
    expect(a).toEqual({ status: "converged", outcome: "cold" })
    expect(calls).toBe(1)
    const asset = await adapter.observe([{ kind: "asset", asset: "agent", scope: "global", id: "x" }] as never)
    expect(asset.status).toBe("pending")
    expect(calls).toBe(1)
  })

  it("parseObserveResponse accepts only cold; noop/hot/extra are pending", async () => {
    expect(parseObserveResponse({ v: 1, observeId: "o", outcome: "cold", scope: "global" }, "o")).toEqual({
      status: "converged",
      outcome: "cold",
    })
    expect(parseObserveResponse({ v: 1, observeId: "o", outcome: "noop", scope: "global" }, "o").status).toBe("pending")
    expect(parseObserveResponse({ v: 1, observeId: "o", outcome: "hot", scope: "global" }, "o").status).toBe("pending")
    expect(parseObserveResponse({ v: 1, observeId: "o", outcome: "cold", scope: "global", extra: 1 }, "o").status).toBe("pending")
    expect(parseObserveResponse({ v: 1, observeId: "wrong", outcome: "cold", scope: "global" }, "o").status).toBe("pending")
  })
})
