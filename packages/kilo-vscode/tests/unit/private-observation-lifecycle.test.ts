import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { PrivateObservationLifecycleTriggers } from "../../src/private-worker/private-observation-lifecycle-triggers"
import { OBSERVATION_VERSION } from "../../src/private-worker/observation"
import { InMemoryCursorStore } from "../../src/private-worker/observation-cursor-store"

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-obs-lifecycle-"))
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
  const host = svc.getHost() as unknown as { proc: import("child_process").ChildProcess | null } | null
  return host?.proc ?? null
}

describe("PrivateObservationLifecycleTriggers R9-C3 bounded proof (real standalone worker)", () => {
  it("gate-off triggers are no-ops (no lease file created)", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const store = new InMemoryCursorStore()
    const svc = new PrivateObservationService({ enabled: false, dbPath, cursorStore: store, env: xdg })
    const triggers = new PrivateObservationLifecycleTriggers(svc, { debounceMs: 150 })
    try {
      expect(svc.isEnabled()).toBe(false)
      expect(svc.getHost()).toBeNull()
      // each entrypoint should be no-op and not create lease
      const r1 = await triggers.onPanelVisibilityChanged(true)
      expect(r1).toBeUndefined()
      expect(fs.existsSync(lease)).toBe(false)
      const r2 = await triggers.onWindowStateChanged(true)
      expect(r2).toBeUndefined()
      expect(fs.existsSync(lease)).toBe(false)
      const r3 = await triggers.onConfigChanged({} as unknown)
      expect(r3).toBeUndefined()
      expect(fs.existsSync(lease)).toBe(false)
      const r4 = await triggers.onActiveSessionChanged("ses_123")
      expect(r4).toBeUndefined()
      expect(fs.existsSync(lease)).toBe(false)
      const r5 = await triggers.onPeerClosed()
      expect(r5).toBeUndefined()
      expect(fs.existsSync(lease)).toBe(false)
      const r6 = await triggers.trigger("manual")
      expect(r6).toBeUndefined()
      expect(fs.existsSync(lease)).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(store.get()).toBeUndefined()
      // no timer leak after op
      expect(triggers._testHasTimer()).toBe(false)
    } finally {
      triggers.dispose()
      svc.dispose()
      await new Promise((r) => setTimeout(r, 210))
      expect(fs.existsSync(lease)).toBe(false)
      await cleanup()
    }
  }, 10000)

  it("gate-on with InMemoryCursorStore: each entrypoint triggers reconnect+read with debounce coalescence (5 rapid calls ->1), idempotent concurrent trigger shares same promise", async () => {
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
    const triggers = new PrivateObservationLifecycleTriggers(svc, { debounceMs: 150 })
    try {
      const init = (await svc.initialize()) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const pid1 = readLeasePid(lease)
      expect(pid1).toBeDefined()
      // mutate to have cursor
      const m1 = (await svc.request("test/mutateChangefeed", { session_id: "ses_lc_a", revision: 1, kind: "changed", time: 5000 })) as { cursor: number }
      await svc.ack(m1.cursor)
      expect(store.get()).toBe(m1.cursor)
      // instrument reconnect counting
      let reconnectCalls = 0
      const origReconnect = svc.reconnect.bind(svc)
      svc.reconnect = async () => {
        reconnectCalls++
        return origReconnect()
      }
      let readCalls = 0
      const origRead = svc.read.bind(svc)
      svc.read = async (c: number, extra?: Record<string, unknown>) => {
        readCalls++
        return origRead(c, extra)
      }

      // 5 rapid calls within 100ms should coalesce into 1 execution (trailing 150ms)
      const p1 = triggers.onPanelVisibilityChanged(true)
      const p2 = triggers.onWindowStateChanged(true)
      const p3 = triggers.onConfigChanged({} as unknown)
      const p4 = triggers.onActiveSessionChanged("ses_lc_a")
      const p5 = triggers.onPeerClosed()
      // all should share same pending promise (debounced)
      expect(p1).toBe(p2)
      expect(p2).toBe(p3)
      expect(p3).toBe(p4)
      expect(p4).toBe(p5)
      // idempotent concurrent trigger shares same promise
      const pManualA = triggers.trigger("manualA")
      const pManualB = triggers.trigger("manualB")
      expect(pManualA).toBe(pManualB)
      expect(pManualA).toBe(p1)

      const res = await p1
      expect(res).toBeDefined()
      expect(res!.reason).toBeDefined()
      // trailing debounce: last reason wins (manualB was last)
      expect(res!.reason).toBe("manualB")
      expect(res!.reconnectResult).toBeDefined()
      expect(reconnectCalls).toBe(1)
      // read happens once with persisted cursor
      expect(readCalls).toBe(1)
      expect(res!.rehydrate).toBe(false)
      expect(res!.readResult).toBeDefined()
      const pid2 = readLeasePid(lease)
      expect(pid2).toBeDefined()
      expect(pid2).not.toBe(pid1)

      // second burst after quiet period should trigger new execution
      reconnectCalls = 0
      readCalls = 0
      await new Promise((r) => setTimeout(r, 200))
      expect(triggers._testHasTimer()).toBe(false)
      const pNext = triggers.onWindowStateChanged(false)
      const rNext = await pNext
      expect(rNext).toBeDefined()
      expect(reconnectCalls).toBe(1)
      expect(readCalls).toBe(1)
      expect(rNext!.reason).toBe("window:blurred")

      // concurrent during inflight shares same promise — start a slow reconnect simulation
      // We can verify by issuing two triggers while one inflight is executing, before debounce fires?
      // Instead test that after burst, pending is cleared
      expect(triggers._testHasTimer()).toBe(false)
    } finally {
      triggers.dispose()
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      await cleanup()
    }
  }, 25000)

  it("peer-closed after SIGKILL triggers reconnect+read", async () => {
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
    const triggers = new PrivateObservationLifecycleTriggers(svc, { debounceMs: 150 })
    try {
      await svc.initialize()
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const m1 = (await svc.request("test/mutateChangefeed", { session_id: "ses_lc_peer", revision: 1, kind: "changed", time: 6000 })) as { cursor: number }
      await svc.ack(m1.cursor)
      expect(store.get()).toBe(m1.cursor)
      const pid1 = readLeasePid(lease)
      expect(pid1).toBeDefined()
      const proc = getHostProc(svc)
      expect(proc?.pid).toBe(pid1)
      // abrupt SIGKILL exact PID
      try {
        proc!.kill("SIGKILL")
      } catch {}
      // wait for host observed closed
      const start = Date.now()
      while (Date.now() - start < 3000) {
        if (svc.getHostState() === "closed") break
        const h = svc.getHost()
        if (!h || h.getState() === "closed") break
        await new Promise((r) => setTimeout(r, 25))
      }
      await new Promise((r) => setTimeout(r, 200))
      expect(fs.existsSync(lease)).toBe(true)
      expect(readLeasePid(lease)).toBe(pid1)

      const res = await triggers.onPeerClosed()
      expect(res).toBeDefined()
      expect(res!.reconnectResult).toBeDefined()
      expect(svc.isStarted()).toBe(true)
      expect(svc.getHostState()).toBe("open")
      const pid2 = readLeasePid(lease)
      expect(pid2).toBeDefined()
      expect(pid2).not.toBe(pid1)
      expect(getHostProc(svc)?.pid).toBe(pid2)
      // read via persisted cursor still valid (no gap)
      expect(res!.rehydrate).toBe(false)
      const snapAfter = (await svc.snapshot({})) as { cursor: number }
      expect(snapAfter.cursor).toBe(m1.cursor)
      const readAfter = (await svc.read(store.get()!)) as { rehydrate: boolean }
      expect(readAfter.rehydrate).toBe(false)
    } finally {
      triggers.dispose()
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      await cleanup()
    }
  }, 25000)

  it("gap case with caps maxRows:1 eviction -> read(persisted) returns rehydrate:true after trigger", async () => {
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
    const triggers = new PrivateObservationLifecycleTriggers(svc, { debounceMs: 150 })
    try {
      await svc.initialize()
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const m1 = (await svc.request("test/mutateChangefeed", { session_id: "ses_gap_a", revision: 1, kind: "changed", time: 7000 })) as { cursor: number }
      await svc.ack(m1.cursor)
      expect(store.get()).toBe(m1.cursor)
      const persisted = store.get()!
      const m2 = (await svc.request("test/mutateChangefeed", { session_id: "ses_gap_b", revision: 1, kind: "changed", time: 7001 })) as { cursor: number }
      expect(m2.cursor).toBeGreaterThan(m1.cursor)
      // force eviction via caps: keep only latest row
      const evict = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_gap_evict",
        revision: 1,
        kind: "changed",
        time: 7002,
        caps: { maxRows: 1, maxBytes: 1024 },
      })) as { cursor: number }
      expect(evict.cursor).toBeGreaterThan(m2.cursor)
      // stale persisted cursor now forces rehydrate
      const staleBefore = (await svc.read(persisted)) as { rehydrate: boolean; cursor: number }
      expect(staleBefore.rehydrate).toBe(true)
      expect(staleBefore.cursor).toBe(evict.cursor)

      // trigger should reconnect and then read(persisted) surface rehydrate:true
      const res = await triggers.onPanelVisibilityChanged(true)
      expect(res).toBeDefined()
      expect(res!.rehydrate).toBe(true)
      expect((res!.readResult as { rehydrate: boolean }).rehydrate).toBe(true)
      expect((res!.readResult as { cursor: number }).cursor).toBe(evict.cursor)
      expect((res!.readResult as { v: string }).v).toBe(OBSERVATION_VERSION)
      // direct read after trigger also rehydrate
      const staleAfter = (await svc.read(persisted)) as { rehydrate: boolean }
      expect(staleAfter.rehydrate).toBe(true)
    } finally {
      triggers.dispose()
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      await cleanup()
    }
  }, 25000)

  it("dispose clears timer/listeners and no further trigger fires", async () => {
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
    // use longer debounce to test clearing
    const triggers = new PrivateObservationLifecycleTriggers(svc, { debounceMs: 150 })
    try {
      await svc.initialize()
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const pid1 = readLeasePid(lease)
      // schedule a trigger but dispose before debounce fires
      let reconnectCalls = 0
      const origReconnect = svc.reconnect.bind(svc)
      svc.reconnect = async () => {
        reconnectCalls++
        return origReconnect()
      }
      const p = triggers.onPanelVisibilityChanged(true)
      expect(triggers._testHasTimer()).toBe(true)
      triggers.dispose()
      expect(triggers._testHasTimer()).toBe(false)
      const r = await p
      // dispose resolves pending with undefined, no reconnect
      expect(r).toBeUndefined()
      expect(reconnectCalls).toBe(0)
      expect(svc.isStarted()).toBe(true)
      expect(readLeasePid(lease)).toBe(pid1)

      // after dispose, further triggers are no-ops (no new timer, no reconnect)
      reconnectCalls = 0
      const p2 = await triggers.onPeerClosed()
      expect(p2).toBeUndefined()
      expect(reconnectCalls).toBe(0)
      expect(triggers._testHasTimer()).toBe(false)
      const p3 = await triggers.trigger("manual-after-dispose")
      expect(p3).toBeUndefined()
      expect(reconnectCalls).toBe(0)

      // second dispose is safe
      triggers.dispose()
      expect(triggers._testHasTimer()).toBe(false)
    } finally {
      triggers.dispose()
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      await cleanup()
    }
  }, 25000)
})
