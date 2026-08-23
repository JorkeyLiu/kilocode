import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { OBSERVATION_METHODS, OBSERVATION_VERSION } from "../../src/private-worker/observation"
import { startWorker } from "../../src/private-worker/worker"
import { PassThrough } from "stream"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
}

async function waitForFileExists(p: string, timeoutMs = 2000): Promise<boolean> {
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

function getHostProc(host: PrivateWorkerHost): import("child_process").ChildProcess | null {
  return (host as unknown as { proc: import("child_process").ChildProcess | null }).proc
}

async function waitForHostClosed(host: PrivateWorkerHost, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (host.getState() === "closed") return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return host.getState() === "closed"
}

async function waitForExit(proc: import("child_process").ChildProcess, timeoutMs = 3000): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true
  return await new Promise<boolean>((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      proc.removeListener("exit", onExit)
      proc.removeListener("close", onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.removeListener("exit", onExit)
      proc.removeListener("close", onExit)
      resolve(true)
    }
    proc.once("exit", onExit)
    proc.once("close", onExit)
  })
}

function makeTmpEnv(): { tmp: string; dbPath: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-standalone-"))
  const dataDir = path.join(tmp, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "kilo.db")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILO_PRIVATE_WORKER_STANDALONE: "1",
    KILO_DB: dbPath,
    XDG_DATA_HOME: path.join(tmp, "xdg-data"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  }
  for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    const v = env[k]!
    fs.mkdirSync(v, { recursive: true })
  }
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

describe("standalone private worker DB lease bootstrap (real child via PrivateWorkerHost)", () => {
  it("opens isolated file-backed DB without lease, routes observation, releases on close, reacquires", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    try {
      expect(fs.existsSync(dbPath)).toBe(false)
      expect(fs.existsSync(lease)).toBe(false)

      const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
      const host = new PrivateWorkerHost({
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        env,
        initializeTimeoutMs: 5000,
      })
      const init = await host.start()
      expect((init as { protocolVersion: string }).protocolVersion).toBe("1.0")

      const pong = (await host.request("ping")) as { pong: boolean }
      expect(pong.pong).toBe(true)
      const echo = (await host.request("echo", { x: 99 })) as { x: number }
      expect(echo.x).toBe(99)

      // No-lease observer: Database.layerNoLease never creates a lease file
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)

      const snap = (await host.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap.v).toBe(OBSERVATION_VERSION)
      expect(snap.cursor).toBe(0)

      const read0 = (await host.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { v: string; cursor: number; rehydrate: boolean; entries: unknown[] }
      expect(read0.v).toBe(OBSERVATION_VERSION)
      expect(read0.rehydrate).toBe(false)
      expect(read0.entries.length).toBe(0)

      const sub = (await host.request(OBSERVATION_METHODS.SUBSCRIBE, {})) as { v: string; cursor: number; subscribed: boolean }
      expect(sub.v).toBe(OBSERVATION_VERSION)
      expect(sub.subscribed).toBe(true)

      const ack = (await host.request(OBSERVATION_METHODS.ACK, { cursor: 0 })) as { v: string; cursor: number }
      expect(ack.v).toBe(OBSERVATION_VERSION)
      expect(ack.cursor).toBe(0)

      try {
        await host.request(OBSERVATION_METHODS.ACK, { cursor: 9999 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }

      try {
        await host.request(OBSERVATION_METHODS.READ, { cursor: -1 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }

      const aheadRead = (await host.request(OBSERVATION_METHODS.READ, { cursor: 9999 })) as { rehydrate: boolean }
      expect(aheadRead.rehydrate).toBe(true)

      host.dispose()
      await new Promise((r) => setTimeout(r, 300))
      expect(host.getState()).toBe("closed")
      // No lease file was ever created, so none to remove
      expect(fs.existsSync(lease)).toBe(false)

      // second worker can reacquire same DB sequentially; no lease exclusivity, sequential reuse via canonical DB path
      const host2 = new PrivateWorkerHost({
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        env,
        initializeTimeoutMs: 5000,
      })
      const init2 = await host2.start()
      expect((init2 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)
      const snap2 = (await host2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap2.v).toBe(OBSERVATION_VERSION)
      expect(snap2.cursor).toBe(0)
      const read2 = (await host2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: unknown[] }
      expect(read2.rehydrate).toBe(false)
      expect(read2.entries.length).toBe(0)
      host2.dispose()
      await new Promise((r) => setTimeout(r, 300))
      expect(fs.existsSync(lease)).toBe(false)
    } finally {
      await cleanup()
    }
  }, 25000)

  it("does not create DB lease when standalone disabled even with absolute KILO_DB (real child negative gate)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-standalone-neg-"))
    const dataDir = path.join(tmp, "data")
    fs.mkdirSync(dataDir, { recursive: true })
    const dbPath = path.join(dataDir, "kilo.db")
    const lease = leasePathForDbFile(dbPath)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KILO_DB: dbPath,
      XDG_DATA_HOME: path.join(tmp, "xdg-data"),
      XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
      XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
      XDG_STATE_HOME: path.join(tmp, "xdg-state"),
    }
    delete env.KILO_PRIVATE_WORKER_STANDALONE
    for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      fs.mkdirSync(env[k]!, { recursive: true })
    }
    const cleanup = async () => {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      try { fs.rmSync(lease, { force: true }) } catch {}
    }
    try {
      expect(fs.existsSync(lease)).toBe(false)
      const workerTs = path.resolve(process.cwd(), "src/private-worker/worker.ts")
      const host = new PrivateWorkerHost({
        command: "bun",
        args: ["--conditions=browser", workerTs],
        env,
        initializeTimeoutMs: 5000,
      })
      const init = await host.start()
      expect((init as { protocolVersion: string }).protocolVersion).toBe("1.0")
      const pong = (await host.request("ping")) as { pong: boolean }
      expect(pong.pong).toBe(true)
      await new Promise((r) => setTimeout(r, 200))
      expect(fs.existsSync(lease)).toBe(false)
      host.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(host.getState()).toBe("closed")
      expect(fs.existsSync(lease)).toBe(false)
    } finally {
      await cleanup()
    }
  }, 15000)

  it("concurrent second real child coexists on same DB without lease while first holds it; both remain healthy (real-child coexistence)", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const host1 = new PrivateWorkerHost({ command: "bun", args: ["--conditions=browser", standaloneTs], env, initializeTimeoutMs: 5000 })
    let host2: PrivateWorkerHost | null = null
    try {
      const init1 = await host1.start()
      expect((init1 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      // No-lease: no lease file is created
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)
      const proc1 = getHostProc(host1)
      expect(proc1?.pid).toBeDefined()
      const pong1 = (await host1.request("ping")) as { pong: boolean }
      expect(pong1.pong).toBe(true)

      host2 = new PrivateWorkerHost({ command: "bun", args: ["--conditions=browser", standaloneTs], env, initializeTimeoutMs: 5000 })
      const init2 = await host2.start()
      expect((init2 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      // Both hosts should be open and healthy; no lease file contention
      expect(host1.getState()).toBe("open")
      expect(host2.getState()).toBe("open")
      expect(fs.existsSync(lease)).toBe(false)
      const proc2 = getHostProc(host2)
      expect(proc2?.pid).toBeDefined()
      expect(proc2?.pid).not.toBe(proc1?.pid)

      const pong2 = (await host2.request("ping")) as { pong: boolean }
      expect(pong2.pong).toBe(true)
      // Both can observe same DB without lease exclusivity
      const snap1 = (await host1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      const snap2 = (await host2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap1.v).toBe(OBSERVATION_VERSION)
      expect(snap2.v).toBe(OBSERVATION_VERSION)
      expect(snap1.cursor).toBe(0)
      expect(snap2.cursor).toBe(0)

      const read2 = (await host2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: unknown[] }
      expect(read2.rehydrate).toBe(false)
      expect(read2.entries.length).toBe(0)

      // Both remain healthy after coexistence
      const pongAfter = (await host1.request("ping")) as { pong: boolean }
      expect(pongAfter.pong).toBe(true)
      const snapAfter = (await host1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snapAfter.v).toBe(OBSERVATION_VERSION)
      expect(snapAfter.cursor).toBe(0)
    } finally {
      host1.dispose()
      host2?.dispose()
      await waitForHostClosed(host1, 2000)
      if (host2) await waitForHostClosed(host2, 2000)
      await new Promise((r) => setTimeout(r, 200))
      expect(fs.existsSync(lease)).toBe(false)
      await cleanup()
    }
  }, 20000)

  it("abrupt SIGKILL of worker leaves recoverable DB without lease; next real child reacquires and observes valid cursor (crash-recovery)", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const host1 = new PrivateWorkerHost({ command: "bun", args: ["--conditions=browser", standaloneTs], env, initializeTimeoutMs: 5000 })
    let host2: PrivateWorkerHost | null = null
    try {
      const init1 = await host1.start()
      expect((init1 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)
      const proc1 = getHostProc(host1)
      const victimPid = proc1?.pid
      expect(victimPid).toBeDefined()
      const snap1 = (await host1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
      expect(snap1.cursor).toBe(0)

      // abrupt exact-PID SIGKILL (no graceful cleanup)
      expect(proc1?.pid).toBeDefined()
      try { proc1!.kill("SIGKILL") } catch {}
      await waitForHostClosed(host1, 3000)
      await new Promise((r) => setTimeout(r, 150))
      expect(host1.getState()).toBe("closed")
      // No-lease observer never creates lease file, so no stale lease remains
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)

      host2 = new PrivateWorkerHost({ command: "bun", args: ["--conditions=browser", standaloneTs], env, initializeTimeoutMs: 5000 })
      const init2 = await host2.start()
      expect((init2 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)
      const proc2 = getHostProc(host2)
      expect(proc2?.pid).toBeDefined()
      expect(proc2?.pid).not.toBe(victimPid)
      const pong2 = (await host2.request("ping")) as { pong: boolean }
      expect(pong2.pong).toBe(true)
      const snap2 = (await host2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap2.v).toBe(OBSERVATION_VERSION)
      expect(snap2.cursor).toBe(0)
      const read2 = (await host2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: unknown[]; v: string; cursor: number }
      expect(read2.v).toBe(OBSERVATION_VERSION)
      expect(read2.rehydrate).toBe(false)
      expect(read2.entries.length).toBe(0)
      const ahead = (await host2.request(OBSERVATION_METHODS.READ, { cursor: 9999 })) as { rehydrate: boolean }
      expect(ahead.rehydrate).toBe(true)
    } finally {
      host1.dispose()
      host2?.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(fs.existsSync(lease)).toBe(false)
      await cleanup()
    }
  }, 25000)

  it("preserves injected deps precedence and default startup without env", async () => {
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const deps = {
      getSnapshot: async () => ({ cursor: 7, snapshot: { hi: 1 } }),
      readAfter: async () => ({ type: "deltas" as const, cursor: 7, entries: [] }),
      ack: async () => {},
    }
    const server = startWorker({ reader: aToB, writer: bToA, observationDeps: deps })
    const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
    const snap = (await client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
    expect(snap.cursor).toBe(7)
    client.dispose()
    server.dispose()

    const aToB2 = new PassThrough()
    const bToA2 = new PassThrough()
    const server2 = startWorker({ reader: aToB2, writer: bToA2 })
    const client2 = new JsonRpcPeer({ reader: bToA2, writer: aToB2 })
    const pong = (await client2.request("ping")) as { pong: boolean }
    expect(pong.pong).toBe(true)
    client2.dispose()
    server2.dispose()
  })

  it("default worker remains lightweight; standalone is isolated and host gate selects artifact", async () => {
    const base = path.resolve(process.cwd(), "src/private-worker")
    const def = fs.readFileSync(path.join(base, "worker.ts"), "utf8")
    expect(def).not.toContain("Database.layerFromPath")
    expect(def).not.toContain("Database.layerNoLease")
    expect(def).not.toContain("createChangefeedDeps")
    expect(def).not.toContain("KILO_PRIVATE_WORKER_STANDALONE")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    expect(standalone).toContain("Database.layerNoLease")
    expect(standalone).not.toContain("Database.layerFromPath")
    expect(standalone).toContain("createChangefeedDeps")
    expect(standalone).toContain("KILO_PRIVATE_WORKER_STANDALONE")
    const { isStandaloneEnabled } = await import("../../src/private-worker/host")
    expect(isStandaloneEnabled({ KILO_PRIVATE_WORKER_STANDALONE: "1", KILO_DB: "/tmp/kilo.db" } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(isStandaloneEnabled({ KILO_PRIVATE_WORKER_STANDALONE: "1", KILO_DB: "relative.db" } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isStandaloneEnabled({ KILO_DB: "/tmp/kilo.db" } as unknown as NodeJS.ProcessEnv)).toBe(false)
  })
})
