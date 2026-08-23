import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService, isPrivateObservationGateEnabled } from "../../src/private-worker/private-observation-service"
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-obs-svc-"))
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
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    const lease = leasePathForDbFile(dbPath)
    try { fs.rmSync(lease, { force: true }) } catch {}
  }
  return { tmp, dbPath, xdg, cleanup }
}

describe("PrivateObservationService P4.2b additive gate and delegation", () => {
  it("gate-off preserves current behavior: no host, no DB lease, requests reject, arbitrary env does not enable", async () => {
    const { tmp, dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const spoofDb = path.join(tmp, "spoof.db")
    const spoofLease = leasePathForDbFile(spoofDb)
    const svc = new PrivateObservationService({ enabled: false, dbPath })
    const svcRelative = new PrivateObservationService({ enabled: true, dbPath: "relative/path.db" })
    const svcNoDb = new PrivateObservationService({ enabled: true })
    // Isolated assertion: caller env attempting to override canonical identity must not enable gate
    const svcEnvSpoof = new PrivateObservationService({
      enabled: false,
      dbPath,
      env: { KILO_PRIVATE_WORKER_STANDALONE: "1", KILO_DB: spoofDb, XDG_DATA_HOME: xdg.XDG_DATA_HOME },
    })
    try {
      expect(isPrivateObservationGateEnabled({ enabled: false, dbPath })).toBe(false)
      expect(isPrivateObservationGateEnabled({ enabled: true, dbPath: "relative.db" })).toBe(false)
      expect(isPrivateObservationGateEnabled({ enabled: true, dbPath })).toBe(true)
      expect(svc.isEnabled()).toBe(false)
      expect(svcRelative.isEnabled()).toBe(false)
      expect(svcNoDb.isEnabled()).toBe(false)
      expect(svcEnvSpoof.isEnabled()).toBe(false)
      expect(svcEnvSpoof.getHost()).toBeNull()
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      const offInit = await svc.initialize()
      expect(offInit).toBeUndefined()
      expect(svc.getHost()).toBeNull()
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(spoofLease)).toBe(false)
      const offSpoofInit = await svcEnvSpoof.initialize()
      expect(offSpoofInit).toBeUndefined()
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(spoofLease)).toBe(false)
      // delegation must reject when not started
      let threw = false
      try { await svc.snapshot({}) } catch (e) { threw = true; expect(String((e as Error).message)).toMatch(/Not started/) }
      expect(threw).toBe(true)
      threw = false
      try { await svc.read(0) } catch (e) { threw = true; expect(String((e as Error).message)).toMatch(/Not started/) }
      expect(threw).toBe(true)
      threw = false
      try { await svc.ack(0) } catch (e) { threw = true; expect(String((e as Error).message)).toMatch(/Not started/) }
      expect(threw).toBe(true)
      threw = false
      try { await svc.subscribe({}) } catch (e) { threw = true; expect(String((e as Error).message)).toMatch(/Not started/) }
      expect(threw).toBe(true)
      // dispose is idempotent and does not create lease
      svc.dispose()
      svc.dispose()
      expect(fs.existsSync(lease)).toBe(false)
      expect(svc.getHost()).toBeNull()
      svcRelative.dispose()
      svcNoDb.dispose()
      svcEnvSpoof.dispose()
    } finally {
      svc.dispose()
      svcRelative.dispose()
      svcNoDb.dispose()
      svcEnvSpoof.dispose()
      await cleanup()
      try { fs.rmSync(spoofLease, { force: true }) } catch {}
      try { fs.rmSync(spoofDb, { force: true }) } catch {}
      // ensure no leftover lease even after gate-off
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(spoofLease)).toBe(false)
    }
  }, 10000)

  it("gate-on creates real PrivateWorkerHost with canonical DB path and delegates snapshot/read/ack/subscribe", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
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
      expect(svc.isEnabled()).toBe(true)
      expect(svc.isStarted()).toBe(false)
      const init = await svc.initialize() as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(svc.getHostState()).toBe("open")
      expect(svc.getHost()).not.toBeNull()
      expect(fs.existsSync(lease)).toBe(false)
      expect(await waitForFileGone(lease, 500)).toBe(true)
      expect(fs.existsSync(dbPath)).toBe(true)
      const snap0 = await svc.snapshot({}) as { v: string; cursor: number }
      expect(snap0.v).toBe(OBSERVATION_VERSION)
      expect(snap0.cursor).toBe(0)
      const read0 = await svc.read(0) as { v: string; cursor: number; rehydrate: boolean; entries: unknown[] }
      expect(read0.v).toBe(OBSERVATION_VERSION)
      expect(read0.rehydrate).toBe(false)
      expect(read0.entries.length).toBe(0)
      const sub = await svc.subscribe({}) as { v: string; cursor: number; subscribed: boolean }
      expect(sub.v).toBe(OBSERVATION_VERSION)
      expect(sub.subscribed).toBe(true)
      const ack = await svc.ack(0) as { v: string; cursor: number }
      expect(ack.v).toBe(OBSERVATION_VERSION)
      expect(ack.cursor).toBe(0)
      let bad = false
      try { await svc.ack(9999) } catch (e) { bad = true; expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams) }
      expect(bad).toBe(true)
      const ahead = await svc.read(9999) as { rehydrate: boolean }
      expect(ahead.rehydrate).toBe(true)
      // idempotent initialize is no-op
      const secondInit = await svc.initialize()
      expect(secondInit).toBeUndefined()
      expect(svc.isStarted()).toBe(true)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(fs.existsSync(lease)).toBe(false)
      expect(await waitForFileGone(lease, 500)).toBe(true)
      await cleanup()
    }
  }, 20000)

  it("gate-on canonical env cannot be overridden by caller env", async () => {
    const { tmp, dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const spoofDb = path.join(tmp, "spoof-override.db")
    const spoofLease = leasePathForDbFile(spoofDb)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: { ...xdg, KILO_DB: spoofDb, KILO_PRIVATE_WORKER_STANDALONE: "0" },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      const init = await svc.initialize() as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      // canonical DB must exist, spoof must not; no-lease observer must not create lease
      expect(fs.existsSync(lease)).toBe(false)
      expect(await waitForFileGone(lease, 500)).toBe(true)
      expect(fs.existsSync(spoofDb)).toBe(false)
      expect(fs.existsSync(spoofLease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(fs.existsSync(lease)).toBe(false)
      await cleanup()
      try { fs.rmSync(spoofLease, { force: true }) } catch {}
      try { fs.rmSync(spoofDb, { force: true }) } catch {}
    }
  }, 20000)

  it("notifications reach service callback; disposal releases host and stops delivery", async () => {
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
      expect(svc.isStarted()).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)
      expect(await waitForFileGone(lease, 500)).toBe(true)
      const snap0 = await svc.snapshot({}) as { cursor: number }
      expect(snap0.cursor).toBe(0)
      const mutate = await svc.request("test/mutateChangefeed", { session_id: "ses_obs_svc_a", revision: 1, kind: "changed", time: 4000 }) as { cursor: number; entry: { seq: number } }
      expect(mutate.cursor).toBeGreaterThan(snap0.cursor)
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      expect(notifs[0]!.method).toBe(OBSERVATION_NOTIFICATION)
      const p1 = notifs[0]!.params as { v: string; cursor: number; entries: Array<{ seq: number; session_id: string; kind: string }> }
      expect(p1.v).toBe(OBSERVATION_VERSION)
      expect(p1.cursor).toBe(mutate.cursor)
      expect(p1.entries[0]!.seq).toBe(mutate.cursor)
      expect(Object.keys(p1.entries[0]!).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
      // disposal releases host and stops further delivery
      const countBefore = notifs.length
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      expect(fs.existsSync(lease)).toBe(false)
      // requests after dispose must reject
      let threw = false
      try { await svc.snapshot({}) } catch (e) { threw = true; expect(String((e as Error).message)).toMatch(/Not started/) }
      expect(threw).toBe(true)
      // no new notifications after dispose
      expect(notifs.length).toBe(countBefore)
      // second dispose is safe
      svc.dispose()
      expect(svc.getHost()).toBeNull()
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await waitForFileGone(lease, 3000).catch(() => {})
      await cleanup()
    }
  }, 20000)

  it("initialization failure cleans up host and lease and is retry-safe", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: "sh",
      args: ["-c", "exit 1"],
      initializeTimeoutMs: 1200,
    })
    try {
      let firstErr: unknown
      try {
        await svc.initialize()
      } catch (e) {
        firstErr = e
      }
      expect(firstErr).toBeDefined()
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(false)
      // retry must also fail cleanly and leave no host/lease (retry-safe)
      let secondErr: unknown
      try {
        await svc.initialize()
      } catch (e) {
        secondErr = e
      }
      expect(secondErr).toBeDefined()
      expect(svc.getHost()).toBeNull()
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHostState()).toBe("closed")
      expect(fs.existsSync(lease)).toBe(false)
      // explicit dispose is idempotent and leaves no lease
      svc.dispose()
      svc.dispose()
      expect(svc.getHost()).toBeNull()
      expect(fs.existsSync(lease)).toBe(false)
      // initialize after dispose must reject as disposed
      let disposedErr: unknown
      try {
        await svc.initialize()
      } catch (e) {
        disposedErr = e
      }
      expect(String((disposedErr as Error).message)).toMatch(/disposed/i)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      await cleanup()
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(false)
    }
  }, 10000)
})
