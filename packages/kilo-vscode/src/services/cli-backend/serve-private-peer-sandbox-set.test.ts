import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalSandboxSetOpId } from "./serve-private-sandbox-set-contract"

function setReq(sid = "ses_abc", token = "tok1", enabled = true) {
  const opId = canonicalSandboxSetOpId(sid, token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "sandbox/set" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", sessionId: sid },
    payload: { enabled, sessionId: sid },
  }
}

function okResult(req: ReturnType<typeof setReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { directory: "/tmp", enabled: req.payload.enabled, available: true, version: 1 } },
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

describe("sandbox-set private peer", () => {
  test("capability gating is fail-closed", async () => {
    const { peer, backend, client } = await peerFor(["sandbox/set"], async () => okResult(setReq()))
    expect(peer.hasCapability("sandbox/set")).toBeTrue()
    expect(() => peer.privateSandboxSetOutcomeWithHandle(setReq() as never)).not.toThrow()
    peer.dispose()
    client.dispose()
    backend.dispose()
    const missing = await peerFor([], async () => okResult(setReq()))
    expect(() => missing.peer.privateSandboxSetOutcomeWithHandle(setReq() as never)).toThrow(
      "Private peer missing sandbox/set capability",
    )
    missing.peer.dispose()
    missing.client.dispose()
    missing.backend.dispose()
  })

  test("echoes the same desired target", async () => {
    const { peer, backend, client } = await peerFor(["sandbox/set"], async (_m: string, p: unknown) => okResult(p as ReturnType<typeof setReq>))
    const on = await peer.privateSandboxSetWithHandle(setReq("ses_abc", "on1", true) as never).promise
    if (on.status === "succeeded") expect(on.data.status.enabled).toBeTrue()
    const off = await peer.privateSandboxSetWithHandle(setReq("ses_abc", "off1", false) as never).promise
    if (off.status === "succeeded") expect(off.data.status.enabled).toBeFalse()
    peer.dispose()
    client.dispose()
    backend.dispose()
  })
})
