import { describe, expect, test } from "bun:test"
import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ServePrivatePeer } from "../../src/services/cli-backend/serve-private-peer"
import { ServerManager } from "../../src/services/cli-backend/server-manager"

function withFixtureEnv(): () => void {
  const prev = process.env.KILO_E2E_FIXTURE
  process.env.KILO_E2E_FIXTURE = "1"
  return () => {
    if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
    else process.env.KILO_E2E_FIXTURE = prev
  }
}

function fakeManager(): ServerManager {
  return new ServerManager({ extensionPath: "/tmp" } as never)
}

function injectInstance(
  mgr: ServerManager,
  inst: { epoch: number; port: number; pid: number; reader: PassThrough; writer: PassThrough; killCalls: string[] },
): void {
  const proc = new EventEmitter() as unknown as import("child_process").ChildProcess & { exitCode: number | null }
  ;(proc as unknown as { pid: number }).pid = inst.pid
  proc.exitCode = null
  ;(proc as unknown as { kill: (s?: string) => boolean }).kill = ((s?: string) => {
    inst.killCalls.push(s ?? "")
    return true
  }) as never
  ;(mgr as unknown as { instance: unknown }).instance = {
    port: inst.port,
    password: "pw",
    process: proc,
    privateReader: inst.reader,
    privateWriter: inst.writer,
    pid: inst.pid,
    epoch: inst.epoch,
    spawnCwd: "/tmp",
  }
}

describe("fixture private pipes owner boundary (ServerManager)", () => {
  test("exact epoch/pid closes owned pipes without killing child; repeat is idempotent", () => {
    const restore = withFixtureEnv()
    try {
      const mgr = fakeManager()
      const reader = new PassThrough()
      const writer = new PassThrough()
      const killCalls: string[] = []
      injectInstance(mgr, { epoch: 7, port: 4123, pid: 4242, reader, writer, killCalls })
      const first = mgr.closePrivatePipesForFixture(7, 4242)
      expect(first?.closed).toBeTrue()
      expect(first?.alreadyClosed).toBeFalse()
      expect(first?.pid).toBe(4242)
      expect(first?.port).toBe(4123)
      expect(first?.epoch).toBe(7)
      expect(reader.destroyed).toBeTrue()
      expect(writer.destroyed).toBeTrue()
      // Owner boundary: no kill, instance retained (backend stays alive).
      expect(killCalls.length).toBe(0)
      const kept = (mgr as unknown as { instance: { port: number } | null }).instance
      expect(kept?.port).toBe(4123)
      // Repeat: idempotent, no throw, no second destroy side effect.
      const second = mgr.closePrivatePipesForFixture(7, 4242)
      expect(second?.closed).toBeFalse()
      expect(second?.alreadyClosed).toBeTrue()
      expect(killCalls.length).toBe(0)
    } finally {
      restore()
    }
  })

  test("stale epoch or foreign pid never touches another generation", () => {
    const restore = withFixtureEnv()
    try {
      const mgr = fakeManager()
      const reader = new PassThrough()
      const writer = new PassThrough()
      const killCalls: string[] = []
      injectInstance(mgr, { epoch: 9, port: 4124, pid: 4343, reader, writer, killCalls })
      const staleEpoch = mgr.closePrivatePipesForFixture(8, 4343)
      expect(staleEpoch?.closed).toBeFalse()
      const foreignPid = mgr.closePrivatePipesForFixture(9, 9999)
      expect(foreignPid?.closed).toBeFalse()
      expect(reader.destroyed).toBeFalse()
      expect(writer.destroyed).toBeFalse()
      expect(killCalls.length).toBe(0)
    } finally {
      restore()
    }
  })

  test("fixture gate absent returns null without touching streams", () => {
    const prev = process.env.KILO_E2E_FIXTURE
    delete process.env.KILO_E2E_FIXTURE
    try {
      const mgr = fakeManager()
      const reader = new PassThrough()
      const writer = new PassThrough()
      injectInstance(mgr, { epoch: 3, port: 4125, pid: 4444, reader, writer, killCalls: [] })
      expect(mgr.closePrivatePipesForFixture(3, 4444)).toBeNull()
      expect(reader.destroyed).toBeFalse()
      expect(writer.destroyed).toBeFalse()
    } finally {
      if (prev !== undefined) process.env.KILO_E2E_FIXTURE = prev
    }
  })
})

describe("fixture peer close borrows inner dispose; owner close ends backend half", () => {
  test("fixture close rejects pending, fires onClosed, leaves pipes to owner; owner destroy closes backend peer", async () => {
    const restore = withFixtureEnv()
    try {
      const hostToBackend = new PassThrough()
      const backendToHost = new PassThrough()
      let closedFired = false
      const hostPeer = new ServePrivatePeer({
        reader: backendToHost,
        writer: hostToBackend,
        pid: 5151,
        epoch: 51,
        initializeTimeoutMs: 500,
        onPeerClosed: () => {
          closedFired = true
        },
      })
      const backendPeer = new JsonRpcPeer({
        reader: hostToBackend,
        writer: backendToHost,
        onRequest: async (method: string) => {
          if (method === "initialize")
            return {
              protocol: { name: "kilo-private", major: 1, minor: 0 },
              serverInfo: { name: "kilo", version: "1" },
              capabilities: ["session/status"],
            }
          // Hang every other method: proves pending rejects on close.
          await new Promise(() => {})
          throw new Error("unreachable")
        },
      })
      try {
        expect(await hostPeer.initialize(500)).toBeTrue()
        expect(hostPeer.isAvailable()).toBeTrue()
        const pending = (hostPeer as unknown as { peer: JsonRpcPeer | null }).peer!.request("session/status", {})
        let rejected: unknown = null
        void pending.catch((e) => {
          rejected = e
        })
        // Borrow-only: inner dispose fires onClosed, rejects pending, but
        // must not destroy the ServerManager-owned pipes.
        const res = hostPeer.fixtureCloseUnderlyingTransportForEvent()
        expect(res.closed).toBeTrue()
        await pending.catch(() => {})
        expect(rejected).not.toBeNull()
        expect(String((rejected as Error)?.message ?? rejected)).not.toBe("")
        expect(closedFired).toBeTrue()
        expect(hostPeer.isAvailable()).toBeFalse()
        expect(hostToBackend.destroyed).toBeFalse()
        expect(backendToHost.destroyed).toBeFalse()
        // Backend half still open until the owner true-closes the pipes.
        expect(backendPeer.getState()).toBe("open")
        // Owner action: destroying both pipes ends the backend half.
        hostToBackend.destroy()
        backendToHost.destroy()
        const deadline = Date.now() + 5_000
        while (backendPeer.getState() !== "closed" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25))
        }
        expect(backendPeer.getState()).toBe("closed")
      } finally {
        try {
          hostPeer.dispose()
        } catch {}
        try {
          backendPeer.dispose()
        } catch {}
        try {
          hostToBackend.destroy()
        } catch {}
        try {
          backendToHost.destroy()
        } catch {}
      }
    } finally {
      restore()
    }
  })
})
