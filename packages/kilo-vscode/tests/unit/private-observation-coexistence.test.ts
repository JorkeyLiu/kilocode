import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { OBSERVATION_METHODS, OBSERVATION_VERSION } from "../../src/private-worker/observation"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { resolveCanonicalDbPath } from "../../src/private-worker/canonical-db-path"
import { resolveManagedServerEnv } from "../../src/services/cli-backend/server-manager"
import { InMemoryCursorStore } from "../../src/private-worker/observation-cursor-store"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
}

async function waitForHostClosed(host: PrivateWorkerHost, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (host.hasExited()) return true
    const proc = host.getProc()
    if (proc && (proc.exitCode !== null || proc.signalCode !== null)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return host.hasExited()
}

function getHostPid(host: PrivateWorkerHost | null): number | undefined {
  if (!host) return undefined
  return host.getPid()
}

async function waitForFileGone(p: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(p)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !fs.existsSync(p)
}

describe("R9 production wiring coexistence — leased legacy + noLease observer on one canonical XDG root", () => {
  it("canonical resolver + managed env: exact absolute KILO_DB identity, ambient divergent override not leaked", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-coexist-canonical-"))
    const xdgData = path.join(tmp, "xdg-data")
    fs.mkdirSync(xdgData, { recursive: true })
    const env = { XDG_DATA_HOME: xdgData } as NodeJS.ProcessEnv
    const canonical = resolveCanonicalDbPath({ env, homedir: tmp })
    expect(path.isAbsolute(canonical)).toBe(true)
    expect(canonical).toBe(path.join(xdgData, "kilo", "kilo.db"))
    expect(canonical.endsWith(path.join("kilo", "kilo.db"))).toBe(true)

    // managed env must carry exact absolute canonical and override ambient divergent KILO_DB
    const out = resolveManagedServerEnv({
      PATH: "/usr/bin",
      KILO_DB: "/tmp/spoof.db",
      XDG_DATA_HOME: xdgData,
    } as unknown as NodeJS.ProcessEnv)
    expect(out.KILO_DB).toBe(canonical)
    expect(out.KILO_DISABLE_CHANNEL_DB).toBe("true")
    expect(out.PATH).toBe("/usr/bin")
    expect(path.isAbsolute(out.KILO_DB!)).toBe(true)

    // explicit override param honored when absolute
    const out2 = resolveManagedServerEnv({ PATH: "/usr/bin" }, "/custom/kilo.db")
    expect(out2.KILO_DB).toBe("/custom/kilo.db")

    // fail-closed when canonical empty: ambient must be removed, not leaked
    const fallback = resolveManagedServerEnv({ KILO_DB: "/tmp/spoof.db" } as NodeJS.ProcessEnv, "")
    expect(fallback.KILO_DB).toBeUndefined()

    fs.rmSync(tmp, { recursive: true, force: true })
    try {
      fs.rmSync(leasePathForDbFile(canonical), { force: true })
    } catch {}
  })

  it("activation path failure is fail-closed and does not block legacy bridge", async () => {
    // resolver throws when no homedir and no XDG_DATA_HOME
    let threw = false
    try {
      resolveCanonicalDbPath({ env: {}, homedir: "" })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    // service construction with invalid path is fail-closed: enabled false, no host, no lease
    const badSvc = new PrivateObservationService({
      enabled: true,
      dbPath: "relative/path.db",
      cursorStore: new InMemoryCursorStore(),
    })
    expect(badSvc.isEnabled()).toBe(false)
    expect(badSvc.getHost()).toBeNull()
    const offInit = await badSvc.initialize()
    expect(offInit).toBeUndefined()
    expect(badSvc.isStarted()).toBe(false)
    badSvc.dispose()

    // managed env with failing canonical still deletes ambient and keeps DISABLE_CHANNEL
    const env = resolveManagedServerEnv({ KILO_DB: "/tmp/spoof.db", PATH: "/usr/bin" } as NodeJS.ProcessEnv, "")
    expect(env.KILO_DB).toBeUndefined()
    expect(env.KILO_DISABLE_CHANNEL_DB).toBe("true")
    expect(env.PATH).toBe("/usr/bin")
  })

  it("leased legacy runtime and noLease private worker coexist on same canonical DB, both healthy, same changefeed visible, ack does not break bridge", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-coexist-"))
    const xdgData = path.join(tmp, "xdg-data")
    fs.mkdirSync(xdgData, { recursive: true })
    const xdg = {
      XDG_DATA_HOME: xdgData,
      XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
      XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
      XDG_STATE_HOME: path.join(tmp, "xdg-state"),
    } as Record<string, string>
    for (const v of Object.values(xdg)) fs.mkdirSync(v, { recursive: true })
    const dbPath = resolveCanonicalDbPath({ env: xdg as unknown as NodeJS.ProcessEnv, homedir: tmp })
    const lease = leasePathForDbFile(dbPath)
    expect(path.isAbsolute(dbPath)).toBe(true)
    expect(dbPath).toBe(path.join(xdgData, "kilo", "kilo.db"))
    expect(fs.existsSync(lease)).toBe(false)
    expect(fs.existsSync(dbPath)).toBe(false)
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    let legacyRuntime: ManagedRuntime.ManagedRuntime<Database.Service, never> | null = null
    let host: PrivateWorkerHost | null = null
    let svc: PrivateObservationService | null = null
    let host2: PrivateWorkerHost | null = null
    let legacyDb: Database.Database | null = null
    try {
      // Start leased legacy runtime (simulates kilo serve with Database.layerFromPath)
      const legacyLayer = Database.layerFromPath(dbPath)
      legacyRuntime = ManagedRuntime.make(legacyLayer)
      legacyDb = await legacyRuntime.runPromise(
        Effect.gen(function* () {
          const s = yield* Database.Service
          return s.db
        }),
      )
      // lease should now exist and be held by this process
      expect(fs.existsSync(lease)).toBe(true)
      expect(fs.existsSync(dbPath)).toBe(true)
      const leasePid = (() => {
        try {
          return JSON.parse(fs.readFileSync(lease, "utf8")).pid as number
        } catch {
          return undefined
        }
      })()
      expect(leasePid).toBe(process.pid)

      // legacy can write changefeed
      const entry1 = await Effect.runPromise(
        Changefeed.append(legacyDb!, { session_id: "ses_legacy_1", revision: 1, kind: "changed", time: 1000 }),
      )
      expect(entry1.seq).toBeGreaterThan(0)

      // Start noLease private worker on same canonical DB concurrently
      const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
      host = new PrivateWorkerHost({
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        env: { ...xdg, KILO_DB: dbPath, KILO_PRIVATE_WORKER_STANDALONE: "1" },
        initializeTimeoutMs: 8000,
      })
      const init = (await host.start()) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(host.getState()).toBe("open")
      const hostPid = getHostPid(host)
      expect(hostPid).toBeDefined()
      // noLease observer must NOT create/overwrite lease
      expect(fs.existsSync(lease)).toBe(true)
      expect(JSON.parse(fs.readFileSync(lease, "utf8")).pid).toBe(process.pid)

      // private can snapshot/read same DB and see legacy's entry
      const snap = (await host.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap.v).toBe(OBSERVATION_VERSION)
      expect(snap.cursor).toBe(entry1.seq)
      const read = (await host.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as {
        v: string
        cursor: number
        rehydrate: boolean
        entries: Array<{ seq: number; session_id: string }>
      }
      expect(read.v).toBe(OBSERVATION_VERSION)
      expect(read.rehydrate).toBe(false)
      expect(read.entries.length).toBe(1)
      expect(read.entries[0]!.seq).toBe(entry1.seq)
      expect(read.entries[0]!.session_id).toBe("ses_legacy_1")
      expect(read.cursor).toBe(entry1.seq)

      // private ack truncates prefix but keeps latest_seq; legacy should still be healthy
      const ack = (await host.request(OBSERVATION_METHODS.ACK, { cursor: entry1.seq })) as { v: string; cursor: number }
      expect(ack.v).toBe(OBSERVATION_VERSION)
      expect(ack.cursor).toBe(entry1.seq)

      // legacy can still write after ack, and private sees new entry (ack does not break bridge)
      const entry2 = await Effect.runPromise(
        Changefeed.append(legacyDb!, { session_id: "ses_legacy_2", revision: 1, kind: "changed", time: 1001 }),
      )
      expect(entry2.seq).toBeGreaterThan(entry1.seq)
      const snap2 = (await host.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
      expect(snap2.cursor).toBe(entry2.seq)
      const readAfter = (await host.request(OBSERVATION_METHODS.READ, { cursor: entry1.seq })) as {
        rehydrate: boolean
        entries: Array<{ seq: number }>
      }
      expect(readAfter.rehydrate).toBe(false)
      expect(readAfter.entries.length).toBe(1)
      expect(readAfter.entries[0]!.seq).toBe(entry2.seq)

      // also via PrivateObservationService high-level wrapper on same canonical path (noLease)
      svc = new PrivateObservationService({
        enabled: true,
        dbPath,
        env: xdg as unknown as NodeJS.ProcessEnv,
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        initializeTimeoutMs: 8000,
        cursorStore: new InMemoryCursorStore(),
      })
      // svc should initialize without contending for lease (coexist with legacy)
      const svcInit = (await svc.initialize()) as { protocolVersion: string }
      expect(svcInit.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      const svcPid = getHostPid(svc.getHost() as unknown as PrivateWorkerHost)
      expect(svcPid).toBeDefined()
      expect(svcPid).not.toBe(hostPid)
      expect(fs.existsSync(lease)).toBe(true)
      const svcSnap = (await svc.snapshot({})) as { cursor: number }
      expect(svcSnap.cursor).toBe(entry2.seq)
      // bounded exact-PID cleanup for svc: dispose and verify child exit, not just lease absence
      const svcHostBefore = svc.getHost() as unknown as PrivateWorkerHost | null
      const svcPidBefore = getHostPid(svcHostBefore)
      svc.dispose()
      if (svcHostBefore) expect(await waitForHostClosed(svcHostBefore, 2000)).toBe(true)
      expect(svc.isStarted()).toBe(false)
      expect(svcPidBefore).toBeDefined()
      // legacy still holds lease after private svc disposed (noLease svc never owned lease)
      expect(fs.existsSync(lease)).toBe(true)
      svc = null

      // legacy still holds lease after private disposed and svc child is gone
      // legacy can still read after private disposed
      const still = await Effect.runPromise(Changefeed.readAfter(legacyDb!, 0).pipe(Effect.orDie))
      expect(still.cursor).toBe(entry2.seq)

      // bounded exact-PID cleanup for host: dispose and verify exact child exit before legacy teardown
      const hostPidBefore = getHostPid(host)
      const hostRef = host
      host.dispose()
      expect(await waitForHostClosed(hostRef, 2000)).toBe(true)
      expect(hostRef.getState()).toBe("closed")
      expect(hostPidBefore).toBeDefined()
      // legacy still holds lease after private host disposed
      expect(fs.existsSync(lease)).toBe(true)
      host = null

      // after legacy disposed, private can still reacquire same DB (sequential) without lease
      host2 = new PrivateWorkerHost({
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        env: { ...xdg, KILO_DB: dbPath, KILO_PRIVATE_WORKER_STANDALONE: "1" },
        initializeTimeoutMs: 8000,
      })
      // host2 will be disposed in finally; but for this sequential reacquire we temporarily need legacy disposed first
      // dispose legacy runtime before starting host2 to prove sequential reacquire without lease contention
      if (legacyRuntime) {
        await legacyRuntime.dispose()
        legacyRuntime = null
        expect(await waitForFileGone(lease, 3000)).toBe(true)
        expect(fs.existsSync(lease)).toBe(false)
      }
      const init2 = (await host2.start()) as { protocolVersion: string }
      expect(init2.protocolVersion).toBe("1.0")
      const host2Pid = getHostPid(host2)
      expect(host2Pid).toBeDefined()
      expect(fs.existsSync(lease)).toBe(false)
      const snap3 = (await host2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
      // DB persists after legacy disposed, cursor still at latest
      expect(snap3.cursor).toBe(entry2.seq)
    } finally {
      // cleanup in ownership order: private hosts/workers first (exact PID), then legacy runtime, then filesystem
      if (svc) {
        const h = svc.getHost() as unknown as PrivateWorkerHost | null
        const pid = h ? getHostPid(h) : undefined
        svc.dispose()
        if (h) {
          expect(await waitForHostClosed(h, 3000)).toBe(true)
          expect(h.getState()).toBe("closed")
        }
        if (pid !== undefined) expect(h?.getState()).toBe("closed")
        svc = null
      }
      if (host) {
        const pid = getHostPid(host)
        const ref = host
        host.dispose()
        expect(await waitForHostClosed(ref, 3000)).toBe(true)
        expect(ref.getState()).toBe("closed")
        expect(pid).toBeDefined()
        host = null
      }
      if (host2) {
        const pid = getHostPid(host2)
        const ref = host2
        host2.dispose()
        expect(await waitForHostClosed(ref, 3000)).toBe(true)
        expect(ref.getState()).toBe("closed")
        expect(pid).toBeDefined()
        host2 = null
      }
      if (legacyRuntime) {
        await legacyRuntime.dispose()
        expect(await waitForFileGone(lease, 3000)).toBe(true)
        legacyRuntime = null
      } else {
        // ensure lease gone when legacy already disposed — exact file check, no swallow
        expect(await waitForFileGone(lease, 3000)).toBe(true)
      }
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.rmSync(lease, { force: true })
    }
  }, 30000)
})
