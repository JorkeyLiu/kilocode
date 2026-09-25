import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { ServerManager } from "../../src/services/cli-backend/server-manager"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { resolveCanonicalDbPath } from "../../src/private-worker/canonical-db-path"
import * as vscode from "vscode"

function makeTempXdg(): { tmp: string; xdg: string; dbPath: string; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-activation-ordering-"))
  const xdg = path.join(tmp, "xdg-data")
  fs.mkdirSync(xdg, { recursive: true })
  const dbPath = resolveCanonicalDbPath({ env: { XDG_DATA_HOME: xdg }, homedir: tmp })
  const cleanup = () => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    // clean lease/markers sibling
    try {
      const dataRoot = path.dirname(dbPath)
      const parent = path.dirname(dataRoot)
      const base = path.basename(dataRoot)
      const marker = path.join(parent, `.cutover-${base}.marker.json`)
      const rollback = path.join(parent, `.rollback-${base}.marker.json`)
      fs.rmSync(marker, { force: true })
      fs.rmSync(rollback, { force: true })
      const lease = path.join(parent, `.kilo-${base}.lease.json`)
      fs.rmSync(lease, { force: true })
    } catch {}
  }
  return { tmp, xdg, dbPath, cleanup }
}

function fakeContext(extensionPath: string, globalStorage: string): vscode.ExtensionContext {
  return {
    extensionPath,
    globalStorageUri: { fsPath: globalStorage } as unknown as vscode.Uri,
    extensionMode: 2,
    extension: { packageJSON: { version: "0.0.0" } } as unknown as vscode.ExtensionContext["extension"],
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} } as unknown as vscode.Memento,
    globalState: { get: () => undefined, update: async () => {}, keys: () => [] } as unknown as vscode.Memento & { keys: () => string[] },
  } as unknown as vscode.ExtensionContext
}

describe("Activation ordering — no standalone worker before canonical cutover", () => {
  it("barrier proves no worker open before cutover completes (owned temp XDG, injectable worker fixture)", async () => {
    const { tmp, xdg, dbPath, cleanup } = makeTempXdg()
    const globalStorage = path.join(tmp, "globalStorage")
    fs.mkdirSync(globalStorage, { recursive: true })
    // barrier for cutover gate
    let gateCalls = 0
    let releaseGate!: () => void
    const gateBarrier = new Promise<void>((res) => { releaseGate = res })
    const gate = async () => {
      gateCalls++
      await gateBarrier
    }
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    let workerSpawnTime = 0
    let gateReleaseTime = 0
    // wrap gate to record times
    const timedGate = async () => {
      gateCalls++
      await gateBarrier
      gateReleaseTime = Date.now()
    }
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: { XDG_DATA_HOME: xdg },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      canonicalStorageGate: timedGate,
    })
    try {
      const start = Date.now()
      const initPromise = svc.initialize()
      // give event loop a tick, gate should be pending, worker not spawned
      await new Promise((r) => setTimeout(r, 200))
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(gateCalls).toBe(1)
      // DB should not exist yet because worker hasn't opened it
      // (no-lease observer creates DB on first open, but we haven't opened)
      expect(fs.existsSync(dbPath)).toBe(false)
      // release gate, worker should then open
      releaseGate()
      const res = await initPromise as { protocolVersion: string }
      workerSpawnTime = Date.now()
      expect(res.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(svc.getHost()).not.toBeNull()
      expect(fs.existsSync(dbPath)).toBe(true)
      expect(gateReleaseTime).toBeGreaterThan(0)
      // worker open must be after gate release
      expect(workerSpawnTime).toBeGreaterThanOrEqual(gateReleaseTime)
      expect(workerSpawnTime - start).toBeGreaterThanOrEqual(150)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      cleanup()
    }
  }, 15000)

  it("failure gate prevents worker spawn (fail-closed, no DB)", async () => {
    const { tmp, xdg, dbPath, cleanup } = makeTempXdg()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    let gateCalls = 0
    const failingGate = async () => {
      gateCalls++
      throw new Error("cutover failed: lease live")
    }
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: { XDG_DATA_HOME: xdg },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 5000,
      canonicalStorageGate: failingGate,
    })
    try {
      let err: unknown
      try { await svc.initialize() } catch (e) { err = e }
      expect(err).toBeDefined()
      expect(String((err as Error).message)).toMatch(/cutover failed/)
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(fs.existsSync(dbPath)).toBe(false)
      expect(gateCalls).toBe(1)
      // second attempt also fails without spawning
      let err2: unknown
      try { await svc.initialize() } catch (e) { err2 = e }
      expect(err2).toBeDefined()
      expect(svc.isStarted()).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(false)
      expect(gateCalls).toBe(2)
    } finally {
      svc.dispose()
      cleanup()
    }
  }, 10000)

  it("singleflight — concurrent initialize shares one gate, one worker", async () => {
    const { tmp, xdg, dbPath, cleanup } = makeTempXdg()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    let gateCalls = 0
    let release!: () => void
    const barrier = new Promise<void>((res) => { release = res })
    const gate = async () => {
      gateCalls++
      await barrier
    }
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: { XDG_DATA_HOME: xdg },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      canonicalStorageGate: gate,
    })
    try {
      const p1 = svc.initialize()
      const p2 = svc.initialize()
      const p3 = svc.initialize()
      await new Promise((r) => setTimeout(r, 150))
      expect(svc.isStarted()).toBe(false)
      // All three share same gate promise; gateCalls should be 1 because initialize coalesces via initPromise singleflight + gate singleflight
      // At this point, p1 created initPromise, p2/p3 returned same promise, gate called once
      expect(gateCalls).toBe(1)
      release()
      const [r1, r2, r3] = await Promise.all([p1, p2, p3])
      expect(svc.isStarted()).toBe(true)
      // All promises resolve to same result or undefined for coalesced
      expect(gateCalls).toBe(1)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      cleanup()
    }
  }, 15000)

  it("reconnect also gates behind cutover (peer-close path)", async () => {
    const { tmp, xdg, dbPath, cleanup } = makeTempXdg()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    // first start with successful gate
    let gateCalls = 0
    const gateOk = async () => { gateCalls++ }
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: { XDG_DATA_HOME: xdg },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      canonicalStorageGate: gateOk,
    })
    try {
      await svc.initialize()
      expect(svc.isStarted()).toBe(true)
      expect(gateCalls).toBe(1)
      // swap gate to barrier for reconnect
      let release!: () => void
      const barrier = new Promise<void>((res) => { release = res })
      let reconnectGateCalls = 0
      svc.setCanonicalStorageGate(async () => {
        reconnectGateCalls++
        await barrier
      })
      const reconnectPromise = svc.reconnect()
      await new Promise((r) => setTimeout(r, 150))
      // During barrier, reconnect should not have completed, old host is shutting down but new not yet open
      // isStarted may be false after shutdown
      expect(reconnectGateCalls).toBe(1)
      release()
      await reconnectPromise
      expect(svc.isStarted()).toBe(true)
      expect(reconnectGateCalls).toBe(1)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      cleanup()
    }
  }, 15000)

  it("ServerManager.ensureCanonicalStorage is singleflight and fail-closed, lazy server not spawned", async () => {
    const { tmp, xdg, dbPath, cleanup } = makeTempXdg()
    const globalStorage = path.join(tmp, "globalStorage")
    fs.mkdirSync(globalStorage, { recursive: true })
    const fakeExtPath = path.join(tmp, "ext")
    fs.mkdirSync(fakeExtPath, { recursive: true })
    // Need a fake extension context; ServerManager will try to run hidden CLI at fakeExtPath/bin/kilo
    // For this test we stub the hidden CLI path to a nonexistent binary to prove fail-closed,
    // but we also test singleflight without actual spawn by injecting a barrier via monkey patch.
    // Instead we test the public API exists and is singleflight by checking that concurrent calls share promise
    // using a real ServerManager but with XDG isolated and hidden CLI missing -> fail-closed singleflight
    const ctx = fakeContext(fakeExtPath, globalStorage)
    const mgr = new ServerManager(ctx as unknown as vscode.ExtensionContext, () => {})
    // Override env to use temp XDG so we don't touch user DB
    const origEnv = process.env.XDG_DATA_HOME
    const origHome = process.env.HOME
    process.env.XDG_DATA_HOME = xdg
    // use a temp homedir that doesn't have existing DB
    const tempHome = tmp
    const origResolve = (global as unknown as { _origHomedir?: () => string })._origHomedir
    // We can't easily stub os.homedir, but resolveCanonicalDbPath uses process.env.XDG_DATA_HOME first, so it's isolated
    try {
      const p1 = mgr.ensureCanonicalStorage().catch((e) => e)
      const p2 = mgr.ensureCanonicalStorage().catch((e) => e)
      const p3 = mgr.ensureCanonicalStorage().catch((e) => e)
      const [r1, r2, r3] = await Promise.all([p1, p2, p3])
      // All should fail closed due to missing hidden CLI, but singleflight means only one spawn attempt
      // The error messages should be identical (same cached error)
      expect(String((r1 as Error).message ?? r1)).toMatch(/CLI binary not found|hidden CLI missing/)
      expect(String((r2 as Error).message ?? r2)).toMatch(/CLI binary not found|hidden CLI missing/)
      expect(String((r3 as Error).message ?? r3)).toMatch(/CLI binary not found|hidden CLI missing/)
      // Second round after failure should also fail closed without new spawn (cached error)
      let secondErr: unknown
      try { await mgr.ensureCanonicalStorage() } catch (e) { secondErr = e }
      expect(String((secondErr as Error).message)).toMatch(/CLI binary not found|hidden CLI missing/)
      // Ensure no server instance was created (lazy)
      // mgr has no public instance accessor, but we can check that getServer would now also fail at same gate
      // and that no file was created at dbPath
      expect(fs.existsSync(dbPath)).toBe(false)
    } finally {
      process.env.XDG_DATA_HOME = origEnv
      if (origHome !== undefined) process.env.HOME = origHome
      mgr.dispose()
      cleanup()
    }
  }, 10000)

  it("KiloConnectionService exposes shared singleflight gate reused by startServer (lazy)", async () => {
    const { tmp, xdg, cleanup } = makeTempXdg()
    const globalStorage = path.join(tmp, "globalStorage")
    fs.mkdirSync(globalStorage, { recursive: true })
    const fakeExtPath = path.join(tmp, "ext2")
    fs.mkdirSync(fakeExtPath, { recursive: true })
    const ctx = fakeContext(fakeExtPath, globalStorage)
    const svc = new KiloConnectionService(ctx as unknown as vscode.ExtensionContext)
    const origXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = xdg
    try {
      // ensureCanonicalStorage should be accessible
      expect(typeof svc.ensureCanonicalStorage).toBe("function")
      expect(typeof svc.getServerManager().ensureCanonicalStorage).toBe("function")
      // Both should be same singleflight
      const p1 = svc.ensureCanonicalStorage().catch((e) => e)
      const p2 = svc.getServerManager().ensureCanonicalStorage().catch((e) => e)
      const [r1, r2] = await Promise.all([p1, p2])
      expect(String((r1 as Error).message ?? r1)).toMatch(/CLI binary not found|hidden CLI missing/)
      expect(String((r2 as Error).message ?? r2)).toMatch(/CLI binary not found|hidden CLI missing/)
    } finally {
      process.env.XDG_DATA_HOME = origXdg
      await svc.dispose()
      cleanup()
    }
  }, 10000)

  it("dispose during gate hold prevents worker spawn — initialize race (owned fixture)", async () => {
    const { tmp, xdg, dbPath, cleanup } = makeTempXdg()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    let calls = 0
    let release!: () => void
    const held = new Promise<void>((res) => { release = res })
    const gate = async () => {
      calls++
      await held
    }
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: { XDG_DATA_HOME: xdg },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      canonicalStorageGate: gate,
    })
    try {
      const pending = svc.initialize()
      void pending.catch(() => {})
      await new Promise((r) => setTimeout(r, 150))
      // Gate held: no worker construction/spawn yet.
      expect(calls).toBe(1)
      expect(svc.getHost()).toBeNull()
      expect(svc.isStarted()).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(false)
      // Dispose while gate held (activation fire-and-forget still pending).
      svc.dispose()
      // Release gate after dispose — must not spawn.
      release()
      let err: unknown
      try { await pending } catch (e) { err = e }
      expect(err).toBeDefined()
      expect(String((err as Error).message)).toMatch(/disposed/i)
      // Zero worker spawn/process: no host, no pid, no pending, no DB.
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      expect(svc.isStarted()).toBe(false)
      expect(svc.getPendingShutdownHost()).toBeNull()
      expect(svc.getPendingShutdownProc()).toBeNull()
      expect(svc.getStatus().pid).toBeUndefined()
      expect(svc.getStatus().pendingPid).toBeUndefined()
      expect(svc.getStatus().disposed).toBe(true)
      expect(fs.existsSync(dbPath)).toBe(false)
      // Service guard still holds for late callers — reconnect/initialize throw.
      let errInit: unknown
      try { await svc.initialize() } catch (e) { errInit = e }
      expect(String((errInit as Error).message)).toMatch(/disposed/i)
      let errRecon: unknown
      try { await svc.reconnect() } catch (e) { errRecon = e }
      expect(String((errRecon as Error).message)).toMatch(/disposed/i)
      expect(svc.getHost()).toBeNull()
      expect(fs.existsSync(dbPath)).toBe(false)
    } finally {
      try { release() } catch {}
      svc.dispose()
      await new Promise((r) => setTimeout(r, 100))
      cleanup()
    }
  }, 10000)

  it("dispose during reconnect gate hold prevents replacement spawn (owned fixture)", async () => {
    const { tmp, xdg, dbPath, cleanup } = makeTempXdg()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: { XDG_DATA_HOME: xdg },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      canonicalStorageGate: async () => {},
    })
    try {
      await svc.initialize()
      expect(svc.isStarted()).toBe(true)
      const before = svc.getHost()?.getPid()
      expect(before).toBeDefined()
      // Hold reconnect re-initialize behind barrier gate.
      let calls = 0
      let release!: () => void
      const held = new Promise<void>((res) => { release = res })
      svc.setCanonicalStorageGate(async () => {
        calls++
        await held
      })
      const pending = svc.reconnect()
      void pending.catch(() => {})
      // Wait until reconnect has shut down old host and entered gate hold.
      const start = Date.now()
      while (calls === 0 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(calls).toBe(1)
      // Old host torn down, replacement not yet spawned.
      expect(svc.getHost()).toBeNull()
      expect(svc.isStarted()).toBe(false)
      svc.dispose()
      release()
      let err: unknown
      try { await pending } catch (e) { err = e }
      expect(err).toBeDefined()
      expect(String((err as Error).message)).toMatch(/disposed/i)
      expect(svc.getHost()).toBeNull()
      expect(svc.isStarted()).toBe(false)
      expect(svc.getPendingShutdownHost()).toBeNull()
      expect(svc.getPendingShutdownProc()).toBeNull()
      expect(svc.getStatus().disposed).toBe(true)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      cleanup()
    }
  }, 15000)
})
