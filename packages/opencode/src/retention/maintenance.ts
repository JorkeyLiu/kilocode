import { Context, Effect, Fiber, Layer, Queue } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import * as Retention from "@opencode-ai/core/retention/retention"
import * as Accounting from "./accounting"
import { Storage } from "@/storage/storage"
import * as Ownership from "./ownership"
import * as Lease from "./lease"
import { Global } from "@opencode-ai/core/global"
import { existsSync, statSync } from "fs"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import { RetentionObligationTable } from "@opencode-ai/core/retention/sql"

function safeSize(p: string): number {
  try {
    if (!existsSync(p)) return 0
    return statSync(p).size
  } catch {
    return 0
  }
}

export type Diagnostics = Retention.Diagnostics

export interface Maintenance {
  readonly schedule: (trigger: string) => Effect.Effect<void>
  readonly runOnce: (trigger: string) => Effect.Effect<Diagnostics>
  readonly replay: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Maintenance>()("@opencode/RetentionMaintenance") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const dbSvc = yield* Database.Service
    const storage = yield* Storage.Service
    const ownership = yield* Ownership.Service
    const lease = yield* Lease.Service
    const accounting = yield* Accounting.Service

    const db = dbSvc.db

    const artifactDeleter = (keys: string[][]) =>
      Effect.forEach(keys, (key) => storage.remove(key).pipe(Effect.catch(() => Effect.void)), { discard: true })

    const runOnce: (trigger: string) => Effect.Effect<Diagnostics> = Effect.fn("RetentionMaintenance.runOnce")(
      function* (trigger: string) {
        const before = yield* accounting.physicalBytes()
        const now = Date.now()
        const families = yield* Retention.listFamilies(db)
        const isActive = (id: string) => ownership.isActive(id)
        const isLeased = (id: string) => ownership.isLeased(id) || lease.isLeased(id)

        const activeLeased = ownership.listActive().length > 0 || ownership.listLeased().length > 0 || lease.list().length > 0
        let idle = !activeLeased
        if (!idle) {
          const diag: Diagnostics = {
            trigger,
            beforeBytes: before,
            afterBytes: before,
            selected: 0,
            deleted: 0,
            skipped: families.length,
            skipReasons: { busy: families.length },
            rowsReclaimed: 0,
            artifactBytesReclaimed: 0,
            checkpoint: "skipped-busy",
            vacuum: "skipped-busy",
            failures: [],
          }
          yield* Effect.logInfo("retention maintenance skipped busy", diag)
          return diag
        }

        const cutoff = now - Retention.SEVEN_DAYS_MS
        const eligible: typeof families = []
        const skipReasons: Record<string, number> = {}
        let skipped = 0
        for (const fam of families) {
          if (fam.activity > cutoff) {
            skipped += 1
            skipReasons["within-7days"] = (skipReasons["within-7days"] ?? 0) + 1
            continue
          }
          let blocked: string | undefined
          for (const sid of fam.sessionIDs) {
            if (isActive(sid)) {
              blocked = "active"
              break
            }
            if (isLeased(sid)) {
              blocked = "leased"
              break
            }
          }
          if (blocked) {
            skipped += 1
            skipReasons[blocked] = (skipReasons[blocked] ?? 0) + 1
            continue
          }
          eligible.push(fam)
        }
        eligible.sort((a, b) =>
          a.activity === b.activity ? a.rootID.localeCompare(b.rootID) : a.activity - b.activity,
        )
        const selected = eligible.length
        if (before <= Retention.HIGH_BYTES) {
          const diag: Diagnostics = {
            trigger,
            beforeBytes: before,
            afterBytes: before,
            selected,
            deleted: 0,
            skipped,
            skipReasons,
            rowsReclaimed: 0,
            artifactBytesReclaimed: 0,
            checkpoint: "skipped-below-high",
            vacuum: "skipped-below-high",
            failures: [],
          }
          yield* Effect.logInfo("retention maintenance below high", diag)
          return diag
        }

        let deleted = 0
        let rowsReclaimed = 0
        let artifactBytesReclaimed = 0
        const failures: string[] = []

        for (const fam of eligible) {
          const cur = yield* accounting.physicalBytes()
          if (cur <= Retention.LOW_BYTES) break

          let busyNow = false
          for (const sid of fam.sessionIDs) {
            if (isActive(sid)) {
              busyNow = true
              break
            }
          }
          if (busyNow) {
            skipped += 1
            skipReasons["active-revalidated"] = (skipReasons["active-revalidated"] ?? 0) + 1
            continue
          }
          let leasedNow = false
          for (const sid of fam.sessionIDs) if (isLeased(sid)) leasedNow = true
          if (leasedNow) {
            skipped += 1
            skipReasons["leased-revalidated"] = (skipReasons["leased-revalidated"] ?? 0) + 1
            continue
          }

          const keys = Artifact.familyArtifactsForFamily(fam.sessionIDs)
          let bytesBefore = 0
          for (const key of keys) {
            const p = `${Global.Path.data}/storage/${key.join("/")}.json`
            bytesBefore += safeSize(p)
          }

          const exit = yield* Retention.deleteFamilyTransaction(db, fam, now, isActive, isLeased).pipe(Effect.exit)
          if (exit._tag === "Failure") {
            const cause = String(exit.cause)
            failures.push(`delete ${fam.rootID} failed: ${cause}`)
            skipped += 1
            skipReasons["delete-failed"] = (skipReasons["delete-failed"] ?? 0) + 1
            continue
          }

          const deleterExit = yield* artifactDeleter(keys).pipe(Effect.exit)
          if (deleterExit._tag === "Failure") {
            failures.push(`artifact delete ${fam.rootID} failed: ${String(deleterExit.cause)}`)
            // Keep obligation for retry, increment attempts - record DB bump failure instead of swallowing
            const bumpExit = yield* db
              .run(sql`UPDATE retention_obligation SET attempts = attempts + 1 WHERE family_root_id = ${fam.rootID}`)
              .pipe(Effect.exit)
            if (bumpExit._tag === "Failure") {
              const msg = `obligation bump ${fam.rootID} failed: ${String(bumpExit.cause)}`
              failures.push(msg)
              yield* Effect.logWarning(msg)
            }
            skipped += 1
            skipReasons["artifact-delete-failed"] = (skipReasons["artifact-delete-failed"] ?? 0) + 1
            continue
          }

          // Only delete obligation after artifacts succeeded
          const delExit = yield* db
            .delete(RetentionObligationTable)
            .where(sql`family_root_id = ${fam.rootID}`)
            .run()
            .pipe(Effect.exit)
          if (delExit._tag === "Failure") {
            failures.push(`obligation delete ${fam.rootID} failed: ${String(delExit.cause)}`)
            // keep obligation for retry, increment attempts - record bump failure
            const bumpExit2 = yield* db
              .run(sql`UPDATE retention_obligation SET attempts = attempts + 1 WHERE family_root_id = ${fam.rootID}`)
              .pipe(Effect.exit)
            if (bumpExit2._tag === "Failure") {
              const msg2 = `obligation bump after delete fail ${fam.rootID} failed: ${String(bumpExit2.cause)}`
              failures.push(msg2)
              yield* Effect.logWarning(msg2)
            }
            continue
          }

          deleted += 1
          rowsReclaimed += fam.sessionIDs.length
          artifactBytesReclaimed += bytesBefore
          const afterCur = yield* accounting.physicalBytes()
          if (afterCur <= Retention.LOW_BYTES) break
        }

        let checkpoint = "skipped-no-delete"
        let vacuum = "skipped-no-delete"
        if (deleted > 0) {
          const cpExit = yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.exit)
          if (cpExit._tag === "Failure") {
            checkpoint = String(cpExit.cause)
            failures.push(`checkpoint ${checkpoint}`)
          } else {
            checkpoint = "ok"
          }

          const modeExit = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.exit)
          if (modeExit._tag === "Failure") {
            vacuum = String(modeExit.cause)
            failures.push(`vacuum ${vacuum}`)
          } else {
            const mode = modeExit.value as { auto_vacuum: number } | undefined
            const auto = mode?.auto_vacuum
            if (auto === 2) {
              const vacExit = yield* db
                .run(sql`PRAGMA incremental_vacuum(100)`)
                .pipe(Effect.exit)
              if (vacExit._tag === "Failure") {
                vacuum = String(vacExit.cause)
                failures.push(`vacuum ${vacuum}`)
              } else {
                vacuum = "ok"
              }
            } else {
              vacuum = `skipped-not-incremental:${String(auto)}`
            }
          }
        } else {
          // No deletions, checkpoint/vacuum not needed but report accurately
          checkpoint = "skipped-no-delete"
          vacuum = "skipped-no-delete"
        }

        const after = yield* accounting.physicalBytes()
        const diag: Diagnostics = {
          trigger,
          beforeBytes: before,
          afterBytes: after,
          selected,
          deleted,
          skipped,
          skipReasons,
          rowsReclaimed,
          artifactBytesReclaimed,
          checkpoint,
          vacuum,
          failures,
        }
        yield* Effect.logInfo("retention maintenance done", diag)
        return diag
      },
    )

    const replay = Effect.fn("RetentionMaintenance.replay")(function* () {
      const deleter = (keys: string[][]) =>
        Effect.forEach(keys, (key) => storage.remove(key).pipe(Effect.catch(() => Effect.void)), { discard: true })
      yield* Retention.replayObligations(db, deleter)
    })

    // Owned scoped worker with coalescing via queue
    const queue = yield* Queue.unbounded<string>()
    const worker = yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const first = yield* Queue.take(queue)
          let coalesced = 1
          while (true) {
            const polled = yield* Queue.poll(queue)
            if (polled._tag === "None") break
            coalesced += 1
          }
          const trig = coalesced > 1 ? `${first}+${coalesced - 1} coalesced` : first
          yield* runOnce(trig).pipe(Effect.catchCause(() => Effect.void))
        }),
      ).pipe(Effect.catchCause(() => Effect.void)),
    )
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(worker).pipe(
        Effect.andThen(Fiber.join(worker)),
        Effect.catchCause(() => Effect.void),
      ),
    )

    const schedule = (trigger: string) => Queue.offer(queue, trigger).pipe(Effect.asVoid)

    // Canonical-commit scheduling: after every successful canonical session-family mutation,
    // enqueue maintenance off the generation hot path. The queue coalesces bursts.
    const eventsOpt = yield* Effect.serviceOption(EventV2.Service)
    if (eventsOpt._tag === "Some") {
      const events = eventsOpt.value
      const unsub = yield* events.listen((event) =>
        event.type.startsWith("session.") || event.type.startsWith("session_")
          ? schedule(`commit:${event.type}`).pipe(Effect.catchCause(() => Effect.void))
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)
    }

    // Boot: replay durable obligations before any retention run, then schedule boot check
    yield* replay().pipe(Effect.catchCause(() => Effect.void))

    // Schedule initial boot check off hot path (after replay completes)
    yield* schedule("boot")

    return Service.of({ schedule, runOnce, replay })
  }),
)

export const defaultLayer = layer
