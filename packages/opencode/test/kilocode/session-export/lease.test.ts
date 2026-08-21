import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { SessionExport } from "@/kilocode/session-export"
import { leasePathFor } from "@opencode-ai/core/cutover/lease"
import { runCutover, isFresh } from "@opencode-ai/core/cutover/cutover"
import { Database } from "@opencode-ai/core/database/database"
import { resetEligibility } from "@/kilocode/session-export/eligibility"

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  postMessage(msg: { kind?: string }): void {
    if (msg.kind === "shutdown") this.onmessage?.({ data: { kind: "shutdown_done" } } as MessageEvent)
  }
  terminate(): void {
    this.terminated = true
  }
}

async function mkRoot(): Promise<{ root: string; dbPath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-se-lease-"))
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {}
    try {
      const parent = path.dirname(path.resolve(dir))
      const base = path.basename(path.resolve(dir))
      await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
      await fs.rm(path.join(parent, `.cutover-${base}.marker.json`), { force: true }).catch(() => {})
      await fs.rm(path.join(parent, `.rollback-${base}.marker.json`), { force: true }).catch(() => {})
    } catch {}
  }
  return { root: dir, dbPath: path.join(dir, "kilo.db"), cleanup }
}

async function ensureProject(root: string): Promise<void> {
  const dbPath = path.join(root, "kilo.db")
  const layer = Database.layerFromPath(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`SELECT 1`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
}

describe("session-export data-root lease (F3)", () => {
  let root: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const r = await mkRoot()
    root = r.root
    cleanup = r.cleanup
    await ensureProject(root)
  })

  afterEach(async () => {
    await SessionExport.shutdown()
    resetEligibility()
    await cleanup()
  })

  test("session-export owner acquires the data-root lease and releases it on shutdown", async () => {
    const lp = leasePathFor(root)
    expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
    await SessionExport.init({
      agentVersion: "v0",
      dbPath: path.join(root, "session-export.db"),
      subscribeAll: () => () => {},
      createWorker: () => new FakeWorker() as unknown as Worker,
      syncSeq: () => 0,
    })
    // lease is held for the full owner lifecycle
    expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
    expect(await isFresh(root)).toBe(false) // legacy store still present, not cut over
    await SessionExport.shutdown()
    expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
  })

  test("live session-export lease blocks cutover and clean release allows it", async () => {
    const lp = leasePathFor(root)
    // owner acquires the data-root lease for its full lifecycle
    await SessionExport.init({
      agentVersion: "v0",
      dbPath: path.join(root, "session-export.db"),
      subscribeAll: () => () => {},
      createWorker: () => new FakeWorker() as unknown as Worker,
      syncSeq: () => 0,
    })
    expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
    // owner releases its lease (clean release)
    await SessionExport.shutdown()
    expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
    // A live external holder (the session-export owner in another process) is
    // represented by the same standard lease file with a foreign token on a
    // live PID; this is exactly the cross-process boundary runCutover checks.
    await fs.writeFile(lp, JSON.stringify({ pid: process.pid, token: "external-owner", createdAt: Date.now() }), "utf8")
    // cutover must be refused because the lease is held by a live owner
    let blocked = false
    try {
      await runCutover({ dataRoot: root })
    } catch (e) {
      blocked = true
      expect(
        String(e).includes("lease") ||
          String(e).includes("live") ||
          String(e).includes("held") ||
          String(e).includes("exclusivity"),
      ).toBe(true)
    }
    expect(blocked).toBe(true)
    // owner releases the lease (simulating the other process letting go)
    await fs.rm(lp, { force: true })
    // now cutover can proceed
    const res = await runCutover({ dataRoot: root })
    expect(res.archiveID).toBeTruthy()
    expect(await isFresh(root)).toBe(true)
  })
})
