import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { OBSERVATION_VERSION } from "../../src/private-worker/observation"
import { AgentManagerObservationCoordinator } from "../../src/agent-manager/observation-coordinator"
import { InMemoryCursorStore, type ObservationCursorStore } from "../../src/private-worker/observation-cursor-store"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
}

function makeTmpEnv(): { tmp: string; dbPath: string; xdg: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-obs-ack-"))
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

async function waitForHostClosedExact(host: PrivateWorkerHost, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (host.hasExited()) return true
    const proc = host.getProc()
    if (proc && (proc.exitCode !== null || proc.signalCode !== null)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return host.hasExited()
}

class ControllableStore implements ObservationCursorStore {
  private inner = new InMemoryCursorStore()
  shouldFail = false
  delayMs = 0
  setLog: number[] = []
  get(): number | undefined {
    return this.inner.get()
  }
  async set(cursor: number): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    this.setLog.push(cursor)
    if (this.shouldFail) throw new Error("store persist fail")
    this.inner.set(cursor)
  }
  async clear(): Promise<void> {
    this.inner.clear()
  }
}

describe("PrivateObservationService ack persistence boundary (real standalone worker)", () => {
  it("remote ack succeeds then cursorStore.set rejects: ack rejects/coordinator false, persisted unchanged, rehydrate on next read, later converges", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const store = new ControllableStore()
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
    try {
      const init = (await svc.initialize()) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)
      expect(store.get()).toBeUndefined()

      // create 2 deltas
      const m1 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_boundary_a",
        revision: 1,
        kind: "changed",
        time: 1000,
      })) as { cursor: number }
      const m2 = (await svc.request("test/mutateChangefeed", {
        session_id: "ses_boundary_b",
        revision: 1,
        kind: "changed",
        time: 1001,
      })) as { cursor: number }
      expect(m2.cursor).toBeGreaterThan(m1.cursor)
      expect(m1.cursor).toBe(1)
      expect(m2.cursor).toBe(2)
      const snap = (await svc.snapshot({})) as { cursor: number; v: string }
      expect(snap.cursor).toBe(2)
      expect(snap.v).toBe(OBSERVATION_VERSION)

      // persist initial cursor 0 (or 1) to simulate pre-ack state; set to m1 cursor minus one?
      // We want old persisted cursor to be 0 so next read uses 0.
      // Set to 0 directly.
      store.shouldFail = false
      await store.set(0)
      expect(store.get()).toBe(0)
      // Make next store attempt fail
      store.shouldFail = true
      store.delayMs = 0
      // Coordinator wrapper should see same store
      const coord = new AgentManagerObservationCoordinator(svc)

      // ack via coordinator should return false when store fails, and direct svc.ack should reject
      const ackDirectPromise = svc.ack(m2.cursor)
      let directRejected = false
      try {
        await ackDirectPromise
      } catch (e) {
        directRejected = true
        expect(String((e as Error).message)).toMatch(/persist fail/i)
      }
      expect(directRejected).toBe(true)
      // coordinator ack after failure (need fresh ack because previous already consumed remote ack truncation)
      // But remote side already truncated feed on first ack (even though store failed).
      // So persisted should remain old (0), not updated to 2.
      expect(store.get()).toBe(0)
      // coordinator.ack for same cursor would attempt remote ack again; remote may still succeed (idempotent)
      // but store will still fail if shouldFail true.
      const coordOk = await coord.ack(m2.cursor)
      expect(coordOk).toBe(false)
      expect(store.get()).toBe(0)

      // feed truncation produces rehydrate on next read with old cursor 0
      const readAfterFail = (await svc.read(0)) as { v: string; rehydrate: boolean; reason: string; cursor: number; entries: unknown[] }
      expect(readAfterFail.v).toBe(OBSERVATION_VERSION)
      expect(readAfterFail.rehydrate).toBe(true)
      expect(typeof readAfterFail.reason).toBe("string")
      expect(readAfterFail.reason.length).toBeGreaterThan(0)
      expect(readAfterFail.entries.length).toBe(0)
      expect(readAfterFail.cursor).toBe(2)

      // coordinator decide with persisted 0 should trigger refresh with ackCursor 2 but validation should still see rehydrate true valid
      // However decide will see rehydrate true and return ackCursor 2 (since reason valid and entries empty)
      const decision = await coord.decide()
      expect(decision.shouldRefresh).toBe(true)
      expect(decision.ackCursor).toBe(2)

      // later successful ack/persistence converges
      store.shouldFail = false
      const ack2 = await svc.ack(m2.cursor)
      expect((ack2 as { cursor: number }).cursor).toBe(2)
      expect(store.get()).toBe(2)
      // After successful ack, read at persisted cursor should not rehydrate and have no entries
      const readAtPersisted = (await svc.read(2)) as { rehydrate: boolean; entries: unknown[]; cursor: number }
      expect(readAtPersisted.rehydrate).toBe(false)
      expect(readAtPersisted.entries.length).toBe(0)
      expect(readAtPersisted.cursor).toBe(2)
      // coordinator decide after convergence should skip refresh
      const decAfter = await coord.decide()
      expect(decAfter.shouldRefresh).toBe(false)
      expect(decAfter.ackCursor).toBeUndefined()
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) expect(await waitForHostClosedExact(retained, 3000)).toBe(true)
      await cleanup()
    }
  }, 25000)

  it("serializes concurrent ack operations in invocation order, older delayed store does not overwrite newer", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const store = new ControllableStore()
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
    try {
      await svc.initialize()
      // create two cursors 1 and 2
      const m1 = (await svc.request("test/mutateChangefeed", { session_id: "ses_ser_1", revision: 1, kind: "changed", time: 2000 })) as { cursor: number }
      const m2 = (await svc.request("test/mutateChangefeed", { session_id: "ses_ser_2", revision: 1, kind: "changed", time: 2001 })) as { cursor: number }
      expect(m1.cursor).toBe(1)
      expect(m2.cursor).toBe(2)
      // Make store.set for cursor 1 artificially delayed, cursor 2 fast
      const origSet = store.set.bind(store)
      let firstCall = true
      store.set = async (c: number) => {
        if (c === 1 && firstCall) {
          firstCall = false
          await new Promise((r) => setTimeout(r, 120))
        }
        return origSet(c)
      }
      // Invoke two acks concurrently without awaiting first
      const p1 = svc.ack(1)
      const p2 = svc.ack(2)
      const results = await Promise.all([p1, p2])
      expect((results[0] as { cursor: number }).cursor).toBe(1)
      expect((results[1] as { cursor: number }).cursor).toBe(2)
      // Both acks should have persisted in order: first 1 then 2, final is 2
      expect(store.get()).toBe(2)
      expect(store.setLog).toEqual([1, 2])
      // After serialization, later successful persistence converges and read at 2 is clean
      const read = (await svc.read(2)) as { rehydrate: boolean }
      expect(read.rehydrate).toBe(false)
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) await waitForHostClosedExact(retained, 3000)
      await cleanup()
    }
  }, 25000)

  it("queue continues after rejection and preserves errors per caller (no timer)", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const store = new ControllableStore()
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
    try {
      await svc.initialize()
      const m1 = (await svc.request("test/mutateChangefeed", { session_id: "ses_q_1", revision: 1, kind: "changed", time: 3000 })) as { cursor: number }
      const m2 = (await svc.request("test/mutateChangefeed", { session_id: "ses_q_2", revision: 1, kind: "changed", time: 3001 })) as { cursor: number }
      const m3 = (await svc.request("test/mutateChangefeed", { session_id: "ses_q_3", revision: 1, kind: "changed", time: 3002 })) as { cursor: number }
      expect(m3.cursor).toBe(3)
      // make second ack's store fail, others succeed
      const origSet = store.set.bind(store)
      store.set = async (c: number) => {
        if (c === 2) throw new Error("store fail for 2")
        return origSet(c)
      }
      const p1 = svc.ack(1)
      const p2 = svc.ack(2)
      const p3 = svc.ack(3)
      const r1 = await p1
      expect((r1 as { cursor: number }).cursor).toBe(1)
      let p2Err: unknown = null
      try {
        await p2
      } catch (e) {
        p2Err = e
      }
      expect(p2Err).toBeTruthy()
      expect(String((p2Err as Error).message)).toMatch(/store fail/)
      const r3 = await p3
      expect((r3 as { cursor: number }).cursor).toBe(3)
      // Final persisted should be 3, not stuck at 1, and queue did not stop after rejection
      expect(store.get()).toBe(3)
    } finally {
      const retained = svc.getHost() as unknown as PrivateWorkerHost | null
      svc.dispose()
      if (retained) await waitForHostClosedExact(retained, 3000)
      await cleanup()
    }
  }, 25000)
})
