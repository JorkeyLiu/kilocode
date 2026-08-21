import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { SessionExport } from "@/kilocode/session-export"
import { isLeaseHeld, leasePathFor } from "@opencode-ai/core/cutover/lease"
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

async function mkRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-se-refcount-"))
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {}
    try {
      const parent = path.dirname(path.resolve(dir))
      const base = path.basename(path.resolve(dir))
      await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
    } catch {}
  }
  return { root: dir, cleanup }
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

describe("session-export lease refcount bounded (F3 follow-up)", () => {
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

  test("repeated init for same data root keeps lease refcount bounded and single shutdown releases", async () => {
    const lp = leasePathFor(root)
    const dbPath = path.join(root, "session-export.db")
    const count = () => (SessionExport as unknown as { _leaseHandleCountForTests?: () => number })._leaseHandleCountForTests?.() ?? 0

    // first init acquires
    await SessionExport.init({
      agentVersion: "v0",
      dbPath,
      subscribeAll: () => () => {},
      createWorker: () => new FakeWorker() as unknown as Worker,
      syncSeq: () => 0,
    })
    expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
    expect(isLeaseHeld(root)).toBe(true)
    expect(count()).toBe(1)

    // repeated inits for same data root / same workspace key must not grow unbounded
    for (let i = 0; i < 4; i++) {
      await SessionExport.init({
        agentVersion: "v0",
        dbPath,
        subscribeAll: () => () => {},
        createWorker: () => new FakeWorker() as unknown as Worker,
        syncSeq: () => 0,
      })
      expect(isLeaseHeld(root)).toBe(true)
      expect(count()).toBe(1)
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
    }

    // also exercise same data root with different workspace keys sharing the same lease
    await SessionExport.init({
      agentVersion: "v0",
      dbPath,
      workspaceKey: "workspace-a",
      subscribeAll: () => () => {},
      createWorker: () => new FakeWorker() as unknown as Worker,
      syncSeq: () => 0,
    })
    expect(count()).toBe(1)
    await SessionExport.init({
      agentVersion: "v0",
      dbPath,
      workspaceKey: "workspace-b",
      subscribeAll: () => () => {},
      createWorker: () => new FakeWorker() as unknown as Worker,
      syncSeq: () => 0,
    })
    expect(count()).toBe(1)

    // single shutdown must release cleanly
    await SessionExport.shutdown()
    expect(count()).toBe(0)
    expect(isLeaseHeld(root)).toBe(false)
    expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)

    // re-acquire after shutdown must succeed (proves no stale refcount)
    await SessionExport.init({
      agentVersion: "v0",
      dbPath,
      subscribeAll: () => () => {},
      createWorker: () => new FakeWorker() as unknown as Worker,
      syncSeq: () => 0,
    })
    expect(count()).toBe(1)
    expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
  })
})
