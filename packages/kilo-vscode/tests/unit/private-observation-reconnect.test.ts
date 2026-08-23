import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { OBSERVATION_METHODS, OBSERVATION_VERSION, OBSERVATION_NOTIFICATION } from "../../src/private-worker/observation"
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
  const host = svc.getHost() as unknown as { proc: import("child_process").ChildProcess | null } | null
  return host?.proc ?? null
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
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const snap0 = (await svc.snapshot({})) as { v: string; cursor: number }
      expect(snap0.v).toBe(OBSERVATION_VERSION)
      expect(snap0.cursor).toBe(0)
      const read0 = (await svc.read(0)) as { v: string; cursor: number; rehydrate: boolean; entries: unknown[] }
      expect(read0.v).toBe(OBSERVATION_VERSION)
      expect(read0.rehydrate).toBe(false)
      expect(read0.entries.length).toBe(0)
      const mutate = (await svc.request("test/mutateChangefeed", { session_id: "ses_reconnect_a", revision: 1, kind: "changed", time: 5000 })) as { cursor: number; entry: { seq: number } }
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
      const readAfter = (await svc.read(snap0.cursor)) as { rehydrate: boolean; entries: Array<{ seq: number }>; cursor: number }
      expect(readAfter.rehydrate).toBe(false)
      expect(readAfter.entries.length).toBe(1)
      expect(readAfter.entries[0]!.seq).toBe(mutate.cursor)
      const readAtCurrent = (await svc.read(mutate.cursor)) as { rehydrate: boolean; entries: unknown[] }
      expect(readAtCurrent.rehydrate).toBe(false)
      expect(readAtCurrent.entries.length).toBe(0)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
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
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const pid1 = readLeasePid(lease)
      expect(pid1).toBeDefined()
      const mutate1 = (await svc.request("test/mutateChangefeed", { session_id: "ses_reconnect_b1", revision: 1, kind: "changed", time: 6000 })) as { cursor: number }
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      const snapBefore = (await svc.snapshot({})) as { cursor: number }
      expect(snapBefore.cursor).toBe(mutate1.cursor)
      // bounded reconnect: disposes old host, clears init state, re-enters with same canonical env
      const recon = (await svc.reconnect()) as { protocolVersion: string }
      expect(recon.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const pid2 = readLeasePid(lease)
      expect(pid2).toBeDefined()
      expect(pid2).not.toBe(pid1)
      expect(getHostProc(svc)?.pid).toBe(pid2)
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
      const mutate2 = (await svc.request("test/mutateChangefeed", { session_id: "ses_reconnect_b2", revision: 1, kind: "changed", time: 6001 })) as { cursor: number }
      expect(mutate2.cursor).toBeGreaterThan(mutate1.cursor)
      expect(await waitForNotificationCount(notifs, 2, 3000)).toBe(true)
      expect(notifs.length).toBe(2)
      expect((notifs[1]!.params as { cursor: number }).cursor).toBe(mutate2.cursor)
      expect((notifs[0]!.params as { cursor: number }).cursor).not.toBe((notifs[1]!.params as { cursor: number }).cursor)
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
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
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
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const m1 = (await svc.request("test/mutateChangefeed", { session_id: "ses_reconnect_c1", revision: 1, kind: "changed", time: 7000 })) as { cursor: number }
      const m2 = (await svc.request("test/mutateChangefeed", { session_id: "ses_reconnect_c2", revision: 1, kind: "changed", time: 7001 })) as { cursor: number }
      expect(m2.cursor).toBeGreaterThan(m1.cursor)
      const snapBeforeEvict = (await svc.snapshot({})) as { cursor: number }
      expect(snapBeforeEvict.cursor).toBe(m2.cursor)
      // force eviction via caps: keep only latest row
      const evict = (await svc.request("test/mutateChangefeed", { session_id: "ses_evict_c", revision: 1, kind: "changed", time: 7002, caps: { maxRows: 1, maxBytes: 1024 } })) as { cursor: number }
      expect(evict.cursor).toBeGreaterThan(m2.cursor)
      const stale = (await svc.read(0)) as { rehydrate: boolean; reason: string; cursor: number; entries: unknown[]; v: string }
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
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
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
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const mutate1 = (await svc.request("test/mutateChangefeed", { session_id: "ses_reconnect_d1", revision: 1, kind: "changed", time: 8000 })) as { cursor: number }
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      const beforeKill = notifs.length
      const proc1 = getHostProc(svc)
      expect(proc1?.pid).toBeDefined()
      const victimPid = proc1!.pid!
      expect(readLeasePid(lease)).toBe(victimPid)
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
      // lease remains stale until reacquire
      expect(fs.existsSync(lease)).toBe(true)
      expect(readLeasePid(lease)).toBe(victimPid)
      // bounded reconnect should recover via stale-PID recovery
      const recon = (await svc.reconnect()) as { protocolVersion: string }
      expect(recon.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(svc.getHostState()).toBe("open")
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const pid2 = readLeasePid(lease)
      expect(pid2).not.toBe(victimPid)
      expect(getHostProc(svc)?.pid).toBe(pid2)
      // no duplicate notification from prior host
      expect(notifs.length).toBe(beforeKill)
      const snapAfter = (await svc.snapshot({})) as { cursor: number }
      expect(snapAfter.cursor).toBe(mutate1.cursor)
      const readAtCurrent = (await svc.read(mutate1.cursor)) as { rehydrate: boolean; entries: unknown[] }
      expect(readAtCurrent.rehydrate).toBe(false)
      expect(readAtCurrent.entries.length).toBe(0)
      const mutate2 = (await svc.request("test/mutateChangefeed", { session_id: "ses_reconnect_d2", revision: 1, kind: "changed", time: 8001 })) as { cursor: number }
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
      svc.dispose()
      let threw = false
      try {
        await svc.reconnect()
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/disposed/i)
      }
      expect(threw).toBe(true)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      await cleanup()
    }
  }, 25000)

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
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const pid1 = readLeasePid(lease)
      expect(pid1).toBeDefined()

      // Reconnect in-flight, then initialize should share same underlying work (no second host)
      const pRecon = svc.reconnect()
      const pInitDuring = svc.initialize()
      const pRecon2 = svc.reconnect()
      const [rRecon, rInitDuring, rRecon2] = await Promise.all([pRecon, pInitDuring, pRecon2])
      expect((rRecon as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(rInitDuring).toEqual(rRecon)
      expect(rRecon2).toEqual(rRecon)
      const pid2 = readLeasePid(lease)
      expect(pid2).toBeDefined()
      expect(pid2).not.toBe(pid1)
      expect(getHostProc(svc)?.pid).toBe(pid2)
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
        expect(await waitForFileExists(lease2, 3000)).toBe(true)
        const finalPid = readLeasePid(lease2)
        expect(finalPid).toBeDefined()
        expect(getHostProc(svc2)?.pid).toBe(finalPid)
      } finally {
        svc2.dispose()
        await new Promise((r) => setTimeout(r, 200))
        expect(await waitForFileGone(lease2, 3000)).toBe(true)
        await cleanup2()
      }
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      await cleanup()
    }
  }, 30000)
})
