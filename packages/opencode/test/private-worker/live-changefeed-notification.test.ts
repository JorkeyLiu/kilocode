import { describe, it, expect } from "bun:test"
import { spawn, type ChildProcess } from "child_process"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { OBSERVATION_METHODS, OBSERVATION_VERSION, OBSERVATION_NOTIFICATION } from "../../src/private-worker/observation"

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-live-"))
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

describe("live canonical changefeed notification delivery and reconnect (real child file-backed)", () => {
  it("proves initialize/snapshot/read, one live payload-free changed notification with monotonic cursor, read/ack, stale→rehydrate, sequential reacquire, no duplicate from prior host", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    let proc1: ChildProcess | undefined
    let peer1: JsonRpcPeer | undefined
    let proc2: ChildProcess | undefined
    let peer2: JsonRpcPeer | undefined
    const notifs1: Array<{ method: string; params: unknown }> = []
    const notifs2: Array<{ method: string; params: unknown }> = []
    try {
      expect(fs.existsSync(lease)).toBe(false)
      const first = spawnStandalone(env, (m, p) => notifs1.push({ method: m, params: p }))
      proc1 = first.proc
      peer1 = first.peer
      const init1 = (await peer1.request("initialize", { clientInfo: { name: "live-test", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
      expect(init1.protocolVersion).toBe("1.0")
      // No-lease observer: Database.layerNoLease never creates a lease file
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(true)
      const snap0 = (await peer1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap0.v).toBe(OBSERVATION_VERSION)
      expect(snap0.cursor).toBe(0)
      const read0 = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { v: string; cursor: number; rehydrate: boolean; entries: unknown[] }
      expect(read0.v).toBe(OBSERVATION_VERSION)
      expect(read0.rehydrate).toBe(false)
      expect(read0.entries.length).toBe(0)
      expect(read0.cursor).toBe(0)
      // trigger one live canonical mutation via test bridge
      const mutate1 = (await peer1.request("test/mutateChangefeed", { session_id: "ses_live_a", revision: 1, kind: "changed", time: 1000 })) as { v: string; cursor: number; entry: { seq: number; session_id: string; revision: number; kind: string; time: number } }
      expect(mutate1.v).toBe(OBSERVATION_VERSION)
      expect(typeof mutate1.cursor).toBe("number")
      expect(mutate1.cursor).toBeGreaterThan(snap0.cursor)
      expect(mutate1.entry.seq).toBe(mutate1.cursor)
      expect(mutate1.entry.session_id).toBe("ses_live_a")
      expect(Object.keys(mutate1.entry).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
      // wait for live payload-free changed notification over private stdio
      expect(await waitForNotificationCount(notifs1, 1, 3000)).toBe(true)
      expect(notifs1.length).toBe(1)
      const n1 = notifs1[0]!
      expect(n1.method).toBe(OBSERVATION_NOTIFICATION)
      const p1 = n1.params as { v: string; cursor: number; entries: Array<{ seq: number; session_id: string; revision: number; kind: string; time: number }> }
      expect(p1.v).toBe(OBSERVATION_VERSION)
      expect(p1.cursor).toBe(mutate1.cursor)
      expect(p1.entries.length).toBe(1)
      expect(p1.entries[0]!.seq).toBe(mutate1.cursor)
      expect(p1.entries[0]!.session_id).toBe("ses_live_a")
      expect(Object.keys(p1.entries[0]!).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
      // monotonic cursor: snapshot before < after
      const snap1 = (await peer1.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap1.cursor).toBe(mutate1.cursor)
      expect(snap1.cursor).toBeGreaterThan(snap0.cursor)
      // read/ack behavior
      const readAfter = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: snap0.cursor })) as { rehydrate: boolean; entries: Array<{ seq: number }>; cursor: number }
      expect(readAfter.rehydrate).toBe(false)
      expect(readAfter.entries.length).toBe(1)
      expect(readAfter.entries[0]!.seq).toBe(mutate1.cursor)
      expect(readAfter.cursor).toBe(mutate1.cursor)
      const readAtCurrent = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { rehydrate: boolean; entries: unknown[]; cursor: number }
      expect(readAtCurrent.rehydrate).toBe(false)
      expect(readAtCurrent.entries.length).toBe(0)
      expect(readAtCurrent.cursor).toBe(mutate1.cursor)
      const ack = (await peer1.request(OBSERVATION_METHODS.ACK, { cursor: mutate1.cursor })) as { v: string; cursor: number }
      expect(ack.v).toBe(OBSERVATION_VERSION)
      expect(ack.cursor).toBe(mutate1.cursor)
      // after ack, at-current remains empty deltas
      const readAfterAck = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { rehydrate: boolean; entries: unknown[] }
      expect(readAfterAck.rehydrate).toBe(false)
      expect(readAfterAck.entries.length).toBe(0)
      // stale cursor → rehydrate after truncation (where feasible)
      const stale = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean; reason: string; cursor: number; entries: unknown[]; v: string }
      expect(stale.rehydrate).toBe(true)
      expect(typeof stale.reason).toBe("string")
      expect(stale.cursor).toBe(mutate1.cursor)
      expect(stale.entries.length).toBe(0)
      expect(stale.v).toBe(OBSERVATION_VERSION)
      // duplicate read is idempotent
      const dup1 = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { entries: unknown[]; cursor: number; rehydrate: boolean }
      const dup2 = (await peer1.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { entries: unknown[]; cursor: number; rehydrate: boolean }
      expect(dup1).toEqual(dup2)
      // verify ack ahead is InvalidParams
      try {
        await peer1.request(OBSERVATION_METHODS.ACK, { cursor: 9999 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      // second live mutation to prove monotonic second notification and to have data for reacquire
      const mutate2 = (await peer1.request("test/mutateChangefeed", { session_id: "ses_live_b", revision: 1, kind: "changed", time: 1001 })) as { cursor: number; entry: { seq: number } }
      expect(mutate2.cursor).toBeGreaterThan(mutate1.cursor)
      expect(await waitForNotificationCount(notifs1, 2, 3000)).toBe(true)
      expect(notifs1.length).toBe(2)
      expect((notifs1[1]!.params as { cursor: number }).cursor).toBe(mutate2.cursor)
      expect((notifs1[1]!.params as { entries: Array<{ seq: number }> }).entries[0]!.seq).toBe(mutate2.cursor)
      const notifs1CountBeforeClose = notifs1.length
      // sequential host reacquire on same file: dispose first host, ensure lease released, start second
      peer1.dispose()
      try { proc1.kill() } catch {}
      await waitForExit(proc1, 3000)
      await new Promise((r) => setTimeout(r, 200))
      expect(peer1.getState()).toBe("closed")
      expect(fs.existsSync(lease)).toBe(false)
      // no duplicate notification from prior host after close: count should stay same
      await new Promise((r) => setTimeout(r, 200))
      expect(notifs1.length).toBe(notifs1CountBeforeClose)
      const secondEnv = { ...env }
      const second = spawnStandalone(secondEnv, (m, p) => notifs2.push({ method: m, params: p }))
      proc2 = second.proc
      peer2 = second.peer
      const init2 = (await peer2.request("initialize", { clientInfo: { name: "live-test2", version: "1" }, protocolVersion: "1.0" })) as { protocolVersion: string }
      expect(init2.protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)
      const snap2 = (await peer2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap2.v).toBe(OBSERVATION_VERSION)
      // cursor preserved monotonic from prior host (latest_seq retained despite ack of first entry, but second entry not acked)
      expect(snap2.cursor).toBe(mutate2.cursor)
      expect(snap2.cursor).toBeGreaterThan(snap0.cursor)
      // read at current still empty
      const read2AtCurrent = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: snap2.cursor })) as { rehydrate: boolean; entries: unknown[] }
      expect(read2AtCurrent.rehydrate).toBe(false)
      expect(read2AtCurrent.entries.length).toBe(0)
      // reading old cursor 0 still rehydrates (stale)
      const stale2 = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean }
      expect(stale2.rehydrate).toBe(true)
      // reading just before latest should return deltas (b not acked)
      const readBeforeLatest = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: mutate1.cursor })) as { rehydrate: boolean; entries: Array<{ seq: number }> }
      expect(readBeforeLatest.rehydrate).toBe(false)
      expect(readBeforeLatest.entries.length).toBe(1)
      expect(readBeforeLatest.entries[0]!.seq).toBe(mutate2.cursor)
      // no notification yet from second host before new mutation
      expect(notifs2.length).toBe(0)
      // trigger new mutation on second host, verify exactly one new notification, monotonic, no duplicate from prior host
      const mutate3 = (await peer2.request("test/mutateChangefeed", { session_id: "ses_live_c", revision: 1, kind: "changed", time: 1002 })) as { cursor: number }
      expect(mutate3.cursor).toBeGreaterThan(mutate2.cursor)
      expect(await waitForNotificationCount(notifs2, 1, 3000)).toBe(true)
      expect(notifs2.length).toBe(1)
      expect((notifs2[0]!.params as { cursor: number }).cursor).toBe(mutate3.cursor)
      // prior host notifications unchanged
      expect(notifs1.length).toBe(notifs1CountBeforeClose)
      // payload-free check on new notification
      const p3 = notifs2[0]!.params as { entries: Array<Record<string, unknown>> }
      expect(Object.keys(p3.entries[0]!).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
      // eviction feasibility: trigger small-caps mutation to force bounded eviction and prove stale→rehydrate
      const evictMutate = (await peer2.request("test/mutateChangefeed", { session_id: "ses_evict", revision: 1, kind: "changed", time: 1003, caps: { maxRows: 1, maxBytes: 1024 } })) as { cursor: number }
      expect(await waitForNotificationCount(notifs2, 2, 3000)).toBe(true)
      expect(notifs2.length).toBe(2)
      // after eviction with maxRows 1, only latest retained: cursor 0 should still rehydrate, and reading after penultimate should be deltas
      const snapAfterEvict = (await peer2.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
      expect(snapAfterEvict.cursor).toBe(evictMutate.cursor)
      const staleAfterEvict = (await peer2.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean }
      expect(staleAfterEvict.rehydrate).toBe(true)
      // ack the latest and verify
      const ack2 = (await peer2.request(OBSERVATION_METHODS.ACK, { cursor: evictMutate.cursor })) as { cursor: number }
      expect(ack2.cursor).toBe(evictMutate.cursor)
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
  }, 30000)

  it("preserves CJS lightweight worker artifact, ESM standalone gating, lease marker and wire shape", async () => {
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
    expect(standalone).toContain("KILO_PRIVATE_WORKER_TEST_BRIDGE")
    // wire shape: payload-free entries only seq/session_id/revision/kind/time
    const { ObservationController } = await import("../../src/private-worker/observation")
    const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {} })
    const note: unknown[] = []
    const fakePeer = { notify: (m: string, p: unknown) => note.push({ m, p }) } as unknown as import("../../src/private-worker/peer").JsonRpcPeer
    const e = { seq: 1, session_id: "ses_wire", revision: 1, kind: "changed" as const, time: 1 }
    ctrl.notifyChanged(fakePeer as unknown as { notify: (method: string, params?: unknown) => void }, [e], 1)
    const sent = note[0] as { p: { entries: Array<Record<string, unknown>> } }
    expect(Object.keys(sent.p.entries[0]!).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
  })
})
