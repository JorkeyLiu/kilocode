import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Effect, Exit, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionDeleteTombstoneTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { Question } from "../../../src/question"
import { QuestionID } from "../../../src/question/schema"
import { GlobalBus } from "../../../src/bus/global"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { testEffect, pollWithTimeout } from "../../lib/effect"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

void Log.init({ print: false })

const it = testEffect(Layer.empty)
const run = <T>(fn: () => Promise<T>) => Effect.promise(fn) as unknown as Effect.Effect<T, unknown, never>

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function replyReq(dir: string, rid: string, token = "tok1", requestId = "req-reply", answers: string[][] = [["Yes"]]) {
  const opId = `question:${rid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "question/reply" as const,
    idempotencyKey: opId,
    context: { directory: dir, requestID: rid },
    payload: { answers },
  }
}

function rejectReq(dir: string, rid: string, token = "tok1", requestId = "req-reject") {
  const opId = `question:${rid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "question/reject" as const,
    idempotencyKey: opId,
    context: { directory: dir, requestID: rid },
    payload: {},
  }
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function initPeer(ext: JsonRpcPeer) {
  return ext.request("initialize", {
    protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
    clientInfo: { name: "kilo-vscode", version: "7.4.11" },
    capabilities: ["question/reply", "question/reject"],
  })
}

function makeSession(dir: string, title: string) {
  return run(() =>
    AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.create({ title })
        }),
      ),
    ),
  )
}

function durableSnapshot(dir: string, sid: SessionID) {
  return run(() =>
    AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const rev = yield* db
            .select({ rev: SessionTable.revision })
            .from(SessionTable)
            .where(eq(SessionTable.id, sid))
            .get()
            .pipe(
              Effect.orDie,
              Effect.map((row) => row?.rev),
            )
          const kinds = yield* db
            .select({ kind: SessionOperationTable.op_kind })
            .from(SessionOperationTable)
            .where(eq(SessionOperationTable.session_id, sid))
            .all()
            .pipe(Effect.orDie)
          const tombs = yield* db
            .select({ op: SessionDeleteTombstoneTable.op_id })
            .from(SessionDeleteTombstoneTable)
            .where(eq(SessionDeleteTombstoneTable.session_id, sid))
            .all()
            .pipe(Effect.orDie)
          const feed = yield* db
            .select({ seq: SessionChangefeedTable.seq })
            .from(SessionChangefeedTable)
            .where(eq(SessionChangefeedTable.session_id, sid))
            .all()
            .pipe(Effect.orDie)
          return { rev, ops: kinds.map((row) => row.kind), tombs, feed: feed.map((row) => row.seq) }
        }),
      ),
    ),
  )
}

function ask(dir: string, sid: SessionID) {
  return AppRuntime.runFork(
    provideInstance(dir)(
      Effect.gen(function* () {
        const svc = yield* Question.Service
        return yield* svc.ask({
          sessionID: sid,
          questions: [
            {
              question: "Proceed?",
              header: "Go",
              options: [{ label: "Yes", description: "Go" }],
            },
          ],
        })
      }),
    ),
  )
}

function waitPending(dir: string) {
  return run(() =>
    AppRuntime.runPromise(
      provideInstance(dir)(
        pollWithTimeout(
          Effect.gen(function* () {
            const svc = yield* Question.Service
            const list = yield* svc.list()
            if (list.length === 1) return list
            return undefined
          }),
          "question never became pending",
        ),
      ),
    ),
  )
}

function collect(dir: string, types: string[]) {
  const seen: Array<{ type: string; props: Record<string, unknown> }> = []
  const off = (evt: { directory?: string; payload?: { type?: string; properties?: Record<string, unknown> } }) => {
    if (evt.directory !== dir) return
    const t = evt.payload?.type
    if (typeof t === "string" && types.includes(t)) seen.push({ type: t, props: evt.payload?.properties ?? {} })
  }
  GlobalBus.on("event", off)
  return { seen, stop: () => GlobalBus.off("event", off) }
}

describe("fd-carrier question/reply question/reject handler", () => {
  it.live("initialize advertises question capabilities", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = (yield* Effect.promise(() => initPeer(ext))) as unknown as { capabilities?: unknown }
        const caps = res.capabilities as string[]
        expect(caps.includes("question/reply")).toBeTrue()
        expect(caps.includes("question/reject")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("reply through handler returns terminal, resolves Deferred, emits SSE, no durable writes", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-question-reply")
      const before = yield* durableSnapshot(dir, sess.id)
      const fiber = ask(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: QuestionID }>
        const rid = String(pending[0]!.id)
        const wire = collect(dir, ["question.replied"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() =>
            ext.request("question/reply", replyReq(dir, rid, "reply-tok", "req-r1", [["Yes"]])),
          )) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            sessionID: string
            requestID: string
            answers: string[][]
          }
          expect(raw.kind).toBe("terminal")
          expect(raw.accepted).toBeTrue()
          expect(raw.terminal).toBeTrue()
          expect(raw.sessionID).toBe(sess.id)
          expect(raw.requestID).toBe(rid)
          expect(raw.answers).toEqual([["Yes"]])
          const exit = (yield* run(() => AppRuntime.runPromise(Fiber.await(fiber as unknown as Fiber.Fiber<never>)))) as unknown as Exit.Exit<unknown>
          expect(Exit.isSuccess(exit)).toBeTrue()
          if (Exit.isSuccess(exit)) expect(exit.value).toEqual([["Yes"]])
          expect(wire.seen.length).toBe(1)
          expect(wire.seen[0]!.type).toBe("question.replied")
          expect(wire.seen[0]!.props.requestID).toBe(rid)
        } finally {
          carrier.dispose()
          ext.dispose()
          wire.stop()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
      const snap = yield* durableSnapshot(dir, sess.id)
      expect(snap.rev).toBe(before.rev)
      expect(snap.ops).toEqual([])
      expect(snap.tombs).toEqual([])
      expect(snap.feed).toEqual(before.feed)
    }),
  )

  it.live("reject through handler returns terminal, fails Deferred with RejectedError, emits SSE, no durable writes", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-question-reject")
      const before = yield* durableSnapshot(dir, sess.id)
      const fiber = ask(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: QuestionID }>
        const rid = String(pending[0]!.id)
        const wire = collect(dir, ["question.rejected"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() =>
            ext.request("question/reject", rejectReq(dir, rid, "reject-tok", "req-j1")),
          )) as unknown as { kind: string; accepted: boolean; terminal: boolean; sessionID: string; requestID: string }
          expect(raw.kind).toBe("terminal")
          expect(raw.accepted).toBeTrue()
          expect(raw.terminal).toBeTrue()
          expect(raw.sessionID).toBe(sess.id)
          expect(raw.requestID).toBe(rid)
          const exit = (yield* run(() => AppRuntime.runPromise(Fiber.await(fiber as unknown as Fiber.Fiber<never>)))) as unknown as Exit.Exit<unknown>
          expect(Exit.isFailure(exit)).toBeTrue()
          expect(wire.seen.length).toBe(1)
          expect(wire.seen[0]!.props.requestID).toBe(rid)
        } finally {
          carrier.dispose()
          ext.dispose()
          wire.stop()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
      const snap = yield* durableSnapshot(dir, sess.id)
      expect(snap.rev).toBe(before.rev)
      expect(snap.ops).toEqual([])
      expect(snap.tombs).toEqual([])
      expect(snap.feed).toEqual(before.feed)
    }),
  )

  it.live("unknown and double submit return question.not_found with no side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-question-double")
      const fiber = ask(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: QuestionID }>
        const rid = String(pending[0]!.id)
        const wire = collect(dir, ["question.replied", "question.rejected"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const first = (yield* Effect.promise(() =>
            ext.request("question/reply", replyReq(dir, rid, "tok-a", "req-a", [])),
          )) as unknown as { kind: string }
          expect(first.kind).toBe("terminal")
          const wireCount = wire.seen.length
          const second = (yield* Effect.promise(() =>
            ext.request("question/reply", replyReq(dir, rid, "tok-b", "req-b", [])),
          )) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            failure: { code: string; retryable: boolean }
            sideEffect: boolean
          }
          expect(second.kind).toBe("terminal-failure")
          expect(second.accepted).toBeFalse()
          expect(second.terminal).toBeTrue()
          expect(second.failure.code).toBe("question.not_found")
          expect(second.failure.retryable).toBeFalse()
          expect(second.sideEffect).toBeFalse()
          const missing = (yield* Effect.promise(() =>
            ext.request(
              "question/reject",
              rejectReq(dir, QuestionID.ascending() as unknown as string, "tok-c", "req-c"),
            ),
          )) as unknown as { kind: string; failure: { code: string }; sideEffect: boolean }
          expect(missing.kind).toBe("terminal-failure")
          expect(missing.failure.code).toBe("question.not_found")
          expect(missing.sideEffect).toBeFalse()
          expect(wire.seen.length).toBe(wireCount)
          const list = (yield* run(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const svc = yield* Question.Service
                  return yield* svc.list()
                }),
              ),
            ),
          )) as unknown as unknown[]
          expect(list.length).toBe(0)
        } finally {
          carrier.dispose()
          ext.dispose()
          wire.stop()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("scope binding mismatch returns scope_mismatch with no side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-question-scope")
      const fiber = ask(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: QuestionID }>
        const rid = String(pending[0]!.id)
        const other = QuestionID.ascending() as unknown as string
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const badOp = {
            ...replyReq(dir, rid, "tok-scope", "req-scope"),
            op: "question/reject" as const,
          }
          const scoped = (yield* Effect.promise(() => ext.request("question/reply", badOp))) as unknown as {
            kind: string
            failure: { code: string }
            sideEffect: boolean
          }
          expect(scoped.kind).toBe("terminal-failure")
          expect(scoped.failure.code).toBe("scope_mismatch")
          expect(scoped.sideEffect).toBeFalse()
          const mismatched = {
            ...replyReq(dir, rid, "tok-scope2", "req-scope2"),
            opId: `question:${other}:tok-scope2`,
            idempotencyKey: `question:${other}:tok-scope2`,
          }
          const scoped2 = (yield* Effect.promise(() => ext.request("question/reply", mismatched))) as unknown as {
            kind: string
            failure: { code: string }
          }
          expect(scoped2.kind).toBe("terminal-failure")
          expect(scoped2.failure.code).toBe("scope_mismatch")
          const list = (yield* run(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const svc = yield* Question.Service
                  return yield* svc.list()
                }),
              ),
            ),
          )) as unknown as unknown[]
          expect(list.length).toBe(1)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("malformed envelope rejects as InvalidParams with no side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-question-invalid")
      const fiber = ask(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: QuestionID }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const badPayload = yield* Effect.promise(() =>
            ext.request("question/reply", { ...replyReq(dir, rid), payload: { answers: "broken" } }).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect((badPayload as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          const extra = yield* Effect.promise(() =>
            ext.request("question/reject", { ...rejectReq(dir, rid), extra: 1 }).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect((extra as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          const list = (yield* run(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const svc = yield* Question.Service
                  return yield* svc.list()
                }),
              ),
            ),
          )) as unknown as unknown[]
          expect(list.length).toBe(1)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )
})
