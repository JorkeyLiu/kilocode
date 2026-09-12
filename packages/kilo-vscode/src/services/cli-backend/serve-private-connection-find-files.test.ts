import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "./connection-service"
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
})
