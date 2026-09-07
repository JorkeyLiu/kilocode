import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "./connection-service"
import { DeferredSessionList } from "./serve-private-session-list"

function makeService(): KiloConnectionService {
  return new KiloConnectionService({} as never)
}

function sessionListReq(token = "tok1", filter: Record<string, unknown> = {}) {
  const opId = `experimental-session-list:${token}`
  return {
    v: 2 as const,
    requestId: "r1",
    opId,
    op: "experimental/session/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { filter },
  }
}

function succeededResult(req: ReturnType<typeof sessionListReq>) {
  return {
    v: 2,
    requestId: req.requestId,
    opId: req.opId,
    op: "experimental/session/list",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { sessions: [] },
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

function fakePeer(outcome: unknown, caps = ["experimental/session/list"]) {
  return {
    dispose: () => {},
    isAvailable: () => true,
    hasCapability: (c: string) => (caps as string[]).includes(c),
    privateSessionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
      id: 11,
      promise: Promise.resolve(outcome ?? { kind: "valid", result: succeededResult(req as never) }),
      cancel: () => true,
    }),
    tryCancelPending: () => true,
    invalidateOnObserverTimeout: (_r: string) => {},
  }
}

describe("session-list connection-service owner", () => {
  test("unavailable peer throws without touching the transport", () => {
    const service = makeService()
    const req = sessionListReq()
    expect(() => service.privateSessionListOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    service.dispose()
  })

  test("missing capability throws fail-closed", () => {
    const service = makeService()
    installPeer(service, fakePeer(null, ["session/get"]))
    const req = sessionListReq()
    expect(() => service.privateSessionListOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing experimental/session/list capability",
    )
    service.dispose()
  })

  test("current epoch passes the normalized outcome through", async () => {
    const service = makeService()
    const req = sessionListReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }))
    const handle = service.privateSessionListOutcomeWithHandle(req as never)
    expect(handle.id).toBe(11)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") expect(outcome.result.status).toBe("succeeded")
    service.dispose()
  })

  test("epoch drift and peer replacement map to ambiguous transportUnknown", async () => {
    const service = makeService()
    const req = sessionListReq()
    const peer = fakePeer({ kind: "valid", result: succeededResult(req) })
    installPeer(service, peer, { epoch: 7 })
    const handle = service.privateSessionListOutcomeWithHandle(req as never)
    ;(service as unknown as Record<string, unknown>).privateEpoch = 8
    const drifted = await handle.promise
    expect(drifted.kind).toBe("valid")
    if (drifted.kind === "valid") {
      expect(drifted.result.status).toBe("ambiguous")
      expect((drifted.result as Record<string, unknown>).transportUnknown).toBeTrue()
    }
    const req2 = sessionListReq("tok2")
    const peer2 = fakePeer({ kind: "valid", result: succeededResult(req2) })
    installPeer(service, peer2, { epoch: 8 })
    const handle2 = service.privateSessionListOutcomeWithHandle(req2 as never)
    ;(service as unknown as Record<string, unknown>).privatePeer = fakePeer(null)
    const replaced = await handle2.promise
    expect(replaced.kind).toBe("valid")
    if (replaced.kind === "valid") expect(replaced.result.status).toBe("ambiguous")
    service.dispose()
  })

  test("stale cancel cleans only the captured peer and returns stale", () => {
    const service = makeService()
    const req = sessionListReq()
    let invalidated: string[] = []
    const peer = {
      ...fakePeer(null),
      invalidateOnObserverTimeout: (r: string) => {
        invalidated.push(r)
      },
    }
    installPeer(service, peer, { epoch: 7 })
    const handle = service.privateSessionListOutcomeWithHandle(req as never)
    ;(service as unknown as Record<string, unknown>).privateEpoch = 9
    expect(handle.cancel()).toBe("stale")
    expect(invalidated).toHaveLength(1)
    expect((service as unknown as Record<string, unknown>).privatePeer).toBe(peer)
    service.dispose()
  })

  test("current-epoch cancel miss fail-closed invalidates the owner peer", () => {
    const service = makeService()
    const req = sessionListReq()
    let invalidated: string[] = []
    const origInvalidate = service.invalidatePrivatePeerOnObserverTimeout.bind(service)
    ;(service as unknown as Record<string, unknown>).invalidatePrivatePeerOnObserverTimeout = (r: string) => {
      invalidated.push(r)
      origInvalidate(r)
    }
    const peer = {
      ...fakePeer(null),
      tryCancelPending: () => false,
    }
    installPeer(service, peer, { epoch: 7 })
    const handle = service.privateSessionListOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBeFalse()
    expect(invalidated).toHaveLength(1)
    expect((service as unknown as Record<string, unknown>).privatePeer).toBeNull()
    service.dispose()
  })

  test("current-epoch cancel throw fail-closed invalidates the owner peer", () => {
    const service = makeService()
    const req = sessionListReq()
    let invalidated: string[] = []
    const origInvalidate = service.invalidatePrivatePeerOnObserverTimeout.bind(service)
    ;(service as unknown as Record<string, unknown>).invalidatePrivatePeerOnObserverTimeout = (r: string) => {
      invalidated.push(r)
      origInvalidate(r)
    }
    const peer = {
      ...fakePeer(null),
      tryCancelPending: () => {
        throw new Error("cancel boom")
      },
    }
    installPeer(service, peer, { epoch: 7 })
    const handle = service.privateSessionListOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBeFalse()
    expect(invalidated).toHaveLength(1)
    expect((service as unknown as Record<string, unknown>).privatePeer).toBeNull()
    service.dispose()
  })

  test("dispose clears the owner peer without retaining observers", () => {
    const service = makeService()
    installPeer(service, fakePeer(null), { epoch: 7 })
    service.dispose()
    expect((service as unknown as Record<string, unknown>).privatePeer).toBeNull()
    expect(() => service.privateSessionListOutcomeWithHandle(sessionListReq() as never)).toThrow()
  })

  test("deferred session-list observer respects epoch/failed-epoch/available guards without retention", () => {
    const service = makeService()
    ;(service as unknown as Record<string, unknown>).privateEpoch = null
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    let fires = 0
    const noop1 = service.addDeferredSessionListObserver("/tmp", undefined, { limit: 10 }, () => {
      fires += 1
    })
    expect(typeof noop1).toBe("function")
    noop1()
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = 7
    const noop2 = service.addDeferredSessionListObserver("/tmp", undefined, { limit: 10 }, () => {
      fires += 1
    })
    expect(typeof noop2).toBe("function")
    noop2()
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    ;(service as unknown as Record<string, unknown>).privateAvailable = true
    const noop3 = service.addDeferredSessionListObserver("/tmp", undefined, { limit: 10 }, () => {
      fires += 1
    })
    expect(typeof noop3).toBe("function")
    noop3()
    expect(fires).toBe(0)
    service.dispose()
  })

  test("deferred session-list observer dedupes per epoch+directory+workspace+filter and one-shot removes", () => {
    const service = makeService()
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    ;(service as unknown as Record<string, unknown>).privateAvailable = false
    const rec = service as unknown as Record<string, unknown> & {
      privateAvailableListeners: Set<() => void>
    }
    let fires = 0
    const unsub1 = service.addDeferredSessionListObserver("/tmp", undefined, { limit: 10 }, () => {
      fires += 1
    })
    const unsub2 = service.addDeferredSessionListObserver("/tmp", undefined, { limit: 10 }, () => {
      fires += 1
    })
    const unsub3 = service.addDeferredSessionListObserver("/tmp", undefined, { limit: 5 }, () => {
      fires += 1
    })
    expect(typeof unsub1).toBe("function")
    expect(typeof unsub2).toBe("function")
    expect(typeof unsub3).toBe("function")
    expect(rec.privateAvailableListeners.size).toBe(2)
    for (const fn of [...rec.privateAvailableListeners]) fn()
    expect(fires).toBe(2)
    expect(rec.privateAvailableListeners.size).toBe(0)
    unsub1()
    unsub2()
    unsub3()
    expect(fires).toBe(2)
    service.dispose()
  })

  test("deferred session-list owner key is opaque and collision-safe across tuples", () => {
    const store = new DeferredSessionList(new Set<() => void>())
    const a = store.key(7, "/tmp/alpha", undefined, { limit: 10 })
    const b = store.key(7, "/tmp/beta", undefined, { limit: 10 })
    const c = store.key(7, "/tmp/alpha", "ws-one", { limit: 10 })
    const d = store.key(7, "/tmp/alpha", undefined, { limit: 5 })
    const cursorA =
      "eyJ2IjoxLCJ1cGRhdGVkIjo3LCJpZCI6InNlc19hYmMifQ"
    const e = store.key(7, "/tmp/alpha", undefined, { limit: 10, cursor: cursorA })
    const f = store.key(7, "/tmp/alpha", undefined, { limit: 10, cursor: cursorA })
    const g = store.key(8, "/tmp/alpha", undefined, { limit: 10 })
    expect(new Set([a, b, c, d, e, g]).size).toBe(6)
    expect(e).toBe(f)
    for (const k of [a, b, c, d, e, g]) {
      expect(k.startsWith("session-list:")).toBeTrue()
      expect(k).not.toContain("/tmp/alpha")
      expect(k).not.toContain("/tmp/beta")
      expect(k).not.toContain("ws-one")
      expect(k).not.toContain("ses_abc")
      expect(k).not.toContain(cursorA)
    }
    const tricky = store.key(7, "/tmp:alpha", undefined, { limit: 10 })
    const nearby = store.key(7, "/tmp", "alpha", { limit: 10 })
    expect(tricky).not.toBe(nearby)
  })

  test("dispose clears deferred session-list observers", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateAvailableListeners: Set<() => void>
      deferredSessionList: DeferredSessionList
    }
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    ;(service as unknown as Record<string, unknown>).privateAvailable = false
    let fires = 0
    service.addDeferredSessionListObserver("/tmp", undefined, { limit: 10 }, () => {
      fires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    const store = rec.deferredSessionList
    expect(store.size).toBe(1)
    service.dispose()
    expect(rec.privateAvailableListeners.size).toBe(0)
    expect(store.size).toBe(0)
    expect(fires).toBe(0)
  })

  test("negotiation failure clears failed epoch keys and admits the next epoch", () => {
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
    service.addDeferredSessionListObserver("/tmp/old-epoch", undefined, { limit: 10 }, () => {
      oldFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    rec.failPrivateNegotiation(7, 111)
    expect(rec.privateAvailableListeners.size).toBe(0)
    expect(oldFires).toBe(0)
    expect(rec.privateFailedGetEpoch).toBe(7)
    let failedFires = 0
    service.addDeferredSessionListObserver("/tmp/old-epoch", undefined, { limit: 10 }, () => {
      failedFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(0)
    expect(failedFires).toBe(0)
    rec.privateEpoch = 8
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    let newFires = 0
    service.addDeferredSessionListObserver("/tmp/new-epoch", undefined, { limit: 10 }, () => {
      newFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    expect(newFires).toBe(0)
    service.dispose()
  })

  test("stale epoch replacement clears only the replaced epoch and never fires old parity", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateEpoch: number | null
      privateFailedGetEpoch: number | null
      privateAvailable: boolean
      privateAvailableListeners: Set<() => void>
      handleStalePeer: (peer: { dispose: () => void }, epoch: number) => boolean
    }
    rec.privateEpoch = 7
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    let oldFires = 0
    service.addDeferredSessionListObserver("/tmp/old", undefined, { limit: 10 }, () => {
      oldFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    const stale = { dispose: () => {} }
    expect(rec.handleStalePeer(stale, 7)).toBe(true)
    expect(rec.privateAvailableListeners.size).toBe(0)
    for (const fn of [...rec.privateAvailableListeners]) fn()
    expect(oldFires).toBe(0)
    rec.privateEpoch = 8
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    let newFires = 0
    service.addDeferredSessionListObserver("/tmp/new", undefined, { limit: 10 }, () => {
      newFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    expect(rec.handleStalePeer(stale, 7)).toBe(true)
    expect(rec.privateAvailableListeners.size).toBe(1)
    for (const fn of [...rec.privateAvailableListeners]) fn()
    expect(newFires).toBe(1)
    expect(oldFires).toBe(0)
    service.dispose()
  })

  test("superseded init clears the stale epoch without touching the current epoch", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateEpoch: number | null
      privateFailedGetEpoch: number | null
      privateAvailable: boolean
      privateAvailableListeners: Set<() => void>
      handleSupersededInit: (peer: { dispose: () => void; getEpoch: () => number }, gen: number) => boolean
      connectGeneration: number
    }
    rec.privateEpoch = 9
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    service.addDeferredSessionListObserver("/tmp/current", undefined, { limit: 10 }, () => {})
    expect(rec.privateAvailableListeners.size).toBe(1)
    const stale = { dispose: () => {}, getEpoch: () => 7 }
    rec.privateEpoch = 7
    service.addDeferredSessionListObserver("/tmp/stale", undefined, { limit: 10 }, () => {})
    expect(rec.privateAvailableListeners.size).toBe(2)
    rec.privateEpoch = 9
    const gen = (rec.connectGeneration as number) + 1
    expect(rec.handleSupersededInit(stale, gen)).toBe(true)
    expect(rec.privateAvailableListeners.size).toBe(1)
    service.dispose()
  })

  test("session-list invalidation branch clears deferred session-list without retaining old epoch", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateEpoch: number | null
      privateFailedGetEpoch: number | null
      privateAvailable: boolean
      privateAvailableListeners: Set<() => void>
      privatePeer: unknown
    }
    rec.privateEpoch = 7
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    rec.privatePeer = fakePeer(null)
    service.addDeferredSessionListObserver("/tmp", undefined, { limit: 10 }, () => {})
    expect(rec.privateAvailableListeners.size).toBe(1)
    service.invalidatePrivatePeerOnObserverTimeout("session-list observer timeout")
    expect(rec.privatePeer).toBeNull()
    expect(rec.privateAvailable).toBeFalse()
    expect(rec.privateEpoch).toBeNull()
    expect(rec.privateAvailableListeners.size).toBe(0)
    service.dispose()
  })

  test("missing-transport init clears the failed epoch session-list keys", async () => {
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
    expect(rec.privateFailedGetEpoch).toBe(21)
    expect(rec.privateAvailableListeners.size).toBe(0)
    service.dispose()
  })

  test("clearForEpoch drops only the old epoch opaque keys", () => {
    const listeners = new Set<() => void>()
    const store = new DeferredSessionList(listeners)
    let oldFires = 0
    let newFires = 0
    store.add(7, null, false, "/tmp/old", undefined, { limit: 10 }, () => {
      oldFires += 1
    })
    store.add(8, null, false, "/tmp/old", undefined, { limit: 10 }, () => {
      newFires += 1
    })
    expect(listeners.size).toBe(2)
    store.clearForEpoch(7)
    expect(listeners.size).toBe(1)
    for (const fn of [...listeners]) fn()
    expect(oldFires).toBe(0)
    expect(newFires).toBe(1)
  })

  test("parity prefers the owner registry over the legacy fallback subscription", async () => {
    const { observeSessionListParityDetached } = await import("../../kilo-provider/session-list-parity")
    const service = makeService()
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    ;(service as unknown as Record<string, unknown>).privateAvailable = false
    const rec = service as unknown as Record<string, unknown> & {
      privateAvailableListeners: Set<() => void>
    }
    let fallbackSubs = 0
    const conn = service as unknown as Record<string, unknown>
    const origOnPrivateAvailable = service.onPrivateAvailable.bind(service)
    conn.onPrivateAvailable = (fn: () => void) => {
      fallbackSubs += 1
      return origOnPrivateAvailable(fn)
    }
    const sdk = { data: [], error: undefined, response: { status: 200 } }
    observeSessionListParityDetached(conn as never, sdk as never, "/tmp", undefined, { limit: 10 }, 50)
    await new Promise((r) => setTimeout(r, 20))
    expect(fallbackSubs).toBe(0)
    expect(rec.privateAvailableListeners.size).toBe(1)
    service.dispose()
  })
})
