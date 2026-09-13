import { describe, expect, it } from "bun:test"
import { LifecycleRefreshCoordinator } from "../../src/kilo-provider/lifecycle-refresh-coordinator"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function tick(times = 1) {
  let chain = Promise.resolve()
  for (let i = 0; i < times; i += 1) chain = chain.then(() => undefined)
  return chain
}

describe("LifecycleRefreshCoordinator", () => {
  it("shares one in-flight promise and runs exactly one trailing round for a concurrent burst", async () => {
    const gate = deferred()
    let rounds = 0
    const order: string[] = []
    const coord = new LifecycleRefreshCoordinator(async () => {
      rounds += 1
      order.push(`round-${rounds}-start`)
      if (rounds === 1) await gate.promise
      order.push(`round-${rounds}-end`)
    })
    const first = coord.request()
    await tick(3)
    expect(coord.active).toBe(true)
    const second = coord.request()
    const third = coord.request()
    const fourth = coord.request()
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(fourth).toBe(first)
    gate.resolve()
    await Promise.all([first, second, third, fourth])
    expect(rounds).toBe(2)
    expect(order).toEqual(["round-1-start", "round-1-end", "round-2-start", "round-2-end"])
    expect(coord.active).toBe(false)
  })

  it("does not amplify N dirty arrivals into N rounds", async () => {
    const gate = deferred()
    let rounds = 0
    const coord = new LifecycleRefreshCoordinator(async () => {
      rounds += 1
      if (rounds === 1) await gate.promise
    })
    const head = coord.request()
    await tick(3)
    const rest = Array.from({ length: 10 }, () => coord.request())
    for (const item of rest) expect(item).toBe(head)
    gate.resolve()
    await Promise.all([head, ...rest])
    expect(rounds).toBe(2)
  })

  it("runs a further round when an event arrives during the trailing round", async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    let rounds = 0
    const coord = new LifecycleRefreshCoordinator(async () => {
      rounds += 1
      if (rounds === 1) await firstGate.promise
      if (rounds === 2) await secondGate.promise
    })
    const head = coord.request()
    await tick(3)
    // Dirty during round 1 -> trailing round 2 will run.
    coord.request()
    firstGate.resolve()
    await tick(5)
    expect(rounds).toBe(2)
    expect(coord.active).toBe(true)
    // Event during trailing round 2 must produce round 3.
    const late = coord.request()
    expect(late).toBe(head)
    secondGate.resolve()
    await Promise.all([head, late])
    expect(rounds).toBe(3)
    expect(coord.active).toBe(false)
  })

  it("still runs trailing coverage when the first round is slow or fails", async () => {
    const gate = deferred()
    let rounds = 0
    const coord = new LifecycleRefreshCoordinator(async () => {
      rounds += 1
      if (rounds === 1) {
        await gate.promise
        throw new Error("config exploded")
      }
    })
    const head = coord.request()
    await tick(3)
    const dirty = coord.request()
    expect(dirty).toBe(head)
    gate.resolve()
    await head
    expect(rounds).toBe(2)
  })

  it("survives sync throw and async rejection without deadlock", async () => {
    let calls = 0
    const coord = new LifecycleRefreshCoordinator(() => {
      calls += 1
      if (calls === 1) throw new Error("sync exploded")
      if (calls === 2) return Promise.reject(new Error("async exploded"))
    })
    await coord.request()
    expect(calls).toBe(1)
    await coord.request()
    expect(calls).toBe(2)
    // Coordinator still accepts new work after failures.
    await coord.request()
    expect(calls).toBe(3)
    expect(coord.active).toBe(false)
  })

  it("covers reentrant requests issued synchronously inside the runner (exit-boundary wakeup)", async () => {
    let rounds = 0
    let coord: LifecycleRefreshCoordinator | null = null
    coord = new LifecycleRefreshCoordinator(() => {
      rounds += 1
      if (rounds === 1) {
        // Synchronous reentrancy before the first await: must not start a
        // second concurrent round and must not be lost.
        void coord?.request()
      }
    })
    await coord.request()
    expect(rounds).toBe(2)
  })

  it("covers a wakeup arriving right as the final round resolves", async () => {
    const gate = deferred()
    let rounds = 0
    const coord = new LifecycleRefreshCoordinator(async () => {
      rounds += 1
      if (rounds === 1) await gate.promise
    })
    const head = coord.request()
    await tick(3)
    // Arrival while round 1 is still in flight (microtask boundary).
    const trailing = coord.request()
    expect(trailing).toBe(head)
    gate.resolve()
    await head
    expect(rounds).toBe(2)
    // After quiescence a new request starts a fresh round.
    const fresh = coord.request()
    expect(fresh).not.toBe(head)
    await fresh
    expect(rounds).toBe(3)
  })

  it("dispose prevents trailing rounds and future work without rejection", async () => {
    const gate = deferred()
    let rounds = 0
    const coord = new LifecycleRefreshCoordinator(async () => {
      rounds += 1
      if (rounds === 1) await gate.promise
    })
    const head = coord.request()
    await tick(3)
    coord.request()
    coord.dispose()
    gate.resolve()
    await head
    expect(rounds).toBe(1)
    expect(coord.active).toBe(false)
    await coord.request()
    expect(rounds).toBe(1)
  })

  it("KiloProvider keeps lifecycle call sites, round order, and disposal wiring (source contract)", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    // Coordinator ownership: one per-provider instance, no timers, no cross-provider sharing.
    expect(src).toContain("LifecycleRefreshCoordinator")
    expect(src).toContain("private readonly lifecycleRefresh: LifecycleRefreshCoordinator")
    expect(src).toContain("new LifecycleRefreshCoordinator(() => this.runLifecycleRound())")
    expect(src).toContain("this.lifecycleRefresh.dispose()")
    // Round order: clear, config first, then parallel providers/agents/skills/commands.
    const round = src.match(/private async runLifecycleRound\(\)[\s\S]*?^\s{2}\}/m)?.[0] ?? ""
    expect(round).toContain("this.requirements.clear()")
    expect(round).toContain("await this.fetchAndSendConfig()")
    expect(round).toContain("this.fetchAndSendProviders()")
    expect(round).toContain("this.fetchAndSendAgents()")
    expect(round).toContain("this.fetchAndSendSkills()")
    expect(round).toContain("this.fetchAndSendCommands()")
    const clearIdx = round.indexOf("this.requirements.clear()")
    const configIdx = round.indexOf("await this.fetchAndSendConfig()")
    const parallelIdx = round.indexOf("await Promise.all")
    expect(clearIdx).toBeGreaterThan(-1)
    expect(configIdx).toBeGreaterThan(clearIdx)
    expect(parallelIdx).toBeGreaterThan(configIdx)
    // reloadAfterAuthChange delegates to the coordinator, preserving the entry point.
    const entry =
      src.match(/private reloadAfterAuthChange\(\)[\s\S]*?return this\.lifecycleRefresh\.request\(\)/)?.[0] ?? ""
    expect(entry.length).toBeGreaterThan(0)
    // Event entries still exist: unconditional global.disposed, same-directory
    // server.instance.disposed, and cross-directory manual reload.
    expect(src).toContain('if (event.type === "global.disposed")')
    expect(src).toContain('if (event.type === "server.instance.disposed")')
    expect(src).toContain("sameDirectory(dir, this.getWorkspaceDirectory())")
    expect(src).toContain("void this.reloadAfterAuthChange()")
    expect(src).toContain("await this.reloadAfterAuthChange()")
    // Immediate auth ack paths stay direct and are not routed through the lifecycle gate.
    expect(src).toContain("fetchAndSendProviders")
    // No debounce timer introduced for lifecycle refresh.
    expect(src).not.toContain("lifecycleDebounce")
    const helper = await Bun.file(
      new URL("../../src/kilo-provider/lifecycle-refresh-coordinator.ts", import.meta.url),
    ).text()
    expect(helper).not.toContain("setTimeout")
    expect(helper).not.toContain("setInterval")
  })
})
