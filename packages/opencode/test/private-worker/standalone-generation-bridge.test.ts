import { describe, it, expect } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { OBSERVATION_METHODS, OBSERVATION_VERSION, OBSERVATION_NOTIFICATION } from "../../src/private-worker/observation"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-gen-bridge-"))
  const dataDir = path.join(tmp, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "kilo.db")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILO_PRIVATE_WORKER_STANDALONE: "1",
    KILO_PRIVATE_WORKER_TEST_BRIDGE: "1",
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
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    const lease = leasePathForDbFile(dbPath)
    try { fs.rmSync(lease, { force: true }) } catch {}
  }
  return { tmp, dbPath, env, cleanup }
}

function spawnStandalone(env: NodeJS.ProcessEnv, onNotification?: (method: string, params: unknown) => void): { proc: ChildProcess; peer: JsonRpcPeer } {
  const workerTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
  const proc = spawn("bun", ["--conditions=browser", workerTs], { stdio: ["pipe", "pipe", "pipe"], env })
  if (!proc.stdout || !proc.stdin) throw new Error("worker stdio missing")
  const peer = new JsonRpcPeer({ reader: proc.stdout, writer: proc.stdin, child: proc, onNotification })
  return { proc, peer }
}

async function waitForNotificationCount(arr: unknown[], expected: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (arr.length >= expected) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return arr.length >= expected
}

describe("standalone test/mutateChangefeed generation preservation (bounded)", () => {
  it("preserves generation kind through bridge and reaches normal validation; unknown falls back to changed", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    let proc: ChildProcess | undefined
    let peer: JsonRpcPeer | undefined
    const notifs: Array<{ method: string; params: unknown }> = []
    try {
      const spawned = spawnStandalone(env, (m, p) => notifs.push({ method: m, params: p }))
      proc = spawned.proc
      peer = spawned.peer
      const init = (await peer.request("initialize", { clientInfo: { name: "gen-bridge-test", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)

      const snap0 = (await peer.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap0.v).toBe(OBSERVATION_VERSION)
      const before = snap0.cursor

      // generation must be preserved verbatim
      const gen = (await peer.request("test/mutateChangefeed", { session_id: "ses_gen_bridge_a", revision: 1, kind: "generation", time: 9000 })) as { v: string; cursor: number; entry: { seq: number; session_id: string; revision: number; kind: string; time: number } }
      expect(gen.v).toBe(OBSERVATION_VERSION)
      expect(gen.entry.kind).toBe("generation")
      expect(gen.cursor).toBe(gen.entry.seq)
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      const n1 = notifs[0]!.params as { v: string; cursor: number; entries: Array<{ kind: string; seq: number }> }
      expect(n1.v).toBe(OBSERVATION_VERSION)
      expect(n1.entries[0]!.kind).toBe("generation")
      expect(n1.entries[0]!.seq).toBe(gen.cursor)

      // read after must validate generation identically to changed/deleted (no special behavior)
      const read = (await peer.request(OBSERVATION_METHODS.READ, { cursor: before })) as { rehydrate: boolean; cursor: number; entries: Array<{ kind: string; seq: number }> }
      expect(read.rehydrate).toBe(false)
      expect(read.entries.length).toBe(1)
      expect(read.entries[0]!.kind).toBe("generation")
      expect(read.cursor).toBe(gen.cursor)

      // mixed changed + generation would also be valid but single generation already proves validator accepts it
      // unknown kind must safely fall back to changed (existing fallback behavior)
      const bogus = (await peer.request("test/mutateChangefeed", { session_id: "ses_gen_bridge_b", revision: 1, kind: "bogus_unknown", time: 9001 })) as { cursor: number; entry: { kind: string } }
      expect(bogus.entry.kind).toBe("changed")
      expect(await waitForNotificationCount(notifs, 2, 3000)).toBe(true)
      const n2 = notifs[1]!.params as { entries: Array<{ kind: string }> }
      expect(n2.entries[0]!.kind).toBe("changed")

      const snap1 = (await peer.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
      expect(snap1.cursor).toBe(bogus.cursor)
      expect(snap1.cursor).toBeGreaterThan(before)
    } finally {
      try { peer?.dispose() } catch {}
      try { if (proc) proc.kill() } catch {}
      if (proc) await waitForExit(proc, 2000)
      expect(fs.existsSync(lease)).toBe(false)
      await cleanup()
    }
  }, 30000)

  it("standalone source still coerces only unknown kinds and keeps bundle markers", async () => {
    const base = path.resolve(process.cwd(), "src/private-worker")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    expect(standalone).toContain(`kindRaw === "generation"`)
    expect(standalone).toContain(`KILO_PRIVATE_WORKER_TEST_BRIDGE`)
    expect(standalone).toContain("notifyChanged")
  })
})
