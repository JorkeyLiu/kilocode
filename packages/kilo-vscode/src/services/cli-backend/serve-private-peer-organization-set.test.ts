import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalOrganizationSetOpId } from "./serve-private-organization-set-contract"

function orgReq(token = "tok1", organizationId: string | null = "org-1") {
  const opId = canonicalOrganizationSetOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "kilo/organization/set" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { organizationId },
  }
}

function okResult(req: ReturnType<typeof orgReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { updated: true },
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

describe("organization-set private peer", () => {
  test("capability gating is fail-closed", async () => {
    const { peer, backend, client } = await peerFor(["session/status"], async () => okResult(orgReq()))
    expect(peer.hasCapability("kilo/organization/set")).toBeFalse()
    expect(() => peer.privateOrganizationSetOutcomeWithHandle(orgReq() as never)).toThrow(
      "Private peer missing kilo/organization/set capability",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("organization/set success resolves strictly valid result with stable organization identity", async () => {
    const { peer, backend, client } = await peerFor(["kilo/organization/set"], async (method: string, params: unknown) => {
      expect(method).toBe("kilo/organization/set")
      const p = params as { payload: { organizationId: string | null } }
      expect(p.payload.organizationId).toBe("org-1")
      return okResult(params as never)
    })
    const out = await peer.privateOrganizationSetWithHandle(orgReq("peer-ok", "org-1") as never).promise
    expect(out.op).toBe("kilo/organization/set")
    expect(out.status).toBe("succeeded")
    if (out.status === "succeeded") expect(out.data).toEqual({ updated: true })
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("null organizationId (personal) resolves with the same identity", async () => {
    const { peer, backend, client } = await peerFor(["kilo/organization/set"], async (method: string, params: unknown) => {
      expect(method).toBe("kilo/organization/set")
      const p = params as { payload: { organizationId: string | null } }
      expect(p.payload.organizationId).toBeNull()
      return okResult(params as never)
    })
    const out = await peer.privateOrganizationSetWithHandle(orgReq("peer-null", null) as never).promise
    expect(out.status).toBe("succeeded")
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("invalid wire rejects with the organization-set validation error", async () => {
    const { peer, backend, client } = await peerFor(["kilo/organization/set"], async () => ({ garbled: true }))
    await expect(peer.privateOrganizationSetWithHandle(orgReq("peer-bad") as never).promise).rejects.toThrow(
      "invalid private response shape",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })
})
