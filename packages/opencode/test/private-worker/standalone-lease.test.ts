import { describe, it, expect } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { OBSERVATION_METHODS, OBSERVATION_VERSION } from "../../src/private-worker/observation"

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

async function waitForFileGone(p: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(p)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !fs.existsSync(p)
}

async function waitForExit(proc: ChildProcess, timeoutMs = 3000): Promise<boolean> {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-standalone-"))
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

function spawnStandalone(env: NodeJS.ProcessEnv): { proc: ChildProcess; peer: JsonRpcPeer } {
  const workerTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
  const proc = spawn("bun", ["--conditions=browser", workerTs], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  })
  if (!proc.stdout || !proc.stdin) throw new Error("worker stdio missing")
  const peer = new JsonRpcPeer({ reader: proc.stdout, writer: proc.stdin, child: proc })
  return { proc, peer }
}

function spawnDefault(env: NodeJS.ProcessEnv): { proc: ChildProcess; peer: JsonRpcPeer } {
  const workerTs = path.resolve(process.cwd(), "src/private-worker/worker.ts")
  const proc = spawn("bun", ["--conditions=browser", workerTs], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  })
  if (!proc.stdout || !proc.stdin) throw new Error("worker stdio missing")
  const peer = new JsonRpcPeer({ reader: proc.stdout, writer: proc.stdin, child: proc })
  return { proc, peer }
}

describe("standalone private worker DB lease bootstrap (real child)", () => {
  it("opens isolated file-backed DB without lease, routes observation, releases on close, reacquires", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    try {
      expect(fs.existsSync(dbPath)).toBe(false)
      expect(fs.existsSync(lease)).toBe(false)

      const { proc: proc1, peer: peer1 } = spawnStandalone(env)
      try {
        const init = (await peer1.request("initialize", { clientInfo: { name: "test", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
        expect(init.protocolVersion).toBe("1.0")
        const pong = (await peer1.request("ping")) as { pong: boolean }
        expect(pong.pong).toBe(true)
        const echo = (await peer1.request("echo", { x: 42 })) as { x: number }
        expect(echo.x).toBe(42)

        // No-lease observer: Database.layerNoLease never creates a lease file
        expect(fs.existsSync(lease)).toBe(false)
        expect(fs.existsSync(dbPath)).toBe(true)

        const snap = (await peer1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number; snapshot: unknown }
        expect(snap.v).toBe(OBSERVATION_VERSION)
        expect(typeof snap.cursor).toBe("number")
        expect(snap.cursor).toBe(0)

        const read0 = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { v: string; cursor: number; rehydrate: boolean; entries: unknown[] }
        expect(read0.v).toBe(OBSERVATION_VERSION)
        expect(read0.rehydrate).toBe(false)
        expect(read0.entries.length).toBe(0)
        expect(read0.cursor).toBe(0)

        const sub = (await peer1.request(OBSERVATION_METHODS.SUBSCRIBE, {})) as { v: string; cursor: number; subscribed: boolean }
        expect(sub.v).toBe(OBSERVATION_VERSION)
        expect(sub.subscribed).toBe(true)
        expect(sub.cursor).toBe(0)

        const ack = (await peer1.request(OBSERVATION_METHODS.ACK, { cursor: 0 })) as { v: string; cursor: number }
        expect(ack.v).toBe(OBSERVATION_VERSION)
        expect(ack.cursor).toBe(0)

        try {
          await peer1.request(OBSERVATION_METHODS.ACK, { cursor: 9999 })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
        }
        try {
          await peer1.request(OBSERVATION_METHODS.READ, { cursor: -1 })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
        }
        const aheadRead = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: 9999 })) as { rehydrate: boolean; reason: string }
        expect(aheadRead.rehydrate).toBe(true)

        peer1.dispose()
        try { proc1.kill() } catch {}
        await new Promise((r) => setTimeout(r, 200))
        expect(peer1.getState()).toBe("closed")
        expect(fs.existsSync(lease)).toBe(false)
      } finally {
        try { peer1.dispose() } catch {}
        try { proc1.kill() } catch {}
      }

      // second worker can reacquire same DB sequentially; no-lease observer allows sequential reuse via canonical DB path
      const { proc: proc2, peer: peer2 } = spawnStandalone(env)
      try {
        const init2 = (await peer2.request("initialize", { clientInfo: { name: "test2", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
        expect(init2.protocolVersion).toBe("1.0")
        expect(fs.existsSync(lease)).toBe(false)
        const snap2 = (await peer2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
        expect(snap2.v).toBe(OBSERVATION_VERSION)
        expect(snap2.cursor).toBe(0)
        const read2 = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: unknown[] }
        expect(read2.rehydrate).toBe(false)
        expect(read2.entries.length).toBe(0)
        peer2.dispose()
        try { proc2.kill() } catch {}
        await new Promise((r) => setTimeout(r, 200))
        expect(fs.existsSync(lease)).toBe(false)
      } finally {
        try { peer2.dispose() } catch {}
        try { proc2.kill() } catch {}
      }
    } finally {
      await cleanup()
    }
  }, 20000)

  it("does not create DB lease when standalone disabled even with absolute KILO_DB (real child negative gate)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-standalone-neg-"))
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
      const { proc, peer } = spawnDefault(env)
      try {
        const init = (await peer.request("initialize", { clientInfo: { name: "neg", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
        expect(init.protocolVersion).toBe("1.0")
        const pong = (await peer.request("ping")) as { pong: boolean }
        expect(pong.pong).toBe(true)
        await new Promise((r) => setTimeout(r, 200))
        expect(fs.existsSync(lease)).toBe(false)
        peer.dispose()
        try { proc.kill() } catch {}
        await new Promise((r) => setTimeout(r, 200))
        expect(peer.getState()).toBe("closed")
        expect(fs.existsSync(lease)).toBe(false)
      } finally {
        try { peer.dispose() } catch {}
        try { proc.kill() } catch {}
      }
    } finally {
      await cleanup()
    }
  }, 15000)

  it("concurrent second real child coexists on same DB without lease while first holds it; both remain healthy (real-child coexistence)", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    let proc1: ChildProcess | undefined
    let peer1: JsonRpcPeer | undefined
    let proc2: ChildProcess | undefined
    let peer2: JsonRpcPeer | undefined
    try {
      expect(fs.existsSync(lease)).toBe(false)
      const first = spawnStandalone(env)
      proc1 = first.proc
      peer1 = first.peer
      const init1 = (await peer1.request("initialize", { clientInfo: { name: "winner", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
      expect(init1.protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)
      const pong1 = (await peer1.request("ping")) as { pong: boolean }
      expect(pong1.pong).toBe(true)

      const second = spawnStandalone(env)
      proc2 = second.proc
      peer2 = second.peer
      const init2 = (await peer2.request("initialize", { clientInfo: { name: "coexist", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
      expect(init2.protocolVersion).toBe("1.0")
      // Both should be open and healthy; no lease file contention
      expect(peer1.getState()).toBe("open")
      expect(peer2.getState()).toBe("open")
      expect(fs.existsSync(lease)).toBe(false)
      expect(proc1.pid).toBeDefined()
      expect(proc2.pid).toBeDefined()
      expect(proc2.pid).not.toBe(proc1.pid)

      const pong2 = (await peer2.request("ping")) as { pong: boolean }
      expect(pong2.pong).toBe(true)

      const snap1 = (await peer1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      const snap2 = (await peer2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap1.v).toBe(OBSERVATION_VERSION)
      expect(snap2.v).toBe(OBSERVATION_VERSION)
      expect(snap1.cursor).toBe(0)
      expect(snap2.cursor).toBe(0)

      const read2 = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: unknown[] }
      expect(read2.rehydrate).toBe(false)
      expect(read2.entries.length).toBe(0)

      const pongAfter = (await peer1.request("ping")) as { pong: boolean }
      expect(pongAfter.pong).toBe(true)
      const snapAfter = (await peer1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snapAfter.v).toBe(OBSERVATION_VERSION)
      expect(snapAfter.cursor).toBe(0)
      expect(peer2.getState()).toBe("open")
    } finally {
      try { peer1?.dispose() } catch {}
      try { if (proc1) proc1.kill() } catch {}
      try { peer2?.dispose() } catch {}
      try { if (proc2) proc2.kill() } catch {}
      if (proc1) await waitForExit(proc1, 2000)
      if (proc2) await waitForExit(proc2, 2000)
      expect(fs.existsSync(lease)).toBe(false)
      await cleanup()
    }
  }, 20000)

  it("abrupt SIGKILL of worker leaves recoverable DB without lease; next real child reacquires and observes valid cursor (crash-recovery)", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    let proc1: ChildProcess | undefined
    let peer1: JsonRpcPeer | undefined
    let proc2: ChildProcess | undefined
    let peer2: JsonRpcPeer | undefined
    try {
      const first = spawnStandalone(env)
      proc1 = first.proc
      peer1 = first.peer
      const init1 = (await peer1.request("initialize", { clientInfo: { name: "crash-victim", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
      expect(init1.protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)
      const victimPid = proc1.pid
      const snap1 = (await peer1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap1.cursor).toBe(0)

      expect(proc1.pid).toBeDefined()
      try { proc1.kill("SIGKILL") } catch {}
      await waitForExit(proc1, 3000)
      await new Promise((r) => setTimeout(r, 150))
      expect(peer1.getState()).toBe("closed")
      // No-lease observer never creates lease file
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)

      const second = spawnStandalone(env)
      proc2 = second.proc
      peer2 = second.peer
      const init2 = (await peer2.request("initialize", { clientInfo: { name: "recovery", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
      expect(init2.protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)
      expect(proc2.pid).toBeDefined()
      expect(proc2.pid).not.toBe(victimPid)
      const pong2 = (await peer2.request("ping")) as { pong: boolean }
      expect(pong2.pong).toBe(true)
      const snap2 = (await peer2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap2.v).toBe(OBSERVATION_VERSION)
      expect(snap2.cursor).toBe(0)
      const read2 = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: unknown[]; v: string; cursor: number }
      expect(read2.v).toBe(OBSERVATION_VERSION)
      expect(read2.rehydrate).toBe(false)
      expect(read2.entries.length).toBe(0)
      const ahead = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: 9999 })) as { rehydrate: boolean }
      expect(ahead.rehydrate).toBe(true)
    } finally {
      try { peer1?.dispose() } catch {}
      try { if (proc1 && proc1.exitCode === null && proc1.signalCode === null) proc1.kill() } catch {}
      try { peer2?.dispose() } catch {}
      try { if (proc2) proc2.kill() } catch {}
      if (proc1) await waitForExit(proc1, 2000)
      if (proc2) await waitForExit(proc2, 2000)
      expect(fs.existsSync(lease)).toBe(false)
      await cleanup()
    }
  }, 25000)

  it("preserves existing injected deps precedence and default startup without env", async () => {
    const { startWorker } = await import("../../src/private-worker/worker")
    const { PassThrough } = await import("stream")
    const { ObservationController } = await import("../../src/private-worker/observation")
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const deps = {
      getSnapshot: async () => ({ cursor: 5, snapshot: { hello: "world" } }),
      readAfter: async () => ({ type: "deltas" as const, cursor: 5, entries: [] }),
      ack: async () => {},
    }
    const server = startWorker({ reader: aToB, writer: bToA, observationDeps: deps })
    const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
    const snap = (await client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
    expect(snap.cursor).toBe(5)
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

  it("default worker remains lightweight without standalone imports; standalone is isolated", async () => {
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
    expect(standalone).toContain("KILO_DB")
    expect(def).toContain("ObservationController")
  })
})
