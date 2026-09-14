import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalBackgroundStopSessionOpId } from "./serve-private-background-process-stop-session-contract"

const SID = "ses_ffffffffffffffffffffffff"

function stopReq(token = "tok1") {
  const opId = canonicalBackgroundStopSessionOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "background-process/stop-session" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", sessionId: SID },
    payload: {},
  }
}

function okResult(req: ReturnType<typeof stopReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { stopped: true },
  }
}

async function peerFor(caps: string[], handler: (method: string, params: unknown) => unknown) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backend = new JsonRpcPeer({ reader: toBackend, writer: toClient, onRequest: handler as never })
  const client = new JsonRpcPeer({ reader: toClient, writer: toBackend })
  const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, epoch: 1 })
  ;(peer as unknown as { capabilities: unknown }).capabilities = caps
  ;(peer as unknown as { available: boolean }).available = true
  ;(peer as unknown as { peer: unknown }).peer = client
  return { peer, backend, client }
}

describe("background stop-session private peer", () => {
  test("capability gating is fail-closed", async () => {
    const { peer, backend, client } = await peerFor(["session/status"], async () => okResult(stopReq()))
    expect(peer.hasCapability("background-process/stop-session")).toBeFalse()
    expect(() => peer.privateBackgroundStopSessionOutcomeWithHandle(stopReq() as never)).toThrow(
      "Private peer missing background-process/stop-session capability",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("stop-session success resolves strictly valid result", async () => {
    const { peer, backend, client } = await peerFor(
      ["background-process/stop-session"],
      async (method: string, params: unknown) => {
        expect(method).toBe("background-process/stop-session")
        const p = params as { context: { sessionId: string; directory: string } }
        expect(p.context.sessionId).toBe(SID)
        expect(p.context.directory).toBe("/tmp")
        return okResult(params as never)
      },
    )
    const out = await peer.privateBackgroundStopSessionWithHandle(stopReq("peer-ok") as never).promise
    expect(out.op).toBe("background-process/stop-session")
    expect(out.status).toBe("succeeded")
    if (out.status === "succeeded") expect(out.data).toEqual({ stopped: true })
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("invalid wire rejects with the stop-session validation error", async () => {
    const { peer, backend, client } = await peerFor(["background-process/stop-session"], async () => ({
      garbled: true,
    }))
    await expect(peer.privateBackgroundStopSessionWithHandle(stopReq("peer-bad") as never).promise).rejects.toThrow(
      "invalid private response shape",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })
})
