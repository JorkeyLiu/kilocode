import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"

function makeTmpEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-host-status-"))
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
  return { dbPath, xdg, cleanup }
}

describe("PrivateWorkerHost/epoch/status boundary (canonical absolute, fail-closed, host close/reconnect)", () => {
  it("host initial state is open (pre-start), not alive, no pid before start", () => {
    const host = new PrivateWorkerHost({ command: "sh", args: ["-c", "exit 0"] })
    // Host state is "open" before peer/host start (peer null -> default open), but no proc yet
    expect(host.getState()).toBe("open")
    expect(host.isAlive()).toBe(false)
    expect(host.getPid()).toBeUndefined()
    expect(host.getProc()).toBeNull()
    host.dispose()
    expect(host.getState()).toBe("closed")
  })

  it("host after successful start is open, alive, with pid, and after dispose closed", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const host = new PrivateWorkerHost({
      env: { ...xdg, KILO_DB: dbPath, KILO_PRIVATE_WORKER_STANDALONE: "1", KILO_PRIVATE_WORKER_TEST_BRIDGE: "1" },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
    })
    try {
      const res = (await host.start()) as { protocolVersion: string }
      expect(res.protocolVersion).toBe("1.0")
      expect(host.getState()).toBe("open")
      expect(host.isAlive()).toBe(true)
      expect(typeof host.getPid()).toBe("number")
      expect(host.getProc()).not.toBeNull()
      host.dispose()
      expect(host.getState()).toBe("closed")
      // after dispose proc still retained as lastProc but isAlive false eventually
      await new Promise((r) => setTimeout(r, 200))
      // at least state closed, pid retained for exact tracking
      expect(host.getPid()).toBeDefined()
    } finally {
      host.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 20000)

  it("closePeerTransport vs kill distinction: close keeps PID alive, kill makes not alive, both transition to closed", async () => {
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
      const pid1 = svc.getStatus().pid!
      // transport close: host closed but proc alive
      const cres = svc.closePeerTransport()
      expect(cres.closed).toBe(true)
      expect(cres.aliveBefore).toBe(true)
      expect(cres.aliveAfter).toBe(true)
      expect(cres.beforePid).toBe(pid1)
      expect(cres.afterPid).toBe(pid1)
      expect(svc.getStatus().hostState).toBe("closed")
      expect(svc.getStatus().available).toBe(false)
      expect(svc.getStatus().epoch).toBe(1)
      // reconnect after transport close increments epoch
      await svc.reconnect()
      const pid2 = svc.getStatus().pid!
      expect(pid2).not.toBe(pid1)
      expect(svc.getStatus().epoch).toBe(2)
      expect(svc.getStatus().hostState).toBe("open")
      // now kill path: abrupt kill makes isAlive false before reconnect
      const proc = svc.getHost()?.getProc()!
      proc.kill("SIGKILL")
      const host = svc.getHost()!
      const exited = await host.waitForExit(3000)
      expect(exited).toBe(true)
      expect(host.isAlive()).toBe(false)
      expect(host.getState()).toBe("closed")
      await svc.reconnect()
      const pid3 = svc.getStatus().pid!
      expect(pid3).not.toBe(pid2)
      expect(svc.getStatus().epoch).toBe(3)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 30000)

  it("epoch increments only on success, stays on failure, pendingShutdown reflects exact PID alive", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const svcFail = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: "sh",
      args: ["-c", "exit 1"],
      initializeTimeoutMs: 800,
    })
    try {
      let err: unknown
      try {
        await svcFail.initialize()
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(svcFail.getStatus().epoch).toBe(0)
      expect(svcFail.getStatus().available).toBe(false)
      // pending may be transiently true while proc still alive; after bounded wait it clears
      await new Promise((r) => setTimeout(r, 200))
      expect(svcFail.getStatus().pendingShutdown).toBe(false)
    } finally {
      svcFail.dispose()
      await cleanup()
    }
    const { dbPath: dbPath2, xdg: xdg2, cleanup: cleanup2 } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svcOk = new PrivateObservationService({
      enabled: true,
      dbPath: dbPath2,
      env: xdg2,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svcOk.initialize()
      expect(svcOk.getStatus().epoch).toBe(1)
      // inject pending by mocking shutdown false
      const oldHost = svcOk.getHost()!
      const orig = oldHost.shutdown.bind(oldHost)
      ;(oldHost as unknown as { shutdown: () => Promise<boolean> }).shutdown = async () => false
      let err: unknown
      try {
        await svcOk.reconnect()
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      const s = svcOk.getStatus()
      expect(s.epoch).toBe(1)
      expect(s.pendingShutdown).toBe(true)
      expect(typeof s.pendingPid).toBe("number")
      // restore and clear
      ;(oldHost as unknown as { shutdown: () => Promise<boolean> }).shutdown = orig
      oldHost.dispose()
      await oldHost.waitForExit(3000)
      await svcOk.reconnect()
      expect(svcOk.getStatus().epoch).toBe(2)
      expect(svcOk.getStatus().pendingShutdown).toBe(false)
    } finally {
      svcOk.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup2()
    }
  }, 30000)
})
