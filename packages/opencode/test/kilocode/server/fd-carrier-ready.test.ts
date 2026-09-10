import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import {
  FD_REGISTRY_READY_TIMEOUT_MS,
  awaitCarrierReady,
  awaitPeerClosedHandoffs,
  createFdCarrier,
} from "../../../src/kilocode/server/fd-carrier"
import type { CarrierReadySleep, FdCarrierRegistry } from "../../../src/kilocode/server/fd-carrier"

function note(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

// Deterministic timer: no fake clocks, no sleeps. Tests fire manually;
// every wait must cancel its timer exactly once, even on late completion.
function manualSleep() {
  let fire!: () => void
  const seen: number[] = []
  let cancels = 0
  const sleep: CarrierReadySleep = (ms, onFire) => {
    seen.push(ms)
    fire = onFire
    return () => {
      cancels += 1
    }
  }
  return { seen, sleep, fire: () => fire(), cancels: () => cancels }
}

function linked(stub: FdCarrierRegistry) {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt, { registry: stub })
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function tracked() {
  const releases: JsonRpcPeer[] = []
  const stub: FdCarrierRegistry = {
    install: () => Promise.resolve(),
    release: (target) => {
      releases.push(target)
      return Promise.resolve()
    },
  }
  return { releases, stub }
}

describe("awaitCarrierReady", () => {
  test("success resolves ready without disposing", async () => {
    const { releases, stub } = tracked()
    const { carrier, ext } = linked(stub)
    try {
      const clock = manualSleep()
      const result = await awaitCarrierReady(carrier, 50, clock.sleep)
      expect(result).toEqual({ status: "ready" })
      expect(clock.seen).toEqual([50])
      expect(clock.cancels()).toBe(1)
      expect(carrier.peer.getState()).toBe("open")
      expect(releases.length).toBe(0)
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })

  test("install rejection warns, disposes, and resolves failed", async () => {
    const stub: FdCarrierRegistry = {
      install: () => Promise.reject(new Error("boom")),
      release: () => Promise.resolve(),
    }
    const { carrier, ext } = linked(stub)
    try {
      const clock = manualSleep()
      const result = await awaitCarrierReady(carrier, 50, clock.sleep)
      expect(result.status).toBe("failed")
      if (result.status === "failed") expect(String(result.err)).toContain("boom")
      expect(carrier.peer.getState()).toBe("closed")
      expect(clock.seen).toEqual([50])
      expect(clock.cancels()).toBe(1)
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })

  test("expiry uses the default bound, disposes, and resolves timeout", async () => {
    let resolveInstall!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveInstall = resolve
    })
    const { releases, stub } = tracked()
    const pending: FdCarrierRegistry = { ...stub, install: () => gate }
    const { carrier, ext } = linked(pending)
    try {
      const clock = manualSleep()
      const waiting = awaitCarrierReady(carrier, undefined, clock.sleep)
      expect(clock.seen).toEqual([FD_REGISTRY_READY_TIMEOUT_MS])
      clock.fire()
      const result = await waiting
      expect(result).toEqual({ status: "timeout" })
      expect(clock.cancels()).toBe(1)
      expect(carrier.peer.getState()).toBe("closed")
      // Settle the late install so nothing leaks past the test.
      resolveInstall()
      await carrier.ready
      expect(releases).toEqual([carrier.peer])
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })

  test("late completion after timeout still exact-releases once", async () => {
    let resolveInstall!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveInstall = resolve
    })
    const { releases, stub } = tracked()
    const pending: FdCarrierRegistry = { ...stub, install: () => gate }
    const { carrier, ext } = linked(pending)
    let disposals = 0
    const origDispose = carrier.dispose.bind(carrier)
    carrier.dispose = () => {
      disposals += 1
      origDispose()
    }
    try {
      const clock = manualSleep()
      const waiting = awaitCarrierReady(carrier, 50, clock.sleep)
      clock.fire()
      expect(await waiting).toEqual({ status: "timeout" })
      expect(disposals).toBe(1)
      expect(clock.cancels()).toBe(1)
      // Late install success reconciles through the state machine. The
      // barrier (not `ready`) must join the install completion and the
      // release/notify it enqueues; the timer must not refire.
      resolveInstall()
      await awaitPeerClosedHandoffs()
      expect(releases).toEqual([carrier.peer])
      expect(clock.cancels()).toBe(1)
      await carrier.ready
      carrier.dispose()
      expect(disposals).toBe(2)
      expect(releases.length).toBe(1)
    } finally {
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
    }
  })
})
