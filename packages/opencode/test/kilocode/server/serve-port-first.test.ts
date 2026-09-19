import { afterEach, describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import path from "node:path"
import fs from "node:fs"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import {
  FD_REGISTRY_READY_TIMEOUT_MS,
  awaitCarrierReady,
  awaitPeerClosedHandoffs,
  createFdCarrier,
} from "../../../src/kilocode/server/fd-carrier"
import type { CarrierReadySleep, FdCarrierRegistry } from "../../../src/kilocode/server/fd-carrier"
import { Server } from "../../../src/server/server"
import { disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const SERVE = fs.readFileSync(path.join(import.meta.dir, "../../../src/cli/cmd/serve.ts"), "utf8")

function at(hay: string, needle: string): number {
  const i = hay.indexOf(needle)
  expect(i, `missing ${needle}`).toBeGreaterThan(-1)
  return i
}

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

function note(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

describe("serve port-first ordering (source boundary)", () => {
  test("port line is byte-identical and precedes carrier init", () => {
    const listen = at(SERVE, "Server.listen(opts)")
    const line = at(SERVE, "console.log(`kilo server listening on ${urls.bind}`)")
    const announced = at(SERVE, 'P0Perf.mark("port_announced"')
    const start = at(SERVE, "tryStartFdCarrier()")
    const wait = at(SERVE, "awaitCarrierReady")
    expect(listen).toBeLessThan(line)
    expect(line).toBeLessThan(announced)
    expect(announced).toBeLessThan(start)
    expect(start).toBeLessThan(wait)
  })

  test("fd_carrier_wait still measures the real wait and shutdown joins it", () => {
    const span = at(SERVE, 'P0Perf.span("fd_carrier_wait")')
    const join = at(SERVE, "await carrierSettled")
    const stop = at(SERVE, "server.stop(true)")
    expect(span).toBeGreaterThan(-1)
    expect(join).toBeLessThan(stop)
    // No detached work: the held promise is joined, never void-and-lost.
    expect(SERVE).not.toContain("forkDetach")
    expect(SERVE).not.toMatch(/void\s+runPromise/)
  })
})

describe("serve port-first behavior (real Server.listen + real awaitCarrierReady)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("HTTP serves while a carrier install is still pending", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stub: FdCarrierRegistry = {
      install: () => gate,
      negotiate: () => Promise.resolve(),
      release: () => Promise.resolve(),
    }
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const { carrier, ext } = linked(stub)
    try {
      const clock = manualSleep()
      const waiting = awaitCarrierReady(carrier, undefined, clock.sleep)
      // Port-first: HTTP is already servable while the carrier has not settled.
      const res = await fetch(new URL("/doc", listener.url).toString())
      expect([200, 404].includes(res.status)).toBeTrue()
      await res.arrayBuffer().catch(() => undefined)
      release()
      expect(await waiting).toEqual({ status: "ready" })
      expect(clock.cancels()).toBe(1)
      expect(carrier.peer.getState()).toBe("open")
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
      await listener.stop()
    }
  }, 30000)

  test("carrier failure still leaves HTTP usable", async () => {
    const stub: FdCarrierRegistry = {
      install: () => Promise.reject(new Error("boom")),
      negotiate: () => Promise.resolve(),
      release: () => Promise.resolve(),
    }
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const { carrier, ext } = linked(stub)
    try {
      const clock = manualSleep()
      const result = await awaitCarrierReady(carrier, 50, clock.sleep)
      expect(result.status).toBe("failed")
      expect(carrier.peer.getState()).toBe("closed")
      const res = await fetch(new URL("/doc", listener.url).toString())
      expect([200, 404].includes(res.status)).toBeTrue()
      await res.arrayBuffer().catch(() => undefined)
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
      await listener.stop()
    }
  }, 30000)

  test("carrier timeout still leaves HTTP usable and late completion reconciles", async () => {
    const releases: JsonRpcPeer[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stub: FdCarrierRegistry = {
      install: () => gate,
      negotiate: () => Promise.resolve(),
      release: (target) => {
        releases.push(target)
        return Promise.resolve()
      },
    }
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const { carrier, ext } = linked(stub)
    try {
      const clock = manualSleep()
      const waiting = awaitCarrierReady(carrier, undefined, clock.sleep)
      expect(clock.seen).toEqual([FD_REGISTRY_READY_TIMEOUT_MS])
      clock.fire()
      expect(await waiting).toEqual({ status: "timeout" })
      const res = await fetch(new URL("/doc", listener.url).toString())
      expect([200, 404].includes(res.status)).toBeTrue()
      await res.arrayBuffer().catch(() => undefined)
      release()
      await awaitPeerClosedHandoffs()
      expect(releases).toEqual([carrier.peer])
      // Barrier drains with no residue.
      await awaitPeerClosedHandoffs()
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
      await listener.stop()
    }
  }, 30000)
})
