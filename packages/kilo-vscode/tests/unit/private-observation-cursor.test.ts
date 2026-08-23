import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { OBSERVATION_NOTIFICATION, OBSERVATION_VERSION } from "../../src/private-worker/observation"
import {
  InMemoryCursorStore,
  createMementoCursorStore,
  OBSERVATION_CURSOR_KEY,
} from "../../src/private-worker/observation-cursor-store"
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

function readLeasePid(p: string): number | undefined {
  try {
    const raw = fs.readFileSync(p, "utf8")
    const data = JSON.parse(raw)
    return typeof data.pid === "number" ? data.pid : undefined
  } catch {
    return undefined
  }
}

function getHostProc(svc: PrivateObservationService): import("child_process").ChildProcess | null {
  const host = svc.getHost()
  return host?.getProc() ?? null
}

function makeTmpEnv(): { tmp: string; dbPath: string; xdg: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-obs-cursor-"))
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

describe("PrivateObservationService R9-C2 persisted cursor bounded proof (real standalone worker)", () => {
  it("ack persists cursor and new service instance with same store sees persisted cursor and reads correctly", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const store = new InMemoryCursorStore()
    // Also verify Memento adapter behaves identically
    const mementoMap = new Map<string, unknown>()
    const memento = {
      get: <T>(k: string) => mementoMap.get(k) as T | undefined,
      update: (k: string, v: unknown) => {
        if (v === undefined) mementoMap.delete(k)
        else mementoMap.set(k, v)
        return Promise.resolve()
      },
    }
    const mStore = createMementoCursorStore(memento)
    const notifs: Array<{ method: string; params: unknown }> = []
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      cursorStore: store,
      onNotification: (m, p) => notifs.push({ method: m, params: p }),
    })
    try {
      expect(store.get()).toBeUndefined()
      expect(mStore.get()).toBeUndefined()
      expect(svc.getPersistedCursor()).toBeUndefined()
      await svc.initialize()
      expect(await waitForFileExists(lease, 3000)).toBe(false)
      const snap0 = (await svc.snapshot({})) as { cursor: number }
      expect(snap0.cursor).toBe(0)
      expect(svc.getPersistedCursor()).toBeUndefined()
      // notifications must NOT auto-persist
      const mutate = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_cursor_a",
        revision: 1,
        kind: "changed",
        time: 5000,
      })) as { cursor: number }
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      // notification cursor should not be persisted automatically
      expect(store.get()).toBeUndefined()
      expect(svc.getPersistedCursor()).toBeUndefined()
      const notifCursor = (notifs[0]!.params as { cursor: number }).cursor
      expect(notifCursor).toBe(mutate.cursor)
      // before ack, read(0) is contiguous (1 entry) — not yet truncated
      const readBeforeAck = (await svc.read(0)) as { rehydrate: boolean; entries: Array<{ seq: number }> }
      expect(readBeforeAck.rehydrate).toBe(false)
      expect(readBeforeAck.entries.length).toBe(1)
      expect(readBeforeAck.entries[0]!.seq).toBe(mutate.cursor)
      // ack persists
      const ack = (await svc.ack(mutate.cursor)) as { cursor: number; v: string }
      expect(ack.cursor).toBe(mutate.cursor)
      expect(store.get()).toBe(mutate.cursor)
      expect(svc.getPersistedCursor()).toBe(mutate.cursor)
      // Memento adapter also persists correctly (isolated check)
      await mStore.set(mutate.cursor)
      expect(mStore.get()).toBe(mutate.cursor)
      expect(mementoMap.get(OBSERVATION_CURSOR_KEY)).toBe(mutate.cursor)
      await mStore.clear()
      expect(mStore.get()).toBeUndefined()
      await mStore.set(mutate.cursor)
      // read via persisted cursor should be valid (at latest, no gap)
      const readPersisted = (await svc.read(store.get()!)) as { rehydrate: boolean; entries: unknown[] }
      expect(readPersisted.rehydrate).toBe(false)
      expect(readPersisted.entries.length).toBe(0)
      // after ack, prefix truncated — stale read(0) now forces rehydrate deterministically
      const read0 = (await svc.read(0)) as {
        rehydrate: boolean
        cursor: number
        entries: unknown[]
        v: string
        reason: string
      }
      expect(read0.rehydrate).toBe(true)
      expect(read0.cursor).toBe(mutate.cursor)
      expect(read0.entries.length).toBe(0)
      expect(read0.v).toBe(OBSERVATION_VERSION)
      expect(typeof read0.reason).toBe("string")
      // new service instance with same in-memory store sees persisted cursor and reads correctly (sequential reacquire)
      const persistedBeforeDispose = store.get()!
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      const svc2 = new PrivateObservationService({
        enabled: true,
        dbPath,
        testBridge: true,
        env: xdg,
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        initializeTimeoutMs: 8000,
        cursorStore: store,
      })
      try {
        expect(svc2.getPersistedCursor()).toBe(persistedBeforeDispose)
        await svc2.initialize()
        expect(await waitForFileExists(lease, 3000)).toBe(false)
        expect(svc2.getPersistedCursor()).toBe(persistedBeforeDispose)
        const snapAfter = (await svc2.snapshot({})) as { cursor: number }
        expect(snapAfter.cursor).toBe(persistedBeforeDispose)
        const readViaPersisted = (await svc2.read(svc2.getPersistedCursor()!)) as {
          rehydrate: boolean
          entries: unknown[]
        }
        expect(readViaPersisted.rehydrate).toBe(false)
        expect(readViaPersisted.entries.length).toBe(0)
      } finally {
        svc2.dispose()
        await new Promise((r) => setTimeout(r, 200))
        await waitForFileGone(lease, 3000).catch(() => {})
      }
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await waitForFileGone(lease, 3000).catch(() => {})
      await cleanup()
    }
  }, 25000)

  it("persisted cursor survives dispose→reinitialize on same DB path (reacquire new PID, cursor preserved, no duplicate)", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const store = new InMemoryCursorStore()
    const notifs: Array<{ method: string; params: unknown }> = []
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      cursorStore: store,
      onNotification: (m, p) => notifs.push({ method: m, params: p }),
    })
    try {
      await svc.initialize()
      expect(await waitForFileExists(lease, 3000)).toBe(false)
      const proc1 = getHostProc(svc)
      expect(proc1?.pid).toBeDefined()
      const pid1 = proc1!.pid!
      const m1 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_cursor_b1",
        revision: 1,
        kind: "changed",
        time: 6000,
      })) as { cursor: number }
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      await svc.ack(m1.cursor)
      expect(store.get()).toBe(m1.cursor)
      expect(svc.getPersistedCursor()).toBe(m1.cursor)
      const snapBefore = (await svc.snapshot({})) as { cursor: number }
      expect(snapBefore.cursor).toBe(m1.cursor)
      // dispose and reacquire with same store and same DB path via new service
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      const svc2 = new PrivateObservationService({
        enabled: true,
        dbPath,
        testBridge: true,
        env: xdg,
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        initializeTimeoutMs: 8000,
        cursorStore: store,
        onNotification: (m, p) => notifs.push({ method: m, params: p }),
      })
      try {
        expect(svc2.getPersistedCursor()).toBe(m1.cursor)
        await svc2.initialize()
        expect(await waitForFileExists(lease, 3000)).toBe(false)
        const proc2 = getHostProc(svc2)
        expect(proc2?.pid).toBeDefined()
        const pid2 = proc2!.pid!
        expect(pid2).not.toBe(pid1)
        expect(svc2.getPersistedCursor()).toBe(m1.cursor)
        const snapAfter = (await svc2.snapshot({})) as { cursor: number; v: string }
        expect(snapAfter.cursor).toBe(m1.cursor)
        expect(snapAfter.v).toBe(OBSERVATION_VERSION)
        // no duplicate notification from prior host
        expect(notifs.length).toBe(1)
        const readAtPersisted = (await svc2.read(store.get()!)) as { rehydrate: boolean; entries: unknown[] }
        expect(readAtPersisted.rehydrate).toBe(false)
        expect(readAtPersisted.entries.length).toBe(0)
        const m2 = (await svc2.request("test/mutateChangefeed", {
          session_id: "ses_cursor_b2",
          revision: 1,
          kind: "changed",
          time: 6001,
        })) as { cursor: number }
        expect(m2.cursor).toBeGreaterThan(m1.cursor)
        expect(await waitForNotificationCount(notifs, 2, 3000)).toBe(true)
        expect(notifs.length).toBe(2)
        expect((notifs[1]!.params as { cursor: number }).cursor).toBe(m2.cursor)
        // setPersistedCursor helper and clear helper also work without host notification coupling
        await svc2.setPersistedCursor(m2.cursor)
        expect(store.get()).toBe(m2.cursor)
        await svc2.clearPersistedCursor()
        expect(store.get()).toBeUndefined()
        expect(svc2.getPersistedCursor()).toBeUndefined()
        await svc2.setPersistedCursor(m2.cursor)
        expect(store.get()).toBe(m2.cursor)
      } finally {
        svc2.dispose()
        await new Promise((r) => setTimeout(r, 200))
        await waitForFileGone(lease, 3000).catch(() => {})
      }
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await waitForFileGone(lease, 3000).catch(() => {})
      await cleanup()
    }
  }, 30000)

  it("stale persisted cursor after caps eviction returns rehydrate:true both via read(persisted) and via fresh service reinit reading stale cursor", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const store = new InMemoryCursorStore()
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      cursorStore: store,
    })
    try {
      await svc.initialize()
      expect(await waitForFileExists(lease, 3000)).toBe(false)
      const m1 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_cursor_c1",
        revision: 1,
        kind: "changed",
        time: 7000,
      })) as { cursor: number }
      await svc.ack(m1.cursor)
      expect(store.get()).toBe(m1.cursor)
      const persisted = store.get()!
      const m2 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_cursor_c2",
        revision: 1,
        kind: "changed",
        time: 7001,
      })) as { cursor: number }
      expect(m2.cursor).toBeGreaterThan(m1.cursor)
      const snapBefore = (await svc.snapshot({})) as { cursor: number }
      expect(snapBefore.cursor).toBe(m2.cursor)
      // force eviction via caps: maxRows 1 keeps only latest row
      const evict = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_cursor_evict",
        revision: 1,
        kind: "changed",
        time: 7002,
        caps: { maxRows: 1, maxBytes: 1024 },
      })) as { cursor: number }
      expect(evict.cursor).toBeGreaterThan(m2.cursor)
      // stale read on persisted cursor (which is now evicted) must rehydrate deterministically
      const staleViaPersisted = (await svc.read(persisted)) as {
        rehydrate: boolean
        reason: string
        cursor: number
        entries: unknown[]
        v: string
      }
      expect(staleViaPersisted.rehydrate).toBe(true)
      expect(typeof staleViaPersisted.reason).toBe("string")
      expect(staleViaPersisted.cursor).toBe(evict.cursor)
      expect(staleViaPersisted.entries.length).toBe(0)
      expect(staleViaPersisted.v).toBe(OBSERVATION_VERSION)
      // also read 0 is rehydrate after eviction
      const stale0 = (await svc.read(0)) as { rehydrate: boolean }
      expect(stale0.rehydrate).toBe(true)
      // at latest is not rehydrate
      const atLatest = (await svc.read(evict.cursor)) as { rehydrate: boolean; entries: unknown[] }
      expect(atLatest.rehydrate).toBe(false)
      expect(atLatest.entries.length).toBe(0)
      // fresh service reinit with same store reads stale persisted cursor and also gets rehydrate:true
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      const svc2 = new PrivateObservationService({
        enabled: true,
        dbPath,
        testBridge: true,
        env: xdg,
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        initializeTimeoutMs: 8000,
        cursorStore: store,
      })
      try {
        expect(svc2.getPersistedCursor()).toBe(persisted)
        await svc2.initialize()
        expect(await waitForFileExists(lease, 3000)).toBe(false)
        const staleAfterReinit = (await svc2.read(svc2.getPersistedCursor()!)) as { rehydrate: boolean; cursor: number }
        expect(staleAfterReinit.rehydrate).toBe(true)
        expect(staleAfterReinit.cursor).toBe(evict.cursor)
        const stale0After = (await svc2.read(0)) as { rehydrate: boolean }
        expect(stale0After.rehydrate).toBe(true)
      } finally {
        svc2.dispose()
        await new Promise((r) => setTimeout(r, 200))
        await waitForFileGone(lease, 3000).catch(() => {})
      }
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await waitForFileGone(lease, 3000).catch(() => {})
      await cleanup()
    }
  }, 30000)

  it("gate-off service with store does not create host/lease and persists nothing", async () => {
    const { tmp, dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const spoofDb = path.join(tmp, "spoof.db")
    const spoofLease = leasePathForDbFile(spoofDb)
    const store = new InMemoryCursorStore()
    const svc = new PrivateObservationService({ enabled: false, dbPath, cursorStore: store })
    const svcRelative = new PrivateObservationService({ enabled: true, dbPath: "relative/path.db", cursorStore: store })
    try {
      expect(svc.isEnabled()).toBe(false)
      expect(svcRelative.isEnabled()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(svc.getPersistedCursor()).toBeUndefined()
      expect(store.get()).toBeUndefined()
      const offInit = await svc.initialize()
      expect(offInit).toBeUndefined()
      expect(svc.getHost()).toBeNull()
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(spoofLease)).toBe(false)
      expect(svc.getPersistedCursor()).toBeUndefined()
      expect(store.get()).toBeUndefined()
      // ack must reject and not persist
      let threw = false
      try {
        await svc.ack(0)
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/Not started/)
      }
      expect(threw).toBe(true)
      expect(store.get()).toBeUndefined()
      // setPersistedCursor on gate-off is still allowed locally (store is per-instance, not gate), but initialize must not create host
      // For strict gate-off no-op, even helper should be no-op? We allow helper but gate-off initialize still no host.
      // Verify store still empty after failed ack
      expect(svc.getPersistedCursor()).toBeUndefined()
      svc.dispose()
      svc.dispose()
      expect(fs.existsSync(lease)).toBe(false)
      expect(store.get()).toBeUndefined()
    } finally {
      svc.dispose()
      svcRelative.dispose()
      await cleanup()
      try {
        fs.rmSync(spoofLease, { force: true })
      } catch {}
      try {
        fs.rmSync(spoofDb, { force: true })
      } catch {}
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(spoofLease)).toBe(false)
      expect(store.get()).toBeUndefined()
    }
  }, 10000)

  it("concurrent ack + reconnect remain idempotent", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const store = new InMemoryCursorStore()
    const notifs: Array<{ method: string; params: unknown }> = []
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      cursorStore: store,
      onNotification: (m, p) => notifs.push({ method: m, params: p }),
    })
    try {
      await svc.initialize()
      expect(await waitForFileExists(lease, 3000)).toBe(false)
      const proc1c = getHostProc(svc)
      expect(proc1c?.pid).toBeDefined()
      const m1 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_cursor_d1",
        revision: 1,
        kind: "changed",
        time: 8000,
      })) as { cursor: number }
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      expect(notifs.length).toBe(1)
      // initial ack persists
      await svc.ack(m1.cursor)
      expect(store.get()).toBe(m1.cursor)
      // concurrent duplicate ack + reconnect: idempotent promises, no duplicate host, no leak
      const pAck = svc.ack(m1.cursor)
      const pRecon1 = svc.reconnect()
      const pRecon2 = svc.reconnect()
      const pAck2 = svc.ack(m1.cursor).catch(() => undefined)
      const results = await Promise.allSettled([pAck, pRecon1, pRecon2, pAck2])
      // at least one reconnect must have succeeded with protocolVersion
      const reconResult =
        results[1].status === "fulfilled" ? (results[1] as PromiseFulfilledResult<unknown>).value : undefined
      const reconResult2 =
        results[2].status === "fulfilled" ? (results[2] as PromiseFulfilledResult<unknown>).value : undefined
      expect(
        (reconResult as { protocolVersion: string })?.protocolVersion ??
          (reconResult2 as { protocolVersion: string })?.protocolVersion,
      ).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(await waitForFileExists(lease, 3000)).toBe(false)
      const proc2c = getHostProc(svc)
      expect(proc2c?.pid).toBeDefined()
      // persisted cursor preserved after concurrent ops
      expect(store.get()).toBe(m1.cursor)
      expect(svc.getPersistedCursor()).toBe(m1.cursor)
      // no duplicate notification from prior host beyond the one original
      expect(notifs.length).toBe(1)
      const snap = (await svc.snapshot({})) as { cursor: number }
      expect(snap.cursor).toBe(m1.cursor)
      const readAtPersisted = (await svc.read(store.get()!)) as { rehydrate: boolean; entries: unknown[] }
      expect(readAtPersisted.rehydrate).toBe(false)
      expect(readAtPersisted.entries.length).toBe(0)
      // idempotent retry: ack same cursor again succeeds (changefeed ack is idempotent)
      const ackAgain = (await svc.ack(m1.cursor)) as { cursor: number }
      expect(ackAgain.cursor).toBe(m1.cursor)
      expect(store.get()).toBe(m1.cursor)
      // concurrent initialize during reconnect is also shared
      const pInit = svc.initialize()
      const pReconAfter = svc.reconnect()
      const [rInit, rReconAfter] = await Promise.all([pInit, pReconAfter])
      // initialize when open is no-op undefined, reconnect returns protocolVersion
      expect(rInit === undefined || (rInit as { protocolVersion: string })?.protocolVersion === "1.0").toBe(true)
      expect((rReconAfter as { protocolVersion: string })?.protocolVersion).toBe("1.0")
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      await waitForFileGone(lease, 3000).catch(() => {})
      await cleanup()
    }
  }, 30000)
})
