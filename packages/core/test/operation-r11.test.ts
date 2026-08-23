import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { sql, eq } from "drizzle-orm"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import * as Retention from "@opencode-ai/core/retention/retention"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions),
)

const location = { directory: AbsolutePath.make("/project") }

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

function sampleRecord(
  opId: string,
  opKind: SessionOperation.OpKind,
  outcome: SessionOperation.Outcome = "failed",
): SessionOperation.FailureRecord {
  return {
    opId,
    opKind,
    outcome,
    code: "provider.unknown",
    message: "msg",
    time: Date.now(),
  }
}

describe("R11 operation record foundation", () => {
  it.effect("migration creates session_operation with FK cascade and checks and indexes and rerunnable", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const table = yield* db
        .get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='session_operation'`)
        .pipe(Effect.orDie)
      expect(table).toBeDefined()
      expect(table!.name).toBe("session_operation")
      const ddl = yield* db
        .get<{ sql: string }>(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`)
        .pipe(Effect.orDie)
      expect(ddl!.sql).toContain("REFERENCES")
      expect(ddl!.sql).toContain("ON DELETE CASCADE")
      expect(ddl!.sql).toContain("CHECK")
      // indexes
      const idx = yield* db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_operation'`)
        .pipe(Effect.orDie)
      const names = idx.map((r) => r.name)
      expect(names).toContain("session_operation_session_idx")
      expect(names).toContain("session_operation_session_kind_idx")
      expect(names).toContain("session_operation_session_time_idx")
      // check constraints enforcement: invalid op_kind should fail
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const badKind = {
        opId: SessionOperation.promptId("msg_bad_kind"),
        opKind: "bad" as unknown as SessionOperation.OpKind,
        outcome: "failed" as const,
        code: "c",
        message: "m",
        time: Date.now(),
      } as unknown as SessionOperation.FailureRecord
      const exitBadKind = yield* SessionOperation.put(db, s.id, badKind).pipe(Effect.exit)
      expect(exitBadKind._tag).toBe("Failure")
      // invalid outcome should fail without advancing revision
      const revBefore = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(revBefore!.rev).toBe(0)
      const badOutcome = {
        opId: SessionOperation.promptId("msg_bad_out"),
        opKind: "prompt" as const,
        outcome: "bad" as unknown as SessionOperation.Outcome,
        code: "c",
        message: "m",
        time: Date.now(),
      } as unknown as SessionOperation.FailureRecord
      const exitBadOut = yield* SessionOperation.put(db, s.id, badOutcome).pipe(Effect.exit)
      expect(exitBadOut._tag).toBe("Failure")
      const revAfter = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(revAfter!.rev).toBe(0)
      // DB CHECK directly: raw insert with invalid kind should be rejected
      const rawBad = yield* db
        .run(
          sql`INSERT INTO session_operation (op_id, session_id, op_kind, outcome, code, message, time, revision) VALUES ('op_raw_bad', ${s.id}, 'invalid', 'failed', 'c', 'm', 1, 0)`,
        )
        .pipe(Effect.exit)
      expect(rawBad._tag).toBe("Failure")
    }),
  )

  it.effect("drizzle declares op_kind and outcome CHECKs matching migration", () =>
    Effect.gen(function* () {
      const cfg = getTableConfig(SessionOperationTable)
      expect(cfg.checks.length).toBe(2)
      const byName = Object.fromEntries(cfg.checks.map((c) => [c.name, c] as const))
      expect(byName["session_operation_op_kind_check"]).toBeDefined()
      expect(byName["session_operation_outcome_check"]).toBeDefined()
      const reconstruct = (c: any) =>
        (c.value.queryChunks as any[]).map((ch: any) => (ch.name ? `"${ch.name}"` : (ch.value?.[0] ?? ""))).join("")
      expect(reconstruct(byName["session_operation_op_kind_check"])).toBe(
        `"op_kind" IN ('prompt','provider','tool','permission','task')`,
      )
      expect(reconstruct(byName["session_operation_outcome_check"])).toBe(
        `"outcome" IN ('succeeded','failed','ambiguous','in-flight','superseded','abandoned')`,
      )
    }),
  )

  it.effect("identity constructors stable and validate attempt and colon rules", () =>
    Effect.gen(function* () {
      expect(SessionOperation.promptId("msg_123")).toBe("prompt:msg_123")
      expect(SessionOperation.promptId("msg_123")).toBe(SessionOperation.promptId("msg_123"))
      expect(SessionOperation.providerId("msg_a", 0)).toBe("provider:msg_a:0")
      expect(SessionOperation.providerId("msg_a", 12)).toBe("provider:msg_a:12")
      expect(SessionOperation.toolId("msg_a", "call_1")).toBe("tool:msg_a:call_1")
      expect(SessionOperation.permissionId("req_1")).toBe("permission:req_1")
      expect(SessionOperation.taskId("ses_abc")).toBe("task:ses_abc")
      expect(SessionOperation.taskId("ses_abc", "call_9")).toBe("task:ses_abc:call_9")
      // nonnegative attempt
      expect(() => SessionOperation.providerId("msg_a", -1)).toThrow()
      expect(() => SessionOperation.providerId("msg_a", 1.5)).toThrow()
      expect(() => SessionOperation.providerId("msg_a", NaN as number)).toThrow()
      // colon rejection
      expect(() => SessionOperation.promptId("bad:colon")).toThrow()
      expect(() => SessionOperation.toolId("msg_a", "bad:colon")).toThrow()
      expect(() => SessionOperation.permissionId("bad:colon")).toThrow()
      expect(() => SessionOperation.taskId("ses_abc", "bad:colon")).toThrow()
      // empty rejection
      expect(() => SessionOperation.promptId("")).toThrow()
      expect(() => SessionOperation.providerId("", 0)).toThrow()
      // parse validation: cross-kind mismatch
      const { db } = yield* Database.Service
      yield* setup
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const rec: SessionOperation.FailureRecord = {
        opId: SessionOperation.promptId("msg_x"),
        opKind: "provider",
        outcome: "failed",
        code: "c",
        message: "m",
        time: Date.now(),
      }
      const exit = yield* SessionOperation.put(db, s.id, rec).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      // provider attempt must be integer in opId
      const badProviderId = "provider:msg_a:notanint"
      const rec2 = {
        opId: badProviderId,
        opKind: "provider" as const,
        outcome: "failed" as const,
        code: "c",
        message: "m",
        time: Date.now(),
      }
      const exit2 = yield* SessionOperation.put(db, s.id, rec2 as unknown as SessionOperation.FailureRecord).pipe(
        Effect.exit,
      )
      expect(exit2._tag).toBe("Failure")
    }),
  )

  it.effect("validates five kinds exactly and rejects config kind", () =>
    Effect.gen(function* () {
      expect([...SessionOperation.OP_KINDS]).toEqual(["prompt", "provider", "tool", "permission", "task"])
      const { db } = yield* Database.Service
      yield* setup
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      for (const kind of SessionOperation.OP_KINDS) {
        let opId: string
        if (kind === "prompt") opId = SessionOperation.promptId(`msg_${kind}`)
        else if (kind === "provider") opId = SessionOperation.providerId(`msg_${kind}`, 0)
        else if (kind === "tool") opId = SessionOperation.toolId(`msg_${kind}`, `call_${kind}`)
        else if (kind === "permission") opId = SessionOperation.permissionId(`req_${kind}`)
        else opId = SessionOperation.taskId(`ses_${kind}`)
        const rec: SessionOperation.FailureRecord = {
          opId,
          opKind: kind,
          outcome: "failed",
          code: "c",
          message: "m",
          time: Date.now(),
        }
        const put = yield* SessionOperation.put(db, s.id, rec)
        expect(put.opId).toBe(opId)
        expect(put.opKind).toBe(kind)
      }
      // config is not a valid opKind — should throw
      const bad: unknown = {
        opId: "config:foo",
        opKind: "config",
        outcome: "failed",
        code: "c",
        message: "m",
        time: Date.now(),
      }
      expect(() => SessionOperation.validateRecord(bad)).toThrow()
    }),
  )

  it.effect("redacted full-record round trip via persist projection", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_redacted")
      // simulate redacted persist: message already scrubbed, detail/stack redacted
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "provider.http",
        message: "apiKey=[redacted] keep",
        time: 1234567890,
        detail: "detail with token=[redacted]",
        stack: "stack with secret=[redacted]",
        cancel: { source: "timeout" },
      }
      const stored = yield* SessionOperation.put(db, s.id, rec)
      expect(stored.message).toBe("apiKey=[redacted] keep")
      expect(stored.detail).toBe("detail with token=[redacted]")
      expect(stored.stack).toBe("stack with secret=[redacted]")
      const fetched = yield* SessionOperation.get(db, opId)
      expect(fetched).toEqual(rec)
      const listed = yield* SessionOperation.list(db, s.id)
      expect(listed.length).toBe(1)
      expect(listed[0]).toEqual(rec)
      // verify DB columns inspectable
      const row = yield* db
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, opId))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeDefined()
      expect(row!.op_kind).toBe("prompt")
      expect(row!.outcome).toBe("failed")
      expect(row!.time).toBe(1234567890)
      expect(row!.revision).toBeGreaterThan(0)
      expect(row!.session_id).toBe(s.id)
      expect(row!.cancel).toBe("timeout")
      // round-trip preserves cancel source
      expect(row!.cancel).toBe("timeout")
    }),
  )

  it.effect("atomic transaction proves row+revision+changed feed together", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const beforeRev = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(beforeRev!.rev).toBe(0)
      const beforeFeed = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      const beforeFeedCount = beforeFeed.length
      const beforeState = yield* Changefeed.getState(db)
      const opId = SessionOperation.providerId("msg_atom", 0)
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "provider",
        outcome: "in-flight",
        code: "provider.unknown",
        message: "start",
        time: Date.now(),
      }
      const stored = yield* SessionOperation.put(db, s.id, rec)
      expect(stored.opId).toBe(opId)
      const afterRev = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(afterRev!.rev).toBe(1)
      const afterFeed = yield* db
        .select()
        .from(SessionChangefeedTable)
        .orderBy(sql`${SessionChangefeedTable.seq} ASC`)
        .all()
        .pipe(Effect.orDie)
      expect(afterFeed.length).toBe(beforeFeedCount + 1)
      const last = afterFeed[afterFeed.length - 1]!
      expect(last.session_id).toBe(s.id)
      expect(last.revision).toBe(1)
      expect(last.kind).toBe("changed")
      expect(Object.keys(last).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
      const state = yield* Changefeed.getState(db)
      expect(state.latest_seq).toBe(last.seq)
      expect(state.retained_rows).toBe(beforeState.retained_rows + 1)
      // operation row revision matches session revision
      const opRow = yield* db
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, opId))
        .get()
        .pipe(Effect.orDie)
      expect(opRow!.revision).toBe(1)
    }),
  )

  it.effect("idempotent replay does not advance revision or feed", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.toolId("msg_idem", "call_1")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "tool",
        outcome: "in-flight",
        code: "tool.failed",
        message: "run",
        time: 1000,
      }
      const first = yield* SessionOperation.put(db, s.id, rec)
      const rev1 = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      const feed1 = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s.id))
        .all()
        .pipe(Effect.orDie)
      expect(feed1.length).toBe(1)
      const second = yield* SessionOperation.put(db, s.id, rec)
      expect(second).toEqual(first)
      const rev2 = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(rev2!.rev).toBe(rev1!.rev)
      const feed2 = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s.id))
        .all()
        .pipe(Effect.orDie)
      expect(feed2.length).toBe(1)
      expect(feed2[0]!.revision).toBe(rev1!.rev)
    }),
  )

  it.effect("rejected cross-kind and cross-identity conflicts do not advance revision or feed", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const s2 = yield* svc.create({ location })
      const opId = SessionOperation.permissionId("req_conflict")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "permission",
        outcome: "failed",
        code: "permission.denied",
        message: "denied",
        time: 1000,
      }
      yield* SessionOperation.put(db, s.id, rec)
      const revBefore = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      const feedBefore = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s.id))
        .all()
        .pipe(Effect.orDie)
      expect(feedBefore.length).toBe(1)
      // cross-kind: same opId but different opKind
      const badKindRec = { ...rec, opKind: "prompt" as const }
      const exitKind = yield* SessionOperation.put(
        db,
        s.id,
        badKindRec as unknown as SessionOperation.FailureRecord,
      ).pipe(Effect.exit)
      expect(exitKind._tag).toBe("Failure")
      const revAfterKind = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(revAfterKind!.rev).toBe(revBefore!.rev)
      const feedAfterKind = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s.id))
        .all()
        .pipe(Effect.orDie)
      expect(feedAfterKind.length).toBe(1)
      // cross-identity: same opId owned by s, try to put in s2
      const exitIdentity = yield* SessionOperation.put(db, s2.id, rec).pipe(Effect.exit)
      expect(exitIdentity._tag).toBe("Failure")
      const revS2Before = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s2.id))
        .get()
        .pipe(Effect.orDie)
      expect(revS2Before!.rev).toBe(0)
      const feedS2 = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s2.id))
        .all()
        .pipe(Effect.orDie)
      expect(feedS2.length).toBe(0)
      // ensure original still intact
      const got = yield* SessionOperation.get(db, opId)
      expect(got).toEqual(rec)
    }),
  )

  it.effect("terminal outcome cannot regress to in-flight", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_terminal")
      const recTerminal: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "provider.http",
        message: "err",
        time: 1000,
      }
      yield* SessionOperation.put(db, s.id, recTerminal)
      const revBefore = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      const inFlightRec: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "in-flight",
        code: "provider.http",
        message: "err",
        time: 2000,
      }
      const exit = yield* SessionOperation.put(db, s.id, inFlightRec).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const revAfter = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(revAfter!.rev).toBe(revBefore!.rev)
      const feed = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s.id))
        .all()
        .pipe(Effect.orDie)
      expect(feed.length).toBe(1)
      const got = yield* SessionOperation.get(db, opId)
      expect(got!.outcome).toBe("failed")
    }),
  )

  it.effect(
    "narrowest transition: in-flight -> terminal allowed, terminal->terminal rejected unless identical, in-flight->in-flight identical only",
    () =>
      Effect.gen(function* () {
        yield* setup
        const svc = yield* SessionV2.Service
        const { db } = yield* Database.Service
        const s = yield* svc.create({ location })
        const opId = SessionOperation.providerId("msg_narrow", 0)
        const inFlight: SessionOperation.FailureRecord = {
          opId,
          opKind: "provider",
          outcome: "in-flight",
          code: "provider.unknown",
          message: "start",
          time: 1000,
        }
        yield* SessionOperation.put(db, s.id, inFlight)
        const rev1 = yield* db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, s.id))
          .get()
          .pipe(Effect.orDie)
        expect(rev1!.rev).toBe(1)
        // in-flight -> in-flight identical should be idempotent (no advance)
        const inFlightDup = { ...inFlight }
        const dup = yield* SessionOperation.put(db, s.id, inFlightDup)
        expect(dup.outcome).toBe("in-flight")
        const revDup = yield* db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, s.id))
          .get()
          .pipe(Effect.orDie)
        expect(revDup!.rev).toBe(1)
        // in-flight -> in-flight with different message should be rejected
        const inFlightDiff: SessionOperation.FailureRecord = { ...inFlight, message: "different", time: 2000 }
        const exitDiff = yield* SessionOperation.put(db, s.id, inFlightDiff).pipe(Effect.exit)
        expect(exitDiff._tag).toBe("Failure")
        const revAfterDiff = yield* db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, s.id))
          .get()
          .pipe(Effect.orDie)
        expect(revAfterDiff!.rev).toBe(1)
        // in-flight -> terminal allowed and advances
        const terminal: SessionOperation.FailureRecord = {
          opId,
          opKind: "provider",
          outcome: "succeeded",
          code: "provider.unknown",
          message: "done",
          time: 3000,
        }
        const termStored = yield* SessionOperation.put(db, s.id, terminal)
        expect(termStored.outcome).toBe("succeeded")
        const rev2 = yield* db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, s.id))
          .get()
          .pipe(Effect.orDie)
        expect(rev2!.rev).toBe(2)
        // terminal -> terminal different message should be rejected (narrowest)
        const terminalDiff: SessionOperation.FailureRecord = { ...terminal, message: "other", time: 4000 }
        const exitTermDiff = yield* SessionOperation.put(db, s.id, terminalDiff).pipe(Effect.exit)
        expect(exitTermDiff._tag).toBe("Failure")
        const revAfterTermDiff = yield* db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, s.id))
          .get()
          .pipe(Effect.orDie)
        expect(revAfterTermDiff!.rev).toBe(2)
        // terminal -> terminal identical should be idempotent
        const termDup = yield* SessionOperation.put(db, s.id, terminal)
        expect(termDup.outcome).toBe("succeeded")
        const revTermDup = yield* db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, s.id))
          .get()
          .pipe(Effect.orDie)
        expect(revTermDup!.rev).toBe(2)
      }),
  )

  it.effect("deterministic read ordering and payload-free changefeed on success", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const ids = [
        SessionOperation.promptId("msg_z"),
        SessionOperation.taskId("ses_a"),
        SessionOperation.permissionId("req_m"),
      ]
      for (const opId of ids) {
        const kind = SessionOperation.parseOpId(opId).kind
        const rec: SessionOperation.FailureRecord = {
          opId,
          opKind: kind,
          outcome: "failed",
          code: "c",
          message: "m",
          time: Date.now(),
        }
        yield* SessionOperation.put(db, s.id, rec)
      }
      const listed = yield* SessionOperation.list(db, s.id)
      expect(listed.length).toBe(3)
      const listedIds = listed.map((r) => r.opId)
      const sorted = [...ids].sort()
      expect(listedIds).toEqual(sorted)
      const feed = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s.id))
        .all()
        .pipe(Effect.orDie)
      expect(feed.length).toBe(3)
      for (const row of feed) {
        expect(Object.keys(row).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
      }
      // revisions monotonic 1,2,3
      const revs = feed.map((r) => r.revision).sort((a, b) => a - b)
      expect(revs).toEqual([1, 2, 3])
    }),
  )

  it.effect("family cascade deletes operation rows but retains deleted tombstone and changefeed", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const root = yield* svc.create({ location })
      const child = yield* svc.create({ location })
      yield* db
        .update(SessionTable)
        .set({ parent_id: root.id })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      const opRoot: SessionOperation.FailureRecord = {
        opId: SessionOperation.promptId("msg_root"),
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "m",
        time: Date.now(),
      }
      const opChild: SessionOperation.FailureRecord = {
        opId: SessionOperation.taskId(child.id),
        opKind: "task",
        outcome: "failed",
        code: "c",
        message: "m",
        time: Date.now(),
      }
      yield* SessionOperation.put(db, root.id, opRoot)
      yield* SessionOperation.put(db, child.id, opChild)
      let opsRoot = yield* SessionOperation.list(db, root.id)
      expect(opsRoot.length).toBe(1)
      let opsChild = yield* SessionOperation.list(db, child.id)
      expect(opsChild.length).toBe(1)
      // make eligible
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, root.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      const fam = { rootID: root.id, sessionIDs: [root.id, child.id], activity: 0 }
      yield* Retention.deleteFamilyTransaction(
        db,
        fam,
        Date.now(),
        () => false,
        () => false,
      )
      // operation rows gone via cascade
      const stillRoot = yield* db
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.session_id, root.id))
        .all()
        .pipe(Effect.orDie)
      expect(stillRoot.length).toBe(0)
      const stillChild = yield* db
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.session_id, child.id))
        .all()
        .pipe(Effect.orDie)
      expect(stillChild.length).toBe(0)
      // session rows gone
      const r1 = yield* db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get().pipe(Effect.orDie)
      expect(r1).toBeUndefined()
      const r2 = yield* db.select().from(SessionTable).where(eq(SessionTable.id, child.id)).get().pipe(Effect.orDie)
      expect(r2).toBeUndefined()
      // changefeed tombstones remain (payload-free deleted) plus earlier changed rows
      const feed = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      // at least: 2 changed from operations + 2 deleted tombstones =4, plus any earlier
      const dels = feed.filter((r) => r.kind === "deleted")
      expect(dels.length).toBe(2)
      for (const d of dels) expect(d.revision).toBeGreaterThan(0)
    }),
  )

  it.effect("transaction rollback leaves revision and feed unchanged on conflict", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.toolId("msg_rb", "call_rb")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "tool",
        outcome: "in-flight",
        code: "tool.failed",
        message: "start",
        time: 1000,
      }
      yield* SessionOperation.put(db, s.id, rec)
      const revBefore = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      const feedBefore = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s.id))
        .all()
        .pipe(Effect.orDie)
      const stateBefore = yield* Changefeed.getState(db)
      // attempt conflicting update: terminal vs terminal different
      const terminal: SessionOperation.FailureRecord = {
        opId,
        opKind: "tool",
        outcome: "succeeded",
        code: "tool.failed",
        message: "done",
        time: 2000,
      }
      yield* SessionOperation.put(db, s.id, terminal)
      const revAfterFirst = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(revAfterFirst!.rev).toBe(revBefore!.rev + 1)
      // now try to change terminal again — should fail and rollback
      const bad: SessionOperation.FailureRecord = { ...terminal, message: "other", time: 3000 }
      const exit = yield* SessionOperation.put(db, s.id, bad).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const revAfterBad = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(revAfterBad!.rev).toBe(revAfterFirst!.rev)
      const feedAfter = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, s.id))
        .all()
        .pipe(Effect.orDie)
      expect(feedAfter.length).toBe(feedBefore.length + 1) // terminal put only, bad is rejected
      const stateAfter = yield* Changefeed.getState(db)
      expect(stateAfter.latest_seq).toBe(stateBefore.latest_seq + 1)
    }),
  )

  it.effect("retention eligibility respects 7-day and active/leased protections with operation rows", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const root = yield* svc.create({ location })
      const child = yield* svc.create({ location })
      yield* db
        .update(SessionTable)
        .set({ parent_id: root.id })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      const op: SessionOperation.FailureRecord = {
        opId: SessionOperation.promptId("msg_ret"),
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "m",
        time: Date.now(),
      }
      yield* SessionOperation.put(db, root.id, op)
      const now = Date.now()
      // recent activity protects
      yield* db
        .update(SessionTable)
        .set({ time_updated: now - 1000 })
        .where(eq(SessionTable.id, root.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: now - 1000 })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      const { eligible: eligibleRecent } = yield* Retention.eligibleFamilies(
        db,
        now,
        () => false,
        () => false,
      )
      expect(eligibleRecent.find((f) => f.rootID === root.id)).toBeUndefined()
      // make old but active leased should still protect
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, root.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      const { eligible: eligibleLeased } = yield* Retention.eligibleFamilies(
        db,
        now,
        () => false,
        (id) => id === root.id,
      )
      expect(eligibleLeased.find((f) => f.rootID === root.id)).toBeUndefined()
      // old and not leased should be eligible even with operation rows
      const { eligible } = yield* Retention.eligibleFamilies(
        db,
        now,
        () => false,
        () => false,
      )
      expect(eligible.find((f) => f.rootID === root.id)).toBeDefined()
    }),
  )
})
