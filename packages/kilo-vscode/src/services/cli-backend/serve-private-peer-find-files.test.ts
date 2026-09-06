import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  FIND_FILES_FAILED_CODE,
  FIND_FILES_FAILED_MESSAGE,
  FIND_FILES_INVALID_DETAIL,
  canonicalFindFilesOpId,
  normalizePrivateFindFilesWire,
  validateFindFilesContractRequest,
} from "./serve-private-find-files-contract"
import {
  FIND_FILES_TRANSPORT_FAILURE_MESSAGE,
  findFilesObserverTimeoutBranch,
  requestFindFilesOutcome,
} from "./serve-private-find-files"
import { KiloConnectionService } from "./connection-service"

function createLinkedChannel(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalFindFilesOpId("tok1")
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

function makeSuccess(req: ReturnType<typeof makeReq>, files: unknown = [{ path: "src/app.ts", type: "file" }]) {
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

function makeFailed(req: ReturnType<typeof makeReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "find/files",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: { code: "internal", message: "boom", retryable: false },
    },
    accepted: false,
    failure: { code: "internal", message: "boom", retryable: false },
  }
}

function setupPeer(epoch: number, caps: unknown = ["find/files"]) {
  const chan = createLinkedChannel(() => new Promise<unknown>(() => {}))
  const peer = new ServePrivatePeer({ reader: chan.clientReader, writer: chan.clientWriter, epoch })
  ;(peer as unknown as Record<string, unknown>).available = true
  ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({
    reader: chan.clientReader,
    writer: chan.clientWriter,
  })
  ;(peer as unknown as Record<string, unknown>).capabilities = caps
  return { chan, peer }
}

describe("find/files private peer", () => {
  test("malformed request fails closed before transport", () => {
    const bad = makeReq({ payload: { query: "", type: "file", limit: 10 } })
    expect(() => validateFindFilesContractRequest(bad)).toThrow()
    const { chan, peer } = setupPeer(5)
    try {
      expect(() => peer.privateFindFilesOutcomeWithHandle(bad as never)).toThrow()
      expect(peer.getPendingCount()).toBe(0)
    } finally {
      peer.dispose()
      chan.backendPeer.dispose()
      chan.clientReader.destroy()
      chan.clientWriter.destroy()
    }
  })

  test("peer unavailable/disposed fails closed without mutation", () => {
    const { chan, peer } = setupPeer(5)
    ;(peer as unknown as Record<string, unknown>).available = false
    const req = makeReq()
    expect(() => peer.privateFindFilesOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    ;(peer as unknown as Record<string, unknown>).available = true
    peer.dispose()
    expect(() => peer.privateFindFilesOutcomeWithHandle(req as never)).toThrow()
    chan.backendPeer.dispose()
    chan.clientReader.destroy()
    chan.clientWriter.destroy()
  })

  test("peer capability gating requires find/files", () => {
    const { chan, peer } = setupPeer(5, ["command/list"])
    const req = makeReq()
    expect(() => peer.privateFindFilesOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing find/files capability",
    )
    peer.dispose()
    chan.backendPeer.dispose()
    chan.clientReader.destroy()
    chan.clientWriter.destroy()
  })

  test("peer outcome handle resolves normalized wire and excludes invalid wire", async () => {
    const req = makeReq()
    const success = makeSuccess(req)
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("find/files")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["find/files"]
    try {
      const outcome = await peer.privateFindFilesOutcomeWithHandle(req as never).promise
      expect(outcome.kind).toBe("valid")
      if (outcome.kind === "valid") {
        expect(outcome.result.status).toBe("succeeded")
      }
      const failed = makeFailed(req)
      expect(normalizePrivateFindFilesWire(failed, req as never).kind).toBe("valid")
      const redacted = normalizePrivateFindFilesWire(failed, req as never)
      if (redacted.kind === "valid" && redacted.result.status === "failed") {
        const f = redacted.result as unknown as { failure: { code: string; message: string } }
        expect(f.failure.code).toBe(FIND_FILES_FAILED_CODE)
        expect(f.failure.message).toBe(FIND_FILES_FAILED_MESSAGE)
      } else {
        throw new Error("expected redacted failed outcome")
      }
      const bad = { ...success, data: { files: [{ path: "/abs/x.ts", type: "file" }] } }
      expect(normalizePrivateFindFilesWire(bad, req as never).kind).toBe("invalid")
      const bad2 = { ...success, data: { files: [{ path: ".env", type: "file" }] } }
      expect(normalizePrivateFindFilesWire(bad2, req as never).kind).toBe("invalid")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("closed transport maps to ambiguous transportUnknown without query echo", async () => {
    const req = makeReq()
    const rawErr = Object.assign(new Error("Peer closed"), { code: -32603 })
    const raw = { requestWithId: () => ({ id: 7, promise: Promise.reject(rawErr) }) }
    const host = {
      isStale: () => false,
      isClosed: () => true,
      failInfo: () => ({ code: "-32603", msg: "secret" }),
    }
    const handle = requestFindFilesOutcome(raw as never, host, () => () => true, req as never)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid ambiguous outcome")
    expect(outcome.result.status).toBe("ambiguous")
    expect(JSON.stringify(outcome.result).includes("hello")).toBeFalse()
  })

  test("transport failure maps to redacted fixed failure without query echo", async () => {
    const req = makeReq()
    const rawErr = new Error("secret transport boom hello detail=hidden")
    const raw = { requestWithId: () => ({ id: 7, promise: Promise.reject(rawErr) }) }
    const host = {
      isStale: () => false,
      isClosed: () => false,
      failInfo: () => ({ code: "-32603", msg: "secret transport boom hello detail=hidden" }),
    }
    const handle = requestFindFilesOutcome(raw as never, host, () => () => true, req as never)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid failure outcome")
    expect(outcome.result.status).toBe("failed")
    const failed = outcome.result as unknown as {
      failure: { code: string; message: string; retryable: boolean }
    }
    expect(failed.failure.code).toBe(FIND_FILES_FAILED_CODE)
    expect(failed.failure.message).toBe(FIND_FILES_TRANSPORT_FAILURE_MESSAGE)
    const leaked = JSON.stringify(outcome.result)
    expect(leaked.includes("secret transport boom")).toBeFalse()
    expect(leaked.includes("hello")).toBeFalse()
    expect(leaked.includes("detail=hidden")).toBeFalse()
  })

  test("peer exact cancel owns the allocated id", async () => {
    const req = makeReq()
    let release: ((v: unknown) => void) | null = null
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["find/files"]
    try {
      const handle = peer.privateFindFilesOutcomeWithHandle(req as never)
      expect(typeof handle.id).toBe("number")
      expect(peer.getPendingCount()).toBe(1)
      expect(handle.cancel()).toBeTrue()
      release!({ kind: "valid", result: makeSuccess(req) })
      const outcome = await handle.promise
      expect(outcome.kind).toBe("valid")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("timeout branch classification stays redacted and fixed", () => {
    expect(findFilesObserverTimeoutBranch("find-files stale observer timeout")).toEqual({ op: "find/files" })
    expect(findFilesObserverTimeoutBranch("find-files observer timeout cancel throw")).toEqual({ op: "find/files" })
    expect(findFilesObserverTimeoutBranch("find-files observer timeout exact cancel miss")).toEqual({
      op: "find/files",
    })
    expect(findFilesObserverTimeoutBranch("find-files observer timeout")).toEqual({ op: "find/files" })
    expect(findFilesObserverTimeoutBranch("unrelated reason")).toBeNull()
    expect(FIND_FILES_INVALID_DETAIL.length).toBeGreaterThan(0)
  })

  test("capability advertisement parses array and object forms", async () => {
    const mk = (caps: unknown) =>
      createLinkedChannel((method) => {
        if (method === "initialize")
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: caps }
        throw new Error("unexpected")
      })
    const a = mk(["find/files"])
    const peerA = new ServePrivatePeer({ reader: a.clientReader, writer: a.clientWriter, epoch: 11 })
    try {
      expect(await peerA.initialize(500)).toBeTrue()
      expect(peerA.hasCapability("find/files")).toBeTrue()
      expect(peerA.getCapabilitiesListForFixture()).toContain("find/files")
    } finally {
      peerA.dispose()
      a.backendPeer.dispose()
      a.clientReader.destroy()
      a.clientWriter.destroy()
    }

    const b = mk({ "find/files": true })
    const peerB = new ServePrivatePeer({ reader: b.clientReader, writer: b.clientWriter, epoch: 12 })
    try {
      expect(await peerB.initialize(500)).toBeTrue()
      expect(peerB.hasCapability("find/files")).toBeTrue()
      expect(peerB.getCapabilitiesListForFixture()).toContain("find/files")
    } finally {
      peerB.dispose()
      b.backendPeer.dispose()
      b.clientReader.destroy()
      b.clientWriter.destroy()
    }
  })

  test("find/files owner cancel miss/throw and stale isolation run through production owner/peer seam", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    const install = (svc: KiloConnectionService, peer: ServePrivatePeer, epoch: number) => {
      ;(svc as unknown as Record<string, unknown>).privatePeer = peer
      ;(svc as unknown as Record<string, unknown>).privateAvailable = true
      ;(svc as unknown as Record<string, unknown>).privateEpoch = epoch
      ;(svc as unknown as Record<string, unknown>).privateFailedGetEpoch = null
    }
    const missSetup = setupPeer(7)
    const missSvc = new KiloConnectionService({} as never)
    const throwSetup = setupPeer(7)
    const throwSvc = new KiloConnectionService({} as never)
    const staleSetup = setupPeer(7)
    const replacementSetup = setupPeer(8)
    const staleSvc = new KiloConnectionService({} as never)
    try {
      install(missSvc, missSetup.peer, 7)
      const missHandle = missSvc.privateFindFilesOutcomeWithHandle(makeReq() as never)
      expect(missHandle.cancel()).toBe(true)
      expect((missSvc as unknown as Record<string, unknown>).privatePeer).not.toBeNull()
      expect(missSetup.peer.isAvailable()).toBeTrue()
      expect(missHandle.cancel()).toBe(false)
      expect((missSvc as unknown as Record<string, unknown>).privatePeer).toBeNull()
      expect((missSvc as unknown as Record<string, unknown>).privateAvailable).toBeFalse()
      expect((missSvc as unknown as Record<string, unknown>).privateEpoch).toBeNull()
      expect(missSetup.peer.isAvailable()).toBeFalse()

      install(throwSvc, throwSetup.peer, 7)
      ;(throwSetup.peer as unknown as Record<string, (id: number, msg?: string) => boolean>).tryCancelPending = () => {
        throw new Error("cancel boom")
      }
      const throwHandle = throwSvc.privateFindFilesOutcomeWithHandle(makeReq() as never)
      expect(throwHandle.cancel()).toBe(false)
      expect((throwSvc as unknown as Record<string, unknown>).privatePeer).toBeNull()
      expect((throwSvc as unknown as Record<string, unknown>).privateAvailable).toBeFalse()
      expect((throwSvc as unknown as Record<string, unknown>).privateEpoch).toBeNull()
      expect(throwSetup.peer.isAvailable()).toBeFalse()

      install(staleSvc, staleSetup.peer, 7)
      const staleHandle = staleSvc.privateFindFilesOutcomeWithHandle(makeReq() as never)
      install(staleSvc, replacementSetup.peer, 8)
      const keepReq = makeReq({
        requestId: "r-keep",
        opId: canonicalFindFilesOpId("tok3"),
        idempotencyKey: canonicalFindFilesOpId("tok3"),
        payload: { query: "other", type: "directory", limit: 5 },
      })
      const keepHandle = staleSvc.privateFindFilesOutcomeWithHandle(keepReq as never)
      expect(staleHandle.cancel()).toBe("stale")
      expect(staleSetup.peer.isAvailable()).toBeFalse()
      expect((staleSvc as unknown as Record<string, unknown>).privatePeer).toBe(replacementSetup.peer)
      expect((staleSvc as unknown as Record<string, unknown>).privateEpoch).toBe(8)
      expect(replacementSetup.peer.isAvailable()).toBeTrue()
      expect(replacementSetup.peer.getPendingCount()).toBe(1)
      expect(keepHandle.cancel()).toBeTrue()
      expect(replacementSetup.peer.getPendingCount()).toBe(0)
      const wire = JSON.stringify(warns)
      expect(wire.includes("find/files")).toBeTrue()
      expect(wire.includes("hello")).toBeFalse()
      expect(wire.includes("/tmp")).toBeFalse()
    } finally {
      console.warn = orig
      missSvc.dispose()
      throwSvc.dispose()
      staleSvc.dispose()
      missSetup.peer.dispose()
      throwSetup.peer.dispose()
      staleSetup.peer.dispose()
      replacementSetup.peer.dispose()
      missSetup.chan.backendPeer.dispose()
      missSetup.chan.clientReader.destroy()
      missSetup.chan.clientWriter.destroy()
      throwSetup.chan.backendPeer.dispose()
      throwSetup.chan.clientReader.destroy()
      throwSetup.chan.clientWriter.destroy()
      staleSetup.chan.backendPeer.dispose()
      staleSetup.chan.clientReader.destroy()
      staleSetup.chan.clientWriter.destroy()
      replacementSetup.chan.backendPeer.dispose()
      replacementSetup.chan.clientReader.destroy()
      replacementSetup.chan.clientWriter.destroy()
    }
  })
})
