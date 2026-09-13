import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import type { KiloProfileContractRequest } from "./serve-private-kilo-profile-contract"

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

function req(): KiloProfileContractRequest {
  return { v: 1, requestId: "r1", op: "kilo/profile", context: { directory: "/tmp" }, payload: {} }
}

function success(r: KiloProfileContractRequest, email = "a@b.c") {
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/profile",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { profile: { email }, balance: null, kiloPass: null, currentOrgId: null },
  }
}

function terminal(r: KiloProfileContractRequest, code: string, message: string) {
  const failure = { code, message, retryable: false }
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/profile",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function retryable(r: KiloProfileContractRequest) {
  const failure = { code: "upstream", message: "kilo gateway upstream failed", retryable: true }
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/profile",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function wirePeer(
  clientReader: PassThrough,
  clientWriter: PassThrough,
  epoch: number,
): ServePrivatePeer {
  const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch })
  ;(peer as unknown as Record<string, unknown>).available = true
  ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({
    reader: clientReader,
    writer: clientWriter,
  })
  ;(peer as unknown as Record<string, unknown>).capabilities = ["kilo/profile"]
  return peer
}

function disposeAll(peer: ServePrivatePeer, backendPeer: JsonRpcPeer, r: PassThrough, w: PassThrough): void {
  peer.dispose()
  backendPeer.dispose()
  r.destroy()
  w.destroy()
}

describe("kilo/profile peer settle-first stale semantics (this op only)", () => {
  test("validated success is preserved across post-response epoch drift", async () => {
    const r = req()
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((resolve) => (release = resolve))
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = wirePeer(clientReader, clientWriter, 5)
    const handle = peer.privateKiloProfileOutcomeWithHandle(r)
    const waited = handle.promise
    // Drift after the call but before the response resolves.
    ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 6
    release(success(r))
    const out = await waited
    expect(out.kind).toBe("valid")
    if (out.kind !== "valid") throw new Error("expected valid")
    expect(out.result.status).toBe("succeeded")
    disposeAll(peer, backendPeer, clientReader, clientWriter)
  })

  test("retryable=false terminal is preserved across post-response drift", async () => {
    const r = req()
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((resolve) => (release = resolve))
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = wirePeer(clientReader, clientWriter, 5)
    const handle = peer.privateKiloProfileOutcomeWithHandle(r)
    const waited = handle.promise
    ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 7
    release(terminal(r, "unauthorized", "not authenticated with Kilo Gateway"))
    const out = await waited
    expect(out.kind).toBe("valid")
    if (out.kind !== "valid") throw new Error("expected valid")
    expect(out.result.status).toBe("failed")
    disposeAll(peer, backendPeer, clientReader, clientWriter)
  })

  test("retryable upstream maps drift to ambiguous (falls back)", async () => {
    const r = req()
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((resolve) => (release = resolve))
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = wirePeer(clientReader, clientWriter, 5)
    const handle = peer.privateKiloProfileOutcomeWithHandle(r)
    const waited = handle.promise
    ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 8
    release(retryable(r))
    const out = await waited
    expect(out.kind).toBe("valid")
    if (out.kind !== "valid") throw new Error("expected valid")
    expect(out.result.status).toBe("ambiguous")
    disposeAll(peer, backendPeer, clientReader, clientWriter)
  })

  test("invalid wire stays invalid across drift (never silently succeeds)", async () => {
    const r = req()
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((resolve) => (release = resolve))
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = wirePeer(clientReader, clientWriter, 5)
    const handle = peer.privateKiloProfileOutcomeWithHandle(r)
    const waited = handle.promise
    ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 9
    release({ ...success(r), data: { profile: {}, balance: null, kiloPass: null, currentOrgId: null } })
    const out = await waited
    expect(out.kind).toBe("invalid")
    disposeAll(peer, backendPeer, clientReader, clientWriter)
  })

  test("other ops keep generic stale-first semantics (mcp/status control)", async () => {
    const mcpReq = {
      v: 1,
      requestId: "m1",
      opId: "mcp-status:t1",
      op: "mcp/status",
      idempotencyKey: "mcp-status:t1",
      context: { directory: "/tmp" },
      payload: {},
    }
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((resolve) => (release = resolve))
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = wirePeer(clientReader, clientWriter, 5)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["kilo/profile", "mcp/status"]
    const handle = peer.privateMcpStatusOutcomeWithHandle(mcpReq as never)
    const waited = handle.promise
    ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 10
    release({
      v: 1,
      requestId: "m1",
      opId: "mcp-status:t1",
      op: "mcp/status",
      idempotencyKey: "mcp-status:t1",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: {} },
    })
    const out = (await waited) as { kind: string; result: { status: string } }
    expect(out.kind).toBe("valid")
    // Generic mcp/status path stays stale-first: settled success after drift
    // still maps to ambiguous here, proving the kilo/profile settle-first
    // change did not leak to other ops.
    expect(out.result.status).toBe("ambiguous")
    disposeAll(peer, backendPeer, clientReader, clientWriter)
  })
})
