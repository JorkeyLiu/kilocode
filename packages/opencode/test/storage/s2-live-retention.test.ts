import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Ref, Semaphore } from "effect"
import { sql, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable, RetentionObligationTable } from "@opencode-ai/core/retention/sql"
import * as Retention from "@opencode-ai/core/retention/retention"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pollWithTimeout } from "../lib/effect"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import * as Ownership from "@/retention/ownership"
import * as Lease from "@/retention/lease"
import * as Accounting from "@/retention/accounting"
import * as Maintenance from "@/retention/maintenance"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Project } from "@opencode-ai/core/project"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs"
import { join, basename } from "path"
import { tmpdir as osTmpdir } from "os"
import { Global } from "@opencode-ai/core/global"

const globalPathGuard = Semaphore.makeUnsafe(1)

// P4.4-G3 live retention/high-low watermark proof — file-backed, run-owned, logical watermark simulation only.
// Run-owned temp file-backed stores: every DB+artifact under mkdtemp s2-g3-* root via per-test Global.Path.data mutation, never the original user data (per-process preload isolates to opencode-test-data-* but per-test storage is additionally rooted under s2-g3-*).
// Logical high/low via injectable Accounting; no 8 GiB allocation; labeled as logical simulation, not physical disk-pressure proof.
// No production code added; evidence-only. Global busy short-circuit is the reachable protection path; per-family active/leased revalidated is structurally unreachable while any busy exists (documented, not claimed).

const location = { directory: AbsolutePath.make("/project") }

function makeFileBaseWithoutMaintenance(
  db: Layer.Layer<Database.Service, never, never>,
  accounting: Layer.Layer<Accounting.Service, never, never> = Accounting.layer,
) {
  const events = EventV2.layer.pipe(Layer.provide(db))
  const store = SessionStore.layer.pipe(Layer.provide(db))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(db))
  const projects = Layer.succeed(
    Project.Service,
    Project.Service.of({
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(db),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(
    db,
    events,
    store,
    projector,
    projects,
    sessions,
    Storage.defaultLayer,
    Ownership.layer,
    Lease.layer,
    accounting,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  )
}

function makeFileBaseWithMaintenance(
  db: Layer.Layer<Database.Service, never, never>,
  accounting: Layer.Layer<Accounting.Service, never, never> = Accounting.layer,
) {
  const base = makeFileBaseWithoutMaintenance(db, accounting)
  return Layer.mergeAll(base, Maintenance.layer.pipe(Layer.provide(base)))
}

function assertOwned(dir: string, file: string, storageDir: string) {
  expect(dir.startsWith(osTmpdir())).toBe(true)
  expect(dir.includes("s2-g3-")).toBe(true)
  expect(file.startsWith(dir)).toBe(true)
  expect(storageDir.startsWith(dir)).toBe(true)
}

function safeRemoveOwned(dir: string) {
  if (!dir.startsWith(osTmpdir())) throw new Error(`refusing to delete outside tmpdir: ${dir}`)
  if (!dir.includes("s2-g3-")) throw new Error(`refusing to delete non-owned prefix: ${dir}`)
  rmSync(dir, { recursive: true, force: true })
}

function assertWatermarkConstants() {
  expect(Retention.HIGH_BYTES).toBe(8 * 1024 * 1024 * 1024)
  expect(Retention.LOW_BYTES).toBe(6 * 1024 * 1024 * 1024)
  expect(Retention.HIGH_BYTES).toBeGreaterThan(Retention.LOW_BYTES)
  expect(Retention.SEVEN_DAYS_MS).toBe(7 * 24 * 60 * 60 * 1000)
}

function assertNoOwnedLeak(dir: string) {
  const base = basename(dir)
  const entries = readdirSync(osTmpdir())
  expect(entries.includes(base)).toBe(false)
}

describe("S2 live retention file-backed (G3)", () => {
  const it = testEffect(Layer.empty)

  it.live(
    "B2 session_update title+result_snapshot family cascade through live Maintenance.runOnce (file-backed WAL)",
    () =>
      globalPathGuard.withPermits(1)(
        Effect.gen(function* () {
          const origData = Global.Path.data
          const dir = mkdtempSync(join(osTmpdir(), "s2-g3-live-"))
          const file = join(dir, "kilo.db")
          const storageDir = join(dir, "storage")
          ;(Global.Path as { data: string }).data = dir
          try {
            expect(dir).not.toBe(origData)
            expect(file).not.toBe(Database.path())
            expect(Database.path()).toBe(":memory:")
            assertOwned(dir, file, storageDir)
            assertWatermarkConstants()
            expect(Accounting.safeStat("/nonexistent-wal-xyz")).toBe(0)
            const bootDone = yield* Ref.make(false)
            const bootCalls = yield* Ref.make(0)
            const isDirect = yield* Ref.make(false)
            const calls = yield* Ref.make(0)
            const hysteresis = Layer.effect(
              Accounting.Service,
              Effect.gen(function* () {
                return Accounting.Service.of({
                  physicalBytes: () =>
                    Effect.gen(function* () {
                      const done = yield* Ref.get(bootDone)
                      if (!done) {
                        yield* Ref.update(bootCalls, (n) => n + 1)
                        return 0
                      }
                      const direct = yield* Ref.get(isDirect)
                      if (!direct) return 0
                      const n = yield* Ref.updateAndGet(calls, (v) => v + 1)
                      if (n <= 2) return Retention.HIGH_BYTES + 1024
                      return Retention.LOW_BYTES
                    }),
                  physicalBytesWith: (p, s) => Effect.sync(() => Accounting.physicalBytesWith(p, s)),
                })
              }),
            )
            const dbLayer = Database.layerFromPath(file)
            const base = makeFileBaseWithMaintenance(dbLayer, hysteresis)
            yield* Effect.gen(function* () {
              // Bounded startup: the worker waits for start before replay/boot.
              yield* (yield* Maintenance.Service).start
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const c = yield* Ref.get(bootCalls)
                  if (c >= 1) return true as const
                  return undefined
                }),
                "boot did not run",
                "2 seconds",
              )
              yield* Ref.set(bootDone, true)
              const { db } = yield* Database.Service
              const storage = yield* Storage.Service
              const session = yield* SessionV2.Service
              const maintenance = yield* Maintenance.Service
              const created = yield* session.create({ location })
              const token = crypto.randomUUID()
              const opId = SessionOperation.sessionUpdateId(created.id, token)
              const idemKey = `sessionUpdate:${created.id}:${token}`
              const hash = SessionOperation.hashIdempotencyKey(idemKey)
              const now = Date.now()
              const record: SessionOperation.FailureRecord = {
                opId,
                opKind: "sessionUpdate",
                outcome: "succeeded",
                code: "sessionUpdate.succeeded",
                message: "ok",
                time: now,
              }
              const meta = {
                idempotencyHash: hash,
                requestId: "req-g3-live",
                directory: "/project",
                parentSessionId: null as string | null,
                configVersion: null as number | null,
                sessionRevision: null as number | null,
                title: "new-live-title",
              }
              yield* db
                .transaction(
                  (tx) =>
                    SessionOperation.insertSessionUpdateSucceededTx(
                      tx as unknown as Database.Interface["db"],
                      created.id,
                      record,
                      meta,
                    ),
                  { behavior: "immediate" },
                )
                .pipe(Effect.orDie)
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, created.id))
                .run()
                .pipe(Effect.orDie)
              const ops = yield* db
                .select()
                .from(SessionOperationTable)
                .where(eq(SessionOperationTable.session_id, created.id))
                .all()
                .pipe(Effect.orDie)
              expect(ops.length).toBe(1)
              expect(ops[0].title).toBe("new-live-title")
              expect(ops[0].result_snapshot).not.toBeNull()
              expect(String(ops[0].result_snapshot)).toContain("new-live-title")
              yield* storage.write(["session_diff", created.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
              yield* storage.write(["session_diff_base", created.id], [{ base: "x" }])
              const diffPath = join(storageDir, "session_diff", `${created.id}.json`)
              const diffBasePath = join(storageDir, "session_diff_base", `${created.id}.json`)
              expect(diffPath.startsWith(dir)).toBe(true)
              expect(diffBasePath.startsWith(dir)).toBe(true)
              expect(existsSync(diffPath)).toBe(true)
              expect(existsSync(diffBasePath)).toBe(true)
              expect(existsSync(join(origData, "storage", "session_diff", `${created.id}.json`))).toBe(false)
              const titleRow = yield* db
                .select({ title: SessionTable.title, rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, created.id))
                .get()
                .pipe(Effect.orDie)
              expect(titleRow?.title).toBe("new-live-title")
              const beforeRev = titleRow?.rev ?? 0
              const feedBefore = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, created.id))
                .all()
                .pipe(Effect.orDie)
              expect(feedBefore.length).toBe(1)
              expect(feedBefore[0].kind).toBe("changed")
              expect(feedBefore[0].revision).toBe(beforeRev)
              yield* Ref.set(calls, 0)
              yield* Ref.set(isDirect, true)
              const diag = yield* maintenance.runOnce("test-live-b2-cascade")
              yield* Ref.set(isDirect, false)
              expect(diag.trigger).toBe("test-live-b2-cascade")
              expect(diag.beforeBytes).toBe(Retention.HIGH_BYTES + 1024)
              expect(diag.afterBytes).toBe(Retention.LOW_BYTES)
              expect(diag.selected).toBe(1)
              expect(diag.deleted).toBe(1)
              expect(diag.rowsReclaimed).toBe(1)
              expect(diag.checkpoint).toBe("ok")
              expect(diag.vacuum).toBe("ok")
              const gone = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, created.id))
                .get()
                .pipe(Effect.orDie)
              expect(gone).toBeUndefined()
              const opAfter = yield* db
                .select()
                .from(SessionOperationTable)
                .where(eq(SessionOperationTable.session_id, created.id))
                .all()
                .pipe(Effect.orDie)
              expect(opAfter.length).toBe(0)
              const feedAfter = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, created.id))
                .all()
                .pipe(Effect.orDie)
              expect(feedAfter.length).toBe(2)
              expect(feedAfter.some((r) => r.kind === "deleted")).toBe(true)
              expect(feedAfter.some((r) => r.kind === "changed")).toBe(true)
              const del = feedAfter.find((r) => r.kind === "deleted")
              expect(del?.revision).toBe(beforeRev + 1)
              const obs = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(obs.length).toBe(0)
              for (const kind of Artifact.FamilyArtifactKind) {
                const k = [kind, created.id] as unknown as string[]
                const ex = yield* storage.read<unknown>(k).pipe(Effect.exit)
                expect(ex._tag).toBe("Failure")
              }
              expect(existsSync(diffPath)).toBe(false)
              expect(existsSync(diffBasePath)).toBe(false)
              const jMode = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`).pipe(Effect.orDie)
              expect(jMode?.journal_mode).toBe("wal")
              const av = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
              expect(av?.auto_vacuum).toBe(2)
              expect(existsSync(file)).toBe(true)
              const via = Accounting.physicalBytesWith(file, storageDir)
              const manual =
                Accounting.safeStat(file) + Accounting.safeStat(file + "-wal") + Accounting.artifactBytes(storageDir)
              expect(via).toBe(manual)
              // WAL lifecycle: owned file-backed DB, WAL size-if-present, no leak under origData
              expect(Accounting.artifactBytes(storageDir)).toBe(0)
              expect(Accounting.artifactBytesForSession(storageDir, created.id)).toBe(0)
              expect(Accounting.safeStat(file + "-wal")).toBeGreaterThanOrEqual(0)
              expect(file.startsWith(dir)).toBe(true)
              expect(storageDir.startsWith(dir)).toBe(true)
              // session_diff dir may remain as empty directory after artifact removal — check artifact count instead of dir existence
              expect(Accounting.artifactBytes(storageDir)).toBe(0)
              expect(existsSync(join(origData, "storage", "session_diff", `${created.id}.json`))).toBe(false)
              expect(Artifact.familyKinds().includes("snapshot" as unknown as Artifact.FamilyArtifactKind)).toBe(false)
              expect(Artifact.familyArtifactsForFamily([created.id]).some((k) => k[0] === "snapshot")).toBe(false)
              // filesystem evidence: snapshot is project-owned, not family-pruned — verify run-owned snapshot paths directly
              const snapStoragePath = join(storageDir, "snapshot", `${created.id}.json`)
              expect(existsSync(snapStoragePath)).toBe(false)
              // snapshot as file artifact under storage/snapshot should not exist as directory with session file
              const snapStorageDir = join(storageDir, "snapshot")
              expect(existsSync(snapStorageDir) ? !existsSync(snapStoragePath) : true).toBe(true)
              // project-owned snapshot gitdir is under Global.Path.data/snapshot, not storage — verify no session file leaked there
              expect(existsSync(join(dir, "snapshot"))).toBe(false)
              expect(existsSync(join(origData, "storage", "snapshot", `${created.id}.json`))).toBe(false)
              expect(existsSync(join(origData, "snapshot"))).toBe(false)
            }).pipe(Effect.provide(base), Effect.scoped)
          } finally {
            ;(Global.Path as { data: string }).data = origData
            safeRemoveOwned(dir)
            expect(existsSync(dir)).toBe(false)
            expect(existsSync(file)).toBe(false)
            expect(existsSync(storageDir)).toBe(false)
            assertNoOwnedLeak(dir)
          }
        }),
      ),
  )

  it.live(
    "high->low hysteresis with file-backed DB and logical Accounting (WAL mode and WAL-inclusive formula, artifact bytes via real FS)",
    () =>
      globalPathGuard.withPermits(1)(
        Effect.gen(function* () {
          const origData = Global.Path.data
          const dir = mkdtempSync(join(osTmpdir(), "s2-g3-hyst-"))
          const file = join(dir, "kilo.db")
          const storageDir = join(dir, "storage")
          ;(Global.Path as { data: string }).data = dir
          try {
            assertOwned(dir, file, storageDir)
            assertWatermarkConstants()
            expect(Accounting.safeStat("/nonexistent-wal-xyz")).toBe(0)
            const bootDone = yield* Ref.make(false)
            const bootCalls = yield* Ref.make(0)
            const isDirect = yield* Ref.make(false)
            const calls = yield* Ref.make(0)
            const hyst = Layer.effect(
              Accounting.Service,
              Effect.gen(function* () {
                return Accounting.Service.of({
                  physicalBytes: () =>
                    Effect.gen(function* () {
                      const d = yield* Ref.get(bootDone)
                      if (!d) {
                        yield* Ref.update(bootCalls, (n) => n + 1)
                        return 0
                      }
                      if (!(yield* Ref.get(isDirect))) return 0
                      const n = yield* Ref.updateAndGet(calls, (v) => v + 1)
                      if (n <= 2) return Retention.HIGH_BYTES + 2048
                      return Retention.LOW_BYTES
                    }),
                  physicalBytesWith: (p, s) => Effect.sync(() => Accounting.physicalBytesWith(p, s)),
                })
              }),
            )
            const dbLayer = Database.layerFromPath(file)
            const base = makeFileBaseWithMaintenance(dbLayer, hyst)
            yield* Effect.gen(function* () {
              // Bounded startup: the worker waits for start before replay/boot.
              yield* (yield* Maintenance.Service).start
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const c = yield* Ref.get(bootCalls)
                  if (c >= 1) return true as const
                  return undefined
                }),
                "boot did not run",
                "2 seconds",
              )
              yield* Ref.set(bootDone, true)
              const { db } = yield* Database.Service
              const storage = yield* Storage.Service
              const session = yield* SessionV2.Service
              const maintenance = yield* Maintenance.Service
              const a = yield* session.create({ location })
              const b = yield* session.create({ location })
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, a.id))
                .run()
                .pipe(Effect.orDie)
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, b.id))
                .run()
                .pipe(Effect.orDie)
              yield* storage.write(["session_diff", a.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
              yield* storage.write(["session_diff", b.id], [{ file: "b.ts", additions: 1, deletions: 0 }])
              const aPath = join(storageDir, "session_diff", `${a.id}.json`)
              const bPath = join(storageDir, "session_diff", `${b.id}.json`)
              expect(aPath.startsWith(dir)).toBe(true)
              expect(bPath.startsWith(dir)).toBe(true)
              expect(existsSync(aPath)).toBe(true)
              expect(existsSync(bPath)).toBe(true)
              expect(existsSync(join(origData, "storage", "session_diff", `${a.id}.json`))).toBe(false)
              const physicalViaHelper = Accounting.physicalBytesWith(file, storageDir)
              const manual =
                Accounting.safeStat(file) + Accounting.safeStat(file + "-wal") + Accounting.artifactBytes(storageDir)
              expect(physicalViaHelper).toBe(manual)
              yield* Ref.set(calls, 0)
              yield* Ref.set(isDirect, true)
              const before = yield* Retention.listFamilies(db)
              expect(before.length).toBe(2)
              const diag = yield* maintenance.runOnce("test-high-low-file")
              yield* Ref.set(isDirect, false)
              expect(diag.beforeBytes).toBe(Retention.HIGH_BYTES + 2048)
              expect(diag.afterBytes).toBe(Retention.LOW_BYTES)
              expect(diag.selected).toBe(2)
              expect(diag.deleted).toBe(1)
              expect(diag.rowsReclaimed).toBe(1)
              expect(diag.checkpoint).toBe("ok")
              expect(diag.vacuum).toBe("ok")
              const after = yield* Retention.listFamilies(db)
              expect(after.length).toBe(1)
              // exactly one artifact remains under owned root
              const remaining = after[0] as { rootID: string }
              const remainingPath = join(storageDir, "session_diff", `${remaining.rootID}.json`)
              expect(existsSync(remainingPath)).toBe(true)
              expect(remainingPath.startsWith(dir)).toBe(true)
              // WAL-inclusive accounting still holds after hysteresis
              expect(Accounting.physicalBytesWith(file, storageDir)).toBe(
                Accounting.safeStat(file) + Accounting.safeStat(file + "-wal") + Accounting.artifactBytes(storageDir),
              )
              expect(Accounting.artifactBytes(storageDir)).toBeGreaterThan(0)
              expect(Accounting.artifactBytesForSession(storageDir, remaining.rootID)).toBeGreaterThan(0)
              const deletedId = [a.id, b.id].find((id) => id !== remaining.rootID)!
              expect(existsSync(join(storageDir, "session_diff", `${deletedId}.json`))).toBe(false)
              expect(existsSync(join(origData, "storage", "session_diff", `${deletedId}.json`))).toBe(false)
              const jMode = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`).pipe(Effect.orDie)
              expect(jMode?.journal_mode).toBe("wal")
              const av = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
              expect(av?.auto_vacuum).toBe(2)
            }).pipe(Effect.provide(base), Effect.scoped)
          } finally {
            ;(Global.Path as { data: string }).data = origData
            safeRemoveOwned(dir)
            expect(existsSync(dir)).toBe(false)
            expect(existsSync(file)).toBe(false)
            expect(existsSync(storageDir)).toBe(false)
            assertNoOwnedLeak(dir)
          }
        }),
      ),
  )

  it.live(
    "global busy short-circuit and 7-day protection with LOW-unreachable diagnostics are descriptive (file-backed)",
    () =>
      globalPathGuard.withPermits(1)(
        Effect.gen(function* () {
          const origData = Global.Path.data
          const dir = mkdtempSync(join(osTmpdir(), "s2-g3-protect-"))
          const file = join(dir, "kilo.db")
          const storageDir = join(dir, "storage")
          ;(Global.Path as { data: string }).data = dir
          try {
            assertOwned(dir, file, storageDir)
            assertWatermarkConstants()
            expect(Accounting.safeStat("/nonexistent-wal-xyz")).toBe(0)
            const bootDone = yield* Ref.make(false)
            const bootCalls = yield* Ref.make(0)
            const isDirect = yield* Ref.make(false)
            const stuckAccounting = Layer.effect(
              Accounting.Service,
              Effect.gen(function* () {
                return Accounting.Service.of({
                  physicalBytes: () =>
                    Effect.gen(function* () {
                      const d = yield* Ref.get(bootDone)
                      if (!d) {
                        yield* Ref.update(bootCalls, (n) => n + 1)
                        return 0
                      }
                      if (!(yield* Ref.get(isDirect))) return 0
                      return Retention.HIGH_BYTES + 512
                    }),
                  physicalBytesWith: () => Effect.succeed(0),
                })
              }),
            )
            const dbLayer = Database.layerFromPath(file)
            const base = makeFileBaseWithMaintenance(dbLayer, stuckAccounting)
            yield* Effect.gen(function* () {
              // Bounded startup: the worker waits for start before replay/boot.
              yield* (yield* Maintenance.Service).start
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const c = yield* Ref.get(bootCalls)
                  if (c >= 1) return true as const
                  return undefined
                }),
                "boot did not run",
                "2 seconds",
              )
              yield* Ref.set(bootDone, true)
              const { db } = yield* Database.Service
              const storage = yield* Storage.Service
              const session = yield* SessionV2.Service
              const ownership = yield* Ownership.Service
              const lease = yield* Lease.Service
              const maintenance = yield* Maintenance.Service
              const fresh = yield* session.create({ location })
              const old = yield* session.create({ location })
              const activeSess = yield* session.create({ location })
              const leasedSess = yield* session.create({ location })
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, old.id))
                .run()
                .pipe(Effect.orDie)
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, activeSess.id))
                .run()
                .pipe(Effect.orDie)
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, leasedSess.id))
                .run()
                .pipe(Effect.orDie)
              yield* storage.write(["session_diff", fresh.id], [{ file: "fresh.ts", additions: 1, deletions: 0 }])
              yield* storage.write(["session_diff", old.id], [{ file: "old.ts", additions: 1, deletions: 0 }])
              yield* storage.write(["session_diff", activeSess.id], [{ file: "active.ts", additions: 1, deletions: 0 }])
              yield* storage.write(["session_diff", leasedSess.id], [{ file: "leased.ts", additions: 1, deletions: 0 }])
              for (const id of [fresh.id, old.id, activeSess.id, leasedSess.id]) {
                const p = join(storageDir, "session_diff", `${id}.json`)
                expect(p.startsWith(dir)).toBe(true)
                expect(existsSync(p)).toBe(true)
              }
              const activeRelease = yield* ownership.acquireActive(activeSess.id)
              const leaseRelease = yield* lease.acquire(leasedSess.id)
              yield* Ref.set(isDirect, true)
              const diag = yield* maintenance.runOnce("test-protect-stuck")
              yield* Ref.set(isDirect, false)
              expect(diag.trigger).toBe("test-protect-stuck")
              expect(diag.beforeBytes).toBe(Retention.HIGH_BYTES + 512)
              expect(diag.afterBytes).toBe(Retention.HIGH_BYTES + 512)
              // global busy guard: any active/leased present skips entire run before per-family checks
              expect(diag.selected).toBe(0)
              expect(diag.deleted).toBe(0)
              expect(diag.skipped).toBe(4)
              expect(diag.skipReasons["busy"]).toBe(4)
              expect(diag.checkpoint).toBe("skipped-busy")
              expect(diag.vacuum).toBe("skipped-busy")
              expect(diag.rowsReclaimed).toBe(0)
              expect(diag.failures.length).toBe(0)
              const famsBusy = yield* Retention.listFamilies(db)
              expect(famsBusy.length).toBe(4)
              yield* activeRelease
              yield* leaseRelease
              // second run: protections released, fresh still within 7 days, so 7-day protection applies and LOW remains unreachable (still HIGH)
              yield* Ref.set(isDirect, true)
              const diag2 = yield* maintenance.runOnce("test-protect-stuck-2")
              yield* Ref.set(isDirect, false)
              expect(diag2.beforeBytes).toBe(Retention.HIGH_BYTES + 512)
              expect(diag2.afterBytes).toBe(Retention.HIGH_BYTES + 512)
              expect(diag2.selected).toBe(3)
              expect(diag2.deleted).toBe(3)
              expect(diag2.skipped).toBe(1)
              expect(diag2.skipReasons["within-7days"]).toBe(1)
              expect(diag2.checkpoint).toBe("ok")
              expect(diag2.vacuum).toBe("ok")
              expect(diag2.failures.length).toBe(0)
              const famsAfter2 = yield* Retention.listFamilies(db)
              expect(famsAfter2.length).toBe(1)
              expect(famsAfter2[0].rootID).toBe(fresh.id)
              // file-backed lifecycle: fresh artifact remains under owned root, others removed, no leak under origData
              expect(existsSync(join(storageDir, "session_diff", `${fresh.id}.json`))).toBe(true)
              expect(Accounting.artifactBytesForSession(storageDir, fresh.id)).toBeGreaterThan(0)
              expect(existsSync(join(storageDir, "session_diff", `${old.id}.json`))).toBe(false)
              expect(existsSync(join(origData, "storage", "session_diff", `${fresh.id}.json`))).toBe(false)
              expect(Accounting.artifactBytes(storageDir)).toBe(Accounting.artifactBytesForSession(storageDir, fresh.id))
              const jMode2 = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`).pipe(Effect.orDie)
              expect(jMode2?.journal_mode).toBe("wal")
            }).pipe(Effect.provide(base), Effect.scoped)
          } finally {
            ;(Global.Path as { data: string }).data = origData
            safeRemoveOwned(dir)
            expect(existsSync(dir)).toBe(false)
            expect(existsSync(file)).toBe(false)
            expect(existsSync(storageDir)).toBe(false)
            assertNoOwnedLeak(dir)
          }
        }),
      ),
  )

  it.live(
    "retention_obligation replay after artifact cleanup failure (file-backed) increments attempts then succeeds",
    () =>
      globalPathGuard.withPermits(1)(
        Effect.gen(function* () {
          const origData = Global.Path.data
          const dir = mkdtempSync(join(osTmpdir(), "s2-g3-oblig-"))
          const file = join(dir, "kilo.db")
          const storageDir = join(dir, "storage")
          ;(Global.Path as { data: string }).data = dir
          try {
            assertOwned(dir, file, storageDir)
            assertWatermarkConstants()
            expect(Accounting.safeStat("/nonexistent-wal-xyz")).toBe(0)
            const dbLayer = Database.layerFromPath(file)
            const base = makeFileBaseWithoutMaintenance(dbLayer)
            yield* Effect.gen(function* () {
              const { db } = yield* Database.Service
              const session = yield* SessionV2.Service
              const storage = yield* Storage.Service
              const created = yield* session.create({ location })
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, created.id))
                .run()
                .pipe(Effect.orDie)
              yield* storage.write(["session_diff", created.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
              const artPath = join(storageDir, "session_diff", `${created.id}.json`)
              expect(artPath.startsWith(dir)).toBe(true)
              expect(existsSync(artPath)).toBe(true)
              const fam = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
              yield* Retention.deleteFamilyTransaction(
                db,
                fam,
                Date.now(),
                () => false,
                () => false,
              )
              const before = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(before.length).toBe(1)
              expect(before[0].attempts).toBe(0)
              const failing = () => Effect.fail(new Error("artifact delete fail"))
              yield* Retention.replayObligations(db, failing)
              const afterFail = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(afterFail.length).toBe(1)
              expect(afterFail[0].attempts).toBe(1)
              // artifact still on disk under owned root when deleter fails, not under origData
              expect(existsSync(artPath)).toBe(true)
              expect(existsSync(join(origData, "storage", "session_diff", `${created.id}.json`))).toBe(false)
              expect(Accounting.artifactBytesForSession(storageDir, created.id)).toBeGreaterThan(0)
              const replayBase = makeFileBaseWithMaintenance(dbLayer)
              yield* Effect.gen(function* () {
                const m = yield* Maintenance.Service
                yield* m.replay()
                const afterReplay = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
                expect(afterReplay.length).toBe(0)
                expect(existsSync(artPath)).toBe(false)
                expect(Accounting.artifactBytesForSession(storageDir, created.id)).toBe(0)
                expect(existsSync(join(origData, "storage", "session_diff", `${created.id}.json`))).toBe(false)
              }).pipe(Effect.provide(replayBase), Effect.scoped)
              yield* Retention.replayObligations(db, () => Effect.void)
              const afterSecond = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(afterSecond.length).toBe(0)
              expect(existsSync(artPath)).toBe(false)
              const created2 = yield* session.create({ location })
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, created2.id))
                .run()
                .pipe(Effect.orDie)
              yield* storage.write(["session_diff", created2.id], [{ file: "b.ts", additions: 1, deletions: 0 }])
              const fam2 = { rootID: created2.id, sessionIDs: [created2.id], activity: 0 }
              yield* Retention.deleteFamilyTransaction(
                db,
                fam2,
                Date.now(),
                () => false,
                () => false,
              )
              const before2 = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(before2.length).toBe(1)
              const bPath2 = join(storageDir, "session_diff", `${created2.id}.json`)
              expect(existsSync(bPath2)).toBe(true)
              expect(existsSync(join(origData, "storage", "session_diff", `${created2.id}.json`))).toBe(false)
              yield* Retention.replayObligations(db, () => Effect.void)
              const afterOk = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(afterOk.length).toBe(0)
              // void deleter clears obligation without touching FS artifact — file remains under owned root (proves obligation semantics, not file deletion)
              expect(existsSync(bPath2)).toBe(true)
              expect(Accounting.artifactBytesForSession(storageDir, created2.id)).toBeGreaterThan(0)
              const jModeO = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`).pipe(Effect.orDie)
              expect(jModeO?.journal_mode).toBe("wal")
              // real file-backed cleanup via Storage.remove proves owned cleanup
              yield* storage.remove(["session_diff", created2.id])
              expect(existsSync(bPath2)).toBe(false)
              expect(Accounting.artifactBytesForSession(storageDir, created2.id)).toBe(0)
            }).pipe(Effect.provide(base), Effect.scoped)
          } finally {
            ;(Global.Path as { data: string }).data = origData
            safeRemoveOwned(dir)
            expect(existsSync(dir)).toBe(false)
            expect(existsSync(file)).toBe(false)
            expect(existsSync(storageDir)).toBe(false)
            assertNoOwnedLeak(dir)
          }
        }),
      ),
  )

  it.live(
    "WAL-inclusive physical byte accounting, checkpoint TRUNCATE and incremental_vacuum outcomes (file-backed)",
    () =>
      globalPathGuard.withPermits(1)(
        Effect.gen(function* () {
          const origData = Global.Path.data
          const dir = mkdtempSync(join(osTmpdir(), "s2-g3-wal-"))
          const file = join(dir, "kilo.db")
          const storageDir = join(dir, "storage")
          ;(Global.Path as { data: string }).data = dir
          try {
            assertOwned(dir, file, storageDir)
            assertWatermarkConstants()
            expect(Accounting.safeStat("/nonexistent-wal-xyz")).toBe(0)
            const dbLayer = Database.layerFromPath(file)
            yield* Effect.gen(function* () {
              const { db } = yield* Database.Service
              const jm = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`).pipe(Effect.orDie)
              expect(jm?.journal_mode).toBe("wal")
              const av = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
              expect(av?.auto_vacuum).toBe(2)
              const session = yield* SessionV2.Service
              const storage = yield* Storage.Service
              const s1 = yield* session.create({ location })
              const s2 = yield* session.create({ location })
              yield* storage.write(["session_diff", s1.id], [{ file: "wal-a.ts", additions: 10, deletions: 0 }])
              yield* storage.write(["session_diff", s2.id], [{ file: "wal-b.ts", additions: 20, deletions: 0 }])
              const aPath = join(storageDir, "session_diff", `${s1.id}.json`)
              const bPath = join(storageDir, "session_diff", `${s2.id}.json`)
              expect(aPath.startsWith(dir)).toBe(true)
              expect(bPath.startsWith(dir)).toBe(true)
              expect(existsSync(aPath)).toBe(true)
              expect(existsSync(bPath)).toBe(true)
              yield* db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`).pipe(Effect.orDie)
              const mainStat = Accounting.safeStat(file)
              const walStat = Accounting.safeStat(file + "-wal")
              expect(mainStat).toBeGreaterThan(0)
              const viaHelper = Accounting.physicalBytesWith(file, storageDir)
              const manual =
                Accounting.safeStat(file) + Accounting.safeStat(file + "-wal") + Accounting.artifactBytes(storageDir)
              expect(viaHelper).toBe(manual)
              expect(viaHelper).toBeGreaterThanOrEqual(Accounting.artifactBytes(storageDir))
              // checkpoint TRUNCATE should succeed and not increase WAL if present (size-if-present)
              const cp = yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.exit)
              expect(cp._tag).toBe("Success")
              const walAfter = Accounting.safeStat(file + "-wal")
              expect(walAfter).toBeLessThanOrEqual(walStat)
              const vac = yield* db.run(sql`PRAGMA incremental_vacuum(10)`).pipe(Effect.exit)
              expect(vac._tag).toBe("Success")
              // lifecycle: owned DB files under dir, not origData, artifactBytes reflects real FS
              expect(file.startsWith(dir)).toBe(true)
              expect(storageDir.startsWith(dir)).toBe(true)
              expect(existsSync(join(origData, "storage", "session_diff", `${s1.id}.json`))).toBe(false)
              expect(Accounting.artifactBytes(storageDir)).toBeGreaterThan(0)
              expect(Accounting.artifactBytesForSession(storageDir, s1.id)).toBeGreaterThan(0)
              expect(Accounting.artifactBytesForSession(storageDir, s2.id)).toBeGreaterThan(0)
              expect(Artifact.familyKinds().includes("snapshot" as unknown as Artifact.FamilyArtifactKind)).toBe(false)
              // filesystem evidence: snapshot project-owned, not counted in family artifact bytes — verify no snapshot file/dir under run-owned paths
              expect(existsSync(join(storageDir, "snapshot", `${s1.id}.json`))).toBe(false)
              expect(existsSync(join(storageDir, "snapshot", `${s2.id}.json`))).toBe(false)
              expect(existsSync(join(storageDir, "snapshot")) ? readdirSync(join(storageDir, "snapshot")).length === 0 : true).toBe(true)
              expect(existsSync(join(dir, "snapshot"))).toBe(false)
              expect(existsSync(join(origData, "storage", "snapshot", `${s1.id}.json`))).toBe(false)
              expect(Accounting.safeStat("/nonexistent-path-xyz-abc")).toBe(0)
              const accounting = Layer.effect(
                Accounting.Service,
                Effect.gen(function* () {
                  return Accounting.Service.of({
                    physicalBytes: () => Effect.succeed(Retention.LOW_BYTES),
                    physicalBytesWith: (p, s) => Effect.sync(() => Accounting.physicalBytesWith(p, s)),
                  })
                }),
              )
              const maintBase = makeFileBaseWithMaintenance(dbLayer, accounting)
              yield* Effect.gen(function* () {
                const m = yield* Maintenance.Service
                const diag = yield* m.runOnce("test-wal-checkpoint")
                expect(["ok", "skipped-below-high", "skipped-no-delete"].includes(diag.checkpoint)).toBe(true)
                expect(
                  ["ok", "skipped-below-high", "skipped-no-delete", "skipped-not-incremental:2"].includes(diag.vacuum),
                ).toBe(true)
                // re-verify WAL-inclusive formula after checkpoint path
                const viaAfter = Accounting.physicalBytesWith(file, storageDir)
                const manualAfter =
                  Accounting.safeStat(file) + Accounting.safeStat(file + "-wal") + Accounting.artifactBytes(storageDir)
                expect(viaAfter).toBe(manualAfter)
              }).pipe(Effect.provide(maintBase), Effect.scoped)
            }).pipe(Effect.provide(makeFileBaseWithoutMaintenance(dbLayer)), Effect.scoped)
          } finally {
            ;(Global.Path as { data: string }).data = origData
            safeRemoveOwned(dir)
            expect(existsSync(file)).toBe(false)
            expect(existsSync(dir)).toBe(false)
            expect(existsSync(storageDir)).toBe(false)
            assertNoOwnedLeak(dir)
          }
        }),
      ),
  )

  it.live(
    "cleanup ownership/idempotency: Storage.remove, obligation, lease, active are idempotent and run-owned temp is cleaned",
    () =>
      globalPathGuard.withPermits(1)(
        Effect.gen(function* () {
          const origData = Global.Path.data
          const dir = mkdtempSync(join(osTmpdir(), "s2-g3-clean-"))
          const file = join(dir, "kilo.db")
          const storageDir = join(dir, "storage")
          ;(Global.Path as { data: string }).data = dir
          try {
            assertOwned(dir, file, storageDir)
            assertWatermarkConstants()
            expect(Accounting.safeStat("/nonexistent-wal-xyz")).toBe(0)
            const dbLayer = Database.layerFromPath(file)
            const base = makeFileBaseWithoutMaintenance(dbLayer)
            yield* Effect.gen(function* () {
              const { db } = yield* Database.Service
              const storage = yield* Storage.Service
              const session = yield* SessionV2.Service
              const ownership = yield* Ownership.Service
              const lease = yield* Lease.Service
              const created = yield* session.create({ location })
              yield* storage.write(["session_diff", created.id], [{ file: "clean.ts", additions: 1, deletions: 0 }])
              const artPath = join(storageDir, "session_diff", `${created.id}.json`)
              expect(artPath.startsWith(dir)).toBe(true)
              expect(existsSync(artPath)).toBe(true)
              yield* storage.remove(["session_diff", created.id])
              expect(existsSync(artPath)).toBe(false)
              const secondRemove = yield* storage.remove(["session_diff", created.id]).pipe(Effect.exit)
              expect(secondRemove._tag).toBe("Success")
              const readAfter = yield* storage.read<unknown>(["session_diff", created.id]).pipe(Effect.exit)
              expect(readAfter._tag).toBe("Failure")
              const neverRemove = yield* storage.remove(["session_diff", "never-existed"]).pipe(Effect.exit)
              expect(neverRemove._tag).toBe("Success")
              yield* db
                .update(SessionTable)
                .set({ time_updated: 0 })
                .where(eq(SessionTable.id, created.id))
                .run()
                .pipe(Effect.orDie)
              const fam = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
              yield* Retention.deleteFamilyTransaction(
                db,
                fam,
                Date.now(),
                () => false,
                () => false,
              )
              const obs1 = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(obs1.length).toBe(1)
              yield* Retention.replayObligations(db, () => Effect.void)
              const obs2 = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(obs2.length).toBe(0)
              yield* Retention.replayObligations(db, () => Effect.void)
              const obs3 = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              expect(obs3.length).toBe(0)
              const relActive = yield* ownership.acquireActive(created.id)
              expect(ownership.isActive(created.id)).toBe(true)
              const relActive2 = yield* ownership.acquireActive(created.id)
              expect(ownership.isActive(created.id)).toBe(true)
              yield* relActive
              expect(ownership.isActive(created.id)).toBe(true)
              yield* relActive2
              expect(ownership.isActive(created.id)).toBe(false)
              yield* relActive2
              expect(ownership.isActive(created.id)).toBe(false)
              const relLease = yield* ownership.acquireLease(created.id)
              expect(ownership.isLeased(created.id)).toBe(true)
              yield* relLease
              expect(ownership.isLeased(created.id)).toBe(false)
              yield* relLease
              expect(ownership.isLeased(created.id)).toBe(false)
              const relLease2 = yield* lease.acquire(created.id)
              expect(lease.isLeased(created.id)).toBe(true)
              yield* relLease2
              expect(lease.isLeased(created.id)).toBe(false)
              expect(dir.startsWith(osTmpdir())).toBe(true)
              expect(file.startsWith(dir)).toBe(true)
              expect(existsSync(file)).toBe(true)
              // file-backed lifecycle: storageDir owned, not under origData, artifactBytes reflects FS
              expect(storageDir.startsWith(dir)).toBe(true)
              expect(existsSync(join(origData, "storage", "session_diff", `${created.id}.json`))).toBe(false)
              expect(Accounting.safeStat(join(storageDir, "session_diff", `${created.id}.json`))).toBe(0)
              expect(Accounting.artifactBytes(storageDir)).toBe(0)
              expect(Accounting.artifactBytesForSession(storageDir, created.id)).toBe(0)
              const jModeClean = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`).pipe(Effect.orDie)
              expect(jModeClean?.journal_mode).toBe("wal")
              expect(Accounting.physicalBytesWith(file, storageDir)).toBe(
                Accounting.safeStat(file) + Accounting.safeStat(file + "-wal") + Accounting.artifactBytes(storageDir),
              )
            }).pipe(Effect.provide(base), Effect.scoped)
          } finally {
            ;(Global.Path as { data: string }).data = origData
            safeRemoveOwned(dir)
            expect(existsSync(dir)).toBe(false)
            expect(existsSync(file)).toBe(false)
            expect(existsSync(storageDir)).toBe(false)
            assertNoOwnedLeak(dir)
          }
        }),
      ),
  )

  it.live("concurrency guard serializes Global.Path.data overrides (no cross-contamination)", () =>
    Effect.gen(function* () {
      assertWatermarkConstants()
      expect(Accounting.safeStat("/nonexistent-wal-xyz")).toBe(0)
      const orig = Global.Path.data
      const seen: string[] = []
      const runOwned = (label: string, millis: number) =>
        globalPathGuard.withPermits(1)(
          Effect.gen(function* () {
            const captured = Global.Path.data
            expect(captured).toBe(orig)
            const dir = mkdtempSync(join(osTmpdir(), `s2-g3-guard-${label}-`))
            const file = join(dir, "kilo.db")
            const storageDir = join(dir, "storage")
            ;(Global.Path as { data: string }).data = dir
            try {
              expect(Global.Path.data).toBe(dir)
              expect(dir.startsWith(osTmpdir())).toBe(true)
              expect(dir.includes("s2-g3-")).toBe(true)
              expect(file.startsWith(dir)).toBe(true)
              expect(storageDir.startsWith(dir)).toBe(true)
              seen.push(`${label}-enter`)
              yield* Effect.sleep(Duration.millis(millis))
              expect(Global.Path.data).toBe(dir)
              seen.push(`${label}-exit`)
            } finally {
              ;(Global.Path as { data: string }).data = captured
              safeRemoveOwned(dir)
              expect(existsSync(dir)).toBe(false)
              expect(Global.Path.data).toBe(orig)
            }
          }),
        )
      yield* Effect.all([runOwned("a", 30), runOwned("b", 15)], { concurrency: 2 })
      expect(seen.length).toBe(4)
      const ok =
        (seen[0] === "a-enter" && seen[1] === "a-exit" && seen[2] === "b-enter" && seen[3] === "b-exit") ||
        (seen[0] === "b-enter" && seen[1] === "b-exit" && seen[2] === "a-enter" && seen[3] === "a-exit")
      expect(ok).toBe(true)
      expect(Global.Path.data).toBe(orig)
      // no owned temp leaks remain after serialized guard
      const leaked = readdirSync(osTmpdir()).filter((n) => n.startsWith("s2-g3-guard-"))
      expect(leaked.length).toBe(0)
      const anyS2 = readdirSync(osTmpdir()).filter((n) => n.startsWith("s2-g3-"))
      // current suite owns only s2-g3-*; after guard test no guard dirs should remain; other tests are serialized via guard so shouldn't leak here
      // if any remain they belong to concurrently running unrelated suite; allow but check not guard
      expect(anyS2.every((n) => !n.startsWith("s2-g3-guard-"))).toBe(true)
    }),
  )
})
