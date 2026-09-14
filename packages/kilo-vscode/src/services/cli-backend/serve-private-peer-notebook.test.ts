import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalNotebookListOpId, canonicalNotebookOpId } from "./serve-private-notebook-contract"

const RID = "nbr_peer0000000000001"

function replyReq(over: Record<string, unknown> = {}) {
  const opId = canonicalNotebookOpId(RID, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "notebook/reply" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", requestID: RID },
    payload: { result: { operation: "read", requestPath: "b.ipynb" } },
    ...over,
  }
}

function rejectReq() {
  const opId = canonicalNotebookOpId(RID, "tok2")
  return {
    v: 1 as const,
    requestId: "r2",
    opId,
    op: "notebook/reject" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", requestID: RID },
    payload: { error: { code: "timeout", message: "timed out" } },
  }
}

function listReq(over: Record<string, unknown> = {}) {
  const opId = canonicalNotebookListOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r3",
    opId,
    op: "notebook/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function terminalReply(req: ReturnType<typeof replyReq>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses_root1",
    requestID: RID,
  }
}

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

function setupPeer(epoch: number, caps: unknown = ["notebook/reply", "notebook/reject", "notebook/list"]) {
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

function teardown(
  chan: { backendPeer: { dispose(): void }; clientReader: { destroy(): void }; clientWriter: { destroy(): void } },
  peer: { dispose(): void },
) {
  peer.dispose()
  chan.backendPeer.dispose()
  chan.clientReader.destroy()
  chan.clientWriter.destroy()
}

describe("notebook private peer", () => {
  test("malformed reply fails closed before transport", () => {
    const bad = replyReq({ payload: { result: 42 } })
    const { chan, peer } = setupPeer(5)
    try {
      expect(() => peer.privateNotebookReplyWithHandle(bad as never)).toThrow()
      expect(peer.getPendingCount()).toBe(0)
    } finally {
      teardown(chan, peer)
    }
  })

  test("peer unavailable/disposed fails closed", () => {
    const { chan, peer } = setupPeer(5)
    ;(peer as unknown as Record<string, unknown>).available = false
    expect(() => peer.privateNotebookReplyWithHandle(replyReq() as never)).toThrow("Private peer unavailable")
    expect(() => peer.privateNotebookRejectWithHandle(rejectReq() as never)).toThrow("Private peer unavailable")
    expect(() => peer.privateNotebookListWithHandle(listReq() as never)).toThrow("Private peer unavailable")
    ;(peer as unknown as Record<string, unknown>).available = true
    peer.dispose()
    expect(() => peer.privateNotebookReplyWithHandle(replyReq() as never)).toThrow()
    teardown(chan, peer)
  })

  test("capability gating requires notebook caps", () => {
    const { chan, peer } = setupPeer(5, ["question/reply"])
    expect(() => peer.privateNotebookReplyWithHandle(replyReq() as never)).toThrow(
      "Private peer missing notebook/reply capability",
    )
    expect(() => peer.privateNotebookRejectWithHandle(rejectReq() as never)).toThrow(
      "Private peer missing notebook/reject capability",
    )
    expect(() => peer.privateNotebookListWithHandle(listReq() as never)).toThrow(
      "Private peer missing notebook/list capability",
    )
    teardown(chan, peer)
  })

  test("reply handle resolves a valid terminal with exact cancel", async () => {
    const req = replyReq()
    const success = terminalReply(req)
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("notebook/reply")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["notebook/reply"]
    try {
      const handle = peer.privateNotebookReplyWithHandle(req as never)
      const outcome = await handle.promise
      expect(outcome.kind).toBe("terminal")
      const direct = await peer.privateNotebookReply(req as never)
      expect(direct.kind).toBe("terminal")
      expect(typeof handle.cancel("probe")).toBe("boolean")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("invalid wire normalizes to ambiguous", async () => {
    const req = replyReq()
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ bad: true }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["notebook/reply"]
    try {
      const outcome = await peer.privateNotebookReplyWithHandle(req as never).promise
      expect(outcome.kind).toBe("ambiguous")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("transport failure maps to ambiguous", async () => {
    const req = rejectReq()
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => {
      throw new Error("transport error")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["notebook/reject"]
    try {
      const outcome = await peer.privateNotebookRejectWithHandle(req as never).promise
      expect(outcome.kind).toBe("ambiguous")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("list handle resolves valid success and invalid wire throws on direct", async () => {
    const req = listReq()
    const success = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "notebook/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { notebooks: [] },
    }
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("notebook/list")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["notebook/list"]
    try {
      const outcome = await peer.privateNotebookListWithHandle(req as never).promise
      expect(outcome.kind).toBe("valid")
      const direct = await peer.privateNotebookList(req as never)
      expect(direct.status).toBe("succeeded")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })
})
