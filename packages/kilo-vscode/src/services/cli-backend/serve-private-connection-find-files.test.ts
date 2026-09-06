import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "./connection-service"
import { DeferredFindFiles } from "./serve-private-find-files"
import { canonicalFindFilesOpId } from "./serve-private-find-files-contract"

function makeService(): KiloConnectionService {
  return new KiloConnectionService({} as never)
}

function findReq(token = "tok1", over: Record<string, unknown> = {}) {
  const opId = canonicalFindFilesOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "find/files" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { query: "hello", type: "file", limit: 10 },
    ...over,
  }
}

function succeededResult(req: ReturnType<typeof findReq>, files: unknown = [{ path: "src/app.ts", type: "file" }]) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "find/files",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { files },
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

function fakePeer(outcome: unknown, caps = ["find/files"]) {
  return {
    dispose: () => {},
    isAvailable: () => true,
    hasCapability: (c: string) => (caps as string[]).includes(c),
    privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => ({
      id: 11,
      promise: Promise.resolve(outcome ?? { kind: "valid", result: succeededResult(req as never) }),
      cancel: () => true,
    }),
    tryCancelPending: () => true,
    invalidateOnObserverTimeout: (_r: string) => {},
  }
}

describe("find/files connection-service owner", () => {
  test("unavailable peer throws without touching the transport", () => {
    const service = makeService()
    const req = findReq()
    expect(() => service.privateFindFilesOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    service.dispose()
  })

  test("missing capability throws fail-closed", () => {
    const service = makeService()
    installPeer(service, fakePeer(null, ["command/list"]))
    const req = findReq()
    expect(() => service.privateFindFilesOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing find/files capability",
    )
    service.dispose()
  })

  test("current epoch passes the normalized outcome through", async () => {
    const service = makeService()
    const req = findReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }))
    const handle = service.privateFindFilesOutcomeWithHandle(req as never)
    expect(handle.id).toBe(11)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    service.dispose()
  })

  test("invalid wire passes through before any comparator", async () => {
    const service = makeService()
    const req = findReq()
    installPeer(service, fakePeer({ kind: "invalid", detail: "bad wire" }))
    const outcome = await service.privateFindFilesOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    service.dispose()
  })

  test("replaced epoch maps to ambiguous transportUnknown", async () => {
    const service = makeService()
    const req = findReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }), { epoch: 7 })
    const handle = service.privateFindFilesOutcomeWithHandle(req as never)
    ;(service as unknown as Record<string, unknown>).privateEpoch = 8
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("ambiguous")
      expect((outcome.result as Record<string, unknown>).transportUnknown).toBeTrue()
    }
    service.dispose()
  })

  test("replaced peer maps to ambiguous transportUnknown", async () => {
    const service = makeService()
    const req = findReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }), { epoch: 7 })
    const handle = service.privateFindFilesOutcomeWithHandle(req as never)
    ;(service as unknown as Record<string, unknown>).privatePeer = fakePeer({
      kind: "valid",
      result: succeededResult(req),
    })
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
    const req = findReq()
    let cleaned = 0
    const captured = {
      dispose: () => {},
      isAvailable: () => true,
      hasCapability: () => true,
      privateFindFilesOutcomeWithHandle: () => ({
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
    const handle = service.privateFindFilesOutcomeWithHandle(req as never)
    ;(service as unknown as Record<string, unknown>).privateEpoch = 8
    expect(handle.cancel()).toBe("stale")
    expect(cleaned).toBe(1)
    service.dispose()
  })

  test("current-epoch cancel miss fail-closed via owner invalidation", () => {
    const service = makeService()
    const req = findReq()
    let invalidated = 0
    const peer = {
      ...fakePeer({ kind: "valid", result: succeededResult(req) }),
      tryCancelPending: () => false,
      invalidateOnObserverTimeout: (_r: string) => {
        invalidated += 1
      },
    }
    installPeer(service, peer)
    const handle = service.privateFindFilesOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBe(false)
    expect(invalidated).toBe(1)
    service.dispose()
  })

  test("current-epoch cancel throw fail-closed via owner invalidation", () => {
    const service = makeService()
    const req = findReq()
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
    const handle = service.privateFindFilesOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBe(false)
    expect(invalidated).toBe(1)
    service.dispose()
  })

  test("exact cancel success preserves the peer", () => {
    const service = makeService()
    const req = findReq()
    installPeer(service, fakePeer({ kind: "valid", result: succeededResult(req) }))
    const handle = service.privateFindFilesOutcomeWithHandle(req as never)
    expect(handle.cancel()).toBe(true)
    expect((service as unknown as Record<string, unknown>).privatePeer).not.toBeNull()
    service.dispose()
  })

  test("find/files invalidation branch clears deferred find/files without touching other epochs", () => {
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
    rec.privatePeer = fakePeer({ kind: "valid", result: succeededResult(findReq()) })
    service.addDeferredFindFilesObserver("/tmp", undefined, "hello", "file", 10, () => {})
    expect(rec.privateAvailableListeners.size).toBe(1)
    service.invalidatePrivatePeerOnObserverTimeout("find-files observer timeout exact cancel miss")
    expect(rec.privatePeer).toBeNull()
    expect(rec.privateAvailable).toBeFalse()
    expect(rec.privateEpoch).toBeNull()
    expect(rec.privateAvailableListeners.size).toBe(0)
    service.dispose()
  })

  test("deferred find/files observer respects epoch lifecycle without retention", () => {
    const service = makeService()
    ;(service as unknown as Record<string, unknown>).privateEpoch = null
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    let fires = 0
    const noop1 = service.addDeferredFindFilesObserver("/tmp", undefined, "hello", "file", 10, () => {
      fires += 1
    })
    expect(typeof noop1).toBe("function")
    noop1()
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = 7
    const noop2 = service.addDeferredFindFilesObserver("/tmp", undefined, "hello", "file", 10, () => {
      fires += 1
    })
    expect(typeof noop2).toBe("function")
    noop2()
    expect(fires).toBe(0)
    service.dispose()
  })

  test("deferred find/files observer dedupes per epoch+directory+query without retention on failure", () => {
    const service = makeService()
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    ;(service as unknown as Record<string, unknown>).privateAvailable = false
    let fires = 0
    const unsub1 = service.addDeferredFindFilesObserver("/tmp", undefined, "hello", "file", 10, () => {
      fires += 1
    })
    const unsub2 = service.addDeferredFindFilesObserver("/tmp", undefined, "hello", "file", 10, () => {
      fires += 1
    })
    const unsub3 = service.addDeferredFindFilesObserver("/tmp", undefined, "other", "file", 10, () => {
      fires += 1
    })
    expect(typeof unsub1).toBe("function")
    expect(typeof unsub2).toBe("function")
    expect(typeof unsub3).toBe("function")
    unsub1()
    unsub2()
    unsub3()
    expect(fires).toBe(0)
    service.dispose()
  })

  test("deferred find/files owner key is opaque and collision-safe across tuples", () => {
    const store = new DeferredFindFiles(new Set<() => void>())
    const a = store.key(7, "/tmp/alpha", undefined, "hello", "file", 10)
    const b = store.key(7, "/tmp/beta", undefined, "hello", "file", 10)
    const c = store.key(7, "/tmp/alpha", "ws-one", "hello", "file", 10)
    const d = store.key(7, "/tmp/alpha", undefined, "other", "file", 10)
    const e = store.key(7, "/tmp/alpha", undefined, "hello", "directory", 10)
    const f = store.key(7, "/tmp/alpha", undefined, "hello", "file", 5)
    const g = store.key(8, "/tmp/alpha", undefined, "hello", "file", 10)
    expect(new Set([a, b, c, d, e, f, g]).size).toBe(7)
    for (const k of [a, b, c, d, e, f, g]) {
      expect(k.startsWith("find-files:")).toBeTrue()
      expect(k).not.toContain("/tmp/alpha")
      expect(k).not.toContain("/tmp/beta")
      expect(k).not.toContain("ws-one")
      expect(k).not.toContain("hello")
      expect(k).not.toContain("other")
    }
    const tricky = store.key(7, "/tmp:alpha", undefined, "hello", "file", 10)
    const nearby = store.key(7, "/tmp", "alpha", "hello", "file", 10)
    expect(tricky).not.toBe(nearby)
  })

  test("dispose clears deferred find/files observers", () => {
    const service = makeService()
    const rec = service as unknown as Record<string, unknown> & {
      privateAvailableListeners: Set<() => void>
      deferredFindFiles: DeferredFindFiles
    }
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    ;(service as unknown as Record<string, unknown>).privateAvailable = false
    let fires = 0
    service.addDeferredFindFilesObserver("/tmp", undefined, "hello", "file", 10, () => {
      fires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    const store = rec.deferredFindFiles
    const inner = store as unknown as { keys: Map<string, () => void> }
    const owned = store.key(7, "/tmp", undefined, "hello", "file", 10)
    expect(inner.keys.has(owned)).toBeTrue()
    expect(inner.keys.size).toBe(1)
    service.dispose()
    expect(rec.privateAvailableListeners.size).toBe(0)
    expect(inner.keys.has(owned)).toBeFalse()
    expect(inner.keys.size).toBe(0)
    let refires = 0
    store.add(7, null, false, "/tmp", undefined, "hello", "file", 10, () => {
      refires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    for (const fn of [...rec.privateAvailableListeners]) fn()
    expect(refires).toBe(1)
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
    service.addDeferredFindFilesObserver("/tmp/old-epoch", undefined, "hello", "file", 10, () => {
      oldFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    rec.failPrivateNegotiation(7, 111)
    expect(rec.privateAvailableListeners.size).toBe(0)
    expect(oldFires).toBe(0)
    rec.privateEpoch = 8
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    let newFires = 0
    service.addDeferredFindFilesObserver("/tmp/new-epoch", undefined, "hello", "file", 10, () => {
      newFires += 1
    })
    expect(rec.privateAvailableListeners.size).toBe(1)
    expect(newFires).toBe(0)
    service.dispose()
  })

  test("stale peer replacement clears only the replaced epoch", () => {
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
    service.addDeferredFindFilesObserver("/tmp/stale-epoch", undefined, "hello", "file", 10, () => {})
    rec.privateEpoch = 8
    const before = rec.privateAvailableListeners.size
    expect(before).toBe(1)
    const stale = { dispose: () => {} }
    expect(rec.handleStalePeer(stale, 7)).toBe(true)
    expect(rec.privateAvailableListeners.size).toBe(1)
    rec.privateEpoch = 7
    rec.privateFailedGetEpoch = null
    rec.privateAvailable = false
    service.addDeferredFindFilesObserver("/tmp/other", undefined, "hello", "file", 10, () => {})
    expect(rec.privateAvailableListeners.size).toBe(2)
    expect(rec.handleStalePeer(stale, 7)).toBe(true)
    expect(rec.privateAvailableListeners.size).toBe(1)
    service.dispose()
  })

  test("superseded init clears the stale epoch without touching the current epoch", () => {
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
    service.addDeferredFindFilesObserver("/tmp/current", undefined, "hello", "file", 10, () => {})
    expect(rec.privateAvailableListeners.size).toBe(1)
    const stale = { dispose: () => {}, getEpoch: () => 7 }
    rec.privateEpoch = 7
    service.addDeferredFindFilesObserver("/tmp/stale", undefined, "hello", "file", 10, () => {})
    expect(rec.privateAvailableListeners.size).toBe(2)
    rec.privateEpoch = 9
    const gen = (rec.connectGeneration as number) + 1
    expect(rec.handleSupersededInit(stale, gen)).toBe(true)
    expect(rec.privateAvailableListeners.size).toBe(1)
    service.dispose()
  })

  test("clearForEpoch drops only the old epoch opaque keys", () => {
    const listeners = new Set<() => void>()
    const store = new DeferredFindFiles(listeners)
    let oldFires = 0
    let newFires = 0
    store.add(7, null, false, "/tmp/old", undefined, "hello", "file", 10, () => {
      oldFires += 1
    })
    store.add(8, null, false, "/tmp/old", undefined, "hello", "file", 10, () => {
      newFires += 1
    })
    expect(listeners.size).toBe(2)
    store.clearForEpoch(7)
    expect(listeners.size).toBe(1)
    for (const fn of [...listeners]) fn()
    expect(oldFires).toBe(0)
    expect(newFires).toBe(1)
  })

  test("missing-transport init clears the failed epoch keys", async () => {
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
})
