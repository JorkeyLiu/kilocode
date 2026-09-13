import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalAuthRemoveOpId } from "./serve-private-auth-remove-contract"

function authReq(token = "tok1", providerID = "kilo") {
  const opId = canonicalAuthRemoveOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "auth/remove" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { providerID },
  }
}

function okResult(req: ReturnType<typeof authReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { removed: true },
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

describe("auth-remove private peer", () => {
  test("capability gating is fail-closed", async () => {
    const { peer, backend, client } = await peerFor(["session/status"], async () => okResult(authReq()))
    expect(peer.hasCapability("auth/remove")).toBeFalse()
    expect(() => peer.privateAuthRemoveOutcomeWithHandle(authReq() as never)).toThrow(
      "Private peer missing auth/remove capability",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("auth/remove success resolves strictly valid result with stable provider identity", async () => {
    const { peer, backend, client } = await peerFor(["auth/remove"], async (method: string, params: unknown) => {
      expect(method).toBe("auth/remove")
      const p = params as { payload: { providerID: string } }
      expect(p.payload.providerID).toBe("kilo")
      return okResult(params as never)
    })
    const out = await peer.privateAuthRemoveWithHandle(authReq("peer-ok") as never).promise
    expect(out.op).toBe("auth/remove")
    expect(out.status).toBe("succeeded")
    if (out.status === "succeeded") expect(out.data).toEqual({ removed: true })
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("invalid wire rejects with the auth-remove validation error", async () => {
    const { peer, backend, client } = await peerFor(["auth/remove"], async () => ({ garbled: true }))
    await expect(peer.privateAuthRemoveWithHandle(authReq("peer-bad") as never).promise).rejects.toThrow(
      "invalid private response shape",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })
})
