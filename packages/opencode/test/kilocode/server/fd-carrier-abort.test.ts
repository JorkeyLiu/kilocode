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
import { SessionRunState } from "../../../src/session/run-state"
import { SessionStatus } from "../../../src/session/status"
import { SessionID } from "../../../src/session/schema"
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

function abortReq(dir: string, sid: string, token = "tok1", requestId = "req-abort") {
  const opId = `abort:${sid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "session/abort" as const,
    idempotencyKey: opId,
    context: { directory: dir, sessionId: sid },
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
    capabilities: ["session/abort"],
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
          const ops = yield* db
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
          return { rev, ops: ops.map((row) => row.kind), tombs, feed: feed.map((row) => row.seq) }
        }),
      ),
    ),
  )
}

describe("fd-carrier session/abort handler", () => {
  it.live("initialize advertises session/abort capability", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = (yield* Effect.promise(() => initPeer(ext))) as unknown as { capabilities?: unknown }
        expect(Array.isArray(res.capabilities) && (res.capabilities as string[]).includes("session/abort")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("idle abort through handler returns terminal with no durable writes", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-abort-idle")
      const before = yield* durableSnapshot(dir, sess.id)
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const raw = (yield* Effect.promise(() => ext.request("session/abort", abortReq(dir, sess.id, "idle-tok", "req-idle")))) as unknown as {
          kind: string
          accepted: boolean
          terminal: boolean
          affected: unknown[]
          diagnostic: { code: string; retryable: boolean; time: number }
        }
        expect(raw.kind).toBe("terminal")
        expect(raw.accepted).toBeTrue()
        expect(raw.terminal).toBeTrue()
        expect(Array.isArray(raw.affected)).toBeTrue()
        expect(raw.diagnostic.code).toBe("cancelled")
        expect(raw.diagnostic.retryable).toBeFalse()
        expect(Number.isFinite(raw.diagnostic.time)).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
      const snap = yield* durableSnapshot(dir, sess.id)
      expect(snap.rev).toBe(before.rev)
      expect(snap.ops).toEqual([])
      expect(snap.tombs).toEqual([])
      expect(snap.feed).toEqual(before.feed)
      const still = yield* run(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(sess.id)
            }),
          ),
        ),
      )
      expect(still.id).toBe(sess.id)
    }),
  )

  it.live("busy abort through handler returns terminal after owner convergence with no durable writes", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-abort-busy")
      const dummy = { info: { id: "m1" }, parts: [] } as unknown as import("@opencode-ai/core/v1/session").SessionV1.WithParts
      const fiber = AppRuntime.runFork(
        provideInstance(dir)(
          Effect.gen(function* () {
            const state = yield* SessionRunState.Service
            return yield* state.ensureRunning(sess.id, Effect.succeed(dummy), Effect.never as unknown as Effect.Effect<typeof dummy>)
          }),
        ),
      )
      try {
        yield* run(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              pollWithTimeout(
                Effect.gen(function* () {
                  const state = yield* SessionRunState.Service
                  const exit = yield* state.assertNotBusy(sess.id).pipe(Effect.exit)
                  return Exit.isFailure(exit) ? (true as const) : undefined
                }),
                `session ${sess.id} never became busy`,
              ),
            ),
          ),
        )
        const active = yield* run(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const state = yield* SessionRunState.Service
                return yield* state.activeGeneration(sess.id)
              }),
            ),
          ),
        )
        expect(typeof active).toBe("string")
        const before = yield* durableSnapshot(dir, sess.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() => ext.request("session/abort", abortReq(dir, sess.id, "hdl-tok", "req-hdl")))) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            affected: { generationId: string; sessionId: string }[]
          }
          expect(raw.kind).toBe("terminal")
          expect(raw.accepted).toBeTrue()
          expect(raw.terminal).toBeTrue()
          expect(raw.affected.length).toBeGreaterThan(0)
          expect(raw.affected[0]!.generationId).toBe(active as string)
          expect(raw.affected[0]!.generationId).not.toBe("hdl-tok")
          expect(raw.affected[0]!.sessionId).toBe(sess.id)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
        const after = yield* run(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const state = yield* SessionRunState.Service
                const status = yield* SessionStatus.Service
                const exit = yield* state.assertNotBusy(sess.id).pipe(Effect.exit)
                const st = yield* status.get(sess.id)
                const genAfter = yield* state.activeGeneration(sess.id)
                return { idle: Exit.isSuccess(exit), status: st.type, genAfter }
              }),
            ),
          ),
        )
        expect(after.idle).toBeTrue()
        expect(after.status).toBe("idle")
        expect(after.genAfter).toBeUndefined()
        const snap = yield* durableSnapshot(dir, sess.id)
        expect(snap.rev).toBe(before.rev)
        expect(snap.ops).toEqual([])
        expect(snap.tombs).toEqual([])
        expect(snap.feed).toEqual(before.feed)
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("handler never reports sideEffect:false after cancelling an in-scope session", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-abort-f1")
      const dummy = { info: { id: "m1" }, parts: [] } as unknown as import("@opencode-ai/core/v1/session").SessionV1.WithParts
      const fiber = AppRuntime.runFork(
        provideInstance(dir)(
          Effect.gen(function* () {
            const state = yield* SessionRunState.Service
            return yield* state.ensureRunning(sess.id, Effect.succeed(dummy), Effect.never as unknown as Effect.Effect<typeof dummy>)
          }),
        ),
      )
      try {
        yield* run(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              pollWithTimeout(
                Effect.gen(function* () {
                  const state = yield* SessionRunState.Service
                  const exit = yield* state.assertNotBusy(sess.id).pipe(Effect.exit)
                  return Exit.isFailure(exit) ? (true as const) : undefined
                }),
                `session ${sess.id} never became busy`,
              ),
            ),
          ),
        )
        const active = (yield* run(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const state = yield* SessionRunState.Service
                return yield* state.activeGeneration(sess.id)
              }),
            ),
          ),
        )) as unknown as string
        // Adversarial token colliding with the live owner generation: the
        // carrier must still report the honest terminal outcome, never a
        // post-cancellation `terminal-failure` with `sideEffect:false`.
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() => ext.request("session/abort", abortReq(dir, sess.id, active, "req-f1")))) as unknown as {
            kind: string
            affected?: { generationId: string }[]
            sideEffect?: boolean
          }
          expect(raw.kind).toBe("terminal")
          expect(raw.sideEffect).toBeUndefined()
          expect(raw.affected?.some((entry) => entry.generationId === active)).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("handler reports missing session as terminal-failure without side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const missing = SessionID.descending()
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const raw = (yield* Effect.promise(() => ext.request("session/abort", abortReq(dir, missing, "miss-tok", "req-miss")))) as unknown as {
          kind: string
          accepted: boolean
          terminal: boolean
          failure: { code: string; retryable: boolean }
          sideEffect: boolean
        }
        expect(raw.kind).toBe("terminal-failure")
        expect(raw.accepted).toBeFalse()
        expect(raw.terminal).toBeTrue()
        expect(raw.failure.code).toBe("session.not_found")
        expect(raw.failure.retryable).toBeFalse()
        expect(raw.sideEffect).toBeFalse()
        const snap = yield* durableSnapshot(dir, missing)
        expect(snap.rev).toBeUndefined()
        expect(snap.ops).toEqual([])
        expect(snap.tombs).toEqual([])
        expect(snap.feed).toEqual([])
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("handler reports scope mismatch as terminal-failure", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const other = yield* run(() => tmpdir({ git: true }))
      const sess = yield* makeSession(dir, "carrier-abort-scope")
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const raw = (yield* Effect.promise(() => ext.request("session/abort", abortReq(other.path, sess.id, "scope-tok", "req-scope")))) as unknown as {
          kind: string
          failure: { code: string }
        }
        expect(raw.kind).toBe("terminal-failure")
        expect(raw.failure.code).toBe("scope_mismatch")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("handler rejects malformed abort envelope as InvalidParams", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-abort-invalid")
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const badPayload = yield* Effect.promise(() =>
          ext.request("session/abort", { ...abortReq(dir, sess.id), payload: { reason: "x" } }).then(
            () => undefined,
            (e: unknown) => e,
          ),
        )
        expect((badPayload as { code?: number }).code).toBe(ErrorCode.InvalidParams)
        const badBinding = yield* Effect.promise(() =>
          ext
            .request("session/abort", {
              ...abortReq(dir, sess.id, "tok", "req-bad"),
              opId: "abort:ses_00000000000000000000000001:tok",
              idempotencyKey: "abort:ses_00000000000000000000000001:tok",
            })
            .then(
              () => undefined,
              (e: unknown) => e,
            ),
        )
        expect((badBinding as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )
})
