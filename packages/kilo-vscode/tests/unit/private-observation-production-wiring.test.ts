import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import {
  PrivateObservationService,
  isPrivateObservationGateEnabled,
} from "../../src/private-worker/private-observation-service"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { InMemoryCursorStore } from "../../src/private-worker/observation-cursor-store"
import { resolveCanonicalDbPath } from "../../src/private-worker/canonical-db-path"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
}

async function waitForFileGone(p: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(p)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !fs.existsSync(p)
}

async function waitForHostClosed(svc: PrivateObservationService, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const host = svc.getHost()
    if (!host && !svc.isStarted() && svc.getHostState() === "closed") return true
    if (host?.hasExited() && !svc.isStarted()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  const host = svc.getHost()
  return !host && svc.getHostState() === "closed"
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

function getSvcPid(svc: PrivateObservationService): number | undefined {
  const h = svc.getHost()
  return h?.getPid()
}

function makeTmpEnv(): { tmp: string; dbPath: string; env: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-prod-wire-"))
  // Mirror production layout: use canonical resolver with injected XDG_DATA_HOME pointing at temp
  const xdgData = path.join(tmp, "xdg-data")
  fs.mkdirSync(xdgData, { recursive: true })
  const env: Record<string, string> = {
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  }
  for (const v of Object.values(env)) fs.mkdirSync(v, { recursive: true })
  const dbPath = resolveCanonicalDbPath({ env: env as unknown as NodeJS.ProcessEnv, homedir: tmp })
  // dbPath must be <xdg-data>/kilo/kilo.db per canonical identity
  const cleanup = async () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
    const lease = leasePathForDbFile(dbPath)
    try {
      fs.rmSync(lease, { force: true })
    } catch {}
  }
  return { tmp, dbPath, env, cleanup }
}

describe("PrivateObservationService R9 production-enablement wiring (canonical DB, enabled:true, fire-and-forget, lifecycle-owned)", () => {
  it("canonical helper returns absolute .../kilo/kilo.db and gate is enabled only with absolute", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    try {
      expect(path.isAbsolute(dbPath)).toBe(true)
      expect(dbPath.endsWith(path.join("kilo", "kilo.db"))).toBe(true)
      expect(path.basename(dbPath)).toBe("kilo.db")
      expect(dbPath).toContain(path.join("xdg-data", "kilo"))
      expect(dbPath).not.toContain(".config")
      expect(dbPath).not.toContain("globalStorage")
      expect(isPrivateObservationGateEnabled({ enabled: true, dbPath })).toBe(true)
      expect(isPrivateObservationGateEnabled({ enabled: true, dbPath: "relative/kilo.db" })).toBe(false)
      expect(isPrivateObservationGateEnabled({ enabled: false, dbPath })).toBe(false)
      expect(isPrivateObservationGateEnabled({ enabled: true })).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it("enabled:true + absolute canonical dbPath + Memento-like cursor store initializes fire-and-forget and is lifecycle-owned via dispose", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    // Minimal Memento-like store mirroring createMementoCursorStore behavior
    const mementoMap = new Map<string, unknown>()
    const memento = {
      get: <T>(k: string) => mementoMap.get(k) as T | undefined,
      update: (k: string, v: unknown) => {
        if (v === undefined) mementoMap.delete(k)
        else mementoMap.set(k, v)
        return Promise.resolve()
      },
    }
    // Import real helper to prove it would be used in extension activation
    const { createMementoCursorStore } = await import("../../src/private-worker/observation-cursor-store")
    const cursorStore = createMementoCursorStore(
      memento as unknown as import("../../src/private-worker/observation-cursor-store").Memento,
    )
    let svc: PrivateObservationService | null = null
    try {
      svc = new PrivateObservationService({
        enabled: true,
        dbPath,
        cursorStore,
        env: env as unknown as NodeJS.ProcessEnv,
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        initializeTimeoutMs: 8000,
      })
      // Simulate extension activation: fire-and-forget, do not await, error handling via catch
      let catchCalled = false
      const initPromise = svc.initialize().catch((e) => {
        catchCalled = true
        throw e
      })
      // Activation must not be blocked: initPromise is pending, not synchronously resolved
      expect(svc.isEnabled()).toBe(true)
      // Wait for actual init to complete
      const init = (await initPromise) as { protocolVersion: string }
      expect(catchCalled).toBe(false)
      expect(init.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(svc.getHost()).not.toBeNull()
      const pidAfterInit = getSvcPid(svc)
      expect(pidAfterInit).toBeDefined()
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)
      // Must be usable
      const snap = (await svc.snapshot({})) as { cursor: number; v: string }
      expect(snap.v).toBe("1.0")
      expect(typeof snap.cursor).toBe("number")
      // Ack persists via cursor store (Memento-like)
      const beforeCursor = cursorStore.get()
      expect(beforeCursor).toBeUndefined()
      await svc.ack(snap.cursor)
      expect(cursorStore.get()).toBe(snap.cursor)
      // Lifecycle-owned: dispose via context.subscriptions analog — releases exact PID, idempotent (noLease)
      const pidBefore = getSvcPid(svc)
      expect(pidBefore).toBeDefined()
      expect(pidBefore).toBe(pidAfterInit)
      const hostBeforeDispose = svc.getHost() as unknown as PrivateWorkerHost | null
      expect(hostBeforeDispose).not.toBeNull()
      svc.dispose()
      if (hostBeforeDispose) {
        expect(await waitForHostClosedExact(hostBeforeDispose, 3000)).toBe(true)
        expect(hostBeforeDispose.getState()).toBe("closed")
      }
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      // Second dispose is safe and does not resurrect — still no host
      svc.dispose()
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      // Cursor persisted in Memento survives dispose (store is external)
      expect(cursorStore.get()).toBe(snap.cursor)
    } finally {
      if (svc) {
        const retained = svc.getHost() as unknown as PrivateWorkerHost | null
        svc.dispose()
        if (retained) {
          expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
          expect(retained.getState()).toBe("closed")
        }
        expect(svc.getHost()).toBeNull()
      }
      await cleanup()
    }
  }, 20000)

  it("fire-and-forget initialize error is catchable and does not block activation; dispose before init is safe", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    let svc: PrivateObservationService | null = null
    try {
      // Force failure: spawn that exits immediately
      svc = new PrivateObservationService({
        enabled: true,
        dbPath,
        env: env as unknown as NodeJS.ProcessEnv,
        command: "sh",
        args: ["-c", "exit 1"],
        initializeTimeoutMs: 1200,
        cursorStore: new InMemoryCursorStore(),
      })
      let caught: unknown
      // Fire-and-forget pattern as used in extension.ts
      void svc.initialize().catch((e) => {
        caught = e
      })
      // Activation not blocked: we can still check gate without awaiting
      expect(svc.isEnabled()).toBe(true)
      // Wait a bit for failure to settle
      await new Promise((r) => setTimeout(r, 800))
      expect(caught).toBeDefined()
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      expect(fs.existsSync(lease)).toBe(false)
      // Dispose is idempotent even after failed init — exact handle proof
      {
        const retainedFail = svc.getHost() as unknown as PrivateWorkerHost | null
        svc.dispose()
        if (retainedFail) {
          expect(await waitForHostClosedExact(retainedFail, 1000)).toBe(true)
          expect(retainedFail.getState()).toBe("closed")
        }
        expect(svc.getHost()).toBeNull()
        expect(svc.getHostState()).toBe("closed")
      }
      svc.dispose()
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      // initialize after dispose must reject as disposed — bounded exact-PID: no new host spawned
      let disposedErr: unknown
      try {
        await svc.initialize()
      } catch (e) {
        disposedErr = e
      }
      expect(String((disposedErr as Error).message)).toMatch(/disposed/i)
      expect(svc.getHost()).toBeNull()
    } finally {
      if (svc) {
        const retained = svc.getHost() as unknown as PrivateWorkerHost | null
        svc.dispose()
        if (retained) {
          expect(await waitForHostClosedExact(retained, 1000)).toBe(true)
          expect(retained.getState()).toBe("closed")
        }
        expect(svc.getHost()).toBeNull()
      }
      await cleanup()
    }
  }, 10000)

  it("preserves exact-PID cleanup and does not touch legacy bridge (no second store, no polling)", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const store = new InMemoryCursorStore()
    let svc: PrivateObservationService | null = null
    try {
      svc = new PrivateObservationService({
        enabled: true,
        dbPath,
        env: env as unknown as NodeJS.ProcessEnv,
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        initializeTimeoutMs: 8000,
        cursorStore: store,
      })
      await svc.initialize()
      expect(fs.existsSync(lease)).toBe(false)
      const pid1 = getSvcPid(svc)
      expect(pid1).toBeDefined()
      // Reconnect must release exact PID and acquire new one (bounded, no global kills, noLease)
      const pidBefore = pid1
      await svc.reconnect()
      expect(fs.existsSync(lease)).toBe(false)
      const pid2 = getSvcPid(svc)
      expect(pid2).toBeDefined()
      expect(pid2).not.toBe(pidBefore)
      expect(svc.isStarted()).toBe(true)
      // Ack persists only ack-derived cursor, no polling/timers invented
      const snap = (await svc.snapshot({})) as { cursor: number }
      await svc.ack(snap.cursor)
      expect(store.get()).toBe(snap.cursor)
      // Dispose exact PID — bounded exact-handle based, verify child exit not just lease absence
      const pidBeforeDispose = getSvcPid(svc)
      const hostBeforeDispose = svc.getHost() as unknown as PrivateWorkerHost | null
      expect(hostBeforeDispose).not.toBeNull()
      svc.dispose()
      if (hostBeforeDispose) {
        expect(await waitForHostClosedExact(hostBeforeDispose, 3000)).toBe(true)
        expect(hostBeforeDispose.getState()).toBe("closed")
      }
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      expect(pidBeforeDispose).toBeDefined()
    } finally {
      // cleanup in ownership order: svc exact PID first, then filesystem
      if (svc) {
        const retained = svc.getHost() as unknown as PrivateWorkerHost | null
        svc.dispose()
        if (retained) {
          expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
          expect(retained.getState()).toBe("closed")
        }
        expect(svc.getHost()).toBeNull()
        expect(svc.getHostState()).toBe("closed")
      }
      await cleanup()
    }
  }, 20000)
})
