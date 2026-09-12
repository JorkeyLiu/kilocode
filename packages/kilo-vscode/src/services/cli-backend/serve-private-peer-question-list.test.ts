import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalQuestionListOpId, validateQuestionListContractRequest } from "./serve-private-question-list-contract"

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
  const opId = canonicalQuestionListOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "question/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, items: unknown = []) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "question/list",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { questions: items },
  }
}

function setupPeer(epoch: number, caps: unknown = ["question/list"]) {
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

describe("question/list private peer", () => {
  test("malformed request fails closed before transport", () => {
    const bad = makeReq({ payload: { filter: {} } })
    expect(() => validateQuestionListContractRequest(bad)).toThrow()
    const { chan, peer } = setupPeer(5)
    try {
      expect(() => peer.privateQuestionListWithHandle(bad as never)).toThrow()
      expect(peer.getPendingCount()).toBe(0)
    } finally {
      peer.dispose()
      chan.backendPeer.dispose()
      chan.clientReader.destroy()
      chan.clientWriter.destroy()
    }
  })

  test("peer unavailable/disposed fails closed", () => {
    const { chan, peer } = setupPeer(5)
    ;(peer as unknown as Record<string, unknown>).available = false
    const req = makeReq()
    expect(() => peer.privateQuestionListWithHandle(req as never)).toThrow("Private peer unavailable")
    ;(peer as unknown as Record<string, unknown>).available = true
    peer.dispose()
    expect(() => peer.privateQuestionListWithHandle(req as never)).toThrow()
    chan.backendPeer.dispose()
    chan.clientReader.destroy()
    chan.clientWriter.destroy()
  })

  test("capability gating requires question/list", () => {
    const { chan, peer } = setupPeer(5, ["permission/list"])
    const req = makeReq()
    expect(() => peer.privateQuestionListWithHandle(req as never)).toThrow(
      "Private peer missing question/list capability",
    )
    peer.dispose()
    chan.backendPeer.dispose()
    chan.clientReader.destroy()
    chan.clientWriter.destroy()
  })

  test("handle resolves valid success with zero mutation", async () => {
    const req = makeReq()
    const success = makeSuccess(req, [])
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("question/list")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["question/list"]
    try {
      const outcome = await peer.privateQuestionListWithHandle(req as never).promise
      expect(outcome.kind).toBe("valid")
      if (outcome.kind === "valid") expect(outcome.result.status).toBe("succeeded")
      const direct = await peer.privateQuestionList(req as never)
      expect(direct.status).toBe("succeeded")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("invalid wire normalizes to invalid outcome and direct throws", async () => {
    const req = makeReq()
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ bad: true }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["question/list"]
    try {
      const outcome = await peer.privateQuestionListWithHandle(req as never).promise
      expect(outcome.kind).toBe("invalid")
      await expect(peer.privateQuestionList(req as never)).rejects.toThrow()
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("transport failure maps to ambiguous with exact cancel", async () => {
    const req = makeReq()
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => {
      throw new Error("transport error")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["question/list"]
    try {
      const handle = peer.privateQuestionListWithHandle(req as never)
      const outcome = await handle.promise
      expect(outcome.kind).toBe("valid")
      if (outcome.kind === "valid") expect(outcome.result.status).toBe("ambiguous")
      expect(typeof handle.cancel("probe")).toBe("boolean")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })
})
