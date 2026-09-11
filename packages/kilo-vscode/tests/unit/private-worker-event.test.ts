import { describe, it, expect } from "bun:test"
import { PassThrough } from "stream"
import { encodeFrame, FrameDecoder } from "../../src/private-worker/frame"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { CANCEL_REQUEST_METHOD, JsonRpcPeer, REQUEST_EVENT_METHOD, type RequestContext } from "../../src/private-worker/peer"

function pair(onRequest?: (method: string, params: unknown, ctx: RequestContext) => unknown | Promise<unknown>, onNotification?: (m: string, p: unknown) => void) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
  const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest, onNotification })
  return { client, server, aToB, bToA }
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 5))
  }
}

function abortWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

describe("JsonRpcPeer per-request correlated events", () => {
  it("concurrent correlation via explicit id, no cross-deliver", async () => {
    const { client, server } = pair(async (_m, _p, ctx) => {
      ctx.emit({ seq: 1, owner: ctx.id })
      ctx.emit({ seq: 2, owner: ctx.id })
      return `ok-${ctx.id}`
    })
    const evA: unknown[] = []
    const evB: unknown[] = []
    const hA = client.requestWithId("stream", { which: "A" }, (e) => evA.push(e))
    const hB = client.requestWithId("stream", { which: "B" }, (e) => evB.push(e))
    void hA.promise.catch(() => {})
    void hB.promise.catch(() => {})
    const [rA, rB] = await Promise.all([hA.promise, hB.promise])
    expect(rA === `ok-${hA.id}` || rA === `ok-${hB.id}`).toBe(true)
    expect(rB === `ok-${hA.id}` || rB === `ok-${hB.id}`).toBe(true)
    expect(evA.length).toBe(2)
    expect(evB.length).toBe(2)
    for (const e of evA) expect((e as { owner: unknown }).owner).toBe(hA.id)
    for (const e of evB) expect((e as { owner: unknown }).owner).toBe(hB.id)
    expect((evA[0] as { seq: number }).seq).toBe(1)
    expect((evA[1] as { seq: number }).seq).toBe(2)
    expect((evB[0] as { seq: number }).seq).toBe(1)
    expect((evB[1] as { seq: number }).seq).toBe(2)
    client.dispose()
    server.dispose()
  })

  it("ordered events then terminal result preserving FIFO", async () => {
    const { client, server } = pair(async (_m, _p, ctx) => {
      ctx.emit({ n: 1 })
      ctx.emit({ n: 2 })
      ctx.emit({ n: 3 })
      return "done"
    })
    const ev: unknown[] = []
    const order: string[] = []
    const { promise } = client.requestWithId("stream", {}, (e) => {
      ev.push(e)
      order.push(`event:${(e as { n: number }).n}`)
    })
    const final = await promise.then((v) => {
      order.push(`result:${v}`)
      return v
    })
    expect(final).toBe("done")
    expect(ev.length).toBe(3)
    expect((ev[0] as { n: number }).n).toBe(1)
    expect((ev[1] as { n: number }).n).toBe(2)
    expect((ev[2] as { n: number }).n).toBe(3)
    expect(order).toEqual(["event:1", "event:2", "event:3", "result:done"])
    client.dispose()
    server.dispose()
  })

  it("no events after terminal success; late event ignored and cannot recreate state", async () => {
    const { client, server, bToA } = pair(async (_m, _p, ctx) => {
      ctx.emit({ kind: "before" })
      return "ok"
    })
    const ev: unknown[] = []
    const { id, promise } = client.requestWithId("stream", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    const res = await promise
    expect(res).toBe("ok")
    expect(ev.length).toBe(1)
    expect((ev[0] as { kind: string }).kind).toBe("before")
    expect(client.getPendingCount()).toBe(0)
    bToA.write(encodeFrame({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id, event: { kind: "late" } } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(ev.length).toBe(1)
    expect(client.getPendingCount()).toBe(0)
    expect(client.getPendingIds().includes(id)).toBe(false)
    client.dispose()
    server.dispose()
  })

  it("no events after tryCancelPending drop, late events ignored", async () => {
    let seen: RequestContext | undefined
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { client, server } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await gate
      ctx.emit({ seq: 99 })
      return "late"
    })
    const ev: unknown[] = []
    const { id, promise } = client.requestWithId("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    expect(seen?.id).toBe(id)
    expect(client.tryCancelPending(id)).toBe(true)
    await expect(promise).rejects.toThrow("private parity timeout")
    expect(client.getPendingCount()).toBe(0)
    release()
    await waitFor(() => server.getIncomingCount() === 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(ev.length).toBe(0)
    expect(client.getPendingIds().includes(id)).toBe(false)
    client.dispose()
    server.dispose()
  })

  it("no events after cancel drop, late events ignored", async () => {
    let seen: RequestContext | undefined
    const { client, server } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await abortWait(ctx.signal)
      ctx.emit({ late: true })
      const err = new Error("aborted") as Error & { name: string }
      err.name = "AbortError"
      throw err
    })
    const ev: unknown[] = []
    const { id, promise } = client.requestWithId("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    expect(client.cancel(id)).toBe(true)
    await expect(promise).rejects.toThrow("private parity timeout")
    await waitFor(() => seen?.signal.aborted === true)
    await waitFor(() => server.getIncomingCount() === 0)
    expect(ev.length).toBe(0)
    expect(client.getPendingCount()).toBe(0)
    client.dispose()
    server.dispose()
  })

  it("cancel aborts RequestContext.signal, existing cancel semantics preserved", async () => {
    let seen: RequestContext | undefined
    let aborted = false
    const { client, server } = pair(async (_m, _p, ctx) => {
      seen = ctx
      ctx.signal.addEventListener("abort", () => (aborted = true), { once: true })
      await abortWait(ctx.signal)
      return "should-not-resolve"
    })
    const ev: unknown[] = []
    const { id, promise } = client.requestWithId("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    expect(seen?.signal.aborted).toBe(false)
    expect(client.cancel(id)).toBe(true)
    await expect(promise).rejects.toThrow("private parity timeout")
    try {
      await promise
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
    }
    await waitFor(() => seen?.signal.aborted === true)
    expect(aborted).toBe(true)
    expect(client.getPendingCount()).toBe(0)
    await waitFor(() => server.getIncomingCount() === 0)
    expect(ev.length).toBe(0)
    client.dispose()
    server.dispose()
  })

  it("peer close/dispose removes registration, late events ignored", async () => {
    let seen: RequestContext | undefined
    const { client, server, bToA } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await abortWait(ctx.signal)
      return "never"
    })
    const ev: unknown[] = []
    const { id, promise } = client.requestWithId("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    server.dispose()
    await waitFor(() => seen?.signal.aborted === true)
    expect(server.getIncomingCount()).toBe(0)
    client.dispose()
    expect(client.getState()).toBe("closed")
    expect(client.getPendingCount()).toBe(0)
    await expect(promise).rejects.toThrow()
    bToA.write(encodeFrame({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id, event: { late: 1 } } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(ev.length).toBe(0)
    expect(client.getPendingCount()).toBe(0)
  })

  it("request send/write failure removes registration and closes peer", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    const peer = new JsonRpcPeer({ reader, writer })
    const ev: unknown[] = []
    const orig = writer.write.bind(writer)
    ;(writer as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
      throw new Error("sync writer failure")
    }
    const { id, promise } = peer.requestWithId("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    expect(peer.getState()).toBe("closed")
    expect(peer.getPendingCount()).toBe(0)
    await expect(promise).rejects.toThrow()
    const late = encodeFrame({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id, event: { x: 1 } } })
    reader.write(late)
    await new Promise((r) => setTimeout(r, 20))
    expect(ev.length).toBe(0)
    expect(peer.getPendingCount()).toBe(0)
    peer.dispose()
    reader.destroy()
    writer.destroy()
    void orig
  })

  it("malformed event notifications ignored, peer stays open, valid still routed", async () => {
    const { client, server, bToA } = pair(async (_m, _p, ctx) => {
      ctx.emit({ ok: 1 })
      return "done"
    })
    const ev: unknown[] = []
    const { promise } = client.requestWithId("stream", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    const raw = (obj: unknown) => bToA.write(encodeFrame(obj))
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: null })
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { event: { x: 1 } } })
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id: null, event: { x: 1 } } })
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id: "not-exist", event: { x: 1 } } })
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD })
    await new Promise((r) => setTimeout(r, 20))
    expect(client.getState()).toBe("open")
    expect(server.getState()).toBe("open")
    const res = await promise
    expect(res).toBe("done")
    expect(ev.length).toBe(1)
    expect((ev[0] as { ok: number }).ok).toBe(1)
    client.dispose()
    server.dispose()
  })

  it("unary regression: request without handler still works, ordinary notifications still delivered", async () => {
    const got: Array<{ method: string; params: unknown }> = []
    const { client, server } = pair(async (method, _p, ctx) => {
      expect(ctx.emit).toBeDefined()
      return "unary-ok"
    }, (m, p) => got.push({ method: m, params: p }))
    const r1 = await client.request("unary")
    expect(r1).toBe("unary-ok")
    const r2 = await client.requestWithId("unary2").promise
    expect(r2).toBe("unary-ok")
    client.notify("event.test", { seq: 1 })
    await waitFor(() => got.length === 1)
    expect(got[0]!.method).toBe("event.test")
    const before = got.length
    const aToB = new PassThrough()
    const bToA2 = new PassThrough()
    const c2 = new JsonRpcPeer({ reader: bToA2, writer: aToB })
    const s2 = new JsonRpcPeer({ reader: aToB, writer: bToA2, onNotification: (m, p) => got.push({ method: m, params: p }) })
    aToB.write(encodeFrame({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id: 9999, event: { x: 1 } } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(got.length).toBe(before)
    c2.dispose()
    s2.dispose()
    client.dispose()
    server.dispose()
  })

  it("requestWithEvents alias atomic before frames, and tryCancelPending local-only", async () => {
    let seen: RequestContext | undefined
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => (release = r))
    const domain: Array<{ method: string; params: unknown }> = []
    const { client, server } = pair(async (_m, _p, ctx) => {
      seen = ctx
      return gate
    }, (m, p) => domain.push({ method: m, params: p }))
    const ev: unknown[] = []
    const { id, promise } = client.requestWithEvents("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    expect(client.tryCancelPending(id)).toBe(true)
    await expect(promise).rejects.toThrow("private parity timeout")
    await new Promise((r) => setTimeout(r, 20))
    expect(seen?.signal.aborted).toBe(false)
    expect(domain.length).toBe(0)
    expect(ev.length).toBe(0)
    release("late-ok")
    await waitFor(() => server.getIncomingCount() === 0)
    expect(client.getPendingCount()).toBe(0)
    client.dispose()
    server.dispose()
  })

  it("ctx.emit returns false after handler completed and after peer closed", async () => {
    let captured!: RequestContext
    const { client, server } = pair(async (_m, _p, ctx) => {
      captured = ctx
      ctx.emit({ a: 1 })
      return "done"
    })
    const ev: unknown[] = []
    const { promise } = client.requestWithId("stream", {}, (e) => ev.push(e))
    const res = await promise
    expect(res).toBe("done")
    expect(ev.length).toBe(1)
    expect(captured.emit({ late: true })).toBe(false)
    server.dispose()
    expect(captured.emit({ late2: true })).toBe(false)
    client.dispose()
  })
})
