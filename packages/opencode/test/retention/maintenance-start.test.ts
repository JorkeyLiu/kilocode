import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Ref } from "effect"
import * as Scope from "effect/Scope"
import { sql } from "drizzle-orm"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir as osTmpdir } from "os"
import { join } from "path"
import { randomUUID } from "crypto"
import { Database } from "@opencode-ai/core/database/database"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import * as Maintenance from "@/retention/maintenance"
import * as Ownership from "@/retention/ownership"
import * as Lease from "@/retention/lease"
import * as Accounting from "@/retention/accounting"
import { Storage } from "@/storage/storage"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"

type Mark = { seq: number; kind: "runonce" | "replay-remove" }

// Observable harness: real file-backed DB (run-owned temp file, no lease so it
// can never conflict with the process canonical DB), real Ownership/Lease, a
// counting Accounting stub (runOnce probes physicalBytes twice per run), and a
// Storage mock recording replay deleter calls. No EventV2, so no event-driven
// schedules interfere.
function baseLayer(dir: string, marks: Ref.Ref<Mark[]>, tick: Ref.Ref<number>) {
  const db = Database.layerNoLease(join(dir, "unit.db"))
  const accounting = Layer.succeed(
    Accounting.Service,
    Accounting.Service.of({
      physicalBytes: () =>
        Effect.gen(function* () {
          const seq = yield* Ref.updateAndGet(tick, (n) => n + 1)
          yield* Ref.update(marks, (m) => [...m, { seq, kind: "runonce" as const }])
          return 0
        }),
      physicalBytesWith: () => Effect.succeed(0),
    }),
  )
  const storage = Layer.mock(Storage.Service)({
    remove: () =>
      Effect.gen(function* () {
        const seq = yield* Ref.updateAndGet(tick, (n) => n + 1)
        yield* Ref.update(marks, (m) => [...m, { seq, kind: "replay-remove" as const }])
      }),
  })
  const inner = Layer.mergeAll(db, Ownership.layer, Lease.layer, accounting, storage)
  return Layer.mergeAll(inner, Maintenance.layer.pipe(Layer.provide(inner)))
}

function seedObligation(root: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .run(
        sql`INSERT INTO retention_obligation (family_root_id, session_ids, time_created, attempts) VALUES (${root}, ${JSON.stringify(["sess-x"])}, ${Date.now()}, 0)`,
      )
      .pipe(Effect.orDie)
  })
}

function obligationCount() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db.all<{ id: number }>(sql`SELECT id FROM retention_obligation`).pipe(Effect.orDie)
    return rows.length
  })
}

describe("RetentionMaintenance bounded startup", () => {
  test("construction performs no I/O; pre-start schedules buffer without running", async () => {
    const dir = mkdtempSync(join(osTmpdir(), "maintenance-start-"))
    try {
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const marks = yield* Ref.make<Mark[]>([])
            const tick = yield* Ref.make(0)
            const ctx = yield* Layer.build(baseLayer(dir, marks, tick))
            const svc = Context.get(ctx, Maintenance.Service)
            // Seed after build: if construction replayed or the worker ran
            // pre-start, this row would be consumed and marks would appear.
            const root = `prestart-${randomUUID()}`
            yield* seedObligation(root).pipe(Effect.provide(ctx))
            yield* svc.schedule("pre-1")
            yield* svc.schedule("pre-2")
            // The old code replayed at build and drained the queue within ms;
            // a bounded absence window proves buffering.
            yield* Effect.sleep("250 millis")
            return {
              marks: yield* Ref.get(marks),
              remaining: yield* obligationCount().pipe(Effect.provide(ctx)),
            }
          }),
        ),
      )
      expect(outcome.marks).toEqual([])
      expect(outcome.remaining).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("start replays before first runOnce, coalesces boot, and is idempotent", async () => {
    const dir = mkdtempSync(join(osTmpdir(), "maintenance-start-"))
    try {
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const marks = yield* Ref.make<Mark[]>([])
            const tick = yield* Ref.make(0)
            const ctx = yield* Layer.build(baseLayer(dir, marks, tick))
            const svc = Context.get(ctx, Maintenance.Service)
            const root = `boot-${randomUUID()}`
            yield* seedObligation(root).pipe(Effect.provide(ctx))
            yield* svc.schedule("pre-1")
            yield* svc.schedule("pre-2")
            yield* svc.start
            yield* svc.start
            yield* svc.start
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const seen = yield* Ref.get(marks)
                if (seen.some((m) => m.kind === "runonce")) return true as const
                return undefined
              }).pipe(Effect.provide(ctx)),
              "runOnce did not run after start",
              "5 seconds",
            )
            // Settle: no further runs may fire (single coalesced run only).
            yield* Effect.sleep("300 millis")
            return {
              marks: yield* Ref.get(marks),
              remaining: yield* obligationCount().pipe(Effect.provide(ctx)),
            }
          }),
        ),
      )
      const removes = outcome.marks.filter((m) => m.kind === "replay-remove")
      const runs = outcome.marks.filter((m) => m.kind === "runonce")
      // Replay consumed the seeded obligation exactly once.
      expect(outcome.remaining).toBe(0)
      expect(removes.length).toBe(Artifact.familyKinds().length)
      // Every replay deleter call precedes the first runOnce probe.
      const firstRun = Math.min(...runs.map((m) => m.seq))
      expect(runs.length).toBeGreaterThan(0)
      for (const r of removes) expect(r.seq).toBeLessThan(firstRun)
      // Buffered schedules + boot coalesced into one below-high run, which
      // probes physicalBytes exactly once (early return, no after-probe).
      expect(runs.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("scope close before start cleans the worker without running anything", async () => {
    const dir = mkdtempSync(join(osTmpdir(), "maintenance-start-"))
    const marks = await Effect.runPromise(Ref.make<Mark[]>([]))
    const tick = await Effect.runPromise(Ref.make(0))
    const scope = await Effect.runPromise(Scope.make())
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const ctx = yield* Layer.buildWithMemoMap(baseLayer(dir, marks, tick), memoMap, scope)
          const svc = Context.get(ctx, Maintenance.Service)
          yield* svc.schedule("pending")
        }),
      )
      await Effect.runPromise(awaitWithTimeout(Scope.close(scope, Exit.void), "scope close hung"))
      await Bun.sleep(250)
      expect(await Effect.runPromise(Ref.get(marks))).toEqual([])
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.ignore)).catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
