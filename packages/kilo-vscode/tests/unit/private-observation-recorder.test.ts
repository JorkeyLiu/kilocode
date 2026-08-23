import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { OBSERVATION_NOTIFICATION } from "../../src/private-worker/observation"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
}

function makeTmpEnv(): { tmp: string; dbPath: string; xdg: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-recorder-"))
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

async function waitForLogCount(svc: PrivateObservationService, expected: number, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (svc.getNotificationLog().length >= expected) return true
    await new Promise((r) => setTimeout(r, 30))
  }
  return svc.getNotificationLog().length >= expected
}

describe("PrivateObservationService bounded notification recorder (R9 fixture-only)", () => {
  let origFixture: string | undefined
  beforeEach(() => {
    origFixture = process.env.KILO_E2E_FIXTURE
  })
  afterEach(() => {
    if (origFixture === undefined) delete process.env.KILO_E2E_FIXTURE
    else process.env.KILO_E2E_FIXTURE = origFixture
  })

  it("disabled behavior when KILO_E2E_FIXTURE absent: no recording, clear is no-op", async () => {
    delete process.env.KILO_E2E_FIXTURE
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svc.initialize()
      const initLog = svc.getNotificationLog()
      expect(initLog.length).toBe(0)
      // mutate to generate notification — should not be recorded when disabled
      await svc.request("test/mutateChangefeed", { session_id: "rec_disabled", revision: 1, kind: "changed", time: 1000 })
      await new Promise((r) => setTimeout(r, 300))
      expect(svc.getNotificationLog().length).toBe(0)
      // clear is no-op but safe
      svc.clearNotificationLog()
      expect(svc.getNotificationLog().length).toBe(0)
      // JSON-safe copy: getNotificationLog returns copy
      const copy = svc.getNotificationLog()
      copy.push({ method: "observation/changed", params: {}, at: "now" })
      expect(svc.getNotificationLog().length).toBe(0)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 150))
      await cleanup()
    }
  }, 20000)

  it("fixture-enabled recording, max 50 retention, clear behavior, JSON-safe copy", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svc.initialize()
      expect(svc.getNotificationLog().length).toBe(0)
      // generate 3 notifications and verify recording
      for (let i = 1; i <= 3; i++) {
        await svc.request("test/mutateChangefeed", { session_id: `rec_a_${i}`, revision: 1, kind: "changed", time: 2000 + i })
      }
      expect(await waitForLogCount(svc, 3)).toBe(true)
      let log = svc.getNotificationLog()
      expect(log.length).toBe(3)
      for (const entry of log) {
        expect(entry.method).toBe(OBSERVATION_NOTIFICATION)
        const p = entry.params as Record<string, unknown>
        expect(p.v).toBe("1.0")
        expect(typeof p.cursor).toBe("number")
        expect(Array.isArray((p as { entries: unknown[] }).entries)).toBe(true)
        expect(typeof entry.at).toBe("string")
      }
      // JSON-safe copy: mutating returned copy does not affect internal
      const copy = svc.getNotificationLog()
      const firstParams = copy[0]!.params as Record<string, unknown>
      const beforeCursor = firstParams.cursor
      ;(firstParams as Record<string, unknown>).cursor = 99999
      expect((svc.getNotificationLog()[0]!.params as Record<string, unknown>).cursor).toBe(beforeCursor)
      // JSON-safe deep copy: mutating nested entry also isolated (params deep copied via JSON)
      // already covered by JSON parse/stringify
      // clear behavior
      svc.clearNotificationLog()
      expect(svc.getNotificationLog().length).toBe(0)
      // generate 55 to test max 50 retention
      for (let i = 1; i <= 55; i++) {
        await svc.request("test/mutateChangefeed", { session_id: `rec_b_${i}`, revision: 1, kind: "changed", time: 3000 + i })
      }
      expect(await waitForLogCount(svc, 50)).toBe(true)
      log = svc.getNotificationLog()
      expect(log.length).toBe(50)
      // oldest 5 should have been evicted — check cursor monotonic increase (last 50)
      const cursors = log.map((e) => (e.params as Record<string, unknown>).cursor as number)
      for (let i = 1; i < cursors.length; i++) expect(cursors[i]!).toBeGreaterThan(cursors[i - 1]!)
      // ensure first cursor > initial 3 cursors (evicted)
      expect(cursors[0]!).toBeGreaterThan(3)
      svc.clearNotificationLog()
      expect(svc.getNotificationLog().length).toBe(0)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 150))
      await cleanup()
    }
  }, 30000)

  it("recording before consumer and consumer failure isolation", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    let consumerCalls = 0
    let failNext = true
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
      onNotification: () => {
        consumerCalls++
        if (failNext) {
          failNext = false
          throw new Error("consumer boom")
        }
      },
    })
    try {
      await svc.initialize()
      await svc.request("test/mutateChangefeed", { session_id: "rec_c_1", revision: 1, kind: "changed", time: 4000 })
      expect(await waitForLogCount(svc, 1)).toBe(true)
      // despite consumer throwing, recorder must have captured before consumer failure
      expect(svc.getNotificationLog().length).toBe(1)
      expect(consumerCalls).toBe(1)
      expect(svc.getNotificationLog()[0]!.method).toBe(OBSERVATION_NOTIFICATION)
      // next notification should succeed for consumer and still be recorded
      await svc.request("test/mutateChangefeed", { session_id: "rec_c_2", revision: 1, kind: "changed", time: 4001 })
      expect(await waitForLogCount(svc, 2)).toBe(true)
      expect(svc.getNotificationLog().length).toBe(2)
      expect(consumerCalls).toBe(2)
      // verify both entries valid
      for (const e of svc.getNotificationLog()) {
        const p = e.params as Record<string, unknown>
        expect(p.v).toBe("1.0")
        expect(typeof p.cursor).toBe("number")
      }
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 150))
      await cleanup()
    }
  }, 20000)

  it("getNotificationLog returns JSON-safe copy not live reference", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svc.initialize()
      await svc.request("test/mutateChangefeed", { session_id: "rec_d_1", revision: 1, kind: "changed", time: 5000 })
      expect(await waitForLogCount(svc, 1)).toBe(true)
      const a = svc.getNotificationLog()
      a.length = 0
      expect(svc.getNotificationLog().length).toBe(1)
      // mutating nested entry in copy does not affect internal
      const b = svc.getNotificationLog()
      const entry = b[0]!.params as Record<string, unknown>
      const entries = entry.entries as Array<Record<string, unknown>>
      const originalSeq = entries[0]!.seq
      entries[0]!.seq = 99999
      expect(((svc.getNotificationLog()[0]!.params as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0]!.seq).toBe(originalSeq)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 150))
      await cleanup()
    }
  }, 20000)

  it("ordinal watermark survives bounded retention and truncated is unproven", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svc.initialize()
      // generate 3, capture watermark ordinal 3
      for (let i = 1; i <= 3; i++) {
        await svc.request("test/mutateChangefeed", { session_id: `ord_a_${i}`, revision: 1, kind: "changed", time: 6000 + i })
      }
      expect(await waitForLogCount(svc, 3)).toBe(true)
      const snapBefore = svc.getNotificationSnapshot()
      expect(snapBefore.nextOrdinal).toBe(3)
      expect(snapBefore.startOrdinal).toBe(0)
      expect(snapBefore.entries.length).toBe(3)
      expect(snapBefore.entries[0]!.ordinal).toBe(0)
      const watermark = snapBefore.nextOrdinal
      // fill to capacity 50 then push 5 more to evict watermark window partially
      for (let i = 4; i <= 55; i++) {
        await svc.request("test/mutateChangefeed", { session_id: `ord_b_${i}`, revision: 1, kind: "changed", time: 7000 + i })
      }
      expect(await waitForLogCount(svc, 50)).toBe(true)
      const snapAfter = svc.getNotificationSnapshot()
      expect(snapAfter.nextOrdinal).toBe(55)
      expect(snapAfter.entries.length).toBe(50)
      expect(snapAfter.startOrdinal).toBe(5)
      // watermark 3 is still within retained window [5..55)? 3 < 5 => truncated -> unproven, must be flagged
      const truncated = watermark < snapAfter.startOrdinal
      expect(truncated).toBe(true)
      // Now generate fresh after watermark 50 (not truncated) to prove continuity path
      const snapMid = svc.getNotificationSnapshot()
      const wm2 = snapMid.nextOrdinal // 55
      await svc.request("test/mutateChangefeed", { session_id: "ord_c_56", revision: 1, kind: "changed", time: 8000 })
      expect(await waitForLogCount(svc, 50)).toBe(true)
      const snapAfter2 = svc.getNotificationSnapshot()
      expect(snapAfter2.nextOrdinal).toBe(56)
      const truncated2 = wm2 < snapAfter2.startOrdinal
      expect(truncated2).toBe(false)
      // Ordinals monotonic and unique
      const ords = snapAfter2.entries.map((e) => e.ordinal)
      for (let i = 1; i < ords.length; i++) expect(ords[i]!).toBe(ords[i - 1]! + 1)
      // Entries filtered by watermark give after delta strictly increasing
      const afterDelta = snapAfter2.entries.filter((e) => e.ordinal >= wm2)
      expect(afterDelta.length).toBe(1)
      expect(afterDelta[0]!.ordinal).toBe(55)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 150))
      await cleanup()
    }
  }, 30000)
})
