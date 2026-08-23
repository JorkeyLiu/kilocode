import { describe, it, expect } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { createSharedCleanup, createSignalExitHandler } from "../../src/private-worker/standalone-worker"

describe("standalone worker event-driven cleanup (no polling) — opencode parity", () => {
  it("peer onClosed fires immediately on dispose without polling interval", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    let closed = 0
    const peer = new JsonRpcPeer({ reader, writer, onClosed: () => closed++ })
    const origSetInterval = global.setInterval
    let pollCreated = false
    // @ts-ignore
    global.setInterval = ((fn: () => void, ms: number, ...rest: unknown[]) => {
      if (ms === 50) {
        try {
          const src = fn.toString()
          if (src.includes("getState") && src.includes("closed")) pollCreated = true
        } catch {}
      }
      return origSetInterval(fn as unknown as () => void, ms as unknown as number, ...(rest as unknown[]))
    }) as unknown as typeof setInterval
    try {
      expect(peer.getState()).toBe("open")
      peer.dispose()
      expect(peer.getState()).toBe("closed")
      expect(closed).toBe(1)
      await new Promise((r) => setTimeout(r, 60))
      expect(closed).toBe(1)
      expect(pollCreated).toBe(false)
    } finally {
      global.setInterval = origSetInterval
      try { peer.dispose() } catch {}
      reader.destroy()
      writer.destroy()
    }
  })

  it("shared cleanup promise: concurrent signals await same disposal before exit (no early exit)", async () => {
    let disposeCalls = 0
    let disposedAt = 0
    const start = Date.now()
    const cleanup = async () => {
      disposeCalls++
      await new Promise((r) => setTimeout(r, 60))
      disposedAt = Date.now() - start
    }
    const doCleanup = createSharedCleanup(cleanup)
    const exits: number[] = []
    const exit = () => {
      exits.push(Date.now() - start)
    }
    const h1 = createSignalExitHandler(doCleanup, exit)
    const h2 = createSignalExitHandler(doCleanup, exit)
    h1()
    await new Promise((r) => setTimeout(r, 5))
    h2()
    await new Promise((r) => setTimeout(r, 90))
    expect(disposeCalls).toBe(1)
    expect(exits.length).toBe(2)
    expect(exits[0] >= 55).toBe(true)
    expect(exits[1] >= 55).toBe(true)
    expect(Math.abs(exits[0] - disposedAt) < 15).toBe(true)
    expect(Math.abs(exits[1] - disposedAt) < 15).toBe(true)
  })

  it("shared cleanup promise: repeated doCleanup calls return same promise and are idempotent", async () => {
    let calls = 0
    const cleanup = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 30))
    }
    const doCleanup = createSharedCleanup(cleanup)
    const p1 = doCleanup()
    const p2 = doCleanup()
    const p3 = doCleanup()
    expect(p1).toBe(p2)
    expect(p2).toBe(p3)
    await Promise.all([p1, p2, p3])
    expect(calls).toBe(1)
    const p4 = doCleanup()
    expect(p4).toBe(p1)
    await p4
    expect(calls).toBe(1)
  })
})
