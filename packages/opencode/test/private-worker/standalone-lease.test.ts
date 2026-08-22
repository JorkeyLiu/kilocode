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

function readLeasePid(p: string): number | undefined {
  try {
    const raw = fs.readFileSync(p, "utf8")
    const data = JSON.parse(raw)
    return typeof data.pid === "number" ? data.pid : undefined
  } catch {
    return undefined
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    const code = (e as { code?: string }).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    return true
  }
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
  // ensure XDG dirs exist
  for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    const v = env[k]!
    fs.mkdirSync(v, { recursive: true })
  }
  const cleanup = async () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
    // also clean sibling lease file that lives beside tmp
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
  it("opens isolated file-backed DB with lease, routes observation, releases on close, reacquires", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    try {
      // ensure clean start
      expect(fs.existsSync(dbPath)).toBe(false)
      expect(fs.existsSync(lease)).toBe(false)

      const { proc: proc1, peer: peer1 } = spawnStandalone(env)
      try {
        const init = (await peer1.request("initialize", { clientInfo: { name: "test", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
        expect(init.protocolVersion).toBe("1.0")
        // ping/echo still work
        const pong = (await peer1.request("ping")) as { pong: boolean }
        expect(pong.pong).toBe(true)
        const echo = (await peer1.request("echo", { x: 42 })) as { x: number }
        expect(echo.x).toBe(42)

        // lease should be held while worker lives
        expect(await waitForFileExists(lease, 2000)).toBe(true)
        expect(fs.existsSync(dbPath)).toBe(true)

        // observation routing over real child with empty DB
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

        // invalid cursor maps to InvalidParams (-32602)
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
        // cursor ahead returns rehydrate true (not InvalidParams); InvalidParams is for truly invalid cursor like -1
        expect(aheadRead.rehydrate).toBe(true)

        // ensure second concurrent open is not attempted while first holds; instead we dispose first and verify lease release
        peer1.dispose()
        try { proc1.kill() } catch {}
        await new Promise((r) => setTimeout(r, 200))
        // peer should be closed, lease should be gone after disposal (allow small delay)
        expect(peer1.getState()).toBe("closed")
        expect(await waitForFileGone(lease, 3000)).toBe(true)
      } finally {
        try { peer1.dispose() } catch {}
        try { proc1.kill() } catch {}
      }

      // second worker can reacquire same DB sequentially; lease exclusivity is provided by Database.layerFromPath but concurrent-owner behavior was not exercised in this increment
      const { proc: proc2, peer: peer2 } = spawnStandalone(env)
      try {
        const init2 = (await peer2.request("initialize", { clientInfo: { name: "test2", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
        expect(init2.protocolVersion).toBe("1.0")
        expect(await waitForFileExists(lease, 2000)).toBe(true)
        const snap2 = (await peer2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
        expect(snap2.v).toBe(OBSERVATION_VERSION)
        // still empty cursor 0 (no mutation via protocol)
        expect(snap2.cursor).toBe(0)
        const read2 = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; entries: unknown[] }
        expect(read2.rehydrate).toBe(false)
        expect(read2.entries.length).toBe(0)
        peer2.dispose()
        try { proc2.kill() } catch {}
        await new Promise((r) => setTimeout(r, 200))
        expect(await waitForFileGone(lease, 3000)).toBe(true)
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
        // lease must not be created when standalone gate disabled
        await new Promise((r) => setTimeout(r, 200))
        expect(fs.existsSync(lease)).toBe(false)
        // also DB file should not be created via leased layer (worker runs without DB)
        // we allow DB file to remain absent; absence confirms no leased acquisition
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

  it("concurrent second real child fails to acquire same DB lease while first holds it; winner remains healthy (real-child lease contention)", async () => {
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
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const winnerPid = readLeasePid(lease)
      expect(typeof winnerPid).toBe("number")
      expect(winnerPid).toBe(proc1.pid)
      // winner healthy before contention
      const pong1 = (await peer1.request("ping")) as { pong: boolean }
      expect(pong1.pong).toBe(true)

      // concurrent second child with same DB/env
      const second = spawnStandalone(env)
      proc2 = second.proc
      peer2 = second.peer
      // loser must fail observably: initialize rejects or peer closes or proc exits non-zero
      let loserFailed = false
      let loserError: unknown = null
      let initSucceeded = false
      try {
        const init2 = peer2.request("initialize", { clientInfo: { name: "loser", version: "1" }, protocolVersion: "1.0" })
        // bound wait: either initialize resolves/rejects or proc exits
        const raced = await Promise.race([
          init2.then(
            () => ({ ok: true as const }),
            (e) => ({ ok: false as const, err: e }),
          ),
          new Promise<{ ok: boolean; err?: unknown }>((resolve) =>
            setTimeout(() => resolve({ ok: false, err: new Error("initialize did not settle") }), 4000),
          ),
        ])
        if (!raced.ok) {
          loserError = (raced as { err?: unknown }).err
          initSucceeded = false
        } else {
          // if it unexpectedly succeeded, that is failure of exclusivity
          initSucceeded = true
        }
      } catch (e) {
        loserError = e
        initSucceeded = false
      }
      // Strict observability: timeout alone does not count; require peer closed or proc exited within bound
      const procExited = await waitForExit(proc2, 3000)
      if (peer2.getState() !== "closed") await new Promise((r) => setTimeout(r, 100))
      const peerClosed = peer2.getState() === "closed"
      loserFailed = !initSucceeded && (peerClosed || procExited)
      expect(loserFailed).toBe(true)
      // error should be observable (InternalError from peer closed or lease message in stderr if available)
      if (loserError) {
        const msg = String((loserError as Error).message ?? loserError)
        // at least contains closed/timeout/lease exclusivity signal
        expect(msg.length > 0).toBe(true)
      }
      // loser must not have corrupted winner lease
      expect(fs.existsSync(lease)).toBe(true)
      expect(readLeasePid(lease)).toBe(winnerPid)
      expect(isPidAlive(winnerPid!)).toBe(true)
      // winner remains healthy after contention
      expect(peer1.getState()).toBe("open")
      const pongAfter = (await peer1.request("ping")) as { pong: boolean }
      expect(pongAfter.pong).toBe(true)
      const snapAfter = (await peer1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snapAfter.v).toBe(OBSERVATION_VERSION)
      expect(snapAfter.cursor).toBe(0)
      // loser peer should be closed; if not, close it
      expect(peer2.getState()).toBe("closed")
    } finally {
      try { peer1?.dispose() } catch {}
      try { if (proc1) proc1.kill() } catch {}
      try { peer2?.dispose() } catch {}
      try { if (proc2) proc2.kill() } catch {}
      // wait bounded for winner lease release after dispose
      if (proc1) await waitForExit(proc1, 2000)
      if (proc2) await waitForExit(proc2, 2000)
      await waitForFileGone(lease, 3000).catch(() => {})
      await cleanup()
    }
  }, 20000)

  it("abrupt SIGKILL of worker leaves recoverable lease; next real child reacquires and observes valid cursor (crash-recovery)", async () => {
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
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const victimPid = readLeasePid(lease)
      expect(victimPid).toBe(proc1.pid)
      const snap1 = (await peer1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap1.cursor).toBe(0)

      // abrupt exact-PID termination via SIGKILL (no graceful cleanup)
      expect(proc1.pid).toBeDefined()
      try { proc1.kill("SIGKILL") } catch {}
      await waitForExit(proc1, 3000)
      await new Promise((r) => setTimeout(r, 150))
      expect(peer1.getState()).toBe("closed")
      // lease file should remain with stale PID (worker had no chance to clean)
      expect(fs.existsSync(lease)).toBe(true)
      const stalePid = readLeasePid(lease)
      expect(stalePid).toBe(victimPid)
      expect(isPidAlive(stalePid!)).toBe(false)

      // next real child should recover stale lease and succeed
      const second = spawnStandalone(env)
      proc2 = second.proc
      peer2 = second.peer
      const init2 = (await peer2.request("initialize", { clientInfo: { name: "recovery", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
      expect(init2.protocolVersion).toBe("1.0")
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const recoveredPid = readLeasePid(lease)
      expect(recoveredPid).toBe(proc2.pid)
      expect(recoveredPid).not.toBe(victimPid)
      expect(isPidAlive(recoveredPid!)).toBe(true)
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
      await waitForFileGone(lease, 3000).catch(() => {})
      await cleanup()
    }
  }, 25000)

  it("preserves existing injected deps precedence and default startup without env", async () => {
    // In-process startWorker with injected deps should still work without lease
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

    // Default worker without env and without injected deps should still start and handle ping
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
    expect(def).not.toContain("createChangefeedDeps")
    expect(def).not.toContain("KILO_PRIVATE_WORKER_STANDALONE")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    expect(standalone).toContain("Database.layerFromPath")
    expect(standalone).toContain("createChangefeedDeps")
    expect(standalone).toContain("KILO_PRIVATE_WORKER_STANDALONE")
    expect(standalone).toContain("KILO_DB")
    // default still handles observation via injection
    expect(def).toContain("ObservationController")
  })
})
