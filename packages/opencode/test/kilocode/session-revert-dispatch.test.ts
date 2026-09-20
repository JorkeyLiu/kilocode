// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionChangefeedTable, SessionChangefeedStateTable } from "@opencode-ai/core/retention/sql"
import { ConfigConvergence } from "@/kilocode/server/config-convergence"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { InstanceStore } from "@/project/instance-store"
import { SessionRevert } from "@/session/revert"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2 } from "@opencode-ai/core/event"
import {
  SessionRevertDispatchService,
  layer as DispatchLayer,
  validateRevertRequest,
  validateUnrevertRequest,
} from "@/kilocode/session/session-revert-dispatch"

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"

function revertReq(token: string, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: `req-${token}`,
    opId: `revert:${SID}:${token}`,
    op: "session/revert",
    idempotencyKey: `revert:${SID}:${token}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: MID },
    ...extra,
  }
}

function unrevertReq(token: string) {
  return {
    v: 1,
    requestId: `req-${token}`,
    opId: `unrevert:${SID}:${token}`,
    op: "session/unrevert",
    idempotencyKey: `unrevert:${SID}:${token}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: {},
  }
}

function makeStore() {
  const stored: { row: any | undefined } = { row: undefined }
  let sessionRev = 0
  const sessionRowBase = {
    id: SID,
    directory: DIR,
    project_id: "proj-1",
    workspace_id: null,
    revision: 0,
    title: "t",
    version: "1",
    slug: "slug-1",
    time_created: Date.now(),
    time_updated: Date.now(),
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    revert: null,
    metadata: null,
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    permission: null,
    agent: null,
    model: null,
    share_url: null,
    path: null,
    parent_id: null,
  }
  const fakeDb: any = {
    select: (..._s: unknown[]) => ({
      from: (table: unknown) => ({
        where: (..._w: unknown[]) => ({
          get: () => {
            if (table === SessionChangefeedStateTable) return Effect.succeed({ id: 1, latest_seq: 1, retained_rows: 1, retained_bytes: 10 })
            if (table === SessionTable) return Effect.succeed({ ...sessionRowBase, directory: DIR, project_id: "proj-1", workspace_id: null, revision: sessionRev, time_updated: Date.now() })
            if (table === ProjectTable) return Effect.succeed({ worktree: DIR })
            if (table === SessionChangefeedTable) return Effect.succeed({ seq: 1, session_id: SID, revision: sessionRev, kind: "changed", time: Date.now() })
            // SessionOperation lookup by opId or hash: return stored row if matches
            return Effect.succeed(stored.row ?? undefined)
          },
          all: () => {
            if (table === SessionChangefeedTable) return Effect.succeed([{ seq: 1, session_id: SID, revision: sessionRev, kind: "changed", time: Date.now() }])
            if (table === SessionChangefeedStateTable) return Effect.succeed([{ id: 1, latest_seq: 1, retained_rows: 1, retained_bytes: 10 }])
            return Effect.succeed([])
          },
        }),
        // for select without where? handle returning
        get: () => {
          if (table === SessionTable) return Effect.succeed({ ...sessionRowBase, revision: sessionRev })
          if (table === SessionChangefeedStateTable) return Effect.succeed({ id: 1, latest_seq: 1, retained_rows: 1, retained_bytes: 10 })
          return Effect.succeed(undefined)
        },
        all: () => {
          if (table === SessionChangefeedTable) return Effect.succeed([{ seq: 1, session_id: SID, revision: sessionRev, kind: "changed", time: Date.now() }])
          return Effect.succeed([])
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        run: () => {
          if (table === SessionOperationTable) {
            stored.row = {
              op_id: v.op_id,
              op_kind: v.op_kind,
              outcome: v.outcome,
              code: v.code,
              message: v.message,
              time: v.time,
              revision: (v.revision as number) ?? sessionRev,
              idempotency_hash: v.idempotency_hash,
              request_id: v.request_id,
              directory: v.directory,
              parent_session_id: (v.parent_session_id as string | null) ?? null,
              config_version: (v.config_version as number | null) ?? null,
              session_revision: (v.session_revision as number | null) ?? null,
              message_id: (v.message_id as string | null) ?? null,
              title: (v.title as string | null) ?? null,
              result_snapshot: v.result_snapshot,
            }
          }
          // SessionChangefeedTable insert is handled via Changefeed.appendTx which uses insert; we simulate by no-op
          return Effect.succeed(undefined)
        },
        returning: () => ({
          get: () => Effect.succeed(v),
          all: () => Effect.succeed([v]),
        }),
        get: () => Effect.succeed(undefined),
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (..._w: unknown[]) => ({
          returning: () => ({
            all: () => {
              if (table === SessionTable) {
                sessionRev += 1
                return Effect.succeed([{ rev: sessionRev }])
              }
              return Effect.succeed([])
            },
            get: () => {
              if (table === SessionTable) {
                sessionRev += 1
                return Effect.succeed({ rev: sessionRev })
              }
              return Effect.succeed(undefined)
            },
          }),
          run: () => Effect.succeed(undefined),
        }),
      }),
    }),
    delete: () => ({ where: () => ({ run: () => Effect.succeed(undefined) }) }),
    transaction: (fn: (tx: unknown) => Effect.Effect<unknown>) => fn(fakeDb),
    run: () => Effect.succeed(undefined),
  }
  return { fakeDb, stored, getRev: () => sessionRev }
}

function makeEventMock() {
  return {
    recordProjectedTx: () => Effect.succeed({ id: "evt_1", type: "session.updated", seq: 0, data: { sessionID: SID, info: { id: SID, slug: "slug-1", projectID: "proj-1", directory: DIR, title: "t", version: "1", time: { created: Date.now(), updated: Date.now() } } } } as unknown),
    notifyCommitted: () => Effect.void,
  } as unknown as EventV2.Interface
}

function layers(fakeDb: unknown, revertImpl: { revert: () => Effect.Effect<unknown>; unrevert: () => Effect.Effect<unknown> }) {
  const dbLayer = Layer.succeed(Database.Service, { db: fakeDb } as never)
  const cfgLayer = Layer.succeed(ConfigConvergence.Service, ConfigConvergence.noop)
  const gateLayer = Layer.succeed(GenerationGate.Service, GenerationGate.noop)
  const eventLayer = Layer.succeed(EventV2.Service, makeEventMock() as never)
  const revertLayer = Layer.succeed(SessionRevert.Service, {
    revert: revertImpl.revert,
    unrevert: revertImpl.unrevert,
    prepareRevert: () =>
      Effect.gen(function* () {
        const info = yield* revertImpl.revert() as unknown as Effect.Effect<{ id: string }>
        // derive prepare result from info if possible; fallback to synthetic revert
        return { revert: { messageID: MID, snapshot: "snap-1", diff: "" }, summary: { additions: 0, deletions: 0, files: 0, diffs: [] } } as unknown
      }),
    prepareUnrevert: () =>
      Effect.gen(function* () {
        yield* revertImpl.unrevert()
        return true as unknown
      }),
    cleanup: () => Effect.void,
  } as never)
  const refLayer = Layer.succeed(InstanceRef, { directory: DIR } as never)
  const deps = Layer.mergeAll(dbLayer, cfgLayer, gateLayer, revertLayer, refLayer, eventLayer)
  return Layer.mergeAll(Layer.provide(DispatchLayer, deps), refLayer)
}

describe("session-revert-dispatch validate", () => {
  test("accepts canonical revert tuple", () => {
    expect(() => validateRevertRequest(revertReq("tok1"))).not.toThrow()
  })
  test("rejects idempotency mismatch", () => {
    expect(() => validateRevertRequest({ ...revertReq("tok1"), idempotencyKey: `revert:${SID}:other` })).toThrow()
  })
  test("rejects non-null parent", () => {
    const r = revertReq("tok1") as Record<string, unknown>
    const ctx = { ...(r.context as Record<string, unknown>), parentSessionId: SID }
    expect(() => validateRevertRequest({ ...r, context: ctx })).toThrow()
  })
  test("accepts canonical unrevert tuple", () => {
    expect(() => validateUnrevertRequest(unrevertReq("tok2"))).not.toThrow()
  })
})

describe("session-revert-dispatch authoritative commit and replay", () => {
  test("revert commits and replays same session without second execution", async () => {
    const { fakeDb } = makeStore()
    let calls = 0
    const info = { id: SID, slug: "slug-1", projectID: "proj-1", directory: DIR, title: "t", version: "1", time: { created: Date.now(), updated: Date.now() } } as never
    const full = layers(fakeDb, {
      revert: () => Effect.gen(function* () { calls += 1; return info as never }),
      unrevert: () => Effect.succeed(info as never),
    })
    const prog = Effect.gen(function* () {
      const svc = yield* SessionRevertDispatchService
      const first = (yield* svc.dispatchRevert(revertReq("tokA"))) as { status: string; accepted: boolean; data: unknown }
      expect(first.status).toBe("succeeded")
      expect(first.accepted).toBe(true)
      const second = (yield* svc.dispatchRevert(revertReq("tokA"))) as { status: string; data: unknown }
      expect(second.status).toBe("succeeded")
      expect(second.data).toEqual((first as any).data)
      expect(calls).toBe(1)
      const priv = (yield* svc.dispatchPrivateRevert(revertReq("tokA"))) as { status: string; data: { session: unknown } }
      expect(priv.status).toBe("succeeded")
      expect(priv.data.session).toEqual((first as any).data)
    })
    await Effect.runPromise(Effect.provide(prog, full) as Effect.Effect<void>)
  })

  test("terminal session.not_found closes without execution", async () => {
    const fakeDb: any = {
      select: () => ({ from: (table: unknown) => ({ where: () => ({ get: () => Effect.succeed(table === SessionTable ? undefined : undefined), all: () => Effect.succeed([]) }) }) }),
      transaction: (fn: (tx: unknown) => Effect.Effect<unknown>) => fn(fakeDb),
    }
    let calls = 0
    const full = layers(fakeDb, {
      revert: () => Effect.gen(function* () { calls += 1; return {} as never }),
      unrevert: () => Effect.succeed({} as never),
    })
    const prog = Effect.gen(function* () {
      const svc = yield* SessionRevertDispatchService
      const out = (yield* svc.dispatchRevert(revertReq("tokB"))) as { status: string; failure: { code: string; retryable: boolean } }
      expect(out.status).toBe("failed")
      expect(out.failure.code).toBe("session.not_found")
      expect(out.failure.retryable).toBe(false)
      expect(calls).toBe(0)
    })
    await Effect.runPromise(Effect.provide(prog, full) as Effect.Effect<void>)
  })

  test("busy maps terminal while barrier maps retryable", async () => {
    const { fakeDb } = makeStore()
    const busy = { _tag: "SessionBusyError", sessionID: SID, message: "busy" }
    const fullBusy = layers(fakeDb, {
      revert: () => Effect.fail(busy),
      unrevert: () => Effect.succeed({} as never),
    })
    const busyOut = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* SessionRevertDispatchService
          return (yield* svc.dispatchRevert(revertReq("tokC"))) as { status: string; failure: { code: string; retryable: boolean } }
        }),
        fullBusy,
      ) as Effect.Effect<{ status: string; failure: { code: string; retryable: boolean } }>,
    )
    expect(busyOut.status).toBe("failed")
    expect(busyOut.failure.code).toBe("busy")
    expect(busyOut.failure.retryable).toBe(false)

    const { fakeDb: fakeDb2 } = makeStore()
    const gateActive = Layer.succeed(GenerationGate.Service, { isBarrierActive: () => true, acquire: () => Effect.void } as never)
    const dbLayer = Layer.succeed(Database.Service, { db: fakeDb2 } as never)
    const cfgLayer = Layer.succeed(ConfigConvergence.Service, ConfigConvergence.noop)
    const revertLayer = Layer.succeed(SessionRevert.Service, { revert: () => Effect.succeed({} as never), unrevert: () => Effect.succeed({} as never), cleanup: () => Effect.void } as never)
    const refLayer = Layer.succeed(InstanceRef, { directory: DIR } as never)
    const deps = Layer.mergeAll(dbLayer, cfgLayer, gateActive, revertLayer, refLayer)
    const fullBarrier = Layer.mergeAll(Layer.provide(DispatchLayer, deps), refLayer)
    const barrierOut = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* SessionRevertDispatchService
          const req = { ...revertReq("tokD"), context: { directory: DIR, sessionId: SID, parentSessionId: null, configVersion: 3 } }
          return (yield* svc.dispatchRevert(req)) as { status: string; failure: { code: string; retryable: boolean } }
        }),
        fullBarrier,
      ) as Effect.Effect<{ status: string; failure: { code: string; retryable: boolean } }>,
    )
    expect(barrierOut.status).toBe("failed")
    expect(barrierOut.failure.code).toBe("InstanceUnavailableDuringConfigRebuild")
    expect(barrierOut.failure.retryable).toBe(true)
  })

  test("unrevert commits", async () => {
    const { fakeDb } = makeStore()
    const info = { id: SID, slug: "slug-1", projectID: "proj-1", directory: DIR, title: "u", version: "1", time: { created: Date.now(), updated: Date.now() } } as never
    const full = layers(fakeDb, {
      revert: () => Effect.succeed({} as never),
      unrevert: () => Effect.succeed(info as never),
    })
    const prog = Effect.gen(function* () {
      const svc = yield* SessionRevertDispatchService
      const out = (yield* svc.dispatchUnrevert(unrevertReq("tokU"))) as { status: string; accepted: boolean }
      expect(out.status).toBe("succeeded")
      expect(out.accepted).toBe(true)
    })
    await Effect.runPromise(Effect.provide(prog, full) as Effect.Effect<void>)
  })

  test("drain fence reports correct op/kind for revert and unrevert", async () => {
    const { fakeDb } = makeStore()
    let calls = 0
    const gateActive = Layer.succeed(GenerationGate.Service, { isBarrierActive: () => true, acquire: () => Effect.void } as never)
    const storeNone = Layer.succeed(InstanceStore.Service, { snapshot: () => Effect.succeed(Option.none()) } as never)
    const dbLayer = Layer.succeed(Database.Service, { db: fakeDb } as never)
    const cfgLayer = Layer.succeed(ConfigConvergence.Service, ConfigConvergence.noop)
    const revertLayer = Layer.succeed(SessionRevert.Service, {
      revert: () => Effect.gen(function* () { calls += 1; return {} as never }),
      unrevert: () => Effect.gen(function* () { calls += 1; return {} as never }),
      cleanup: () => Effect.void,
    } as never)
    const deps = Layer.mergeAll(dbLayer, cfgLayer, gateActive, revertLayer, storeNone)
    const dispatchOnly = Layer.provide(DispatchLayer, deps)
    const full = Layer.mergeAll(dispatchOnly, storeNone, gateActive)
    const prog = Effect.gen(function* () {
      const svc = yield* SessionRevertDispatchService
      const rout = (yield* svc.dispatchRevert(revertReq("tokFenceR"))) as {
        status: string
        op: string
        opId: string
        requestId: string
        idempotencyKey: string
        accepted: boolean
        failure: { code: string; retryable: boolean }
      }
      expect(rout.status).toBe("failed")
      expect(rout.op).toBe("session/revert")
      expect(rout.opId).toBe(`revert:${SID}:tokFenceR`)
      expect(rout.requestId).toBe("req-tokFenceR")
      expect(rout.idempotencyKey).toBe(`revert:${SID}:tokFenceR`)
      expect(rout.accepted).toBe(false)
      expect(rout.failure.code).toBe("InstanceUnavailableDuringConfigRebuild")
      expect(rout.failure.retryable).toBe(true)
      const uout = (yield* svc.dispatchUnrevert(unrevertReq("tokFenceU"))) as {
        status: string
        op: string
        opId: string
        requestId: string
        idempotencyKey: string
        accepted: boolean
        failure: { code: string; retryable: boolean }
      }
      expect(uout.status).toBe("failed")
      expect(uout.op).toBe("session/unrevert")
      expect(uout.opId).toBe(`unrevert:${SID}:tokFenceU`)
      expect(uout.requestId).toBe("req-tokFenceU")
      expect(uout.idempotencyKey).toBe(`unrevert:${SID}:tokFenceU`)
      expect(uout.accepted).toBe(false)
      expect(uout.failure.code).toBe("InstanceUnavailableDuringConfigRebuild")
      expect(uout.failure.retryable).toBe(true)
      expect(calls).toBe(0)
    })
    await Effect.runPromise(Effect.provide(prog, full) as Effect.Effect<void>)
  })

  test("persist failure returns terminal internal and claims no replay record", async () => {
    const { fakeDb, stored } = makeStore()
    const failingDb: Record<string, unknown> = { ...(fakeDb as Record<string, unknown>) }
    failingDb["insert"] = (_t: unknown) => ({
      values: (_v: unknown) => ({ run: () => Effect.fail(new Error("injected persist failure")) }),
    })
    failingDb["transaction"] = (fn: (tx: unknown) => Effect.Effect<unknown>) => fn(failingDb)
    const info = { id: SID, slug: "slug-1", projectID: "proj-1", directory: DIR, title: "t", version: "1", time: { created: Date.now(), updated: Date.now() } } as never
    for (const kind of ["revert", "unrevert"] as const) {
      stored.row = undefined
      let calls = 0
      const full = layers(failingDb, {
        revert: () => Effect.gen(function* () { calls += 1; return info as never }),
        unrevert: () => Effect.gen(function* () { calls += 1; return info as never }),
      })
      const prog = Effect.gen(function* () {
        const svc = yield* SessionRevertDispatchService
        if (kind === "revert") {
          const out = (yield* svc.dispatchRevert(revertReq("tokPersistR"))) as {
            status: string
            op: string
            accepted: boolean
            failure: { code: string; retryable: boolean; message: string }
          }
          expect(out.status).toBe("failed")
          expect(out.op).toBe("session/revert")
          expect(out.accepted).toBe(false)
          expect(out.failure.code).toBe("internal")
          expect(out.failure.retryable).toBe(false)
          expect(stored.row).toBeUndefined()
          const priv = (yield* svc.dispatchPrivateRevert(revertReq("tokPersistR"))) as { status: string; failure: { code: string } }
          expect(priv.status).toBe("failed")
          expect(priv.failure.code).toBe("internal")
          expect(calls).toBe(1)
        } else {
          const out = (yield* svc.dispatchUnrevert(unrevertReq("tokPersistU"))) as {
            status: string
            op: string
            accepted: boolean
            failure: { code: string; retryable: boolean }
          }
          expect(out.status).toBe("failed")
          expect(out.op).toBe("session/unrevert")
          expect(out.accepted).toBe(false)
          expect(out.failure.code).toBe("internal")
          expect(out.failure.retryable).toBe(false)
          expect(stored.row).toBeUndefined()
          const priv = (yield* svc.dispatchPrivateUnrevert(unrevertReq("tokPersistU"))) as { status: string; failure: { code: string } }
          expect(priv.status).toBe("failed")
          expect(priv.failure.code).toBe("internal")
          expect(calls).toBe(1)
        }
      })
      await Effect.runPromise(Effect.provide(prog, full) as Effect.Effect<void>)
    }
  })
})
