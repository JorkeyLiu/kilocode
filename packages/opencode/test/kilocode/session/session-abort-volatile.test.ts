// Volatile abort regression coverage.
//
// The current `POST /session/:sessionID/abort` contract is intentionally
// volatile: the handler calls `promptSvc.cancel(sessionID)` and returns
// boolean `true` with no durable operation row and no revision advance.
// This file pins that behavior over real HTTP (the shared `httpApiLayer`
// server used by `test/server/session-actions.test.ts`, whose layer tree
// shares the memoized `Database` instance with the test body so revision
// and operation-table assertions observe the same state the handlers wrote)
// without adding durable abort semantics.
//
// Busy-session transition is explicitly NOT proven here: no reliable
// HTTP-level busy prompt/shell fixture exists (the existing shell-busy
// coverage in `test/session/prompt.test.ts` drives `SessionPrompt` directly,
// not HTTP), and inventing provider mocks or timing-sensitive infrastructure
// for this file is out of scope.
import { afterEach, describe, expect, mock } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Session as SessionNs } from "@/session/session"
import { SessionID } from "@/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { httpApiLayer, requestInDirectory } from "../../server/httpapi-layer"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

function revisionOf(db: Database.Interface["db"], id: SessionID) {
  return db
    .select({ rev: SessionTable.revision })
    .from(SessionTable)
    .where(eq(SessionTable.id, id))
    .get()
    .pipe(Effect.orDie)
    .pipe(Effect.map((row) => row!.rev))
}

function opKindsFor(db: Database.Interface["db"], id: SessionID) {
  return db
    .select({ kind: SessionOperationTable.op_kind })
    .from(SessionOperationTable)
    .where(eq(SessionOperationTable.session_id, id))
    .all()
    .pipe(Effect.orDie)
    .pipe(Effect.map((rows) => rows.map((row) => row.kind as string)))
}

function createSession(directory: string, title: string) {
  return Effect.gen(function* () {
    const created = yield* requestInDirectory("/session", directory, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    })
    expect(created.status).toBe(200)
    return (yield* created.json) as SessionNs.Info
  })
}

function abortSession(directory: string, id: SessionID) {
  return Effect.gen(function* () {
    const res = yield* requestInDirectory(`/session/${id}/abort`, directory, { method: "POST" })
    expect(res.status).toBe(200)
    return (yield* res.json) as unknown
  })
}

describe("volatile session abort", () => {
  it.instance("idle abort returns true without durable writes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const session = yield* createSession(test.directory, "abort-volatile-idle")

      const before = yield* revisionOf(db, session.id)
      expect(yield* opKindsFor(db, session.id)).toEqual([])

      expect(yield* abortSession(test.directory, session.id)).toBe(true)

      expect(yield* revisionOf(db, session.id)).toBe(before)
      const kinds = yield* opKindsFor(db, session.id)
      expect(kinds).toEqual([])
      expect(kinds.includes("abort")).toBe(false)

      yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
    }),
    { git: true },
  )

  it.instance("missing session abort returns true without durable writes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const missing = SessionID.make("ses_99999999999999999999999999")

      expect(yield* abortSession(test.directory, missing)).toBe(true)
      expect(yield* opKindsFor(db, missing)).toEqual([])
    }),
    { git: true },
  )

  // Idle fixture only: pins no durable revision/operation writes to a sibling.
  // Volatile runtime cancellation isolation is not covered here.
  it.instance("aborting one idle session does not durably mutate a sibling session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const first = yield* createSession(test.directory, "abort-volatile-first")
      const second = yield* createSession(test.directory, "abort-volatile-second")
      const revFirstBefore = yield* revisionOf(db, first.id)
      const revSecondBefore = yield* revisionOf(db, second.id)

      expect(yield* abortSession(test.directory, first.id)).toBe(true)

      expect(yield* revisionOf(db, first.id)).toBe(revFirstBefore)
      expect(yield* revisionOf(db, second.id)).toBe(revSecondBefore)
      expect(yield* opKindsFor(db, first.id)).toEqual([])
      expect(yield* opKindsFor(db, second.id)).toEqual([])

      const fetched = yield* requestInDirectory(`/session/${second.id}`, test.directory)
      expect(fetched.status).toBe(200)
      expect(((yield* fetched.json) as SessionNs.Info).id).toBe(second.id)

      yield* SessionNs.Service.use((svc) => svc.remove(first.id).pipe(Effect.ignore))
      yield* SessionNs.Service.use((svc) => svc.remove(second.id).pipe(Effect.ignore))
    }),
    { git: true },
  )
})
