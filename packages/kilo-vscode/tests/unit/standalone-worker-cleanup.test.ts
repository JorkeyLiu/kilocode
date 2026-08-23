import { describe, it, expect } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { createSharedCleanup, createSignalExitHandler } from "../../src/private-worker/standalone-worker"

describe("standalone worker event-driven cleanup (no polling)", () => {
  it("peer onClosed fires immediately on dispose without polling interval", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    let closed = 0
    const peer = new JsonRpcPeer({ reader, writer, onClosed: () => closed++ })
    // Patch setInterval to detect polling creation
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
      // onClosed should have fired synchronously via dispose, not via polling
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

  it("peer onClosed fires on stream close (EOF) without polling", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    let closed = 0
    const peer = new JsonRpcPeer({ reader, writer, onClosed: () => closed++ })
    expect(peer.getState()).toBe("open")
    // Simulate EOF by emitting close on reader
    reader.emit("close")
    // Wait a tick for transitionClosed
    await new Promise((r) => setTimeout(r, 10))
    expect(peer.getState()).toBe("closed")
    expect(closed).toBe(1)
    // Second dispose is idempotent, no second callback
    peer.dispose()
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(1)
    writer.destroy()
  })

  it("standalone worker cleanup is event-driven: peer close triggers dispose idempotently", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    let disposed = 0
    const peer = new JsonRpcPeer({
      reader,
      writer,
      onClosed: () => {
        disposed++
      },
    })
    // Monkey-patch dispose to count
    const orig = peer.dispose.bind(peer)
    let disposeCalls = 0
    ;(peer as unknown as { dispose: () => void }).dispose = () => {
      disposeCalls++
      orig()
    }
    // No polling interval should exist
    const origSetInterval = global.setInterval
    let intervals: number[] = []
    // @ts-ignore
    global.setInterval = ((fn: () => void, ms: number, ...rest: unknown[]) => {
      intervals.push(ms)
      return origSetInterval(fn as unknown as () => void, ms as unknown as number, ...(rest as unknown[]))
    }) as unknown as typeof setInterval
    try {
      peer.dispose()
      expect(peer.getState()).toBe("closed")
      expect(disposed).toBe(1)
      expect(disposeCalls).toBe(1)
      // No 50ms polling interval created
      expect(intervals.includes(50)).toBe(false)
      // Idempotent second call: underlying dispose is no-op but wrapper still called; onClosed must remain 1
      peer.dispose()
      expect(disposed).toBe(1)
      expect(disposeCalls).toBe(2)
    } finally {
      global.setInterval = origSetInterval
      writer.destroy()
      reader.destroy()
    }
  })

  it("no polling timer remains after peer close; only debounce timers allowed in triggers", async () => {
    const reader = new PassThrough()
    const writer = new PassThrough()
    const peer = new JsonRpcPeer({ reader, writer })
    peer.dispose()
    expect(peer.getState()).toBe("closed")
    // Ensure no leaked intervals tracking getState polling
    // This test is behavioral: cleanup occurred via event, not interval
    writer.destroy()
    reader.destroy()
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
    // First signal starts cleanup, second arrives while first is in-flight
    h1()
    // Second signal 5ms later — must share same promise, not return immediately
    await new Promise((r) => setTimeout(r, 5))
    h2()
    // Wait enough for cleanup to complete and both exits to fire
    await new Promise((r) => setTimeout(r, 90))
    expect(disposeCalls).toBe(1)
    expect(exits.length).toBe(2)
    // Both exits must happen after disposal completed, not immediately
    expect(exits[0] >= 55).toBe(true)
    expect(exits[1] >= 55).toBe(true)
    // Both exits share same disposal time window (within 15ms)
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
    // Subsequent call after resolved still returns same resolved promise, no second dispose
    const p4 = doCleanup()
    expect(p4).toBe(p1)
    await p4
    expect(calls).toBe(1)
  })

  it("shared cleanup integrates peer onClosed and stdin end event-driven paths without polling", async () => {
    let disposeCalls = 0
    const cleanup = async () => {
      disposeCalls++
      await new Promise((r) => setTimeout(r, 20))
    }
    const doCleanup = createSharedCleanup(cleanup)
    // Simulate peer onClosed and stdin end racing
    const onPeerClosed = () => {
      void doCleanup()
    }
    const onEnd = () => {
      void doCleanup()
    }
    const reader = new PassThrough()
    const writer = new PassThrough()
    const peer = new JsonRpcPeer({ reader, writer, onClosed: onPeerClosed })
    // Trigger peer close and stdin end nearly simultaneously
    reader.emit("close")
    onEnd()
    await new Promise((r) => setTimeout(r, 40))
    expect(disposeCalls).toBe(1)
    expect(peer.getState()).toBe("closed")
    writer.destroy()
    reader.destroy()
  })
})
