import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalPtyRemoveOpId, canonicalPtyUpdateOpId } from "./serve-private-pty-contract"

const PTY = "pty_aaaaaaaaaaaaaaaaaaaaaaaaaa"

function updateReq(token = "tok1") {
  const opId = canonicalPtyUpdateOpId(PTY, token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "pty/update" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", ptyID: PTY },
    payload: { size: { rows: 24, cols: 80 } },
  }
}

function removeReq(token = "tok1") {
  const opId = canonicalPtyRemoveOpId(PTY, token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "pty/remove" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", ptyID: PTY },
    payload: {},
  }
}

function okUpdate(req: ReturnType<typeof updateReq>) {
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

function okRemove(req: ReturnType<typeof removeReq>) {
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

describe("pty private peer", () => {
  test("capability gating is fail-closed for both ops", async () => {
    const { peer, backend, client } = await peerFor(["session/status"], async () => okUpdate(updateReq()))
    expect(peer.hasCapability("pty/update")).toBeFalse()
    expect(peer.hasCapability("pty/remove")).toBeFalse()
    expect(() => peer.privatePtyUpdateOutcomeWithHandle(updateReq() as never)).toThrow(
      "Private peer missing pty/update capability",
    )
    expect(() => peer.privatePtyRemoveOutcomeWithHandle(removeReq() as never)).toThrow(
      "Private peer missing pty/remove capability",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("update success resolves strictly valid result with same tuple", async () => {
    const { peer, backend, client } = await peerFor(["pty/update"], async (method: string, params: unknown) => {
      expect(method).toBe("pty/update")
      const p = params as {
        context: { ptyID: string; directory: string }
        payload: { size: { rows: number; cols: number } }
      }
      expect(p.context.ptyID).toBe(PTY)
      expect(p.payload.size).toEqual({ rows: 24, cols: 80 })
      return okUpdate(params as never)
    })
    const out = await peer.privatePtyUpdateWithHandle(updateReq("peer-ok") as never).promise
    expect(out.op).toBe("pty/update")
    expect(out.status).toBe("succeeded")
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("remove success resolves strictly valid result", async () => {
    const { peer, backend, client } = await peerFor(["pty/remove"], async () => okRemove(removeReq("peer-ok") as never))
    const out = await peer.privatePtyRemoveWithHandle(removeReq("peer-ok") as never).promise
    expect(out.op).toBe("pty/remove")
    expect(out.status).toBe("succeeded")
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("pty transport failures are redacted to a fixed safe message", async () => {
    const { requestPtyUpdateOutcome } = await import("./serve-private-pty")
    const req = updateReq("peer-transport")
    const rawErr = new Error("secret transport boom /tmp/pty-abc detail=hidden")
    ;(rawErr as unknown as Record<string, unknown>).code = -32603
    const raw = {
      requestWithId: () => ({ id: 7, promise: Promise.reject(rawErr) }),
    }
    const host = {
      isStale: () => false,
      isClosed: () => false,
      failInfo: () => ({ code: "-32603", msg: "secret transport boom /tmp/pty-abc detail=hidden" }),
    }
    const handle = requestPtyUpdateOutcome(raw as never, host, () => () => true, req as never)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid failure outcome")
    const result = outcome.result as {
      status: string
      failure: { code: string; message: string; retryable: boolean }
      outcome: { failure: { code: string; message: string; retryable: boolean } }
    }
    expect(result.status).toBe("failed")
    expect(result.failure.code).toBe("transport")
    expect(result.failure.message).toBe("private pty-update transport failed")
    expect(result.failure.retryable).toBe(false)
    expect(result.outcome.failure.code).toBe("transport")
    const leaked = JSON.stringify(result)
    expect(leaked.includes("secret transport boom")).toBeFalse()
    expect(leaked.includes("pty-abc")).toBeFalse()
    expect(leaked.includes("detail=hidden")).toBeFalse()
    expect(leaked.includes("-32603")).toBeFalse()
  })

  test("invalid wire rejects with the pty validation error", async () => {
    const { peer, backend, client } = await peerFor(["pty/update"], async () => ({ garbled: true }))
    await expect(peer.privatePtyUpdateWithHandle(updateReq("peer-bad") as never).promise).rejects.toThrow(
      "invalid private response shape",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })
})
