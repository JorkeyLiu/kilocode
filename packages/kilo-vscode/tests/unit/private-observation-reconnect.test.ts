import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import {
  OBSERVATION_METHODS,
  OBSERVATION_VERSION,
  OBSERVATION_NOTIFICATION,
} from "../../src/private-worker/observation"
import { ErrorCode } from "../../src/private-worker/json-rpc"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
}

async function waitForFileExists(p: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return fs.existsSync(p)
}

async function waitForFileGone(p: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(p)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !fs.existsSync(p)
}

async function waitForNotificationCount(arr: unknown[], expected: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (arr.length >= expected) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return arr.length >= expected
}

async function waitForHostClosedExact(host: PrivateWorkerHost, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (host.hasExited()) return true
    const proc = host.getProc()
    if (proc && (proc.exitCode !== null || proc.signalCode !== null)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return host.hasExited()
}

function makeTmpEnv(): { tmp: string; dbPath: string; xdg: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-obs-reconnect-"))
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
    const lease = leasePathForDbFile(dbPath)
    try {
      fs.rmSync(lease, { force: true })
    } catch {}
  }
  return { tmp, dbPath, xdg, cleanup }
}

function getHostProc(svc: PrivateObservationService): import("child_process").ChildProcess | null {
  const host = svc.getHost()
  return host?.getProc() ?? null
}

function readLeasePid(p: string): number | undefined {
  try {
    const raw = fs.readFileSync(p, "utf8")
    const data = JSON.parse(raw)
    return typeof data.pid === "number" ? data.pid : undefined
  } catch {
    return undefined
  }
}

describe("PrivateObservationService R9-C1 reconnect/reacquire bounded proof (real standalone worker)", () => {
  it("proves initial snapshot/notification/read continuity via service wrapper", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const notifs: Array<{ method: string; params: unknown }> = []
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      onNotification: (m, p) => notifs.push({ method: m, params: p }),
    })
    try {
      const init = (await svc.initialize()) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)
      const snap0 = (await svc.snapshot({})) as { v: string; cursor: number }
      expect(snap0.v).toBe(OBSERVATION_VERSION)
      expect(snap0.cursor).toBe(0)
      const read0 = (await svc.read(0)) as { v: string; cursor: number; rehydrate: boolean; entries: unknown[] }
      expect(read0.v).toBe(OBSERVATION_VERSION)
      expect(read0.rehydrate).toBe(false)
      expect(read0.entries.length).toBe(0)
      const mutate = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_reconnect_a",
        revision: 1,
        kind: "changed",
        time: 5000,
      })) as { cursor: number; entry: { seq: number } }
      expect(mutate.cursor).toBeGreaterThan(snap0.cursor)
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      expect(notifs[0]!.method).toBe(OBSERVATION_NOTIFICATION)
      const p1 = notifs[0]!.params as { v: string; cursor: number; entries: Array<{ seq: number; session_id: string }> }
      expect(p1.v).toBe(OBSERVATION_VERSION)
      expect(p1.cursor).toBe(mutate.cursor)
      expect(p1.entries[0]!.seq).toBe(mutate.cursor)
      const snap1 = (await svc.snapshot({})) as { cursor: number }
      expect(snap1.cursor).toBe(mutate.cursor)
      const readAfter = (await svc.read(snap0.cursor)) as {
        rehydrate: boolean
        entries: Array<{ seq: number }>
        cursor: number
      }
      expect(readAfter.rehydrate).toBe(false)
      expect(readAfter.entries.length).toBe(1)
      expect(readAfter.entries[0]!.seq).toBe(mutate.cursor)
      const readAtCurrent = (await svc.read(mutate.cursor)) as { rehydrate: boolean; entries: unknown[] }
      expect(readAtCurrent.rehydrate).toBe(false)
      expect(readAtCurrent.entries.length).toBe(0)
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      await cleanup()
    }
  }, 20000)

  it("reconnect reacquires lease and preserves latest cursor on same DB path", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const notifs: Array<{ method: string; params: unknown }> = []
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      onNotification: (m, p) => notifs.push({ method: m, params: p }),
    })
    try {
      await svc.initialize()
      expect(fs.existsSync(lease)).toBe(false)
      const pid1 = getHostProc(svc)?.pid
      expect(pid1).toBeDefined()
      const mutate1 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_reconnect_b1",
        revision: 1,
        kind: "changed",
        time: 6000,
      })) as { cursor: number }
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      const snapBefore = (await svc.snapshot({})) as { cursor: number }
      expect(snapBefore.cursor).toBe(mutate1.cursor)
      // bounded reconnect: disposes old host, clears init state, re-enters with same canonical env
      const recon = (await svc.reconnect()) as { protocolVersion: string }
      expect(recon.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)
      const pid2 = getHostProc(svc)?.pid
      expect(pid2).toBeDefined()
      expect(pid2).not.toBe(pid1)
      const snapAfter = (await svc.snapshot({})) as { cursor: number; v: string }
      expect(snapAfter.cursor).toBe(mutate1.cursor)
      expect(snapAfter.v).toBe(OBSERVATION_VERSION)
      const readAtPrev = (await svc.read(0)) as { rehydrate: boolean; entries: Array<{ seq: number }>; cursor: number }
      // with single entry and no eviction, read(0) remains contiguous
      expect(readAtPrev.rehydrate).toBe(false)
      expect(readAtPrev.entries.length).toBe(1)
      expect(readAtPrev.entries[0]!.seq).toBe(mutate1.cursor)
      const readAtCurrent = (await svc.read(mutate1.cursor)) as { rehydrate: boolean; entries: unknown[] }
      expect(readAtCurrent.rehydrate).toBe(false)
      expect(readAtCurrent.entries.length).toBe(0)
      // no duplicate notification from prior host
      expect(notifs.length).toBe(1)
      const mutate2 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_reconnect_b2",
        revision: 1,
        kind: "changed",
        time: 6001,
      })) as { cursor: number }
      expect(mutate2.cursor).toBeGreaterThan(mutate1.cursor)
      expect(await waitForNotificationCount(notifs, 2, 3000)).toBe(true)
      expect(notifs.length).toBe(2)
      expect((notifs[1]!.params as { cursor: number }).cursor).toBe(mutate2.cursor)
      expect((notifs[0]!.params as { cursor: number }).cursor).not.toBe(
        (notifs[1]!.params as { cursor: number }).cursor,
      )
      const snapFinal = (await svc.snapshot({})) as { cursor: number }
      expect(snapFinal.cursor).toBe(mutate2.cursor)
      // idempotent concurrent reconnect: second call during first should share same promise
      const pA = svc.reconnect()
      const pB = svc.reconnect()
      const [rA, rB] = await Promise.all([pA, pB])
      expect((rA as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect((rB as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      await cleanup()
    }
  }, 25000)

  it("stale/evicted cursor returns rehydrate:true via service read", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
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
      expect(fs.existsSync(lease)).toBe(false)
      const m1 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_reconnect_c1",
        revision: 1,
        kind: "changed",
        time: 7000,
      })) as { cursor: number }
      const m2 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_reconnect_c2",
        revision: 1,
        kind: "changed",
        time: 7001,
      })) as { cursor: number }
      expect(m2.cursor).toBeGreaterThan(m1.cursor)
      const snapBeforeEvict = (await svc.snapshot({})) as { cursor: number }
      expect(snapBeforeEvict.cursor).toBe(m2.cursor)
      // force eviction via caps: keep only latest row
      const evict = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_evict_c",
        revision: 1,
        kind: "changed",
        time: 7002,
        caps: { maxRows: 1, maxBytes: 1024 },
      })) as { cursor: number }
      expect(evict.cursor).toBeGreaterThan(m2.cursor)
      const stale = (await svc.read(0)) as {
        rehydrate: boolean
        reason: string
        cursor: number
        entries: unknown[]
        v: string
      }
      expect(stale.rehydrate).toBe(true)
      expect(typeof stale.reason).toBe("string")
      expect(stale.cursor).toBe(evict.cursor)
      expect(stale.entries.length).toBe(0)
      expect(stale.v).toBe(OBSERVATION_VERSION)
      const atLatest = (await svc.read(evict.cursor)) as { rehydrate: boolean; entries: unknown[] }
      expect(atLatest.rehydrate).toBe(false)
      expect(atLatest.entries.length).toBe(0)
      // after reconnect, rehydrate semantics still hold on same DB
      await svc.reconnect()
      const staleAfter = (await svc.read(0)) as { rehydrate: boolean }
      expect(staleAfter.rehydrate).toBe(true)
      const atLatestAfter = (await svc.read(evict.cursor)) as { rehydrate: boolean; entries: unknown[] }
      expect(atLatestAfter.rehydrate).toBe(false)
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      await cleanup()
    }
  }, 25000)

  it("abrupt child disconnect/restart is recoverable and does not duplicate prior notifications", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const notifs: Array<{ method: string; params: unknown }> = []
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      onNotification: (m, p) => notifs.push({ method: m, params: p }),
    })
    try {
      await svc.initialize()
      expect(fs.existsSync(lease)).toBe(false)
      const mutate1 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_reconnect_d1",
        revision: 1,
        kind: "changed",
        time: 8000,
      })) as { cursor: number }
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      const beforeKill = notifs.length
      const proc1 = getHostProc(svc)
      expect(proc1?.pid).toBeDefined()
      const victimPid = proc1!.pid!
      expect(getHostProc(svc)?.pid).toBe(victimPid)
      // abrupt exact-PID SIGKILL (no graceful cleanup)
      try {
        proc1!.kill("SIGKILL")
      } catch {}
      // wait for host to be observed closed
      const start = Date.now()
      while (Date.now() - start < 3000) {
        if (svc.getHostState() === "closed") break
        const h = svc.getHost()
        if (!h || h.getState() === "closed") break
        await new Promise((r) => setTimeout(r, 25))
      }
      await new Promise((r) => setTimeout(r, 200))
      // noLease: no lease remains stale, host is closed
      expect(fs.existsSync(lease)).toBe(false)
      expect(svc.getHostState()).toBe("closed")
      // bounded reconnect should recover via stale-PID recovery
      const recon = (await svc.reconnect()) as { protocolVersion: string }
      expect(recon.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(svc.getHostState()).toBe("open")
      expect(fs.existsSync(lease)).toBe(false)
      const pid2 = getHostProc(svc)?.pid
      expect(pid2).not.toBe(victimPid)
      // no duplicate notification from prior host
      expect(notifs.length).toBe(beforeKill)
      const snapAfter = (await svc.snapshot({})) as { cursor: number }
      expect(snapAfter.cursor).toBe(mutate1.cursor)
      const readAtCurrent = (await svc.read(mutate1.cursor)) as { rehydrate: boolean; entries: unknown[] }
      expect(readAtCurrent.rehydrate).toBe(false)
      expect(readAtCurrent.entries.length).toBe(0)
      const mutate2 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_reconnect_d2",
        revision: 1,
        kind: "changed",
        time: 8001,
      })) as { cursor: number }
      expect(mutate2.cursor).toBeGreaterThan(mutate1.cursor)
      expect(await waitForNotificationCount(notifs, 2, 3000)).toBe(true)
      expect(notifs.length).toBe(2)
      expect((notifs[1]!.params as { cursor: number }).cursor).toBe(mutate2.cursor)
      expect((notifs[0]!.params as { cursor: number }).cursor).toBe(mutate1.cursor)
      // fail-closed gate still preserved: reconnect on gate-off is no-op, disposed throws
      const offSvc = new PrivateObservationService({ enabled: false, dbPath })
      const offRecon = await offSvc.reconnect()
      expect(offRecon).toBeUndefined()
      expect(offSvc.getHost()).toBeNull()
      offSvc.dispose()
      {
        const retainedEarly = svc.getHost() as unknown as PrivateWorkerHost | null
        svc.dispose()
        if (retainedEarly) {
          expect(await waitForHostClosedExact(retainedEarly, 3000)).toBe(true)
          expect(retainedEarly.getState()).toBe("closed")
        }
        expect(svc.getHost()).toBeNull()
      }
      let threw = false
      try {
        await svc.reconnect()
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/disposed/i)
      }
      expect(threw).toBe(true)
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      await cleanup()
    }
  }, 25000)

  it("dispose during reconnect does not spawn new host after bounded shutdown", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
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
      expect(svc.isStarted()).toBe(true)
      const pid1 = getHostProc(svc)?.pid
      expect(pid1).toBeDefined()
      expect(svc.getHostState()).toBe("open")
      const oldHost = svc.getHost() as unknown as PrivateWorkerHost | null
      expect(oldHost).not.toBeNull()
      // Start reconnect which awaits old shutdown (bounded 2000ms) then would re-initialize
      const reconPromise = svc.reconnect()
      // Dispose during the awaited shutdown boundary — should prevent new host spawn
      // Tiny yield to ensure reconnect has entered doReconnect's await
      await new Promise((r) => setTimeout(r, 25))
      svc.dispose()
      let threw = false
      try {
        await reconPromise
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/disposed/i)
      }
      expect(threw).toBe(true)
      // No host can spawn after dispose — exact PID assertion, bounded
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      expect(svc.isStarted()).toBe(false)
      // bounded await of exact old handle, not nulled service state
      if (oldHost) {
        expect(await waitForHostClosedExact(oldHost, 3000)).toBe(true)
        expect(oldHost.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      // Subsequent initialize/reconnect must also throw disposed
      let threw2 = false
      try {
        await svc.initialize()
      } catch (e) {
        threw2 = true
        expect(String((e as Error).message)).toMatch(/disposed/i)
      }
      expect(threw2).toBe(true)
      let threw3 = false
      try {
        await svc.reconnect()
      } catch (e) {
        threw3 = true
        expect(String((e as Error).message)).toMatch(/disposed/i)
      }
      expect(threw3).toBe(true)
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      await cleanup()
    }
  }, 20000)

  it("initialize↔reconnect interop: initialize shares in-flight reconnect and reconnect supersedes in-flight initialize", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
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
      // Initial open
      await svc.initialize()
      expect(svc.isStarted()).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)
      const pid1 = getHostProc(svc)?.pid
      expect(pid1).toBeDefined()

      // Reconnect in-flight, then initialize should share same underlying work (no second host)
      const pRecon = svc.reconnect()
      const pInitDuring = svc.initialize()
      const pRecon2 = svc.reconnect()
      const [rRecon, rInitDuring, rRecon2] = await Promise.all([pRecon, pInitDuring, pRecon2])
      expect((rRecon as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(rInitDuring).toEqual(rRecon)
      expect(rRecon2).toEqual(rRecon)
      const pid2 = getHostProc(svc)?.pid
      expect(pid2).toBeDefined()
      expect(pid2).not.toBe(pid1)
      expect(svc.isStarted()).toBe(true)
      // Subsequent initialize when already open is no-op undefined
      const afterOpen = await svc.initialize()
      expect(afterOpen).toBeUndefined()

      // Reconnect supersedes in-flight initialize: start fresh service without initial initialize
      const { dbPath: dbPath2, xdg: xdg2, cleanup: cleanup2 } = makeTmpEnv()
      const lease2 = leasePathForDbFile(dbPath2)
      const svc2 = new PrivateObservationService({
        enabled: true,
        dbPath: dbPath2,
        testBridge: true,
        env: xdg2,
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        initializeTimeoutMs: 8000,
      })
      try {
        const pInit = svc2.initialize()
        const pReconDuringInit = svc2.reconnect()
        const [rInit, rReconDuring] = await Promise.all([pInit, pReconDuringInit])
        expect((rInit as { protocolVersion: string }).protocolVersion).toBe("1.0")
        expect((rReconDuring as { protocolVersion: string }).protocolVersion).toBe("1.0")
        expect(svc2.isStarted()).toBe(true)
        expect(fs.existsSync(lease2)).toBe(false)
        const finalPid = svc2.getHost()?.getPid()
        expect(finalPid).toBeDefined()
        expect(getHostProc(svc2)?.pid).toBe(finalPid)
      } finally {
        const retained2 = svc2.getHost() as unknown as PrivateWorkerHost | null
        svc2.dispose()
        if (retained2) {
          expect(await waitForHostClosedExact(retained2, 3000)).toBe(true)
          expect(retained2.getState()).toBe("closed")
        }
        expect(svc2.getHost()).toBeNull()
        await cleanup2()
      }
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      await cleanup()
    }
  }, 30000)

  it("reconnect fails closed when old shutdown returns false — no replacement spawned, pending remains owned", async () => {
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
    let origShutdown: ((timeoutMs?: number) => Promise<boolean>) | null = null
    try {
      await svc.initialize()
      expect(svc.isStarted()).toBe(true)
      const pid1 = getHostProc(svc)?.pid
      expect(pid1).toBeDefined()
      oldHost = svc.getHost() as unknown as PrivateWorkerHost | null
      expect(oldHost).not.toBeNull()
      origShutdown = oldHost!.shutdown.bind(oldHost!)
      // inject failure: shutdown returns false (timeout) — child stays live
      oldHost!.shutdown = async () => false
      let err: unknown
      try {
        await svc.reconnect()
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(String((err as Error).message)).toMatch(/shutdown timed out|reconnect aborted/i)
      expect(svc.getHost()).toBeNull()
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHostState()).toBe("closed")
      // no replacement spawned — still no host, pid gone
      expect(getHostProc(svc)).toBeNull()
      // explicit pending-shutdown ownership: still-live old child remains owned by service
      const pending = (
        svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }
      ).getPendingShutdownHost()
      expect(pending).not.toBeNull()
      expect(pending).toBe(oldHost)
      // oldHost mock kept proc alive — pending still holds exact PID, not orphaned
      const pendingProc = (pending as unknown as { proc: import("child_process").ChildProcess | null })?.proc
      expect(pendingProc?.pid).toBe(pid1)
      // Immediate second reconnect while pending still live must also fail closed without spawning replacement
      let err2: unknown
      try {
        await svc.reconnect()
      } catch (e) {
        err2 = e
      }
      expect(err2).toBeDefined()
      expect(String((err2 as Error).message)).toMatch(/shutdown timed out|reconnect aborted/i)
      expect(svc.getHost()).toBeNull()
      expect(
        (svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }).getPendingShutdownHost(),
      ).toBe(oldHost)
      // restore for cleanup: oldHost still holds exact child, need to terminate it
      if (oldHost && origShutdown) {
        oldHost.shutdown = origShutdown
        try {
          oldHost.dispose()
        } catch {}
        expect(await waitForHostClosedExact(oldHost, 3000)).toBe(true)
        expect(oldHost.getState()).toBe("closed")
      }
      // pending is now closed — service should clear it on next reconnect and spawn replacement
      // oldHost remains referenced as pending until next reconnect clears closed pending; verify service still owns it until cleared
      expect(
        (svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }).getPendingShutdownHost(),
      ).toBe(oldHost)
      const recon2 = (await svc.reconnect()) as { protocolVersion: string }
      expect(recon2.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(svc.getHost()).not.toBeNull()
      expect(getHostProc(svc)?.pid).not.toBe(pid1)
      // pending cleared after successful reinitialize
      expect(
        (svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }).getPendingShutdownHost(),
      ).toBeNull()
      oldHost = null
    } finally {
      if (oldHost) {
        if (origShutdown) oldHost.shutdown = origShutdown
        try {
          oldHost.dispose()
        } catch {}
        await waitForHostClosedExact(oldHost, 3000).catch(() => {})
      }
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      const pendingRetained = (
        svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }
      ).getPendingShutdownHost()
      svc.dispose()
      // disposal must clean both active host and pending shutdown host (explicit ownership)
      if (pendingRetained) {
        expect(await waitForHostClosedExact(pendingRetained, 3000)).toBe(true)
        expect(pendingRetained.getState()).toBe("closed")
      }
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      expect(
        (svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }).getPendingShutdownHost(),
      ).toBeNull()
      await cleanup()
    }
  }, 25000)

  it("shutdown timeout leaves pending owned and service disposal cleans it without spawning replacement", async () => {
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
    let origShutdown: ((timeoutMs?: number) => Promise<boolean>) | null = null
    try {
      await svc.initialize()
      expect(svc.isStarted()).toBe(true)
      const pid1 = getHostProc(svc)?.pid
      expect(pid1).toBeDefined()
      oldHost = svc.getHost() as unknown as PrivateWorkerHost | null
      expect(oldHost).not.toBeNull()
      origShutdown = oldHost!.shutdown.bind(oldHost!)
      oldHost!.shutdown = async () => false
      let err: unknown
      try {
        await svc.reconnect()
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(svc.getHost()).toBeNull()
      const pending = (
        svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }
      ).getPendingShutdownHost()
      expect(pending).toBe(oldHost)
      expect(pending?.hasExited()).toBe(false)
      expect(pending?.isAlive()).toBe(true)
      // stale host state alone is not proof — must check actual child exit (proc exitCode)
      // service disposal must clean pending without spawning replacement
      const pendingRef = pending!
      svc.dispose()
      expect(await waitForHostClosedExact(pendingRef, 3000)).toBe(true)
      expect(pendingRef.hasExited()).toBe(true)
      expect(svc.getHost()).toBeNull()
      expect(
        (svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }).getPendingShutdownHost(),
      ).toBeNull()
      oldHost = null
      // disposed service must throw on further reconnect
      let threw = false
      try {
        await svc.reconnect()
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/disposed/i)
      }
      expect(threw).toBe(true)
    } finally {
      if (oldHost) {
        if (origShutdown) oldHost.shutdown = origShutdown
        try {
          oldHost.dispose()
        } catch {}
        await waitForHostClosedExact(oldHost, 3000).catch(() => {})
      }
      svc.dispose()
      await cleanup()
    }
  }, 25000)

  it("concurrent reconnect during init shares singleflight and does not enter doReconnect twice", async () => {
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
      // Start initialize but do not await — host creation in flight
      const pInit = svc.initialize()
      // Immediately issue two concurrent reconnects while init is pending
      const pR1 = svc.reconnect()
      const pR2 = svc.reconnect()
      // Singleflight: concurrent reconnect callers share same underlying work (installed before awaiting init) — both should resolve to same result without duplicate doReconnect
      const [rInit, rR1, rR2] = await Promise.all([pInit, pR1, pR2])
      expect((rInit as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect((rR1 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect((rR2 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(rR1).toEqual(rR2)
      // Only one host should exist after coalesced reconnect — exact PID owned
      expect(svc.isStarted()).toBe(true)
      const pid = getHostProc(svc)?.pid
      expect(pid).toBeDefined()
      expect(svc.getHost()).not.toBeNull()
      // No duplicate host was spawned — pending is clear because child exited
      const pending = (
        svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }
      ).getPendingShutdownHost()
      expect(pending).toBeNull()
      const pendingProc = (
        svc as unknown as { getPendingShutdownProc: () => import("child_process").ChildProcess | null }
      ).getPendingShutdownProc()
      expect(pendingProc).toBeNull()
      // Subsequent concurrent reconnect still coalesced — both resolve to same result
      const pA = svc.reconnect()
      const pB = svc.reconnect()
      const [rA, rB] = await Promise.all([pA, pB])
      expect((rA as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect((rB as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(rA).toEqual(rB)
      expect(svc.isStarted()).toBe(true)
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.hasExited()).toBe(true)
      }
      await cleanup()
    }
  }, 30000)

  it("initialize while pending shutdown is alive must fail closed without spawning", async () => {
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
    let origShutdown: ((timeoutMs?: number) => Promise<boolean>) | null = null
    try {
      await svc.initialize()
      expect(svc.isStarted()).toBe(true)
      const pid1 = getHostProc(svc)?.pid
      expect(pid1).toBeDefined()
      oldHost = svc.getHost() as unknown as PrivateWorkerHost | null
      expect(oldHost).not.toBeNull()
      origShutdown = oldHost!.shutdown.bind(oldHost!)
      oldHost!.shutdown = async () => false
      let err: unknown
      try {
        await svc.reconnect()
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(String((err as Error).message)).toMatch(/shutdown timed out/i)
      expect(svc.getHost()).toBeNull()
      const pending = (
        svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }
      ).getPendingShutdownHost()
      expect(pending).toBe(oldHost)
      const pendingProc = (
        svc as unknown as { getPendingShutdownProc: () => import("child_process").ChildProcess | null }
      ).getPendingShutdownProc()
      expect(pendingProc).not.toBeNull()
      expect(pendingProc?.pid).toBe(pid1)
      expect(pending?.hasExited()).toBe(false)
      expect(pending?.isAlive()).toBe(true)
      // stale getState alone would be "closed" after real shutdown, but exact PID is still alive — prove hasExited guard
      // Initialize must fail closed while pending is alive and must not spawn a new host
      let initErr: unknown
      try {
        await svc.initialize()
      } catch (e) {
        initErr = e
      }
      expect(initErr).toBeDefined()
      expect(String((initErr as Error).message)).toMatch(/initialize aborted|shutdown timed out/i)
      expect(svc.getHost()).toBeNull()
      expect(
        (svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }).getPendingShutdownHost(),
      ).toBe(oldHost)
      // Also reconnect must still fail while pending alive
      let reconErr2: unknown
      try {
        await svc.reconnect()
      } catch (e) {
        reconErr2 = e
      }
      expect(reconErr2).toBeDefined()
      expect(String((reconErr2 as Error).message)).toMatch(/shutdown timed out/i)
      expect(svc.getHost()).toBeNull()
      // Cleanup: restore shutdown and dispose pending — exact PID exit must be observed, not just host state
      if (oldHost && origShutdown) {
        oldHost.shutdown = origShutdown
        try {
          oldHost.dispose()
        } catch {}
        expect(await waitForHostClosedExact(oldHost, 3000)).toBe(true)
        expect(oldHost.hasExited()).toBe(true)
      }
      oldHost = null
      // After pending child has exited, initialize should succeed and spawn replacement
      const reconAfter = (await svc.reconnect()) as { protocolVersion: string }
      expect(reconAfter.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(getHostProc(svc)?.pid).not.toBe(pid1)
      expect(
        (svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }).getPendingShutdownHost(),
      ).toBeNull()
    } finally {
      if (oldHost) {
        if (origShutdown) oldHost.shutdown = origShutdown
        try {
          oldHost.dispose()
        } catch {}
        await waitForHostClosedExact(oldHost, 3000).catch(() => {})
      }
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      const pendingRetained = (
        svc as unknown as { getPendingShutdownHost: () => PrivateWorkerHost | null }
      ).getPendingShutdownHost()
      svc.dispose()
      if (pendingRetained) {
        expect(await waitForHostClosedExact(pendingRetained, 3000)).toBe(true)
        expect(pendingRetained.hasExited()).toBe(true)
      }
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.hasExited()).toBe(true)
      }
      await cleanup()
    }
  }, 30000)

  it("later initialize during pending init+reconnect shares reconnectPromise not superseded init", async () => {
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
      // Start init without await — initPromise pending (real host creation)
      const pInit1 = svc.initialize()
      // Immediately start reconnect — installs reconnectPromise before awaiting initPromise
      const pRecon = svc.reconnect()
      // Late initialize while both init and reconnect are pending must join reconnect, not the superseded init
      const pInitLate = svc.initialize()
      // Track settlement to prove late shares reconnect (still pending after original init settles)
      let lateSettled = false
      let reconSettled = false
      pInitLate.then(
        () => {
          lateSettled = true
        },
        () => {
          lateSettled = true
        },
      )
      pRecon.then(
        () => {
          reconSettled = true
        },
        () => {
          reconSettled = true
        },
      )
      const rInit1 = await pInit1
      expect((rInit1 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      // Yield to let reconnect enter doReconnect shutdown+reinit; late must remain pending (joining reconnect)
      await new Promise((r) => setTimeout(r, 20))
      // If initialize incorrectly returned the original initPromise, late would already be settled here
      expect(lateSettled).toBe(false)
      expect(reconSettled).toBe(false)
      const [rRecon, rLate] = await Promise.all([pRecon, pInitLate])
      expect((rRecon as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(rLate).toEqual(rRecon)
      expect(lateSettled).toBe(true)
      expect(reconSettled).toBe(true)
      // Final active child must be the reconnect host, not the superseded init host
      expect(svc.isStarted()).toBe(true)
      expect(svc.getHostState()).toBe("open")
      const finalPid = getHostProc(svc)?.pid
      expect(finalPid).toBeDefined()
      // Pending ownership cleared — old child exited via bounded shutdown
      expect(svc.getPendingShutdownHost()).toBeNull()
      expect(svc.getPendingShutdownProc()).toBeNull()
      // Subsequent initialize when open is no-op
      expect(await svc.initialize()).toBeUndefined()
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) {
        expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
        expect(retained.hasExited()).toBe(true)
      }
      await cleanup()
    }
  }, 30000)
})
