import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
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

describe("P4.2 persistence/projection redaction boundary", () => {
  it.effect("manually supplied secret-bearing record is scrubbed before persistence", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_secret")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "provider.unknown",
        message: "call failed apiKey=sk-123456 secret token=abc123",
        time: Date.now(),
        detail: "detail password=superSecret credential=mycred authorization=BearerXYZ",
        stack: "at foo token=stackSecret",
      }
      const stored = yield* SessionOperation.put(db, s.id, rec)
      // message/detail/stack must not contain raw secrets
      expect(stored.message).not.toContain("sk-123456")
      expect(stored.message).not.toContain("abc123")
      expect(stored.message).toContain("apiKey=[redacted]")
      expect(stored.message).toContain("token=[redacted]")
      expect(stored.detail).not.toContain("superSecret")
      expect(stored.detail).not.toContain("mycred")
      expect(stored.detail).not.toContain("BearerXYZ")
      expect(stored.detail).toContain("password=[redacted]")
      expect(stored.detail).toContain("credential=[redacted]")
      expect(stored.detail).toContain("authorization=[redacted]")
      expect(stored.stack).not.toContain("stackSecret")
      expect(stored.stack).toContain("token=[redacted]")

      // DB row must also be scrubbed
      const row = yield* db
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, opId))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeDefined()
      expect(row!.message).toBe(stored.message)
      expect(row!.detail ?? undefined).toBe(stored.detail)
      expect(row!.stack ?? undefined).toBe(stored.stack)
      expect(row!.message).not.toContain("sk-123456")
      // get returns scrubbed too
      const fetched = yield* SessionOperation.get(db, opId)
      expect(fetched).toEqual(stored)
      // list also
      const listed = yield* SessionOperation.list(db, s.id)
      expect(listed[0]).toEqual(stored)
    }),
  )

  it.effect("scrubs quoted key values and full bearer authorization credentials before persistence", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_quoted_bearer")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "provider.unknown",
        message: 'call failed apiKey="sk-live" and secret: "raw" check',
        time: Date.now(),
        detail: "detail authorization: Bearer sk-live token leak",
        stack: "stack secret='single-quoted' and password=\"double-quoted\" tail",
      }
      const stored = yield* SessionOperation.put(db, s.id, rec)
      expect(stored.message).not.toContain("sk-live")
      expect(stored.message).not.toContain("raw")
      expect(stored.message).toContain("apiKey=[redacted]")
      expect(stored.message).toContain("secret=[redacted]")
      expect(stored.detail).not.toContain("sk-live")
      expect(stored.detail).toBe("detail authorization=[redacted] token leak")
      expect(stored.detail).not.toContain("Bearer")
      expect(stored.stack).not.toContain("single-quoted")
      expect(stored.stack).not.toContain("double-quoted")
      expect(stored.stack).toContain("secret=[redacted]")
      expect(stored.stack).toContain("password=[redacted]")

      const row = yield* db
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, opId))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeDefined()
      expect(row!.message).toBe(stored.message)
      expect(row!.detail ?? undefined).toBe(stored.detail)
      expect(row!.stack ?? undefined).toBe(stored.stack)
      expect(row!.message).not.toContain("sk-live")
      expect(row!.detail).not.toContain("sk-live")
      expect(row!.detail).not.toContain("Bearer")

      // bearer with equals and without space variant still redacted (unquoted)
      const opId2 = SessionOperation.promptId("msg_bearer_eq")
      const rec2: SessionOperation.FailureRecord = {
        opId: opId2,
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "auth authorization=BearerXYZ leak",
        time: Date.now(),
      }
      const stored2 = yield* SessionOperation.put(db, s.id, rec2)
      expect(stored2.message).not.toContain("BearerXYZ")
      expect(stored2.message).toBe("auth authorization=[redacted] leak")

      // already-redacted idempotency for quoted and bearer
      const recQuotedRedacted: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "provider.unknown",
        message: "call failed apiKey=[redacted] and secret=[redacted] check",
        time: rec.time,
        detail: "detail authorization=[redacted] token leak",
        stack: "stack secret=[redacted] and password=[redacted] tail",
      }
      const normalized = SessionOperation.normalizeRecord(rec)
      const normalizedRedacted = SessionOperation.normalizeRecord(recQuotedRedacted)
      expect(normalized.message).toBe(normalizedRedacted.message)
      expect(normalized.detail).toBe(normalizedRedacted.detail)
      expect(normalized.stack).toBe(normalizedRedacted.stack)
    }),
  )

  it.effect("caps match contract 500/1000/2000 with trailing ellipsis", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const longMsg = "a".repeat(600)
      const longDetail = "b".repeat(1500)
      const longStack = "c".repeat(2500)
      const opId = SessionOperation.toolId("msg_caps", "call_caps")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "tool",
        outcome: "failed",
        code: "tool.failed",
        message: longMsg,
        time: Date.now(),
        detail: longDetail,
        stack: longStack,
      }
      const stored = yield* SessionOperation.put(db, s.id, rec)
      expect(stored.message.length).toBe(501) // 500 + ellipsis
      expect(stored.message).toBe("a".repeat(500) + "…")
      expect(stored.detail!.length).toBe(1001)
      expect(stored.detail).toBe("b".repeat(1000) + "…")
      expect(stored.stack!.length).toBe(2001)
      expect(stored.stack).toBe("c".repeat(2000) + "…")

      // exact boundary: 500 stays not truncated
      const opId2 = SessionOperation.promptId("msg_exact")
      const exactMsg = "x".repeat(500)
      const rec2: SessionOperation.FailureRecord = {
        opId: opId2,
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: exactMsg,
        time: Date.now(),
      }
      const stored2 = yield* SessionOperation.put(db, s.id, rec2)
      expect(stored2.message).toBe(exactMsg)
      expect(stored2.message.length).toBe(500)

      // scrub then cap: secret scrub shortens? but cap after scrub
      const opId3 = SessionOperation.permissionId("req_cap_scrub")
      const msgWithSecret = "apiKey=" + "k".repeat(600) + " end"
      const rec3: SessionOperation.FailureRecord = {
        opId: opId3,
        opKind: "permission",
        outcome: "failed",
        code: "permission.denied",
        message: msgWithSecret,
        time: Date.now(),
      }
      const stored3 = yield* SessionOperation.put(db, s.id, rec3)
      // after scrub, message becomes "apiKey=[redacted] end" which is short, so no cap to 500
      // but ensure scrubbed not raw
      expect(stored3.message).not.toContain("k".repeat(10))
      expect(stored3.message).toBe("apiKey=[redacted] end")
    }),
  )

  it.effect("panel projection excludes diagnostic detail/stack and is redacted", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.providerId("msg_panel", 0)
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "provider",
        outcome: "failed",
        code: "provider.http",
        message: "apiKey=secret123 hello",
        time: Date.now(),
        detail: "detail token=abc detailBody",
        stack: "stack password=xyz",
        cancel: { source: "timeout" },
      }
      const stored = yield* SessionOperation.put(db, s.id, rec)
      // stored is redacted
      expect(stored.message).toBe("apiKey=[redacted] hello")
      // panel projection via core helper
      const panel = SessionOperation.toPanelRecord(rec)
      expect(panel.opId).toBe(opId)
      expect(panel.message).toBe("apiKey=[redacted] hello")
      expect(panel.detail).toBeUndefined()
      expect(panel.stack).toBeUndefined()
      // ensure opKind/time excluded? opKind is durable not panel-visible, so excluded from panel
      expect((panel as Record<string, unknown>)["opKind"]).toBeUndefined()
      expect((panel as Record<string, unknown>)["time"]).toBeUndefined()
      // panel-visible fields remain
      expect(panel.outcome).toBe("failed")
      expect(panel.code).toBe("provider.http")
      expect(panel.cancel).toEqual({ source: "timeout" })

      // toPanelRecord on stored also excludes diagnostic
      const panel2 = SessionOperation.toPanelRecord(stored)
      expect(panel2.detail).toBeUndefined()
      expect(panel2.stack).toBeUndefined()

      // persist tier retains diagnostic but redacted
      const persisted = SessionOperation.toPersistedRecord(rec)
      expect(persisted.detail).toBe("detail token=[redacted] detailBody")
      expect(persisted.stack).toBe("stack password=[redacted]")

      // select with diagnose includes diagnostic + panel-visible, excludes durable opKind/time? Check FIELD_TIERS
      const diag = SessionOperation.toDiagnosticRecord(rec)
      expect(diag.detail).toBe("detail token=[redacted] detailBody")
      expect(diag.stack).toBe("stack password=[redacted]")
      expect(diag.message).toBe("apiKey=[redacted] hello")
      // diagnose excludes durable
      expect((diag as Record<string, unknown>)["opKind"]).toBeUndefined()

      // field tiers sanity
      expect(SessionOperation.FIELD_TIERS.detail).toBe("diagnostic")
      expect(SessionOperation.FIELD_TIERS.stack).toBe("diagnostic")
      expect(SessionOperation.FIELD_TIERS.message).toBe("panel-visible")
    }),
  )

  it.effect("normalizeRecord is idempotent and scrubbed equality preserves idempotency semantics", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_idem_scrub")
      const recA: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "apiKey=secretA",
        time: 1000,
      }
      const recB: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "apiKey=secretB",
        time: 1000,
      }
      // Both scrub to same redacted value, should be idempotent after first put
      const first = yield* SessionOperation.put(db, s.id, recA)
      expect(first.message).toBe("apiKey=[redacted]")
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
      const seq1 = feed1[0]!.seq
      const revSeq1 = feed1[0]!.revision
      expect(revSeq1).toBe(rev1!.rev)
      const second = yield* SessionOperation.put(db, s.id, recB)
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
      expect(feed2.length).toBe(feed1.length)
      expect(feed2[0]!.seq).toBe(seq1)
      expect(feed2[0]!.revision).toBe(revSeq1)
      // different scrubbed message should be conflict (terminal already)
      const recC: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "different",
        time: 1000,
      }
      const exit = yield* SessionOperation.put(db, s.id, recC).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect(
    "existing operation semantics intact after redaction: in-flight -> terminal, idempotent, terminal rejection",
    () =>
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service
        const svc = yield* SessionV2.Service
        const s = yield* svc.create({ location })
        const opId = SessionOperation.providerId("msg_sem", 0)
        const inflight: SessionOperation.FailureRecord = {
          opId,
          opKind: "provider",
          outcome: "in-flight",
          code: "provider.unknown",
          message: "start",
          time: 1000,
        }
        const stored1 = yield* SessionOperation.put(db, s.id, inflight)
        expect(stored1.outcome).toBe("in-flight")
        // idempotent in-flight
        const dup = yield* SessionOperation.put(db, s.id, inflight)
        expect(dup).toEqual(stored1)
        // in-flight -> terminal allowed even with secret
        const terminal: SessionOperation.FailureRecord = {
          opId,
          opKind: "provider",
          outcome: "failed",
          code: "provider.unknown",
          message: "failed apiKey=secret",
          time: 2000,
          detail: "detail secret=xyz",
        }
        const stored2 = yield* SessionOperation.put(db, s.id, terminal)
        expect(stored2.outcome).toBe("failed")
        expect(stored2.message).toBe("failed apiKey=[redacted]")
        expect(stored2.detail).toBe("detail secret=[redacted]")
        // terminal -> terminal identical normalized is idempotent
        const termDup = yield* SessionOperation.put(db, s.id, terminal)
        expect(termDup).toEqual(stored2)
        // terminal -> in-flight should still be rejected
        const inflight2: SessionOperation.FailureRecord = { ...inflight, time: 3000 }
        const exit = yield* SessionOperation.put(db, s.id, inflight2).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
  )

  it.effect("validateRecord still rejects unexpected keys and caps not bypass validation", () =>
    Effect.gen(function* () {
      const bad: unknown = {
        opId: SessionOperation.promptId("msg_bad"),
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "m",
        time: Date.now(),
        extra: "not allowed",
      }
      expect(() => SessionOperation.validateRecord(bad)).toThrow()
      // caps: long string still validates (validation does not check length)
      const long: unknown = {
        opId: SessionOperation.promptId("msg_long"),
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "a".repeat(10000),
        time: Date.now(),
      }
      expect(() => SessionOperation.validateRecord(long)).not.toThrow()
      const normalized = SessionOperation.normalizeRecord(long as SessionOperation.FailureRecord)
      expect(normalized.message.length).toBe(501)
    }),
  )

  it.effect("escaped quoted secret and bearer values are fully redacted without suffix leak", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_escaped_secret")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "prompt",
        outcome: "failed",
        code: "provider.unknown",
        message: 'prefix secret="foo\\"bar-secret" tail',
        time: Date.now(),
        detail: "detail secret='a\\'b-secret' tail2",
        stack: 'stack authorization: Bearer "tok\\"en-secret" tail3',
      }
      const stored = yield* SessionOperation.put(db, s.id, rec)
      expect(stored.message).toBe("prefix secret=[redacted] tail")
      expect(stored.message).not.toContain("bar-secret")
      expect(stored.message).not.toContain("foo")
      expect(stored.detail).toBe("detail secret=[redacted] tail2")
      expect(stored.detail).not.toContain("b-secret")
      expect(stored.detail).not.toContain("a\\'b")
      expect(stored.stack).toBe("stack authorization=[redacted] tail3")
      expect(stored.stack).not.toContain("tok")
      expect(stored.stack).not.toContain("en-secret")
      expect(stored.stack).not.toContain("Bearer")

      const row = yield* db
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, opId))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeDefined()
      expect(row!.message).toBe(stored.message)
      expect(row!.detail ?? undefined).toBe(stored.detail)
      expect(row!.stack ?? undefined).toBe(stored.stack)
      expect(row!.message).not.toContain("bar-secret")
      expect(row!.stack).not.toContain("tok")

      const opId2 = SessionOperation.promptId("msg_escaped_bearer_single")
      const rec2: SessionOperation.FailureRecord = {
        opId: opId2,
        opKind: "prompt",
        outcome: "failed",
        code: "c",
        message: "msg authorization: Bearer 'tok\\'en-secret' tail",
        time: Date.now(),
      }
      const stored2 = yield* SessionOperation.put(db, s.id, rec2)
      expect(stored2.message).toBe("msg authorization=[redacted] tail")
      expect(stored2.message).not.toContain("tok")
      expect(stored2.message).not.toContain("en-secret")
    }),
  )
})
