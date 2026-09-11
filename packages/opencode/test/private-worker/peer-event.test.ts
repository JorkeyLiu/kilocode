import { describe, expect, test } from "bun:test"
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
  test("concurrent correlation via explicit id, no cross-deliver", async () => {
    const { client, server } = pair(async (_m, _p, ctx) => {
      // emit two events correlated to own id, FIFO before result
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
    expect(rA === `ok-${hA.id}` || rA === `ok-${hB.id}`).toBeTrue()
    expect(rB === `ok-${hA.id}` || rB === `ok-${hB.id}`).toBeTrue()
    // each handler got exactly 2 events for its own id, not mixed
    expect(evA.length).toBe(2)
    expect(evB.length).toBe(2)
    // verify payload owner matches respective id
    for (const e of evA) expect((e as { owner: unknown }).owner).toBe(hA.id)
    for (const e of evB) expect((e as { owner: unknown }).owner).toBe(hB.id)
    // ordering within each stream preserved
    expect((evA[0] as { seq: number }).seq).toBe(1)
    expect((evA[1] as { seq: number }).seq).toBe(2)
    expect((evB[0] as { seq: number }).seq).toBe(1)
    expect((evB[1] as { seq: number }).seq).toBe(2)
    client.dispose()
    server.dispose()
  })

  test("ordered events then terminal result preserving FIFO", async () => {
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
    // attach terminal ordering
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

  test("no events after terminal success; late event ignored and cannot recreate state", async () => {
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
    // late dangling event after terminal should be ignored and not recreate pending
    const decoder = new FrameDecoder()
    const frames: unknown[] = []
    // we capture server to client frames? Actually bToA is client->server, need server->client is aToB? In pair, aToB is client->server, bToA is server->client? Wait pair: client writer aToB, reader bToA ; server reader aToB writer bToA . So server->client is bToA
    // send raw late event from server side via bToA? Actually server writes to bToA, so to inject late event we write to bToA as if server sent it
    // Use server's writer is bToA, but we have direct access via bToA PassThrough; we can write encodeFrame to bToA
    bToA.write(encodeFrame({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id, event: { kind: "late" } } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(ev.length).toBe(1) // still 1, late ignored
    expect(client.getPendingCount()).toBe(0)
    // also ensure pending not recreated by checking getPendingIds
    expect(client.getPendingIds().includes(id)).toBeFalse()
    client.dispose()
    server.dispose()
  })

  test("no events after tryCancelPending drop, late events ignored", async () => {
    let seen: RequestContext | undefined
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { client, server } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await gate
      // try to emit after client dropped — should be ignored on client (pending gone)
      ctx.emit({ seq: 99 })
      return "late"
    })
    const ev: unknown[] = []
    const { id, promise } = client.requestWithId("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    expect(seen?.id).toBe(id)
    expect(client.tryCancelPending(id)).toBeTrue()
    await expect(promise).rejects.toThrow("private parity timeout")
    expect(client.getPendingCount()).toBe(0)
    // server still pending, then we release handler which emits late event
    release()
    await waitFor(() => server.getIncomingCount() === 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(ev.length).toBe(0) // dropped before any event
    // late event from server after drop must not recreate pending
    expect(client.getPendingIds().includes(id)).toBeFalse()
    client.dispose()
    server.dispose()
  })

  test("no events after cancel drop, late events ignored", async () => {
    let seen: RequestContext | undefined
    const { client, server } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await abortWait(ctx.signal)
      // emit after abort — client already dropped pending, should be ignored
      ctx.emit({ late: true })
      const err = new Error("aborted") as Error & { name: string }
      err.name = "AbortError"
      throw err
    })
    const ev: unknown[] = []
    const { id, promise } = client.requestWithId("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    expect(client.cancel(id)).toBeTrue()
    await expect(promise).rejects.toThrow("private parity timeout")
    await waitFor(() => seen?.signal.aborted === true)
    await waitFor(() => server.getIncomingCount() === 0)
    expect(ev.length).toBe(0)
    expect(client.getPendingCount()).toBe(0)
    client.dispose()
    server.dispose()
  })

  test("cancel aborts RequestContext.signal, existing cancel semantics preserved", async () => {
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
    // no domain notification leakage
    // pending cleared
    expect(client.getPendingCount()).toBe(0)
    await waitFor(() => server.getIncomingCount() === 0)
    expect(ev.length).toBe(0)
    client.dispose()
    server.dispose()
  })

  test("peer close/dispose removes registration, late events ignored", async () => {
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
    // dispose server side aborts incoming; client pending still? client hasn't cancelled yet
    server.dispose()
    await waitFor(() => seen?.signal.aborted === true)
    expect(server.getIncomingCount()).toBe(0)
    // client pending should still be there until closed? Actually server dispose does not close client; client pending remains until response or close
    // close client too
    client.dispose()
    expect(client.getState()).toBe("closed")
    expect(client.getPendingCount()).toBe(0)
    await expect(promise).rejects.toThrow()
    // late event after dispose should be ignored (no recreate)
    bToA.write(encodeFrame({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id, event: { late: 1 } } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(ev.length).toBe(0)
    expect(client.getPendingCount()).toBe(0)
  })

  test("request send/write failure removes registration and closes peer", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    const peer = new JsonRpcPeer({ reader, writer })
    const ev: unknown[] = []
    // make writer fail on next write
    const orig = writer.write.bind(writer)
    ;(writer as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
      throw new Error("sync writer failure")
    }
    const { id, promise } = peer.requestWithId("slow", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    expect(peer.getState()).toBe("closed")
    expect(peer.getPendingCount()).toBe(0)
    await expect(promise).rejects.toThrow()
    // late event cannot recreate
    const late = encodeFrame({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id, event: { x: 1 } } })
    // write to reader (incoming) to simulate peer receiving late event
    reader.write(late)
    await new Promise((r) => setTimeout(r, 20))
    expect(ev.length).toBe(0)
    expect(peer.getPendingCount()).toBe(0)
    peer.dispose()
    reader.destroy()
    writer.destroy()
    void orig
  })

  test("malformed event notifications ignored, peer stays open, valid still routed", async () => {
    const { client, server, bToA } = pair(async (_m, _p, ctx) => {
      ctx.emit({ ok: 1 })
      return "done"
    })
    const ev: unknown[] = []
    const domain: Array<{ method: string; params: unknown }> = []
    // also track domain notifications
    const pair2 = pair(undefined, (m, p) => domain.push({ method: m, params: p }))
    // we will use client/server from first pair for event test; also test domain unaffected
    const { id, promise } = client.requestWithId("stream", {}, (e) => ev.push(e))
    void promise.catch(() => {})
    // inject malformed events before terminal: they should be ignored, peer stays open
    const raw = (obj: unknown) => bToA.write(encodeFrame(obj))
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: null })
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id } }) // missing event
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { event: { x: 1 } } }) // missing id
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id: null, event: { x: 1 } } })
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id: "not-exist", event: { x: 1 } } })
    raw({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD }) // no params
    await new Promise((r) => setTimeout(r, 20))
    expect(client.getState()).toBe("open")
    expect(server.getState()).toBe("open")
    const res = await promise
    expect(res).toBe("done")
    // only the valid server-emitted event should be present, malformed ignored
    expect(ev.length).toBe(1)
    expect((ev[0] as { ok: number }).ok).toBe(1)
    client.dispose()
    server.dispose()
    pair2.client.dispose()
    pair2.server.dispose()
  })

  test("unary regression: request without handler still works, ordinary notifications still delivered", async () => {
    const got: Array<{ method: string; params: unknown }> = []
    const { client, server } = pair(async (method, _p, ctx) => {
      // unary handler does not emit
      expect(ctx.emit).toBeDefined()
      // ensure emit not called breaks unary
      return "unary-ok"
    }, (m, p) => got.push({ method: m, params: p }))
    const r1 = await client.request("unary")
    expect(r1).toBe("unary-ok")
    const r2 = await client.requestWithId("unary2").promise
    expect(r2).toBe("unary-ok")
    // ordinary notification still reaches onNotification, not mistaken for event
    client.notify("event.test", { seq: 1 })
    await waitFor(() => got.length === 1)
    expect(got[0]!.method).toBe("event.test")
    // event notification for unknown id should not surface as domain notification
    const before = got.length
    const bToA = (client as unknown as { reader: PassThrough }).reader as PassThrough
    // we need server->client channel: server writes to bToA (client reader)
    // send an event for unknown id via server side? Use second pair to craft
    const aToB = new PassThrough()
    const bToA2 = new PassThrough()
    const c2 = new JsonRpcPeer({ reader: bToA2, writer: aToB })
    const s2 = new JsonRpcPeer({ reader: aToB, writer: bToA2, onNotification: (m, p) => got.push({ method: m, params: p }) })
    // craft event with pending? no pending, should be ignored, not pushed to got
    aToB.write(encodeFrame({ jsonrpc: "2.0", method: REQUEST_EVENT_METHOD, params: { id: 9999, event: { x: 1 } } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(got.length).toBe(before)
    c2.dispose()
    s2.dispose()
    client.dispose()
    server.dispose()
  })

  test("requestWithEvents alias atomic before frames, and tryCancelPending local-only", async () => {
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
    expect(client.tryCancelPending(id)).toBeTrue()
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

  test("ctx.emit returns false after handler completed and after peer closed", async () => {
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
    // after handler completed, emit should be false (incoming cleared)
    expect(captured.emit({ late: true })).toBeFalse()
    // after peer closed, emit false
    server.dispose()
    expect(captured.emit({ late2: true })).toBeFalse()
    client.dispose()
  })
})
