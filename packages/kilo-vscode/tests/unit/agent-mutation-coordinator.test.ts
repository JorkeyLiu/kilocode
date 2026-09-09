import { describe, expect, it } from "bun:test"
import {
  createAgentMutationCoordinator,
  type AgentMutationIdentity,
  type AgentMutationStamp,
  type AgentMutationWire,
} from "../../webview-ui/src/context/agent-mutations"

function harness() {
  const posted: AgentMutationWire[] = []
  const identities = new Map<string, AgentMutationIdentity>()
  const stamp: AgentMutationStamp = { globalHash: "g", projectHash: "p", materializationVersion: 1, assetHash: null }
  const timers: Array<() => void> = []
  let ids = 0
  const coord = createAgentMutationCoordinator({
    post: (m) => posted.push(m),
    getStamp: () => ({ ...stamp }),
    getIdentity: (n) => identities.get(n),
    exists: (n) => identities.has(n),
    makeId: () => `req-${(ids += 1)}`,
    editDelay: 50,
    schedule: (fn) => {
      timers.push(fn)
      return () => {
        const k = timers.indexOf(fn)
        if (k >= 0) timers.splice(k, 1)
      }
    },
  })
  const fireTimers = () => {
    const pending = timers.splice(0)
    for (const fn of pending) fn()
  }
  const applied = (requestId: string, name: string, contentHash: string) =>
    coord.handleMessage({ type: "agentMutationApplied", requestId, name, contentHash })
  const failed = (requestId: string, name: string, message = "boom", kind = "io") =>
    coord.handleMessage({ type: "agentMutationError", requestId, name, message, kind })
  return { posted, identities, coord, fireTimers, applied, failed }
}

describe("agent mutation coordinator", () => {
  it("coalesces rapid description/prompt/model changes into the latest synthesis", async () => {
    const h = harness()
    h.identities.set("helper", {
      scope: "project",
      assetHash: "h1",
      frontmatter: { mode: "primary", description: "old", model: "a/b" },
      body: "old body",
    })
    const p1 = h.coord.scheduleEdit("helper", { frontmatter: { description: "new description" } })
    const p2 = h.coord.scheduleEdit("helper", { body: "new body" })
    const p3 = h.coord.scheduleEdit("helper", { frontmatter: { model: null } })
    h.fireTimers()
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].requestId).toBe("req-1")
    expect(h.posted[0].expectedHash).toBe("h1")
    expect(h.posted[0].frontmatter).toMatchObject({ mode: "primary", description: "new description", model: null })
    expect(h.posted[0].body).toBe("new body")
    h.applied("req-1", "helper", "h2")
    await expect(p1).resolves.toMatchObject({ ok: true, requestId: "req-1" })
    await expect(p2).resolves.toMatchObject({ ok: true, requestId: "req-1" })
    await expect(p3).resolves.toMatchObject({ ok: true, requestId: "req-1" })
    h.coord.dispose()
  })

  it("serializes same-agent edits: later edit uses the returned hash and latest draft, no stale overwrite", async () => {
    const h = harness()
    h.identities.set("helper", { scope: "project", assetHash: "h1", frontmatter: { mode: "primary" }, body: "v1" })
    const first = h.coord.scheduleEdit("helper", { body: "v2" })
    h.fireTimers()
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].body).toBe("v2")
    // Second edit arrives while the first is still in flight.
    const second = h.coord.scheduleEdit("helper", { body: "v3" })
    h.fireTimers()
    // Still serialized behind the in-flight mutation — no second send yet.
    expect(h.posted).toHaveLength(1)
    h.applied("req-1", "helper", "h2")
    await expect(first).resolves.toMatchObject({ ok: true })
    // The queued edit is built after Applied with the returned hash + latest body.
    expect(h.posted).toHaveLength(2)
    expect(h.posted[1].expectedHash).toBe("h2")
    expect(h.posted[1].body).toBe("v3")
    expect(h.posted[1].requestId).toBe("req-2")
    h.applied("req-2", "helper", "h3")
    await expect(second).resolves.toMatchObject({ ok: true, requestId: "req-2" })
    h.coord.dispose()
  })

  it("keeps different agents independent", async () => {
    const h = harness()
    h.identities.set("alpha", { scope: "project", assetHash: "ha", frontmatter: {}, body: "a" })
    h.identities.set("beta", { scope: "project", assetHash: "hb", frontmatter: {}, body: "b" })
    const pa = h.coord.scheduleEdit("alpha", { body: "a2" })
    const pb = h.coord.scheduleEdit("beta", { body: "b2" })
    h.fireTimers()
    expect(h.posted).toHaveLength(2)
    expect(h.posted.map((p) => p.name).sort()).toEqual(["alpha", "beta"])
    h.applied(h.posted[0].requestId, h.posted[0].name, "ha2")
    h.applied(h.posted[1].requestId, h.posted[1].name, "hb2")
    await expect(pa).resolves.toMatchObject({ ok: true })
    await expect(pb).resolves.toMatchObject({ ok: true })
    h.coord.dispose()
  })

  it("does not let interleaved Applied/Error for other requests settle a waiter", async () => {
    const h = harness()
    const pa = h.coord.submit({ action: "create", name: "one", frontmatter: { mode: "primary" }, body: "1" })
    const pb = h.coord.submit({ action: "create", name: "two", frontmatter: { mode: "primary" }, body: "2" })
    expect(h.posted).toHaveLength(2)
    const [r1, r2] = [h.posted[0].requestId, h.posted[1].requestId]
    // Unknown request events are ignored and leave both waiters pending.
    expect(h.coord.handleMessage({ type: "agentMutationApplied", requestId: "req-unknown", name: "one", contentHash: "x" })).toBe(false)
    h.failed(r1, "one", "bad one", "invalid")
    await expect(pa).resolves.toMatchObject({ ok: false, requestId: r1, kind: "invalid", message: "bad one" })
    // The other waiter is untouched by the first settlement.
    h.applied(r2, "two", "h-two")
    await expect(pb).resolves.toMatchObject({ ok: true, requestId: r2, contentHash: "h-two" })
    h.coord.dispose()
  })

  it("create/import wait for their own settlement; failures keep content for retry", async () => {
    const h = harness()
    const p = h.coord.submit({ action: "import", name: "imp", frontmatter: { mode: "subagent" }, body: "b" })
    expect(h.posted).toHaveLength(1)
    const id = h.posted[0].requestId
    h.failed(id, "imp", "duplicate", "stale")
    await expect(p).resolves.toMatchObject({ ok: false, requestId: id, kind: "stale" })
    // A retry re-sends (server CAS stays authoritative).
    const retry = h.coord.submit({ action: "import", name: "imp", frontmatter: { mode: "subagent" }, body: "b" })
    expect(h.posted).toHaveLength(2)
    h.applied(h.posted[1].requestId, "imp", "h-imp")
    await expect(retry).resolves.toMatchObject({ ok: true })
    h.coord.dispose()
  })

  it("dispose cancels local waits without resending accepted operations", async () => {
    const h = harness()
    h.identities.set("helper", { scope: "project", assetHash: "h1", frontmatter: {}, body: "v1" })
    const p = h.coord.scheduleEdit("helper", { body: "v2" })
    h.fireTimers()
    expect(h.posted).toHaveLength(1)
    h.coord.dispose()
    await expect(p).resolves.toMatchObject({ ok: false, kind: "cancelled" })
    expect(h.posted).toHaveLength(1)
    // Late server events after dispose settle nothing.
    expect(h.applied(h.posted[0].requestId, "helper", "h2")).toBe(false)
  })

  it("flush sends debounced drafts immediately (field-switch path)", async () => {
    const h = harness()
    h.identities.set("helper", { scope: "project", assetHash: "h1", frontmatter: { mode: "primary" }, body: "v1" })
    const p = h.coord.scheduleEdit("helper", { body: "v2" })
    expect(h.posted).toHaveLength(0)
    h.coord.flush("helper")
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].body).toBe("v2")
    h.applied("req-1", "helper", "h2")
    await expect(p).resolves.toMatchObject({ ok: true })
    h.coord.dispose()
  })

  it("full edit submit synthesizes with the pending draft instead of replacing it", async () => {
    const h = harness()
    h.identities.set("helper", {
      scope: "project",
      assetHash: "h1",
      frontmatter: { mode: "primary", description: "old" },
      body: "old body",
    })
    // Typed description still debounced (unsent).
    const typed = h.coord.scheduleEdit("helper", { frontmatter: { description: "typed" } })
    // A concurrent full-snapshot submit (stale read plus a model change).
    const full = h.coord.submit({
      action: "edit",
      name: "helper",
      frontmatter: { mode: "primary", description: "old", model: "p/m" },
      body: "old body",
    })
    expect(h.posted).toHaveLength(1)
    // The pending draft wins for keys it owns; the submit contributes the model.
    expect(h.posted[0].frontmatter).toMatchObject({ mode: "primary", description: "typed", model: "p/m" })
    h.applied(h.posted[0].requestId, "helper", "h2")
    await expect(typed).resolves.toMatchObject({ ok: true })
    await expect(full).resolves.toMatchObject({ ok: true })
    h.coord.dispose()
  })

  it("model delta scheduled after a pending description merges into a single send", async () => {
    const h = harness()
    h.identities.set("helper", {
      scope: "project",
      assetHash: "h1",
      frontmatter: { mode: "primary", description: "old", model: "a/b" },
      body: "old body",
    })
    // Edit-view typing (unsent) followed by a ModelsTab-style model delta.
    const p1 = h.coord.scheduleEdit("helper", { frontmatter: { description: "typed" } })
    const p2 = h.coord.scheduleEdit("helper", { frontmatter: { model: "p/m" } })
    h.fireTimers()
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].frontmatter).toMatchObject({ description: "typed", model: "p/m" })
    expect(h.posted[0].body).toBe("old body")
    h.applied(h.posted[0].requestId, "helper", "h2")
    await expect(p1).resolves.toMatchObject({ ok: true })
    await expect(p2).resolves.toMatchObject({ ok: true })
    h.coord.dispose()
  })
})

describe("inflight error batch settlement (no replay)", () => {
  it("settles inflight AND queued waiters with the same error, sends nothing more", async () => {
    const h = harness()
    h.identities.set("helper", { scope: "project", assetHash: "h1", frontmatter: { mode: "primary" }, body: "v1" })
    const first = h.coord.scheduleEdit("helper", { body: "v2" })
    h.fireTimers()
    expect(h.posted).toHaveLength(1)
    // Second edit queues behind the inflight send.
    const second = h.coord.scheduleEdit("helper", { body: "v3" })
    h.fireTimers()
    expect(h.posted).toHaveLength(1)
    h.failed("req-1", "helper", "disk full", "io")
    await expect(first).resolves.toMatchObject({ ok: false, requestId: "req-1", kind: "io", message: "disk full" })
    await expect(second).resolves.toMatchObject({ ok: false, requestId: "req-1", kind: "io", message: "disk full" })
    // No replay, no second send, pending cleared (waiter gone).
    expect(h.posted).toHaveLength(1)
    expect(h.coord.handleMessage({ type: "agentMutationApplied", requestId: "req-1", name: "helper", contentHash: "hx" })).toBe(false)
  })

  it("late error for a settled request never touches the next request", async () => {
    const h = harness()
    h.identities.set("helper", { scope: "project", assetHash: "h1", frontmatter: { mode: "primary" }, body: "v1" })
    const first = h.coord.scheduleEdit("helper", { body: "v2" })
    h.fireTimers()
    h.failed("req-1", "helper", "stale", "stale")
    await expect(first).resolves.toMatchObject({ ok: false, kind: "stale" })
    // Server advanced meanwhile (agentsLoaded refresh); the next explicit
    // edit rebuilds from the retained draft with the fresh hash.
    h.identities.set("helper", { scope: "project", assetHash: "h2", frontmatter: { mode: "primary" }, body: "v1" })
    const next = h.coord.scheduleEdit("helper", { body: "v4" })
    h.fireTimers()
    expect(h.posted).toHaveLength(2)
    expect(h.posted[1].expectedHash).toBe("h2")
    expect(h.posted[1].body).toBe("v4")
    // The late duplicate of the old error settles nothing.
    expect(h.coord.handleMessage({ type: "agentMutationError", requestId: "req-1", name: "helper", message: "stale", kind: "stale" })).toBe(false)
    h.applied(h.posted[1].requestId, "helper", "h3")
    await expect(next).resolves.toMatchObject({ ok: true, contentHash: "h3" })
    h.coord.dispose()
  })

  it("flush error settles the original waiter instead of being swallowed", async () => {
    const h = harness()
    h.identities.set("helper", { scope: "project", assetHash: "h1", frontmatter: { mode: "primary" }, body: "v1" })
    // Unmount/agent-switch path: debounced draft flushed synchronously.
    const p = h.coord.scheduleEdit("helper", { body: "v2" })
    h.coord.flush("helper")
    expect(h.posted).toHaveLength(1)
    h.failed(h.posted[0].requestId, "helper", "CAS moved under us", "stale")
    await expect(p).resolves.toMatchObject({ ok: false, kind: "stale", message: "CAS moved under us" })
    h.coord.dispose()
  })
})

describe("full snapshot reconciliation", () => {
  it("deletes non-dirty old keys while dirty local keys win", async () => {
    const h = harness()
    h.identities.set("helper", {
      scope: "project",
      assetHash: "h1",
      frontmatter: { mode: "primary", description: "old", model: "old-model", temperature: 0.5 },
      body: "old body",
    })
    // Typed description is dirty (unsent); model/temperature are clean.
    const typed = h.coord.scheduleEdit("helper", { frontmatter: { description: "typed" } })
    // Full snapshot omits model/temperature and restates description stale.
    const full = h.coord.submit({
      action: "edit",
      name: "helper",
      frontmatter: { mode: "primary", description: "old" },
      body: "old body",
    })
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].frontmatter).toMatchObject({ mode: "primary", description: "typed" })
    expect("model" in h.posted[0].frontmatter).toBe(false)
    expect("temperature" in h.posted[0].frontmatter).toBe(false)
    h.applied(h.posted[0].requestId, "helper", "h2")
    await expect(typed).resolves.toMatchObject({ ok: true })
    await expect(full).resolves.toMatchObject({ ok: true })
    h.coord.dispose()
  })
})

describe("session diagnostic text", () => {
  it("reports failures, stays silent on success and cancellation", async () => {
    const { agentMutationDiagnostic } = await import("../../webview-ui/src/context/agent-mutations")
    expect(agentMutationDiagnostic({ ok: true, requestId: "r", name: "a", action: "edit", contentHash: "h" })).toBeNull()
    expect(agentMutationDiagnostic({ ok: false, requestId: "r", name: "a", action: "edit", kind: "cancelled", message: "x" })).toBeNull()
    expect(agentMutationDiagnostic({ ok: false, requestId: "r", name: "a", action: "edit", kind: "stale", message: "moved" })).toBe(
      "moved [stale]",
    )
    expect(agentMutationDiagnostic({ ok: false, requestId: undefined, name: "a", action: "create", kind: "io", message: "boom" })).toBe(
      "boom [io]",
    )
  })
})

describe("prototype-pollution defense in merges", () => {
  it("drops __proto__/constructor/prototype patch keys without touching prototypes", async () => {
    const h = harness()
    h.identities.set("helper", { scope: "project", assetHash: "h1", frontmatter: { mode: "primary" }, body: "v1" })
    const before = ({} as Record<string, unknown>).polluted
    const p = h.coord.scheduleEdit("helper", {
      frontmatter: { description: "typed", __proto__: { polluted: true }, constructor: { polluted: true } } as Record<string, unknown>,
    })
    h.fireTimers()
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].frontmatter).toMatchObject({ mode: "primary", description: "typed" })
    expect("polluted" in h.posted[0].frontmatter).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBe(before)
    h.applied(h.posted[0].requestId, "helper", "h2")
    await expect(p).resolves.toMatchObject({ ok: true })
    h.coord.dispose()
  })
})

describe("owner guard", () => {
  it("passes calls through while alive and ignores them after dispose", async () => {
    const { createOwnerGuard } = await import("../../webview-ui/src/context/agent-mutations")
    const owner = createOwnerGuard()
    let calls = 0
    const fn = owner.guard(() => {
      calls += 1
    })
    expect(owner.isAlive()).toBe(true)
    fn()
    expect(calls).toBe(1)
    owner.dispose()
    expect(owner.isAlive()).toBe(false)
    fn()
    fn()
    expect(calls).toBe(1)
  })

  it("cancelled settlement plus guard means no second navigation or state write", async () => {
    const { createOwnerGuard } = await import("../../webview-ui/src/context/agent-mutations")
    const h = harness()
    const owner = createOwnerGuard()
    const p = h.coord.submit({ action: "create", name: "one", frontmatter: { mode: "primary" }, body: "1" })
    expect(h.posted).toHaveLength(1)
    const navigations: Array<string> = []
    void p.then(
      owner.guard((result) => {
        if (result.ok) navigations.push(result.name)
      }),
    )
    // Unmount before settlement: cancel locally, then a late Applied arrives.
    owner.dispose()
    h.coord.cancelAll()
    await expect(p).resolves.toMatchObject({ ok: false, kind: "cancelled" })
    expect(h.coord.handleMessage({ type: "agentMutationApplied", requestId: "req-1", name: "one", contentHash: "h" })).toBe(false)
    expect(navigations).toEqual([])
    // Nothing was resent.
    expect(h.posted).toHaveLength(1)
    h.coord.dispose()
  })
})
