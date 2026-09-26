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
import { PrivateConvergenceAdapter } from "../../src/config/convergence"

const waitFor = async (fn: () => boolean, message: string): Promise<void> => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 5000) throw new Error(message)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Mode = "throw" | "cold" | "failed"

function makePeer(state: { mode: Mode; calls: number }) {
  return {
    request: async (_method: string, params: unknown) => {
      state.calls += 1
      if (state.mode === "throw") throw new Error("transport loss")
      const p = params as { observeId: string }
      if (state.mode === "failed")
        return { v: 1, observeId: p.observeId, outcome: "failed", scope: "global", reason: "boom", retryable: true }
      return { v: 1, observeId: p.observeId, outcome: "cold", scope: "global" }
    },
    hasCapability: () => true,
  }
}

describe("external observe eventual reconcile (two throws -> recovery -> cold)", () => {
  it("coalescer parks two-throw batch with no hot loop; reconcile delivers cold once", async () => {
    const state = { mode: "throw" as Mode, calls: 0 }
    const adapter = new PrivateConvergenceAdapter(() => makePeer(state) as never, 200)
    const coalescer = new ExternalObserveCoalescer()
    const pending: string[] = []
    const deps = {
      isDisposed: () => false,
      hasProject: true,
      projectRoot: "/tmp/proj",
      observe: adapter.observe.bind(adapter) as never,
      onPending: (m: string) => pending.push(m),
    }
    coalescer.notify("global", deps as never, [{ kind: "config", scope: "global" }] as never)
    await waitFor(() => pending.length === 1, "pending diagnostic never surfaced")
    expect(state.calls).toBe(2)
    expect(coalescer.hasPending()).toBe(true)
    await sleep(90)
    expect(state.calls).toBe(2)
    expect(pending.length).toBe(1)
    state.mode = "cold"
    coalescer.reconcile()
    await waitFor(() => state.calls === 3, "reconciled redelivery never ran")
    await sleep(60)
    expect(state.calls).toBe(3)
    expect(pending.length).toBe(1)
    expect(coalescer.hasPending()).toBe(false)
    coalescer.notify("global", deps as never, [{ kind: "config", scope: "global" }] as never)
    await waitFor(() => state.calls === 4, "duplicate redelivery never ran")
    await sleep(60)
    expect(state.calls).toBe(4)
    expect(coalescer.hasPending()).toBe(false)
    coalescer.dispose()
    coalescer.reconcile()
    await sleep(40)
    expect(state.calls).toBe(4)
  })

  it("parsed pending parks without retry; reconcile delivers cold once", async () => {
    const state = { mode: "failed" as Mode, calls: 0 }
    const adapter = new PrivateConvergenceAdapter(() => makePeer(state) as never, 200)
    const coalescer = new ExternalObserveCoalescer()
    const pending: string[] = []
    const deps = {
      isDisposed: () => false,
      hasProject: true,
      projectRoot: "/tmp/proj",
      observe: adapter.observe.bind(adapter) as never,
      onPending: (m: string) => pending.push(m),
    }
    coalescer.notify("global", deps as never, [{ kind: "config", scope: "global" }] as never)
    await waitFor(() => pending.length === 1, "parsed-pending diagnostic never surfaced")
    expect(state.calls).toBe(1)
    expect(coalescer.hasPending()).toBe(true)
    await sleep(60)
    expect(state.calls).toBe(1)
    state.mode = "cold"
    coalescer.reconcile()
    await waitFor(() => state.calls === 2, "reconciled cold never ran")
    await sleep(50)
    expect(state.calls).toBe(2)
    expect(pending.length).toBe(1)
    expect(coalescer.hasPending()).toBe(false)
    coalescer.dispose()
  })
})

describe("service next-read eventual reconcile (real implementation)", () => {
  let tmpDir: string
  let globalRoot: string
  let projectRoot: string

  beforeEach(() => {
    resetVersion()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-reconcile-"))
    globalRoot = path.join(tmpDir, "global")
    projectRoot = path.join(tmpDir, "project")
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("external edit snapshot updates while observe throws twice; next read after recovery converges cold with no loop", async () => {
    fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }), "utf-8")
    fs.writeFileSync(path.join(projectRoot, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }), "utf-8")
    const state = { mode: "throw" as Mode, calls: 0 }
    const adapter = new PrivateConvergenceAdapter(() => makePeer(state) as never, 300)
    const secrets = createMemorySecretAdapter()
    const watcherAdapter = createMemoryWatcherAdapter()
    const svc = new CanonicalConfigService({ secrets, subscriptions: { push: () => {} } } as never, {
      roots: new Roots(projectRoot, globalRoot),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
      watcherAdapter,
      emitterFactory: createMemoryEmitterFactory(),
      convergence: adapter as never,
    })
    const errors: string[] = []
    svc.onDidError((e) => errors.push(e.message))
    await svc.initialize()
    expect(state.calls).toBe(0)
    fs.writeFileSync(
      path.join(globalRoot, "kilo.jsonc"),
      JSON.stringify({ $schema: "https://app.kilo.ai/config.json", model: "test/ext" }),
      "utf-8",
    )
    watcherAdapter.watchers_[0].onChange()
    await waitFor(() => errors.some((m) => m.includes("pending")), "pending diagnostic never surfaced")
    expect(state.calls).toBe(2)
    expect(JSON.stringify(svc.snapshot).includes("test/ext")).toBe(true)
    const settled = state.calls
    await sleep(100)
    expect(state.calls).toBe(settled)
    state.mode = "cold"
    svc.getScopeConfig("global")
    await waitFor(() => state.calls === settled + 1, "next-read redelivery never ran")
    await sleep(80)
    expect(state.calls).toBe(settled + 1)
    expect(JSON.stringify(svc.snapshot).includes("test/ext")).toBe(true)
    svc.getScopeConfig("global")
    svc.getScopeConfig("project")
    svc.reconcileExternalObserve()
    await sleep(80)
    expect(state.calls).toBe(settled + 1)
    svc.dispose()
    svc.reconcileExternalObserve()
    await sleep(40)
    expect(state.calls).toBe(settled + 1)
  })
})
