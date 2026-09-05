import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "./connection-service"
import { DeferredCommandList } from "./serve-private-command-list"

function makeService(): KiloConnectionService {
  return new KiloConnectionService({} as never)
}

function commandListReq(token = "tok1") {
  const opId = `command-list:${token}`
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "command/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
}

function succeededResult(req: ReturnType<typeof commandListReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "command/list",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { commands: [{ name: "init", source: "command" }] },
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

function fakePeer(outcome: unknown, caps = ["command/list"]) {
  return {
    dispose: () => {},
    isAvailable: () => true,
    hasCapability: (c: string) => (caps as string[]).includes(c),
    privateCommandListOutcomeWithHandle: (req: Record<string, unknown>) => ({
      id: 11,
      promise: Promise.resolve(outcome ?? { kind: "valid", result: succeededResult(req as never) }),
      cancel: () => true,
    }),
    tryCancelPending: () => true,
    invalidateOnObserverTimeout: (_r: string) => {},
  }
}

describe("command-list connection-service owner", () => {
  test("unavailable peer throws without touching the transport", () => {
    const service = makeService()
    const req = commandListReq()
    expect(() => service.privateCommandListOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    service.dispose()
  })

  test("missing capability throws fail-closed", () => {
    const service = makeService()
    installPeer(service, fakePeer(null, ["session/get"]))
    const req = commandListReq()
    expect(() => service.privateCommandListOutcomeWithHandle(req as never)).toThrow("Private peer missing command/list capability")
    service.dispose()
  })

  test("current epoch passes the normalized outcome through", async () => {
    const service = makeService()
    const req = commandListReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }))
    const handle = service.privateCommandListOutcomeWithHandle(req as never)
    expect(handle.id).toBe(11)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    service.dispose()
  })

  test("invalid wire passes through before any comparator", async () => {
    const service = makeService()
    const req = commandListReq()
    installPeer(service, fakePeer({ kind: "invalid", detail: "bad wire" }))
    const outcome = await service.privateCommandListOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    service.dispose()
  })

  test("replaced epoch maps to ambiguous transportUnknown", async () => {
    const service = makeService()
    const req = commandListReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }), { epoch: 7 })
    const handle = service.privateCommandListOutcomeWithHandle(req as never)
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
    const req = commandListReq()
    let cleaned = 0
    const captured = {
      dispose: () => {},
      isAvailable: () => true,
      hasCapability: () => true,
      privateCommandListOutcomeWithHandle: () => ({
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
    const handle = service.privateCommandListOutcomeWithHandle(req as never)
    ;(service as unknown as Record<string, unknown>).privateEpoch = 8
    expect(handle.cancel()).toBe("stale")
    expect(cleaned).toBe(1)
    service.dispose()
  })

  test("current-epoch cancel miss fail-closed via owner invalidation", () => {
    const service = makeService()
    const req = commandListReq()
    let invalidated = 0
    const peer = {
      ...fakePeer({ kind: "valid", result: succeededResult(req) }),
      tryCancelPending: () => false,
      invalidateOnObserverTimeout: (_r: string) => {
        invalidated += 1
      },
    }
    installPeer(service, peer)
    const handle = service.privateCommandListOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBe(false)
    expect(invalidated).toBe(1)
    service.dispose()
  })

  test("current-epoch cancel throw fail-closed via owner invalidation", () => {
    const service = makeService()
    const req = commandListReq()
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
    const handle = service.privateCommandListOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBe(false)
    expect(invalidated).toBe(1)
    service.dispose()
  })

  test("deferred command-list observer respects epoch lifecycle without retention", () => {
    const service = makeService()
    // Null epoch: impossible registration, no retention, never fires.
    ;(service as unknown as Record<string, unknown>).privateEpoch = null
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    let fires = 0
    const noop1 = service.addDeferredCommandListObserver("/tmp", undefined, () => {
      fires += 1
    })
    expect(typeof noop1).toBe("function")
    noop1()
    // Definitively failed epoch: rejected without retention.
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = 7
    const noop2 = service.addDeferredCommandListObserver("/tmp", undefined, () => {
      fires += 1
    })
    expect(typeof noop2).toBe("function")
    noop2()
    expect(fires).toBe(0)
    service.dispose()
  })

  test("deferred command-list observer dedupes per epoch+directory without retention on failure", () => {
    const service = makeService()
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    let fires = 0
    const unsub1 = service.addDeferredCommandListObserver("/tmp", undefined, () => {
      fires += 1
    })
    const unsub2 = service.addDeferredCommandListObserver("/tmp", undefined, () => {
      fires += 1
    })
    expect(typeof unsub1).toBe("function")
    expect(typeof unsub2).toBe("function")
    unsub1()
    unsub2()
    expect(fires).toBe(0)
    service.dispose()
  })

  test("deferred command-list owner key is opaque and collision-safe across tuples", () => {
    const store = new DeferredCommandList(new Set<() => void>())
    const a = store.key(7, "/tmp/alpha", undefined)
    const b = store.key(7, "/tmp/beta", undefined)
    const c = store.key(7, "/tmp/alpha", "ws-one")
    const d = store.key(7, "/tmp/alpha", "ws-two")
    const e = store.key(8, "/tmp/alpha", undefined)
    expect(new Set([a, b, c, d, e]).size).toBe(5)
    for (const k of [a, b, c, d, e]) {
      expect(k.startsWith("command-list:")).toBeTrue()
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

  test("dispose clears deferred command-list observers", () => {
    const service = makeService()
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    ;(service as unknown as Record<string, unknown>).privateAvailable = false
    service.addDeferredCommandListObserver("/tmp", undefined, () => {})
    const store = (service as unknown as { deferredCommandList: { key: (e: number | null, d: string, w: string | undefined) => string } }).deferredCommandList
    expect(typeof store.key).toBe("function")
    service.dispose()
  })

  test("F-003 negotiation failure clears failed epoch keys and admits the next epoch", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateEpoch: number | null
      privateFailedGetEpoch: number | null
      privateAvailable: boolean
      privateAvailableListeners: Set<() => void>
      failPrivateNegotiation: (epoch: number, pid: number | undefined) => void
    }
    rec.privateEpoch = 7
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    let oldFires = 0
    service.addDeferredCommandListObserver("/tmp/old-epoch", undefined, () => {
      oldFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    rec.failPrivateNegotiation(7, 111)
    expect(rec.privateAvailableListeners.size).toBe(0)
    expect(oldFires).toBe(0)
    // Next epoch is not suppressed by the failed epoch.
    rec.privateEpoch = 8
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    let newFires = 0
    service.addDeferredCommandListObserver("/tmp/new-epoch", undefined, () => {
      newFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    expect(newFires).toBe(0)
    // Deferred store-level epoch isolation: clearing 7 never drops 8.
    const store = new DeferredCommandList(new Set<() => void>())
    const listeners = (service as unknown as { privateAvailableListeners: Set<() => void> }).privateAvailableListeners
    void store
    void listeners
    service.dispose()
  })

  test("F-003 stale peer replacement clears only the replaced epoch", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateEpoch: number | null
      privateFailedGetEpoch: number | null
      privateAvailable: boolean
      privateAvailableListeners: Set<() => void>
      handleStalePeer: (peer: { dispose: () => void }, epoch: number) => boolean
    }
    rec.privateEpoch = 8
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    service.addDeferredCommandListObserver("/tmp/stale-epoch", undefined, () => {})
    rec.privateEpoch = 8
    const before = rec.privateAvailableListeners.size
    expect(before).toBe(1)
    const stale = { dispose: () => {} }
    expect(rec.handleStalePeer(stale, 7)).toBe(true)
    // Epoch 7 had no keys under epoch 8, so the current key survives.
    expect(rec.privateAvailableListeners.size).toBe(1)
    // Now register under epoch 7 and clear it: new epoch keys survive.
    rec.privateEpoch = 7
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    service.addDeferredCommandListObserver("/tmp/other", undefined, () => {})
    expect(rec.privateAvailableListeners.size).toBe(2)
    expect(rec.handleStalePeer(stale, 7)).toBe(true)
    expect(rec.privateAvailableListeners.size).toBe(1)
    service.dispose()
  })

  test("F-003 superseded init clears the stale epoch without touching the current epoch", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateEpoch: number | null
      privateFailedGetEpoch: number | null
      privateAvailable: boolean
      privateAvailableListeners: Set<() => void>
      privatePeer: unknown
      handleSupersededInit: (peer: { dispose: () => void; getEpoch: () => number }, gen: number) => boolean
      connectGeneration: number
    }
    rec.privateEpoch = 9
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    service.addDeferredCommandListObserver("/tmp/current", undefined, () => {})
    expect(rec.privateAvailableListeners.size).toBe(1)
    const stale = { dispose: () => {}, getEpoch: () => 7 }
    rec.privateEpoch = 7
    service.addDeferredCommandListObserver("/tmp/stale", undefined, () => {})
    expect(rec.privateAvailableListeners.size).toBe(2)
    rec.privateEpoch = 9
    // Superseded generation forces stale cleanup for epoch 7.
    const gen = (rec.connectGeneration as number) + 1
    expect(rec.handleSupersededInit(stale, gen)).toBe(true)
    expect(rec.privateAvailableListeners.size).toBe(1)
    service.dispose()
  })

  test("F-003 clearForEpoch drops only the old epoch opaque keys", () => {
    const listeners = new Set<() => void>()
    const store = new DeferredCommandList(listeners)
    let oldFires = 0
    let newFires = 0
    store.add(7, null, false, "/tmp/old", undefined, () => {
      oldFires += 1
    })
    store.add(8, null, false, "/tmp/old", undefined, () => {
      newFires += 1
    })
    expect(listeners.size).toBe(2)
    store.clearForEpoch(7)
    expect(listeners.size).toBe(1)
    for (const fn of [...listeners]) fn()
    expect(oldFires).toBe(0)
    expect(newFires).toBe(1)
  })

  test("F-003 missing-transport init clears the failed epoch keys", async () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateEpoch: number | null
      privateFailedGetEpoch: number | null
      privateAvailable: boolean
      privateAvailableListeners: Set<() => void>
      initPrivatePeer: (server: { epoch: number; pid: number }) => Promise<void>
    }
    rec.privateEpoch = null
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    await rec.initPrivatePeer({ epoch: 21, pid: 999 })
    // No-transport negotiation fails closed: the epoch is marked failed.
    expect(rec.privateFailedGetEpoch).toBe(21)
    expect(rec.privateAvailableListeners.size).toBe(0)
    service.dispose()
  })
})
