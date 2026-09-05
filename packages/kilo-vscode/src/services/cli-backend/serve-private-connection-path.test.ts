import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "./connection-service"
import { DeferredPath } from "./serve-private-path"

function makeService(): KiloConnectionService {
  return new KiloConnectionService({} as never)
}

function pathReq(token = "tok1") {
  const opId = `path:${token}`
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "path/get" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
}

function succeededResult(req: ReturnType<typeof pathReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "path/get",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: {
      path: { home: "/h", state: "/s", config: "/c", worktree: "/tmp", directory: "/tmp" },
    },
  }
}

function installPeer(
  service: KiloConnectionService,
  peer: Record<string, unknown>,
  opts: { available?: boolean; epoch?: number } = {},
) {
  ;(service as unknown as Record<string, unknown>).privatePeer = peer
  ;(service as unknown as Record<string, unknown>).privateAvailable = opts.available ?? true
  ;(service as unknown as Record<string, unknown>).privateEpoch = opts.epoch ?? 7
  ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
}

function fakePeer(outcome: unknown, caps = ["path/get"]) {
  return {
    dispose: () => {},
    isAvailable: () => true,
    hasCapability: (c: string) => (caps as string[]).includes(c),
    privatePathOutcomeWithHandle: (req: Record<string, unknown>) => ({
      id: 11,
      promise: Promise.resolve(outcome ?? { kind: "valid", result: succeededResult(req as never) }),
      cancel: () => true,
    }),
    tryCancelPending: () => true,
    invalidateOnObserverTimeout: (_r: string) => {},
  }
}

describe("path connection-service owner", () => {
  test("unavailable peer throws without touching the transport", () => {
    const service = makeService()
    const req = pathReq()
    expect(() => service.privatePathOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    service.dispose()
  })

  test("missing capability throws fail-closed", () => {
    const service = makeService()
    installPeer(service, fakePeer(null, ["session/get"]))
    const req = pathReq()
    expect(() => service.privatePathOutcomeWithHandle(req as never)).toThrow("Private peer missing path/get capability")
    service.dispose()
  })

  test("current epoch passes the normalized outcome through", async () => {
    const service = makeService()
    const req = pathReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }))
    const handle = service.privatePathOutcomeWithHandle(req as never)
    expect(handle.id).toBe(11)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    service.dispose()
  })

  test("invalid wire passes through before any comparator", async () => {
    const service = makeService()
    const req = pathReq()
    installPeer(service, fakePeer({ kind: "invalid", detail: "bad wire" }))
    const outcome = await service.privatePathOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    service.dispose()
  })

  test("replaced epoch maps to ambiguous transportUnknown", async () => {
    const service = makeService()
    const req = pathReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }), { epoch: 7 })
    const handle = service.privatePathOutcomeWithHandle(req as never)
    ;(service as unknown as Record<string, unknown>).privateEpoch = 8
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("ambiguous")
      expect((outcome.result as Record<string, unknown>).transportUnknown).toBeTrue()
    }
    service.dispose()
  })

  test("stale cancel cleans only the captured peer", () => {
    const service = makeService()
    const req = pathReq()
    let cleaned = 0
    const captured = {
      dispose: () => {},
      isAvailable: () => true,
      hasCapability: () => true,
      privatePathOutcomeWithHandle: () => ({
        id: 11,
        promise: Promise.resolve({ kind: "valid", result: succeededResult(req) }),
        cancel: () => true,
      }),
      tryCancelPending: () => true,
      invalidateOnObserverTimeout: (_r: string) => {
        cleaned += 1
      },
    }
    installPeer(service, captured, { epoch: 7 })
    const handle = service.privatePathOutcomeWithHandle(req as never)
    ;(service as unknown as Record<string, unknown>).privateEpoch = 8
    expect(handle.cancel()).toBe("stale")
    expect(cleaned).toBe(1)
    service.dispose()
  })

  test("current-epoch cancel miss fail-closed via owner invalidation", () => {
    const service = makeService()
    const req = pathReq()
    let invalidated = 0
    const peer = {
      ...fakePeer({ kind: "valid", result: succeededResult(req) }),
      tryCancelPending: () => false,
      invalidateOnObserverTimeout: (_r: string) => {
        invalidated += 1
      },
    }
    installPeer(service, peer)
    const handle = service.privatePathOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBe(false)
    expect(invalidated).toBe(1)
    service.dispose()
  })

  test("current-epoch cancel throw fail-closed via owner invalidation", () => {
    const service = makeService()
    const req = pathReq()
    let invalidated = 0
    const peer = {
      ...fakePeer({ kind: "valid", result: succeededResult(req) }),
      tryCancelPending: () => {
        throw new Error("cancel boom")
      },
      invalidateOnObserverTimeout: (_r: string) => {
        invalidated += 1
      },
    }
    installPeer(service, peer)
    const handle = service.privatePathOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBe(false)
    expect(invalidated).toBe(1)
    service.dispose()
  })

  test("deferred path observer respects epoch lifecycle without retention", () => {
    const service = makeService()
    // Null epoch: impossible registration, no retention, never fires.
    ;(service as unknown as Record<string, unknown>).privateEpoch = null
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    let fires = 0
    const noop1 = service.addDeferredPathObserver("/tmp", undefined, () => {
      fires += 1
    })
    expect(typeof noop1).toBe("function")
    noop1()
    // Definitively failed epoch: rejected without retention.
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = 7
    const noop2 = service.addDeferredPathObserver("/tmp", undefined, () => {
      fires += 1
    })
    expect(typeof noop2).toBe("function")
    noop2()
    expect(fires).toBe(0)
    service.dispose()
  })

  test("deferred path observer dedupes per epoch+directory without retention on failure", () => {
    const service = makeService()
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    let fires = 0
    const unsub1 = service.addDeferredPathObserver("/tmp", undefined, () => {
      fires += 1
    })
    const unsub2 = service.addDeferredPathObserver("/tmp", undefined, () => {
      fires += 1
    })
    expect(typeof unsub1).toBe("function")
    expect(typeof unsub2).toBe("function")
    unsub1()
    unsub2()
    expect(fires).toBe(0)
    service.dispose()
  })

  test("deferred path owner key is opaque and collision-safe across tuples", () => {
    const store = new DeferredPath(new Set<() => void>())
    const a = store.key(7, "/tmp/alpha", undefined)
    const b = store.key(7, "/tmp/beta", undefined)
    const c = store.key(7, "/tmp/alpha", "ws-one")
    const d = store.key(7, "/tmp/alpha", "ws-two")
    const e = store.key(8, "/tmp/alpha", undefined)
    expect(new Set([a, b, c, d, e]).size).toBe(5)
    for (const k of [a, b, c, d, e]) {
      expect(k.startsWith("path:")).toBeTrue()
      expect(k).not.toContain("/tmp/alpha")
      expect(k).not.toContain("/tmp/beta")
      expect(k).not.toContain("ws-one")
      expect(k).not.toContain("ws-two")
    }
    // Delimiter composition cannot collide: a directory containing a colon
    // plus empty workspace never equals a nearby tuple.
    const tricky = store.key(7, "/tmp:alpha", undefined)
    const nearby = store.key(7, "/tmp", "alpha")
    expect(tricky).not.toBe(nearby)
  })

  test("path routing uses the exact active spawn identity, never mutable directories", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown>
    rec.serverManager = { getActiveSpawnCwd: () => "/exact/spawn-cwd", dispose: () => {} }
    rec.currentDirectory = "/mutable/current"
    rec.rootDirectory = "/mutable/root"
    expect(service.getPathRoutingDirectory()).toBe("/exact/spawn-cwd")
    service.dispose()
  })

  test("path routing fails closed when no active exact identity exists", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown>
    rec.serverManager = { getActiveSpawnCwd: () => null, dispose: () => {} }
    rec.currentDirectory = "/mutable/current"
    rec.rootDirectory = "/mutable/root"
    expect(service.getPathRoutingDirectory()).toBeUndefined()
    rec.serverManager = {
      getActiveSpawnCwd: () => {
        throw new Error("owner gone")
      },
      dispose: () => {},
    }
    expect(service.getPathRoutingDirectory()).toBeUndefined()
    service.dispose()
  })

  test("path routing divergence after restart stays bound to the exact identity", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown>
    let spawn: string | null = "/exact/spawn-a"
    rec.serverManager = { getActiveSpawnCwd: () => spawn, dispose: () => {} }
    rec.currentDirectory = "/mutable/current"
    expect(service.getPathRoutingDirectory()).toBe("/exact/spawn-a")
    // Backend restart moves the exact identity; mutable tracking must not leak through.
    spawn = "/exact/spawn-b"
    rec.currentDirectory = "/exact/spawn-a"
    expect(service.getPathRoutingDirectory()).toBe("/exact/spawn-b")
    // Dead/disposed identity clears to fail-closed even with stale mutable state.
    spawn = null
    expect(service.getPathRoutingDirectory()).toBeUndefined()
    service.dispose()
  })
})
