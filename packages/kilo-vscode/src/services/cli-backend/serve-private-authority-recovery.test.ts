import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { KiloConnectionService } from "./connection-service"
import { fetchMcpStatusPrivate, buildMcpStatusReq } from "../../kilo-provider/mcp-status-private"
import { fetchKiloAuthStatusPrivate } from "../../kilo-provider/kilo-auth-status-private"
import { fetchFindFilesTypePrivate } from "../../kilo-provider/find-files-private"

function authorityBackend(counts: Map<string, number>): { clientReader: PassThrough; clientWriter: PassThrough; backendPeer: JsonRpcPeer } {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: async (method, params) => {
      counts.set(method, (counts.get(method) ?? 0) + 1)
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued", "session/update", "mcp/status", "kilo/auth-status", "find/files", "transport/health"] }
      }
      if (method === "transport/health") {
        const p = params as { requestId: string }
        return { v: 1, requestId: p.requestId, op: "transport/health", status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { ok: true } }
      }
      if (method === "mcp/status") {
        const p = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: p.requestId, opId: p.opId, op: "mcp/status", idempotencyKey: p.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { status: {} } }
      }
      if (method === "kilo/auth-status") {
        const p = params as { requestId: string }
        return { v: 1, requestId: p.requestId, op: "kilo/auth-status", status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { authenticated: false } }
      }
      if (method === "find/files") {
        const p = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: p.requestId, opId: p.opId, op: "find/files", idempotencyKey: p.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { files: [] } }
      }
      return new Promise(() => {})
    },
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

describe("authority lazy recovery", () => {
  test("mcp/status recovers on next request after quarantine with zero SDK", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = authorityBackend(counts)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 21, epoch: 31, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const svc = new KiloConnectionService({} as never)
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = peer
    ;(svc as unknown as { privateEpoch: unknown }).privateEpoch = 31
    ;(svc as unknown as { privateAvailable: unknown }).privateAvailable = true
    // trigger quarantine via cancel miss on a hanging op
    const hanging = peer.privateSessionUpdateWithHandle({ v: 1, requestId: "t1", opId: "sessionUpdate:ses_q:tq", op: "session/update", idempotencyKey: "sessionUpdate:ses_q:tq", context: { directory: "/tmp", sessionId: "ses_q", parentSessionId: null }, payload: { title: "x" } } as never)
    hanging.cancel("test")
    await hanging.promise
    hanging.cancel("test")
    expect(peer.isQuarantined()).toBeTrue()
    const mcpBefore = counts.get("mcp/status") ?? 0
    const out = await fetchMcpStatusPrivate({ connection: svc as never, directory: "/tmp" })
    expect(out.kind).toBe("ok")
    expect((counts.get("transport/health") ?? 0)).toBe(1)
    expect((counts.get("mcp/status") ?? 0)).toBe(mcpBefore + 1)
    expect(svc.isPrivateAvailable()).toBeTrue()
    try { peer.dispose() } catch {}
    try { backendPeer.dispose() } catch {}
    try { clientReader.destroy() } catch {}
    try { clientWriter.destroy() } catch {}
  })

  test("kilo/auth-status recovers on next request after quarantine", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = authorityBackend(counts)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 22, epoch: 32, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const svc = new KiloConnectionService({} as never)
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = peer
    ;(svc as unknown as { privateEpoch: unknown }).privateEpoch = 32
    ;(svc as unknown as { privateAvailable: unknown }).privateAvailable = true
    peer.enterQuarantine("miss")
    const out = await fetchKiloAuthStatusPrivate({ connection: svc as never, directory: "/tmp" })
    expect(out.kind).toBe("ok")
    expect((counts.get("transport/health") ?? 0)).toBe(1)
    try { peer.dispose() } catch {}
    try { backendPeer.dispose() } catch {}
    try { clientReader.destroy() } catch {}
    try { clientWriter.destroy() } catch {}
  })

  test("find/files recovers on next request after quarantine", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = authorityBackend(counts)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 23, epoch: 33, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const svc = new KiloConnectionService({} as never)
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = peer
    ;(svc as unknown as { privateEpoch: unknown }).privateEpoch = 33
    ;(svc as unknown as { privateAvailable: unknown }).privateAvailable = true
    peer.enterQuarantine("miss")
    const out = await fetchFindFilesTypePrivate({ connection: svc as never, directory: "/tmp", query: "foo", type: "file" })
    expect(out.kind).toBe("ok")
    expect((counts.get("transport/health") ?? 0)).toBe(1)
    try { peer.dispose() } catch {}
    try { backendPeer.dispose() } catch {}
    try { clientReader.destroy() } catch {}
    try { clientWriter.destroy() } catch {}
  })

  test("triggering operation is not retried", async () => {
    const req = buildMcpStatusReq("/tmp")
    // Isolated hanging check: triggering op completes once with no retry
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    let mcpCalls = 0
    const b2 = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method, params) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued", "mcp/status", "transport/health"] }
        if (method === "mcp/status") {
          mcpCalls += 1
          return new Promise(() => {})
        }
        if (method === "transport/health") {
          const p = params as { requestId: string }
          return { v: 1, requestId: p.requestId, op: "transport/health", status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { ok: true } }
        }
        return new Promise(() => {})
      },
    })
    const p2 = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 25, epoch: 35, initializeTimeoutMs: 300 })
    expect(await p2.initialize(300)).toBeTrue()
    const h = p2.privateMcpStatusOutcomeWithHandle(req as never)
    // timeout cancel once (success), then miss quarantines; triggering promise settles once
    expect(h.cancel("test")).toBeTrue()
    await h.promise
    expect(mcpCalls).toBe(1)
    expect(h.cancel("test")).toBeFalse()
    expect(p2.isQuarantined()).toBeTrue()
    expect(mcpCalls).toBe(1)
    try { p2.dispose() } catch {}
    try { b2.dispose() } catch {}
    try { toClient.destroy() } catch {}
    try { toBackend.destroy() } catch {}
  })
})
