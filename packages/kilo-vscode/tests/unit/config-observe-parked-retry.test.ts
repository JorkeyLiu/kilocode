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
import { FakeConvergenceAdapter } from "../../src/config/convergence"

const waitFor = async (fn: () => boolean, message: string, timeoutMs = 5000): Promise<void> => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(message)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Deps = {
  isDisposed: () => boolean
  hasProject: boolean
  projectRoot: string
  observe: (d: readonly never[]) => Promise<{ status: string; outcome?: string; message?: string }>
  onPending: (m: string) => void
}

const makeDeps = (
  observe: (d: readonly never[]) => Promise<{ status: string; outcome?: string; message?: string }>,
  pending: string[],
): Deps => ({
  isDisposed: () => false,
  hasProject: true,
  projectRoot: "/tmp/proj",
  observe,
  onPending: (m: string) => pending.push(m),
})

describe("parked observe self-owned bounded retry (real coalescer)", () => {
  it("delayed retry succeeds with no external signal; identical cause dedups diagnostics", async () => {
    let mode: "fail" | "cold" = "fail"
    let calls = 0
    const observe = async (): Promise<{ status: string; outcome?: string; message?: string }> => {
      calls += 1
      if (mode === "fail") return { status: "pending", message: "still down" }
      return { status: "converged", outcome: "cold" }
    }
    const pending: string[] = []
    // 50ms floor keeps CI scheduling headroom (no 30ms exact-window asserts).
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 50, retryMaxMs: 150 })
    coalescer.notify("global", makeDeps(observe as never, pending) as never, [
      { kind: "config", scope: "global" },
    ] as never)
    await waitFor(() => pending.length >= 1, "first pending never surfaced")
    await waitFor(() => calls >= 1, "first attempt never ran")
    expect(coalescer.hasPending()).toBe(true)
    // Still failing: the backoff wakeup must fire again without any explicit
    // signal, but must keep the work parked (no faked success) and must not
    // re-emit the identical diagnostic.
    const firstCalls = calls
    await waitFor(() => calls >= firstCalls + 2, "self-owned retry never fired", 5000)
    expect(coalescer.hasPending()).toBe(true)
    expect(pending.length).toBe(1)
    // Recover: the next backoff wakeup converges with no explicit signal.
    mode = "cold"
    const beforeRecover = calls
    await waitFor(() => calls > beforeRecover, "recovery retry never ran", 5000)
    await waitFor(() => !coalescer.hasPending(), "parked work never converged", 5000)
    // Still exactly one diagnostic: retries stayed silent on identical cause.
    expect(pending.length).toBe(1)
    const settled = calls
    await sleep(250)
    expect(calls).toBe(settled)
    coalescer.dispose()
  })

  it("error change and fresh edit re-emit while identical redelivery stays silent", async () => {
    let message = "cause-A"
    let calls = 0
    const observe = async (): Promise<{ status: string; message?: string }> => {
      calls += 1
      return { status: "pending", message }
    }
    const pending: string[] = []
    // Long backoff parks the timer so this test drives redelivery
    // deterministically via explicit reconcile()/notify() (immediate paths).
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 5000, retryMaxMs: 5000 })
    const deps = () => makeDeps(observe as never, pending)
    const desc = [{ kind: "config", scope: "global" }] as never
    coalescer.notify("global", deps() as never, desc)
    await waitFor(() => calls >= 1, "first attempt never ran")
    await waitFor(() => pending.length >= 1, "first diagnostic never surfaced")
    expect(pending.length).toBe(1)
    // Same descriptors + same cause via explicit redelivery: wire runs again
    // but the diagnostic stays deduped.
    coalescer.reconcile()
    await waitFor(() => calls >= 2, "reconcile redelivery never ran")
    await sleep(80)
    expect(pending.length).toBe(1)
    expect(coalescer.hasPending()).toBe(true)
    // Changed cause emits again on the next attempt.
    message = "cause-B"
    coalescer.reconcile()
    await waitFor(() => calls >= 3, "changed-cause redelivery never ran")
    await waitFor(() => pending.length >= 2, "changed cause never re-emitted")
    expect(pending[1]).toContain("cause-B")
    // Fresh watcher edit with the same cause text emits again (new intent).
    coalescer.notify("global", deps() as never, desc)
    await waitFor(() => calls >= 4, "fresh notify never ran")
    await waitFor(() => pending.length >= 3, "fresh edit never re-emitted")
    coalescer.dispose()
  })

  it("fd unavailable (null peer pending) keeps a capped rate with one diagnostic", async () => {
    let calls = 0
    const observe = async (): Promise<{ status: string; message?: string }> => {
      calls += 1
      return { status: "pending", message: "private transport unavailable; runtime convergence pending" }
    }
    const pending: string[] = []
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 50, retryMaxMs: 150 })
    coalescer.notify("global", makeDeps(observe as never, pending) as never, [
      { kind: "config", scope: "global" },
    ] as never)
    await waitFor(() => pending.length >= 1, "pending never surfaced")
    // Eventual retry without an external signal, but bounded: wait for a few
    // attempts instead of asserting an exact count inside a fixed sleep.
    await waitFor(() => calls >= 3, "bounded retry never fired", 5000)
    expect(coalescer.hasPending()).toBe(true)
    // Identical cause dedups: still a single user-facing diagnostic.
    expect(pending.length).toBe(1)
    // Never a hot loop: well under a per-25ms spin over the observed window.
    const windowStart = calls
    await sleep(300)
    expect(calls - windowStart).toBeLessThanOrEqual(8)
    expect(coalescer.hasPending()).toBe(true)
    expect(pending.length).toBe(1)
    coalescer.dispose()
  })

  it("dispose clears the self-owned timer: no further calls", async () => {
    let calls = 0
    const observe = async (): Promise<{ status: string; message?: string }> => {
      calls += 1
      return { status: "pending", message: "down" }
    }
    const pending: string[] = []
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 50, retryMaxMs: 150 })
    coalescer.notify("global", makeDeps(observe as never, pending) as never, [
      { kind: "config", scope: "global" },
    ] as never)
    await waitFor(() => pending.length >= 1, "pending never surfaced")
    await waitFor(() => calls >= 1, "first attempt never ran")
    coalescer.dispose()
    const settled = calls
    await sleep(300)
    expect(calls).toBe(settled)
    expect(coalescer.hasPending()).toBe(false)
    coalescer.reconcile()
    await sleep(100)
    expect(calls).toBe(settled)
  })

  it("in-flight settle after dispose never revives parked work or the timer", async () => {
    let release!: (v: { status: string; message?: string }) => void
    let calls = 0
    const observe = async (): Promise<{ status: string; message?: string }> => {
      calls += 1
      return new Promise((resolve) => {
        release = resolve as (v: { status: string; message?: string }) => void
      })
    }
    const pending: string[] = []
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 50, retryMaxMs: 150 })
    coalescer.notify("global", makeDeps(observe as never, pending) as never, [
      { kind: "config", scope: "global" },
    ] as never)
    await waitFor(() => calls >= 1, "wire batch never started")
    // Dispose while the wire batch is still in flight, then let it settle as
    // a failure. Settling must not re-park or re-arm.
    coalescer.dispose()
    release({ status: "pending", message: "down" })
    await sleep(120)
    expect(coalescer.hasPending()).toBe(false)
    expect(pending.length).toBe(0)
    const settled = calls
    await sleep(250)
    expect(calls).toBe(settled)
  })

  it("pending timer plus new edit coalesces same keys and keeps distinct ids", async () => {
    let mode: "fail" | "cold" = "fail"
    const batches: string[][] = []
    const observe = async (
      d: readonly { kind: string; id?: string }[],
    ): Promise<{ status: string; outcome?: string; message?: string }> => {
      batches.push(d.map((x) => x.id ?? x.kind))
      if (mode === "fail") return { status: "pending", message: "down" }
      return { status: "converged", outcome: "cold" }
    }
    const pending: string[] = []
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 50, retryMaxMs: 150 })
    const deps = () => makeDeps(observe as never, pending)
    const a = { kind: "asset", asset: "agent", scope: "global", id: "a" } as never
    const b = { kind: "asset", asset: "agent", scope: "global", id: "b" } as never
    coalescer.notify("global", deps() as never, [a] as never)
    await waitFor(() => pending.length >= 1, "first park never surfaced")
    // New edit while the backoff timer is armed: same-key duplicate collapses,
    // distinct id is kept. Immediate kick attempts it (still failing -> parks).
    coalescer.notify("global", deps() as never, [a, b] as never)
    await waitFor(() => batches.length >= 2, "second batch never attempted", 5000)
    // The second batch is briefly inflight (batch removed, not yet re-parked),
    // so wait for it to settle back to parked before asserting.
    await waitFor(() => coalescer.hasPending(), "second park never settled", 5000)
    mode = "cold"
    await waitFor(() => !coalescer.hasPending(), "coalesced work never converged", 5000)
    const flat = batches.flat()
    expect(flat.includes("a")).toBe(true)
    expect(flat.includes("b")).toBe(true)
    // Same-key merge: the final converged delivery never duplicates one id in one batch.
    for (const batch of batches) expect(new Set(batch).size).toBe(batch.length)
    coalescer.dispose()
  })

  it("explicit reconcile while parked with long backoff armed converges immediately", async () => {
    let mode: "fail" | "cold" = "fail"
    let calls = 0
    const observe = async (): Promise<{ status: string; outcome?: string; message?: string }> => {
      calls += 1
      if (mode === "fail") return { status: "pending", message: "still down" }
      return { status: "converged", outcome: "cold" }
    }
    const pending: string[] = []
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 5000, retryMaxMs: 5000 })
    coalescer.notify("global", makeDeps(observe as never, pending) as never, [
      { kind: "config", scope: "global" },
    ] as never)
    await waitFor(() => calls >= 1, "first attempt never ran")
    await waitFor(() => pending.length >= 1, "park diagnostic never surfaced")
    expect(coalescer.hasPending()).toBe(true)
    // Backoff is armed for 5s; flipping to healthy plus an explicit
    // reconcile must converge well before the timer could fire.
    mode = "cold"
    const before = calls
    coalescer.reconcile()
    await waitFor(() => calls > before, "explicit reconcile never ran", 2000)
    await waitFor(() => !coalescer.hasPending(), "explicit reconcile never converged", 2000)
    coalescer.dispose()
  })

  it("fresh notify while parked with long backoff armed sends immediately", async () => {
    let mode: "fail" | "cold" = "fail"
    let calls = 0
    const observe = async (): Promise<{ status: string; outcome?: string; message?: string }> => {
      calls += 1
      if (mode === "fail") return { status: "pending", message: "still down" }
      return { status: "converged", outcome: "cold" }
    }
    const pending: string[] = []
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 5000, retryMaxMs: 5000 })
    const deps = () => makeDeps(observe as never, pending)
    const desc = [{ kind: "config", scope: "global" }] as never
    coalescer.notify("global", deps() as never, desc)
    await waitFor(() => calls >= 1, "first attempt never ran")
    await waitFor(() => pending.length >= 1, "park diagnostic never surfaced")
    expect(coalescer.hasPending()).toBe(true)
    // Fresh watcher evidence promotes the parked descriptor and kicks the
    // pump immediately, without waiting for the armed 5s backoff.
    mode = "cold"
    const before = calls
    coalescer.notify("global", deps() as never, desc)
    await waitFor(() => calls > before, "fresh notify never sent", 2000)
    await waitFor(() => !coalescer.hasPending(), "fresh notify never converged", 2000)
    coalescer.dispose()
  })

  it("explicit ready/read signals stay immediate even with a long backoff armed", async () => {
    let calls = 0
    const observe = async (): Promise<{ status: string; outcome?: string }> => {
      calls += 1
      return { status: "converged", outcome: "cold" }
    }
    const pending: string[] = []
    const coalescer = new ExternalObserveCoalescer({ retryInitialMs: 5000, retryMaxMs: 5000 })
    coalescer.notify("global", makeDeps(observe as never, pending) as never, [
      { kind: "config", scope: "global" },
    ] as never)
    await waitFor(() => calls === 1, "immediate notify never sent")
    expect(pending.length).toBe(0)
    coalescer.dispose()
  })
})

describe("service parked retry without next read/FD signal (real service)", () => {
  let tmpDir: string
  let globalRoot: string
  let projectRoot: string

  beforeEach(() => {
    resetVersion()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parked-retry-"))
    globalRoot = path.join(tmpDir, "global")
    projectRoot = path.join(tmpDir, "project")
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("external edit parks on throw then self-redelivers cold with no getScopeConfig/notifyPrivateReady", async () => {
    fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }), "utf-8")
    fs.writeFileSync(
      path.join(projectRoot, ".kilo", "kilo.jsonc"),
      JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }),
      "utf-8",
    )
    const fake = new FakeConvergenceAdapter()
    fake.observeThrows = true
    const secrets = createMemorySecretAdapter()
    const watcherAdapter = createMemoryWatcherAdapter()
    const svc = new CanonicalConfigService({ secrets, subscriptions: { push: () => {} } } as never, {
      roots: new Roots(projectRoot, globalRoot),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
      watcherAdapter,
      emitterFactory: createMemoryEmitterFactory(),
      convergence: fake as never,
      observeRetry: { retryInitialMs: 50, retryMaxMs: 150 },
    })
    const errors: string[] = []
    svc.onDidError((e) => errors.push(e.message))
    await svc.initialize()
    expect(fake.observes.length).toBe(0)
    fs.writeFileSync(
      path.join(globalRoot, "kilo.jsonc"),
      JSON.stringify({ $schema: "https://app.kilo.ai/config.json", model: "test/ext" }),
      "utf-8",
    )
    watcherAdapter.watchers_[0].onChange()
    await waitFor(() => errors.some((m) => m.includes("pending")), "pending diagnostic never surfaced")
    expect(fake.observes.length).toBe(1)
    expect(JSON.stringify(svc.snapshot).includes("test/ext")).toBe(true)
    // Timer redeliveries while the transport stays down keep the wire rate
    // bounded and must not refresh the user-facing diagnostic.
    const parkedErrors = errors.length
    await waitFor(() => fake.observes.length >= 3, "bounded redelivery never ran", 5000)
    expect(errors.length).toBe(parkedErrors)
    // Recover the transport with no read/ready signal: the service-owned
    // backoff must redeliver the parked descriptor on its own.
    fake.observeThrows = false
    fake.observeResult = { status: "converged", outcome: "cold" }
    const before = fake.observes.length
    await waitFor(() => fake.observes.length > before, "self-owned redelivery never ran", 5000)
    await sleep(250)
    // Converged: further reads stay silent (no loop, no replay of the write).
    const settled = fake.observes.length
    svc.getScopeConfig("global")
    svc.reconcileExternalObserve()
    await sleep(150)
    expect(fake.observes.length).toBe(settled)
    svc.dispose()
    const afterDispose = fake.observes.length
    await sleep(200)
    expect(fake.observes.length).toBe(afterDispose)
  })
})
