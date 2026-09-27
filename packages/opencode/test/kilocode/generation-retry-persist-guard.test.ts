// kilocode_change - live durable guard: terminal/crash idempotency, no duplicate
// feed/revision, redaction. Proves current behavior is preserved: persisted
// recovery columns remain the terminal stub `{budget:0,nextAt:null,
// provenance:"terminal"}` with no scheduler/retry.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { count, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { createSessionOperationsDeps } from "@/private-worker/session-operations-adapter"

const SID = "ses_guard00000000000001"
const DIR = "/tmp/ws-guard"

const run = <A>(self: Effect.Effect<A, unknown, unknown>) =>
  Effect.runPromise(self.pipe(Effect.catchCause((c: unknown) => Effect.die(c))) as Effect.Effect<A, never, never>)

const ensureSession = (db: any) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: "proj-guard" as any, worktree: DIR as any, vcs: "git", time_created: Date.now(), time_updated: Date.now(), sandboxes: [] as any } as any)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: SID as any, project_id: "proj-guard" as any, slug: "guard", directory: DIR, title: "t", version: "1", revision: 0, time_created: Date.now(), time_updated: Date.now() } as any)
      .run()
      .pipe(Effect.orDie)
  })

const feedCount = (db: any) =>
  Effect.gen(function* () {
    const rows = (yield* db.select({ n: count() }).from(SessionChangefeedTable).all().pipe(Effect.orDie)) as unknown as {
      n: number
    }[]
    return rows.reduce((n: number, r: { n: number }) => n + r.n, 0)
  })

const sessionRev = (db: any) =>
  Effect.gen(function* () {
    const row = (yield* db
      .select({ rev: SessionTable.revision })
      .from(SessionTable)
      .where(eq(SessionTable.id, SID as any))
      .get()
      .pipe(Effect.orDie)) as unknown as { rev: number }
    return row.rev
  })

const opRow = (db: any, opId: string) =>
  Effect.gen(function* () {
    const row = (yield* db
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, opId))
      .get()
      .pipe(Effect.orDie)) as unknown as Record<string, unknown>
    if (!row) throw new Error(`missing row ${opId}`)
    return row
  })

describe("generation retry live durable guard (real DB)", () => {
  test("terminal CAS idempotent: no duplicate feed/revision", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const opId = SessionOperation.promptId("msg_guard00000000000011")
            yield* SessionOperation.ensurePromptInFlight(db, SID as any, opId)
            const rec = SessionOperation.generationTerminal({ opId, outcome: "failed", code: "prompt.failed", message: "boom" })
            const first = yield* SessionOperation.tryTransitionPromptTerminal(db, SID as any, rec)
            expect(first.applied).toBe(true)
            const feedsAfterFirst = yield* feedCount(db)
            const revAfterFirst = yield* sessionRev(db)
            const second = yield* SessionOperation.tryTransitionPromptTerminal(db, SID as any, rec)
            expect(second.applied).toBe(false)
            expect(yield* feedCount(db)).toBe(feedsAfterFirst)
            expect(yield* sessionRev(db)).toBe(revAfterFirst)
            const row = yield* opRow(db, opId)
            expect(row["recovery_budget"]).toBe(0)
            expect(row["recovery_next_at"]).toBeNull()
            expect(row["recovery_provenance"]).toBe("terminal")
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("crash converge rerun no-op: no duplicate feed/revision", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const opId = SessionOperation.promptId("msg_guard00000000000012")
            yield* SessionOperation.ensurePromptInFlight(db, SID as any, opId)
            const first = yield* SessionOperation.convergeOrphanedInFlight(db)
            expect(first.converged).toContain(opId)
            const feedsAfterFirst = yield* feedCount(db)
            const rerun = yield* SessionOperation.convergeOrphanedInFlight(db)
            expect(rerun.converged).toEqual([])
            expect(rerun.raced).toEqual([])
            expect(yield* feedCount(db)).toBe(feedsAfterFirst)
            const row = yield* opRow(db, opId)
            expect(row["outcome"]).toBe("abandoned")
            expect(row["recovery_budget"]).toBe(0)
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })

  test("panel projection redacted: no detail/stack/raw leak", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dbLayer = Database.layerNoLease(":memory:")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* ensureSession(db)
            const opId = SessionOperation.promptId("msg_guard00000000000013")
            yield* SessionOperation.ensurePromptInFlight(db, SID as any, opId)
            const rec = SessionOperation.generationTerminal({
              opId,
              outcome: "failed",
              code: "prompt.failed",
              message: "boom api_key=live-secret",
              detail: "diagnostic password=live-secret",
            })
            const withStack: SessionOperation.FailureRecord = { ...rec, stack: "stack token=live-secret" }
            const res = yield* SessionOperation.tryTransitionPromptTerminal(db, SID as any, withStack)
            expect(res.applied).toBe(true)
            const deps = createSessionOperationsDeps(db)
            const found = yield* Effect.promise(() => deps.operations({ directory: DIR, sessionId: SID }))
            if (found.status !== "found") throw new Error("expected found")
            const entry = found.operations.find((o) => o.opId === opId)!
            expect(entry).toBeDefined()
            const wire = JSON.stringify(entry)
            expect(wire).not.toContain("live-secret")
            expect(wire).not.toContain("detail")
            expect(wire).not.toContain("stack")
            // unattributable prompt (no generation member/receipt) omits recovery rather than a placeholder budget
            expect(Object.keys(entry).sort()).toEqual(["code", "message", "opId", "outcome", "time"].sort())
            expect("recovery" in entry).toBe(false)
          }).pipe(Effect.provide(Layer.mergeAll(dbLayer)))
        }),
      ),
    )
  })
})
