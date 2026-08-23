import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { OBSERVATION_METHODS, OBSERVATION_VERSION, OBSERVATION_NOTIFICATION } from "../../src/private-worker/observation"
import { startWorker } from "../../src/private-worker/worker"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { PassThrough } from "stream"

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

async function waitForHostClosed(host: PrivateWorkerHost, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (host.getState() === "closed") return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return host.getState() === "closed"
}

async function waitForNotificationCount(arr: unknown[], expected: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (arr.length >= expected) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return arr.length >= expected
}

function makeTmpEnv(): { tmp: string; dbPath: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-live-"))
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

describe("live canonical changefeed notification delivery and reconnect (real child file-backed via PrivateWorkerHost)", () => {
  it("proves initialize/snapshot/read, one live payload-free changed notification with monotonic cursor, read/ack, stale→rehydrate, sequential reacquire, no duplicate from prior host", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const notifs1: Array<{ method: string; params: unknown }> = []
    const notifs2: Array<{ method: string; params: unknown }> = []
    const host1 = new PrivateWorkerHost({
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      env,
      initializeTimeoutMs: 8000,
      onNotification: (m, p) => notifs1.push({ method: m, params: p }),
    })
    let host2: PrivateWorkerHost | null = null
    try {
      expect(fs.existsSync(lease)).toBe(false)
      const init1 = await host1.start()
      expect((init1 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      expect(fs.existsSync(dbPath)).toBe(true)
      const snap0 = (await host1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap0.v).toBe(OBSERVATION_VERSION)
      expect(snap0.cursor).toBe(0)
      const read0 = (await host1.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { v: string; cursor: number; rehydrate: boolean; entries: unknown[] }
      expect(read0.v).toBe(OBSERVATION_VERSION)
      expect(read0.rehydrate).toBe(false)
      expect(read0.entries.length).toBe(0)
      const mutate1 = (await host1.request("test/mutateChangefeed", { session_id: "ses_live_a", revision: 1, kind: "changed", time: 2000 })) as { v: string; cursor: number; entry: { seq: number; session_id: string; revision: number; kind: string; time: number } }
      expect(mutate1.v).toBe(OBSERVATION_VERSION)
      expect(mutate1.cursor).toBeGreaterThan(snap0.cursor)
      expect(mutate1.entry.seq).toBe(mutate1.cursor)
      expect(Object.keys(mutate1.entry).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
      expect(await waitForNotificationCount(notifs1, 1, 3000)).toBe(true)
      expect(notifs1.length).toBe(1)
      const n1 = notifs1[0]!
      expect(n1.method).toBe(OBSERVATION_NOTIFICATION)
      const p1 = n1.params as { v: string; cursor: number; entries: Array<{ seq: number; session_id: string }> }
      expect(p1.v).toBe(OBSERVATION_VERSION)
      expect(p1.cursor).toBe(mutate1.cursor)
      expect(p1.entries[0]!.seq).toBe(mutate1.cursor)
      const snap1 = (await host1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap1.cursor).toBe(mutate1.cursor)
      const readAfter = (await host1.request(OBSERVATION_METHODS.READ, { cursor: snap0.cursor })) as { rehydrate: boolean; entries: Array<{ seq: number }>; cursor: number }
      expect(readAfter.rehydrate).toBe(false)
      expect(readAfter.entries.length).toBe(1)
      expect(readAfter.entries[0]!.seq).toBe(mutate1.cursor)
      const readAtCurrent = (await host1.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { rehydrate: boolean; entries: unknown[] }
      expect(readAtCurrent.rehydrate).toBe(false)
      expect(readAtCurrent.entries.length).toBe(0)
      const ack = (await host1.request(OBSERVATION_METHODS.ACK, { cursor: mutate1.cursor })) as { v: string; cursor: number }
      expect(ack.v).toBe(OBSERVATION_VERSION)
      expect(ack.cursor).toBe(mutate1.cursor)
      const stale = (await host1.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; reason: string; cursor: number; entries: unknown[]; v: string }
      expect(stale.rehydrate).toBe(true)
      expect(typeof stale.reason).toBe("string")
      expect(stale.cursor).toBe(mutate1.cursor)
      expect(stale.entries.length).toBe(0)
      const dup1 = (await host1.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { entries: unknown[]; cursor: number; rehydrate: boolean }
      const dup2 = (await host1.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { entries: unknown[]; cursor: number; rehydrate: boolean }
      expect(dup1).toEqual(dup2)
      try {
        await host1.request(OBSERVATION_METHODS.ACK, { cursor: 9999 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      const mutate2 = (await host1.request("test/mutateChangefeed", { session_id: "ses_live_b", revision: 1, kind: "changed", time: 2001 })) as { cursor: number }
      expect(mutate2.cursor).toBeGreaterThan(mutate1.cursor)
      expect(await waitForNotificationCount(notifs1, 2, 3000)).toBe(true)
      expect(notifs1.length).toBe(2)
      const notifs1CountBeforeClose = notifs1.length
      host1.dispose()
      await waitForHostClosed(host1, 3000)
      await new Promise((r) => setTimeout(r, 200))
      expect(host1.getState()).toBe("closed")
      expect(await waitForFileGone(lease, 3000)).toBe(true)
      await new Promise((r) => setTimeout(r, 200))
      expect(notifs1.length).toBe(notifs1CountBeforeClose)
      host2 = new PrivateWorkerHost({
        command: "bun",
        args: ["--conditions=browser", standaloneTs],
        env,
        initializeTimeoutMs: 8000,
        onNotification: (m, p) => notifs2.push({ method: m, params: p }),
      })
      const init2 = await host2.start()
      expect((init2 as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(await waitForFileExists(lease, 3000)).toBe(true)
      const snap2 = (await host2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap2.v).toBe(OBSERVATION_VERSION)
      expect(snap2.cursor).toBe(mutate2.cursor)
      const read2AtCurrent = (await host2.request(OBSERVATION_METHODS.READ, { cursor: snap2.cursor })) as { rehydrate: boolean; entries: unknown[] }
      expect(read2AtCurrent.rehydrate).toBe(false)
      expect(read2AtCurrent.entries.length).toBe(0)
      const stale2 = (await host2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean }
      expect(stale2.rehydrate).toBe(true)
      const readBeforeLatest = (await host2.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { rehydrate: boolean; entries: Array<{ seq: number }> }
      expect(readBeforeLatest.rehydrate).toBe(false)
      expect(readBeforeLatest.entries.length).toBe(1)
      expect(readBeforeLatest.entries[0]!.seq).toBe(mutate2.cursor)
      expect(notifs2.length).toBe(0)
      const mutate3 = (await host2.request("test/mutateChangefeed", { session_id: "ses_live_c", revision: 1, kind: "changed", time: 2002 })) as { cursor: number }
      expect(mutate3.cursor).toBeGreaterThan(mutate2.cursor)
      expect(await waitForNotificationCount(notifs2, 1, 3000)).toBe(true)
      expect(notifs2.length).toBe(1)
      expect((notifs2[0]!.params as { cursor: number }).cursor).toBe(mutate3.cursor)
      expect(notifs1.length).toBe(notifs1CountBeforeClose)
      const p3 = notifs2[0]!.params as { entries: Array<Record<string, unknown>> }
      expect(Object.keys(p3.entries[0]!).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
      const evictMutate = (await host2.request("test/mutateChangefeed", { session_id: "ses_evict", revision: 1, kind: "changed", time: 2003, caps: { maxRows: 1, maxBytes: 1024 } })) as { cursor: number }
      expect(await waitForNotificationCount(notifs2, 2, 3000)).toBe(true)
      expect(notifs2.length).toBe(2)
      const snapAfterEvict = (await host2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
      expect(snapAfterEvict.cursor).toBe(evictMutate.cursor)
      const staleAfterEvict = (await host2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean }
      expect(staleAfterEvict.rehydrate).toBe(true)
      const ack2 = (await host2.request(OBSERVATION_METHODS.ACK, { cursor: evictMutate.cursor })) as { cursor: number }
      expect(ack2.cursor).toBe(evictMutate.cursor)
    } finally {
      host1.dispose()
      host2?.dispose()
      await waitForHostClosed(host1, 2000)
      if (host2) await waitForHostClosed(host2, 2000)
      await new Promise((r) => setTimeout(r, 200))
      await waitForFileGone(lease, 3000).catch(() => {})
      await cleanup()
    }
  }, 30000)

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
    expect(def).not.toContain("createChangefeedDeps")
    expect(def).not.toContain("KILO_PRIVATE_WORKER_STANDALONE")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    expect(standalone).toContain("Database.layerFromPath")
    expect(standalone).toContain("createChangefeedDeps")
    expect(standalone).toContain("KILO_PRIVATE_WORKER_STANDALONE")
    expect(standalone).toContain("KILO_PRIVATE_WORKER_TEST_BRIDGE")
    const { isStandaloneEnabled } = await import("../../src/private-worker/host")
    expect(isStandaloneEnabled({ KILO_PRIVATE_WORKER_STANDALONE: "1", KILO_DB: "/tmp/kilo.db" } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(isStandaloneEnabled({ KILO_PRIVATE_WORKER_STANDALONE: "1", KILO_DB: "relative.db" } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isStandaloneEnabled({ KILO_DB: "/tmp/kilo.db" } as unknown as NodeJS.ProcessEnv)).toBe(false)
  })
})
