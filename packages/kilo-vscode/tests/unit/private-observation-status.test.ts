import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { resolveCanonicalDbPath } from "../../src/private-worker/canonical-db-path"

function makeTmpEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-obs-status-"))
  const dataDir = path.join(tmp, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "kilo.db")
  const xdg = {
    XDG_DATA_HOME: path.join(tmp, "xdg-data"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  }
  for (const v of Object.values(xdg)) fs.mkdirSync(v, { recursive: true })
  const cleanup = async () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
  }
  return { tmp, dbPath, xdg, cleanup }
}

describe("PrivateObservationService runtime status probe (enabled/started/hostState/canonical dbPath/available/epoch/pending/disposed)", () => {
  it("fail-closed gate: disabled, relative, missing dbPath -> status enabled false, started false, available false, epoch 0, hostState closed, dbPath undefined, no host", async () => {
    const { dbPath, cleanup } = makeTmpEnv()
    const svcOff = new PrivateObservationService({ enabled: false, dbPath })
    const svcRel = new PrivateObservationService({ enabled: true, dbPath: "relative/path.db" })
    const svcNoDb = new PrivateObservationService({ enabled: true })
    const svcEmpty = new PrivateObservationService({ enabled: true, dbPath: "" })
    try {
      for (const svc of [svcOff, svcRel, svcNoDb, svcEmpty]) {
        const s = svc.getStatus()
        expect(s.enabled).toBe(false)
        expect(s.started).toBe(false)
        expect(s.hostState).toBe("closed")
        expect(s.available).toBe(false)
        expect(s.epoch).toBe(0)
        expect(s.pendingShutdown).toBe(false)
        expect(s.disposed).toBe(false)
        expect(s.dbPath).toBeUndefined()
        expect(s.pid).toBeUndefined()
        expect(svc.isEnabled()).toBe(false)
        expect(svc.getAvailable()).toBe(false)
        expect(svc.getEpoch()).toBe(0)
        expect(svc.getCanonicalDbPath()).toBeUndefined()
        const init = await svc.initialize()
        expect(init).toBeUndefined()
        expect(svc.getStatus().epoch).toBe(0)
        expect(svc.getHost()).toBeNull()
      }
    } finally {
      svcOff.dispose()
      svcRel.dispose()
      svcNoDb.dispose()
      svcEmpty.dispose()
      await cleanup()
    }
  }, 10000)

  it("canonical absolute dbPath probe: when enabled with absolute path, status.dbPath is absolute canonical and matches opts", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const svc = new PrivateObservationService({ enabled: true, dbPath, env: xdg })
    try {
      const s0 = svc.getStatus()
      expect(s0.enabled).toBe(true)
      expect(s0.dbPath).toBe(dbPath)
      expect(path.isAbsolute(s0.dbPath!)).toBe(true)
      expect(s0.dbPath).not.toContain("globalStorage")
      expect(s0.dbPath).not.toContain(".config/kilo")
      expect(svc.getCanonicalDbPath()).toBe(dbPath)
      // resolver canonical matches same absolute identity when using same homedir
      const resolved = resolveCanonicalDbPath({ env: xdg, homedir: "/home/tester" })
      expect(path.isAbsolute(resolved)).toBe(true)
      expect(resolved.endsWith(path.join("kilo", "kilo.db"))).toBe(true)
    } finally {
      svc.dispose()
      await cleanup()
    }
  }, 10000)

  it("status available/epoch tracks successful initialize and stays stable on idempotent init", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      const sBefore = svc.getStatus()
      expect(sBefore.enabled).toBe(true)
      expect(sBefore.started).toBe(false)
      expect(sBefore.available).toBe(false)
      expect(sBefore.epoch).toBe(0)
      expect(sBefore.hostState).toBe("closed")
      expect(sBefore.pendingShutdown).toBe(false)
      const init = (await svc.initialize()) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      const sAfter = svc.getStatus()
      expect(sAfter.started).toBe(true)
      expect(sAfter.hostState).toBe("open")
      expect(sAfter.available).toBe(true)
      expect(sAfter.epoch).toBe(1)
      expect(sAfter.pid).toBeDefined()
      expect(typeof sAfter.pid).toBe("number")
      expect(svc.getEpoch()).toBe(1)
      expect(svc.getAvailable()).toBe(true)
      // idempotent second initialize is no-op and does not bump epoch
      const second = await svc.initialize()
      expect(second).toBeUndefined()
      expect(svc.getStatus().epoch).toBe(1)
      expect(svc.getStatus().started).toBe(true)
      expect(svc.getStatus().available).toBe(true)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      const sDisposed = svc.getStatus()
      expect(sDisposed.disposed).toBe(true)
      expect(sDisposed.started).toBe(false)
      expect(sDisposed.available).toBe(false)
      expect(sDisposed.hostState).toBe("closed")
      // epoch stays at last successful value after dispose
      expect(sDisposed.epoch).toBe(1)
      await cleanup()
    }
  }, 20000)

  it("host close/reconnect/epoch: transport close keeps PID alive but status closed/available false, reconnect bumps epoch and restores availability", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svc.initialize()
      const s1 = svc.getStatus()
      const pid1 = s1.pid!
      expect(s1.epoch).toBe(1)
      expect(s1.available).toBe(true)
      expect(s1.hostState).toBe("open")
      // transport close (peer close, process still alive)
      const closeRes = svc.closePeerTransport()
      expect(closeRes.closed).toBe(true)
      expect(closeRes.aliveBefore).toBe(true)
      expect(closeRes.aliveAfter).toBe(true)
      expect(closeRes.beforePid).toBe(pid1)
      const sClosed = svc.getStatus()
      expect(sClosed.hostState).toBe("closed")
      expect(sClosed.started).toBe(false)
      expect(sClosed.available).toBe(false)
      expect(sClosed.epoch).toBe(1) // unchanged on close
      expect(sClosed.pendingShutdown).toBe(false)
      expect(sClosed.pid).toBe(pid1) // pid still retained until reconnect disposes
      // reconnect should dispose old and start new, epoch bumps
      const recon = (await svc.reconnect()) as { protocolVersion: string }
      expect(recon.protocolVersion).toBe("1.0")
      const s2 = svc.getStatus()
      expect(s2.epoch).toBe(2)
      expect(s2.hostState).toBe("open")
      expect(s2.available).toBe(true)
      expect(s2.started).toBe(true)
      expect(s2.pid).not.toBe(pid1)
      expect(s2.pendingShutdown).toBe(false)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 30000)

  it("failed initialize keeps epoch 0 and available false, pending logic, and status reflects pendingShutdown absolute proc", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: "sh",
      args: ["-c", "exit 1"],
      initializeTimeoutMs: 900,
    })
    try {
      let err: unknown
      try {
        await svc.initialize()
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      await new Promise((r) => setTimeout(r, 200))
      const s = svc.getStatus()
      expect(s.enabled).toBe(true)
      expect(s.started).toBe(false)
      expect(s.hostState).toBe("closed")
      expect(s.available).toBe(false)
      expect(s.epoch).toBe(0)
      // proc already exited after bounded wait, so pending false (no orphan)
      expect(s.pendingShutdown).toBe(false)
      expect(s.disposed).toBe(false)
      expect(s.dbPath).toBe(dbPath)
      // retry still fail-closed, epoch still 0
      let err2: unknown
      try {
        await svc.initialize()
      } catch (e) {
        err2 = e
      }
      expect(err2).toBeDefined()
      await new Promise((r) => setTimeout(r, 200))
      expect(svc.getStatus().epoch).toBe(0)
      expect(svc.getStatus().pendingShutdown).toBe(false)
    } finally {
      svc.dispose()
      expect(svc.getStatus().disposed).toBe(true)
      expect(svc.getStatus().available).toBe(false)
      await cleanup()
    }
  }, 10000)

  it("pending shutdown timeout retains pendingShutdown true with pendingPid, epoch not bumped, initialize/reconnect fail-closed until cleared", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    let oldHost: PrivateWorkerHost | null = null
    let origShutdown: ((ms?: number) => Promise<boolean>) | null = null
    try {
      await svc.initialize()
      const pid1 = svc.getStatus().pid!
      expect(svc.getStatus().epoch).toBe(1)
      oldHost = svc.getHost() as unknown as PrivateWorkerHost | null
      expect(oldHost).not.toBeNull()
      origShutdown = oldHost!.shutdown.bind(oldHost!)
      // inject shutdown false (timeout) to retain pending
      ;(oldHost as unknown as { shutdown: (ms?: number) => Promise<boolean> }).shutdown = async () => false
      let err: unknown
      try {
        await svc.reconnect()
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      const sPending = svc.getStatus()
      expect(sPending.started).toBe(false)
      expect(sPending.available).toBe(false)
      expect(sPending.hostState).toBe("closed")
      expect(sPending.pendingShutdown).toBe(true)
      expect(sPending.pendingPid).toBe(pid1)
      expect(sPending.epoch).toBe(1) // not bumped
      // initialize while pending must fail
      let initErr: unknown
      try {
        await svc.initialize()
      } catch (e) {
        initErr = e
      }
      expect(initErr).toBeDefined()
      expect(svc.getStatus().pendingShutdown).toBe(true)
      expect(svc.getStatus().epoch).toBe(1)
      // restore and clear pending via dispose path of oldHost
      if (oldHost && origShutdown) {
        ;(oldHost as unknown as { shutdown: (ms?: number) => Promise<boolean> }).shutdown = origShutdown
        try {
          oldHost.dispose()
        } catch {}
        // wait for exit
        const ok = await oldHost.waitForExit(3000)
        expect(ok).toBe(true)
      }
      oldHost = null
      // now reconnect should succeed and bump epoch
      const recon2 = (await svc.reconnect()) as { protocolVersion: string }
      expect(recon2.protocolVersion).toBe("1.0")
      const sAfter = svc.getStatus()
      expect(sAfter.epoch).toBe(2)
      expect(sAfter.pendingShutdown).toBe(false)
      expect(sAfter.available).toBe(true)
      expect(sAfter.pid).not.toBe(pid1)
    } finally {
      if (oldHost && origShutdown) {
        ;(oldHost as unknown as { shutdown: (ms?: number) => Promise<boolean> }).shutdown = origShutdown
        try {
          oldHost.dispose()
        } catch {}
      }
      svc.dispose()
      const sd = svc.getStatus()
      expect(sd.disposed).toBe(true)
      // after dispose pending cleared
      expect(sd.pendingShutdown).toBe(false)
      await cleanup()
    }
  }, 30000)

  it("epoch is monotonic across multiple successful reconnects and stable on transport close", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svc.initialize()
      expect(svc.getStatus().epoch).toBe(1)
      await svc.reconnect()
      expect(svc.getStatus().epoch).toBe(2)
      // transport close does not bump
      svc.closePeerTransport()
      expect(svc.getStatus().epoch).toBe(2)
      expect(svc.getStatus().available).toBe(false)
      await svc.reconnect()
      expect(svc.getStatus().epoch).toBe(3)
      await svc.reconnect()
      expect(svc.getStatus().epoch).toBe(4)
      expect(svc.getStatus().available).toBe(true)
      expect(svc.getStatus().hostState).toBe("open")
    } finally {
      svc.dispose()
      expect(svc.getStatus().epoch).toBe(4)
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 30000)

  it("status snapshot is pure — no side effects, returns new object each call, reflects current real state", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const svc = new PrivateObservationService({ enabled: false, dbPath, env: xdg })
    try {
      const a = svc.getStatus()
      const b = svc.getStatus()
      expect(a).not.toBe(b)
      expect(a).toEqual(b)
      // mutating returned object must not affect internal state
      ;(a as unknown as Record<string, unknown>).epoch = 999
      expect(svc.getStatus().epoch).toBe(0)
      expect(svc.getStatus().dbPath).toBeUndefined() // fail-closed when disabled
    } finally {
      svc.dispose()
      await cleanup()
    }
  }, 10000)
})
