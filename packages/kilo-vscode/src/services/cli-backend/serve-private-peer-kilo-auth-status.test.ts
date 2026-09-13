import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import type { KiloAuthStatusContractRequest } from "./serve-private-kilo-auth-status-contract"

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

function req(): KiloAuthStatusContractRequest {
  return { v: 1, requestId: "r1", op: "kilo/auth-status", context: { directory: "/tmp" }, payload: {} }
}

function success(r: KiloAuthStatusContractRequest) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/auth-status",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { authenticated: true, type: "oauth" },
  }
}

function terminal(r: KiloAuthStatusContractRequest, code: string, message: string) {
  const failure = { code, message, retryable: false }
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/auth-status",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function ambiguous(r: KiloAuthStatusContractRequest) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/auth-status",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
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
  ;(peer as unknown as Record<string, unknown>).capabilities = ["kilo/auth-status"]
  return peer
}

function disposeAll(peer: ServePrivatePeer, backendPeer: JsonRpcPeer, r: PassThrough, w: PassThrough): void {
  peer.dispose()
  backendPeer.dispose()
  r.destroy()
  w.destroy()
}

describe("kilo/auth-status peer settle-first stale semantics (this op only)", () => {
  test("validated success is preserved across post-response epoch drift", async () => {
    const r = req()
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((resolve) => (release = resolve))
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = wirePeer(clientReader, clientWriter, 5)
    const handle = peer.privateKiloAuthStatusOutcomeWithHandle(r)
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
    const handle = peer.privateKiloAuthStatusOutcomeWithHandle(r)
    const waited = handle.promise
    ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 7
    release(terminal(r, "internal", "internal error"))
    const out = await waited
    expect(out.kind).toBe("valid")
    if (out.kind !== "valid") throw new Error("expected valid")
    expect(out.result.status).toBe("failed")
    disposeAll(peer, backendPeer, clientReader, clientWriter)
  })

  test("unresolved ambiguous maps drift to ambiguous (falls back)", async () => {
    const r = req()
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((resolve) => (release = resolve))
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = wirePeer(clientReader, clientWriter, 5)
    const handle = peer.privateKiloAuthStatusOutcomeWithHandle(r)
    const waited = handle.promise
    ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 8
    release(ambiguous(r))
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
    const handle = peer.privateKiloAuthStatusOutcomeWithHandle(r)
    const waited = handle.promise
    ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 9
    release({ ...success(r), data: { authenticated: true, type: "oauth", token: "secret" } })
    const out = await waited
    expect(out.kind).toBe("invalid")
    disposeAll(peer, backendPeer, clientReader, clientWriter)
  })

  test("missing capability fails closed before any transport work", () => {
    const r = req()
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => success(r))
    const peer = wirePeer(clientReader, clientWriter, 5)
    ;(peer as unknown as Record<string, unknown>).capabilities = ["kilo/profile"]
    expect(() => peer.privateKiloAuthStatusOutcomeWithHandle(r)).toThrow("kilo/auth-status capability")
    disposeAll(peer, backendPeer, clientReader, clientWriter)
  })
})
