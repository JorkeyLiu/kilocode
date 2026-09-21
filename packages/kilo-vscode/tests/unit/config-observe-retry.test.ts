import { describe, expect, it } from "bun:test"
import { ExternalObserveCoalescer } from "../../src/config/external-observe"
import { PrivateConvergenceAdapter } from "../../src/config/convergence"

const waitFor = async (fn: () => boolean, message: string): Promise<void> => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 3000) throw new Error(message)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("external observe strictly bounded retry (at most one retry after a transport/timeout failure; no delivery guarantee)", () => {
  it("first throw then valid cold => two different bound tokens + converged", async () => {
    const seen: Array<Record<string, unknown>> = []
    let calls = 0
    const peer = {
      request: async (_method: string, params: unknown) => {
        calls += 1
        seen.push(params as Record<string, unknown>)
        if (calls === 1) throw new Error("transport loss")
        const p = params as { observeId: string }
        return { v: 1, observeId: p.observeId, outcome: "cold", scope: "global" }
      },
      hasCapability: () => true,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer as never, 200)
    const res = await adapter.observe([{ kind: "config", scope: "global" }] as never)
    expect(res).toEqual({ status: "converged", outcome: "cold" })
    expect(calls).toBe(2)
    expect(seen.length).toBe(2)
    const a = seen[0]
    const b = seen[1]
    expect(a.observeId).not.toBe(b.observeId)
    // four-key binding: observeId/opId/requestId/idempotencyKey identical per attempt
    expect(a.observeId).toBe(a.opId)
    expect(a.observeId).toBe(a.requestId)
    expect(a.observeId).toBe(a.idempotencyKey)
    expect(b.observeId).toBe(b.opId)
    expect(b.observeId).toBe(b.requestId)
    expect(b.observeId).toBe(b.idempotencyKey)
    // descriptors identical batch
    expect(JSON.stringify(a.descriptors)).toBe(JSON.stringify(b.descriptors))
  })

  it("two throws => twice then pending + not third", async () => {
    let calls = 0
    const peer = {
      request: async () => {
        calls += 1
        throw new Error("loss")
      },
      hasCapability: () => true,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer as never, 50)
    const res = await adapter.observe([{ kind: "config", scope: "global" }] as never)
    expect(res.status).toBe("pending")
    expect(calls).toBe(2)
    // no third attempt: observe already returned, extra wait should not increase
    await new Promise((r) => setTimeout(r, 60))
    expect(calls).toBe(2)
  })

  it("valid pending response => once no retry (failed/malformed/id mismatch/noop/hot/extra)", async () => {
    const cases: Array<{ name: string; make: (id: string) => unknown }> = [
      {
        name: "failed",
        make: (id) => ({ v: 1, observeId: id, outcome: "failed", scope: "global", reason: "x", retryable: true }),
      },
      { name: "malformed", make: () => ({ v: 1 }) },
      { name: "id mismatch", make: () => ({ v: 1, observeId: "wrong", outcome: "cold", scope: "global" }) },
      { name: "noop", make: (id) => ({ v: 1, observeId: id, outcome: "noop", scope: "global" }) },
      { name: "hot", make: (id) => ({ v: 1, observeId: id, outcome: "hot", scope: "global" }) },
      { name: "unknown field", make: (id) => ({ v: 1, observeId: id, outcome: "cold", scope: "global", extra: 1 }) },
      { name: "scope mismatch", make: (id) => ({ v: 1, observeId: id, outcome: "cold", scope: "oops" }) },
    ]
    for (const c of cases) {
      let calls = 0
      const peer = {
        request: async (_m: string, params: unknown) => {
          calls += 1
          const p = params as { observeId: string }
          return c.make(p.observeId)
        },
        hasCapability: () => true,
      }
      const adapter = new PrivateConvergenceAdapter(() => peer as never, 50)
      const res = await adapter.observe([{ kind: "config", scope: "global" }] as never)
      expect(res.status).toBe("pending")
      expect(calls).toBe(1)
    }
  })

  it("external coalescer failure after retry still processes trailing dirty batch and no SDK call", async () => {
    let calls = 0
    const seenIds: string[] = []
    const peer = {
      request: async (_m: string, params: unknown) => {
        calls += 1
        const p = params as { observeId: string }
        seenIds.push(p.observeId)
        if (calls <= 2) {
          await new Promise((r) => setTimeout(r, 30))
          throw new Error("transport loss")
        }
        await new Promise((r) => setTimeout(r, 5))
        return { v: 1, observeId: p.observeId, outcome: "cold", scope: "global" }
      },
      hasCapability: () => true,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer as never, 500)
    const coalescer = new ExternalObserveCoalescer()
    const pending: string[] = []
    const deps = {
      isDisposed: () => false,
      hasProject: true,
      projectRoot: "/tmp/proj",
      observe: adapter.observe.bind(adapter) as never,
      onPending: (m: string) => pending.push(m),
    }
    const a = { kind: "asset", asset: "agent", scope: "global", id: "a" } as never
    const b = { kind: "asset", asset: "agent", scope: "global", id: "b" } as never
    coalescer.notify("global", deps as never, [a] as never)
    await new Promise((r) => setTimeout(r, 10))
    coalescer.notify("global", deps as never, [b] as never)
    await waitFor(() => calls === 3, "trailing batch never ran")
    await new Promise((r) => setTimeout(r, 40))
    expect(calls).toBe(3)
    expect(seenIds.length).toBe(3)
    expect(seenIds[0]).not.toBe(seenIds[1])
    expect(pending.length).toBe(1)
    expect(pending[0]).toContain("pending")
    // no SDK: coalescer only calls the bound observe; peer.request count proves no extra path
    // ensure trailing dirty batch was delivered (second batch's descriptor)
    // seenIds[2] corresponds to retry-success batch for b (or third call)
    // calls 1+2 are the bounded retry for a; call 3 is b
  })

  it("timeout is treated as transport failure and retried once", async () => {
    let calls = 0
    const peer = {
      request: async (_m: string, params: unknown) => {
        calls += 1
        if (calls === 1) {
          // exceed timeout so withTimeout rejects -> retry
          await new Promise((r) => setTimeout(r, 100))
          return { v: 1, observeId: (params as { observeId: string }).observeId, outcome: "cold", scope: "global" }
        }
        const p = params as { observeId: string }
        return { v: 1, observeId: p.observeId, outcome: "cold", scope: "global" }
      },
      hasCapability: () => true,
    }
    const adapter = new PrivateConvergenceAdapter(() => peer as never, 20)
    const res = await adapter.observe([{ kind: "config", scope: "global" }] as never)
    expect(res).toEqual({ status: "converged", outcome: "cold" })
    expect(calls).toBe(2)
  })

  it("null peer returns pending without request or retry", async () => {
    let factory = 0
    const adapter = new PrivateConvergenceAdapter(() => {
      factory += 1
      return null
    }, 50)
    const res = await adapter.observe([{ kind: "config", scope: "global" }] as never)
    expect(res.status).toBe("pending")
    expect(factory).toBe(1)
    await new Promise((r) => setTimeout(r, 60))
    expect(factory).toBe(1)
  })

  it("capability missing returns pending without request or retry", async () => {
    let calls = 0
    let probed = 0
    const peer = {
      request: async () => {
        calls += 1
        const dummy = "unreachable"
        void dummy
        return { v: 1, observeId: dummy, outcome: "cold", scope: "global" }
      },
      hasCapability: () => {
        probed += 1
        return false
      },
    }
    let factory = 0
    const adapter = new PrivateConvergenceAdapter(() => {
      factory += 1
      return peer as never
    }, 50)
    const res = await adapter.observe([{ kind: "config", scope: "global" }] as never)
    expect(res.status).toBe("pending")
    expect(calls).toBe(0)
    expect(probed).toBe(1)
    expect(factory).toBe(1)
    await new Promise((r) => setTimeout(r, 60))
    expect(calls).toBe(0)
    expect(probed).toBe(1)
    expect(factory).toBe(1)
  })

  it("capability probe throw returns pending without request or retry", async () => {
    let calls = 0
    let probed = 0
    const peer = {
      request: async () => {
        calls += 1
        return { v: 1, observeId: "x", outcome: "cold", scope: "global" }
      },
      hasCapability: () => {
        probed += 1
        throw new Error("probe boom")
      },
    }
    let factory = 0
    const adapter = new PrivateConvergenceAdapter(() => {
      factory += 1
      return peer as never
    }, 50)
    const res = await adapter.observe([{ kind: "config", scope: "global" }] as never)
    expect(res.status).toBe("pending")
    expect(calls).toBe(0)
    expect(probed).toBe(1)
    expect(factory).toBe(1)
    await new Promise((r) => setTimeout(r, 60))
    expect(calls).toBe(0)
    expect(probed).toBe(1)
    expect(factory).toBe(1)
  })
})
