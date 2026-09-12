import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalSuggestionOpId } from "./serve-private-suggestion-contract"

const DIR = "/tmp/work"
const RID = "sug_peer0000000000000001"

function acceptReq(over: Record<string, unknown> = {}) {
  const opId = canonicalSuggestionOpId(RID, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "suggestion/accept" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: { index: 0 },
    ...over,
  }
}

function dismissReq(over: Record<string, unknown> = {}) {
  const opId = canonicalSuggestionOpId(RID, "tok2")
  return {
    v: 1 as const,
    requestId: "r2",
    opId,
    op: "suggestion/dismiss" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: {},
    ...over,
  }
}

function terminalAccept(req: ReturnType<typeof acceptReq>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses_peer0000000000000001",
    requestID: RID,
    index: 0,
    action: { label: "Run", prompt: "Run tests" },
  }
}

function terminalDismiss(req: ReturnType<typeof dismissReq>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses_peer0000000000000001",
    requestID: RID,
  }
}

function notFound(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code: "suggestion.not_found", retryable: false, time: 1 },
    sideEffect: false,
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

function setupPeer(epoch: number, caps: unknown = ["suggestion/accept", "suggestion/dismiss"]) {
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

describe("suggestion private peer", () => {
  test("malformed request fails closed before transport", () => {
    const bad = acceptReq({ payload: { index: -1 } })
    const { chan, peer } = setupPeer(5)
    try {
      expect(() => peer.privateSuggestionAcceptWithHandle(bad as never)).toThrow()
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
    expect(() => peer.privateSuggestionAcceptWithHandle(acceptReq() as never)).toThrow("Private peer unavailable")
    expect(() => peer.privateSuggestionDismissWithHandle(dismissReq() as never)).toThrow("Private peer unavailable")
    ;(peer as unknown as Record<string, unknown>).available = true
    peer.dispose()
    expect(() => peer.privateSuggestionAcceptWithHandle(acceptReq() as never)).toThrow()
    chan.backendPeer.dispose()
    chan.clientReader.destroy()
    chan.clientWriter.destroy()
  })

  test("capability gating requires suggestion caps", () => {
    const { chan, peer } = setupPeer(5, ["question/list"])
    expect(() => peer.privateSuggestionAcceptWithHandle(acceptReq() as never)).toThrow(
      "Private peer missing suggestion/accept capability",
    )
    expect(() => peer.privateSuggestionDismissWithHandle(dismissReq() as never)).toThrow(
      "Private peer missing suggestion/dismiss capability",
    )
    peer.dispose()
    chan.backendPeer.dispose()
    chan.clientReader.destroy()
    chan.clientWriter.destroy()
  })

  test("accept handle resolves validated terminal with zero mutation", async () => {
    const req = acceptReq()
    const terminal = terminalAccept(req)
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("suggestion/accept")
      return terminal
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["suggestion/accept", "suggestion/dismiss"]
    try {
      const out = await peer.privateSuggestionAcceptWithHandle(req as never).promise
      expect(out.kind).toBe("terminal")
      const direct = await peer.privateSuggestionAccept(req as never)
      expect(direct.kind).toBe("terminal")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("dismiss handle resolves terminal-failure not_found", async () => {
    const req = dismissReq()
    const failure = notFound(req)
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => failure)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["suggestion/accept", "suggestion/dismiss"]
    try {
      const out = await peer.privateSuggestionDismissWithHandle(req as never).promise
      expect(out.kind).toBe("terminal-failure")
      if (out.kind === "terminal-failure") expect(out.failure.code).toBe("suggestion.not_found")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("invalid wire maps to ambiguous with exact id ownership", async () => {
    const req = acceptReq()
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ kind: "terminal", v: 999 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["suggestion/accept", "suggestion/dismiss"]
    try {
      const handle = peer.privateSuggestionAcceptWithHandle(req as never)
      const out = await handle.promise
      expect(out.kind).toBe("ambiguous")
      expect(typeof handle.id).toBe("number")
    } finally {
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })
})
