import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "./connection-service"

function makeService(): KiloConnectionService {
  return new KiloConnectionService({} as never)
}

function sessionListReq(token = "tok1", filter: Record<string, unknown> = {}) {
  const opId = `experimental-session-list:${token}`
  return {
    v: 1 as const,
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
    v: 1,
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
})
