import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"

describe("JsonRpcPeer backend writer async failure settlement", () => {
  test("writer error closes peer and settles all pending", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    const peer = new JsonRpcPeer({ reader, writer })
    // need peer open
    expect(peer.getState()).toBe("open")
    // create a pending request that will hang (no response)
    // we need to set up a backend that never responds: just use the peer's writer to send, but no reader response
    // Use peer.request directly; it will enqueue pending and write to writer
    const p1 = peer.request("session/update", { foo: 1 })
    const p2 = peer.request("session/cancelQueued", { foo: 2 })
    expect(peer.getPendingCount()).toBe(2)
    // prevent unhandled rejection warnings after settlement
    void p1.catch(() => {})
    void p2.catch(() => {})

    // simulate async writer error
    ;(writer as unknown as { emit: (e: string, v: unknown) => void }).emit("error", new Error("writer async error"))
    // allow microtask for transition
    await new Promise((r) => setTimeout(r, 10))
    expect(peer.getState()).toBe("closed")
    expect(peer.getPendingCount()).toBe(0)
    await expect(p1).rejects.toThrow()
    await expect(p2).rejects.toThrow()
    peer.dispose()
    reader.destroy()
    writer.destroy()
  })

  test("writer close settles pending and marks closed", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    const peer = new JsonRpcPeer({ reader, writer })
    const p = peer.request("session/update", { foo: 1 })
    void p.catch(() => {})
    expect(peer.getPendingCount()).toBe(1)
    ;(writer as unknown as { emit: (e: string, v?: unknown) => void }).emit("close")
    await new Promise((r) => setTimeout(r, 10))
    expect(peer.getState()).toBe("closed")
    expect(peer.getPendingCount()).toBe(0)
    await expect(p).rejects.toThrow()
    peer.dispose()
    reader.destroy()
    writer.destroy()
  })

  test("writer sync throw closes peer and clears pending", async () => {
    const reader = new PassThrough()
    const writer = {
      write: () => { throw new Error("sync writer failure") },
      on: () => {},
      removeListener: () => {},
    } as unknown as NodeJS.WritableStream
    const peer = new JsonRpcPeer({ reader, writer } as unknown as { reader: NodeJS.ReadableStream; writer: NodeJS.WritableStream })
    expect(peer.getState()).toBe("open")
    const p = peer.request("session/cancelQueued", { x: 1 })
    void p.catch(() => {})
    // sync throw during write should have closed peer and pending cleared (rejected)
    await new Promise((r) => setTimeout(r, 5))
    expect(peer.getState()).toBe("closed")
    expect(peer.getPendingCount()).toBe(0)
    await expect(p).rejects.toThrow()
    peer.dispose()
    reader.destroy()
  })

  test("timeout exact cancel removes owned pending without leak", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    const peer = new JsonRpcPeer({ reader, writer })
    const { id, promise } = peer.requestWithId("session/update", { t: 1 })
    void promise.catch(() => {})
    expect(peer.getPendingCount()).toBe(1)
    expect(peer.getPendingIds()).toContain(id)
    const ok = peer.tryCancelPending(id, "private parity timeout")
    expect(ok).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)
    await expect(promise).rejects.toThrow("private parity timeout")
    // second miss
    const second = peer.tryCancelPending(id, "private parity timeout")
    expect(second).toBeFalse()
    expect(peer.getState()).toBe("open")
    peer.dispose()
    reader.destroy()
    writer.destroy()
  })
})
