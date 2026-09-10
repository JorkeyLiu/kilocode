import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { FrameDecoder, encodeFrame } from "../../src/private-worker/frame"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { CANCEL_REQUEST_METHOD, JsonRpcPeer, type RequestContext } from "../../src/private-worker/peer"

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

describe("JsonRpcPeer wire-level incoming cancellation", () => {
  test("bidirectional cancel rejects sender, aborts remote signal, clears counts", async () => {
    let seen: RequestContext | undefined
    let observed = false
    const domain: Array<{ method: string; params: unknown }> = []
    const gate = new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (seen?.signal.aborted) {
          clearInterval(t)
          resolve()
        }
      }, 5)
    })
    const { client, server } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await gate
      observed = true
      const err = new Error("aborted") as Error & { name: string }
      err.name = "AbortError"
      throw err
    }, (m, p) => domain.push({ method: m, params: p }))
    const { id, promise } = client.requestWithId("slow")
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    expect(seen?.id).toBe(id)
    expect(seen?.signal.aborted).toBe(false)
    expect(client.cancel(id)).toBe(true)
    await expect(promise).rejects.toThrow("private parity timeout")
    try {
      await promise
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
    }
    await waitFor(() => seen?.signal.aborted === true)
    await waitFor(() => server.getIncomingCount() === 0)
    expect(observed).toBe(true)
    expect(client.getPendingCount()).toBe(0)
    expect(domain.find((d) => d.method === CANCEL_REQUEST_METHOD)).toBeUndefined()
    client.dispose()
    server.dispose()
  })

  test("unknown and completed id cancel false with no domain notification", async () => {
    const domain: Array<{ method: string; params: unknown }> = []
    const { client, server } = pair(async () => "fast", (m, p) => domain.push({ method: m, params: p }))
    expect(client.cancel(9999 as never)).toBe(false)
    const { id, promise } = client.requestWithId("fast")
    void promise.catch(() => {})
    await expect(promise).resolves.toBe("fast")
    expect(client.cancel(id)).toBe(false)
    expect(domain.length).toBe(0)
    client.dispose()
    server.dispose()
  })

  test("malformed cancel consumed, ordinary notification still delivered, peer open", async () => {
    const domain: Array<{ method: string; params: unknown }> = []
    let seen: RequestContext | undefined
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { client, server, aToB } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await gate
      return "done"
    }, (m, p) => domain.push({ method: m, params: p }))
    const { id, promise } = client.requestWithId("slow")
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    const raw = (obj: unknown) => aToB.write(encodeFrame(obj))
    raw({ jsonrpc: "2.0", method: CANCEL_REQUEST_METHOD, params: { id, extra: 1 } })
    raw({ jsonrpc: "2.0", method: CANCEL_REQUEST_METHOD, params: { id: null } })
    raw({ jsonrpc: "2.0", method: CANCEL_REQUEST_METHOD })
    await new Promise((r) => setTimeout(r, 30))
    expect(seen?.signal.aborted).toBe(false)
    expect(domain.length).toBe(0)
    raw({ jsonrpc: "2.0", method: "event.test", params: { seq: 1 } })
    await waitFor(() => domain.length === 1)
    expect(domain[0]!.method).toBe("event.test")
    expect(server.getState()).toBe("open")
    release()
    client.cancel(id)
    await expect(promise).rejects.toThrow()
    await waitFor(() => server.getIncomingCount() === 0)
    client.dispose()
    server.dispose()
  })

  test("dispose aborts active handler with no response writeback", async () => {
    let seen: RequestContext | undefined
    const { client, server, bToA } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await abortWait(ctx.signal)
      return "never"
    })
    const decoder = new FrameDecoder()
    const frames: unknown[] = []
    bToA.on("data", (c: Buffer) => {
      for (const b of decoder.push(c)) {
        try {
          frames.push(JSON.parse(b))
        } catch {}
      }
    })
    const { id, promise } = client.requestWithId("slow")
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    const before = frames.length
    server.dispose()
    await waitFor(() => seen?.signal.aborted === true)
    expect(server.getIncomingCount()).toBe(0)
    await new Promise((r) => setTimeout(r, 30))
    expect(frames.length).toBe(before)
    client.cancel(id)
    await expect(promise).rejects.toThrow()
    client.dispose()
  })

  test("tryCancelPending does not trigger remote abort", async () => {
    let seen: RequestContext | undefined
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => (release = r))
    const { client, server } = pair(async (_m, _p, ctx) => {
      seen = ctx
      return gate
    })
    const { id, promise } = client.requestWithId("slow")
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    expect(client.tryCancelPending(id)).toBe(true)
    await expect(promise).rejects.toThrow("private parity timeout")
    await new Promise((r) => setTimeout(r, 20))
    expect(seen?.signal.aborted).toBe(false)
    expect(server.getIncomingCount()).toBe(1)
    release("late-ok")
    await waitFor(() => server.getIncomingCount() === 0)
    client.dispose()
    server.dispose()
  })

  test("cancel with sync write failure cleans pending, returns false, closes peer", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    let fail = false
    const orig = writer.write.bind(writer)
    ;(writer as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
      if (fail) throw new Error("sync writer failure")
      return orig(c)
    }
    const peer = new JsonRpcPeer({ reader, writer })
    const { id, promise } = peer.requestWithId("slow")
    void promise.catch(() => {})
    expect(peer.getPendingCount()).toBe(1)
    fail = true
    expect(peer.cancel(id)).toBe(false)
    expect(peer.getPendingCount()).toBe(0)
    expect(peer.getState()).toBe("closed")
    await expect(promise).rejects.toThrow("private parity timeout")
    peer.dispose()
    reader.destroy()
    writer.destroy()
  })

  test("active duplicate incoming id rejected, first owns id, reuse after completion", async () => {
    let calls = 0
    let seen: RequestContext | undefined
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { client, server, aToB, bToA } = pair(async (_m, _p, ctx) => {
      calls++
      seen = ctx
      await Promise.race([gate, abortWait(ctx.signal)])
      return "ok-first"
    })
    const decoder = new FrameDecoder()
    const frames: unknown[] = []
    bToA.on("data", (c: Buffer) => {
      for (const b of decoder.push(c)) {
        try {
          frames.push(JSON.parse(b))
        } catch {}
      }
    })
    const dup = 500
    const raw = (obj: unknown) => aToB.write(encodeFrame(obj))
    raw({ jsonrpc: "2.0", id: dup, method: "slow" })
    await waitFor(() => server.getIncomingCount() === 1)
    expect(calls).toBe(1)
    raw({ jsonrpc: "2.0", id: dup, method: "slow" })
    await waitFor(() => frames.length === 1)
    expect(calls).toBe(1)
    const dupErr = frames[0] as { id: unknown; error: { code: number; message: string } }
    expect(dupErr.id).toBe(dup)
    expect(dupErr.error.code).toBe(ErrorCode.InvalidRequest)
    expect(dupErr.error.message).toMatch(/Duplicate active request id/)
    expect(seen?.signal.aborted).toBe(false)
    expect(server.getIncomingCount()).toBe(1)
    raw({ jsonrpc: "2.0", method: CANCEL_REQUEST_METHOD, params: { id: dup } })
    await waitFor(() => seen?.signal.aborted === true)
    release()
    await waitFor(() => server.getIncomingCount() === 0)
    frames.length = 0
    raw({ jsonrpc: "2.0", id: dup, method: "slow" })
    await waitFor(() => calls === 2)
    await waitFor(() => server.getIncomingCount() === 0)
    expect(frames.length).toBeGreaterThan(0)
    const last = frames[frames.length - 1] as { id: unknown; result: unknown }
    expect(last.id).toBe(dup)
    expect(last.result).toBe("ok-first")
    client.dispose()
    server.dispose()
  })

  test("raw EOF aborts active incoming, clears counts, rejects caller pending", async () => {
    let seen: RequestContext | undefined
    const { client, server, aToB, bToA } = pair(async (_m, _p, ctx) => {
      seen = ctx
      await abortWait(ctx.signal)
      return "late"
    })
    const { promise } = client.requestWithId("slow")
    void promise.catch(() => {})
    await waitFor(() => server.getIncomingCount() === 1)
    aToB.end()
    bToA.end()
    await waitFor(() => seen?.signal.aborted === true)
    await waitFor(() => server.getIncomingCount() === 0)
    expect(server.getState()).toBe("closed")
    expect(client.getState()).toBe("closed")
    expect(server.getIncomingCount()).toBe(0)
    expect(client.getPendingCount()).toBe(0)
    await expect(promise).rejects.toThrow()
    client.dispose()
    server.dispose()
  })

  test("async writer error and close abort incoming and reject pending", async () => {
    for (const kind of ["error", "close"] as const) {
      const reader = new PassThrough()
      const writer = new PassThrough()
      let seen: RequestContext | undefined
      const peer = new JsonRpcPeer({
        reader,
        writer,
        onRequest: async (_m, _p, ctx) => {
          seen = ctx
          await abortWait(ctx.signal)
          return "late"
        },
      })
      reader.write(encodeFrame({ jsonrpc: "2.0", id: 77, method: "slow" }))
      await waitFor(() => peer.getIncomingCount() === 1)
      const { promise } = peer.requestWithId("out")
      void promise.catch(() => {})
      expect(peer.getPendingCount()).toBe(1)
      if (kind === "error") writer.emit("error", new Error("async writer boom"))
      else writer.emit("close")
      await waitFor(() => peer.getState() === "closed")
      await waitFor(() => seen?.signal.aborted === true)
      expect(peer.getIncomingCount()).toBe(0)
      expect(peer.getPendingCount()).toBe(0)
      await expect(promise).rejects.toThrow()
      peer.dispose()
      reader.destroy()
      writer.destroy()
    }
  })
})
