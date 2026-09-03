import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Context, Effect, Option } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Session } from "../../../src/session/session"
import { SessionStatus } from "../../../src/session/status"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type StatusResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string } }
  accepted: boolean
  data?: { statuses: Record<string, { type: string }> }
  failure?: { code: string }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}

function str(record: Record<string, unknown>, key: string): string {
  const v = record[key]
  if (typeof v !== "string") throw new Error(`expected string response.${key}`)
  return v
}

function failureOf(v: unknown, path: string): { code: string } {
  if (!isRecord(v)) throw new Error(`expected record ${path}`)
  const code = v.code
  if (typeof code !== "string") throw new Error(`expected string ${path}.code`)
  return { code }
}

function outcomeOf(v: unknown): StatusResult["outcome"] {
  if (!isRecord(v)) throw new Error("expected record response.outcome")
  const type = v.type
  if (typeof type !== "string") throw new Error("expected string response.outcome.type")
  const time = v.time
  if (typeof time !== "number") throw new Error("expected number response.outcome.time")
  if (v.failure === undefined) return { type, time }
  return { type, time, failure: failureOf(v.failure, "response.outcome.failure") }
}

function statusesOf(v: unknown): Record<string, { type: string }> {
  if (!isRecord(v)) throw new Error("expected record response.data.statuses")
  const out: Record<string, { type: string }> = {}
  for (const [key, entry] of Object.entries(v)) {
    if (!isRecord(entry)) throw new Error(`expected record response.data.statuses[${key}]`)
    const type = entry.type
    if (typeof type !== "string") throw new Error(`expected string response.data.statuses[${key}].type`)
    out[key] = { type }
  }
  return out
}

function asStatusResult(v: unknown): StatusResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "session/status") throw new Error("expected response.op to be session/status")
  const idempotencyKey = str(record, "idempotencyKey")
  if (idempotencyKey.length === 0) throw new Error("expected non-empty response.idempotencyKey")
  const status = str(record, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status to be succeeded or failed")
  const accepted = record.accepted
  if (typeof accepted !== "boolean") throw new Error("expected boolean response.accepted")
  const outcome = outcomeOf(record.outcome)
  let data: StatusResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    data = { statuses: statusesOf(record.data.statuses) }
  }
  let failure: StatusResult["failure"]
  if (record.failure !== undefined) failure = failureOf(record.failure, "response.failure")
  return {
    v: 1,
    requestId,
    opId,
    op,
    idempotencyKey,
    status,
    outcome,
    accepted,
    ...(data !== undefined ? { data } : {}),
    ...(failure !== undefined ? { failure } : {}),
  }
}

function asError(v: unknown): { code?: number; message?: string } {
  if (!isRecord(v)) return {}
  const out: { code?: number; message?: string } = {}
  if (typeof v.code === "number") out.code = v.code
  if (typeof v.message === "string") out.message = v.message
  return out
}

function capabilitiesOf(v: unknown): string[] {
  if (!isRecord(v)) return []
  const caps = v.capabilities
  if (!Array.isArray(caps)) return []
  return caps.filter((entry): entry is string => typeof entry === "string")
}

function failureCodeOf(v: StatusResult): string | undefined {
  if (typeof v.failure?.code === "string") return v.failure.code
  if (typeof v.outcome?.failure?.code === "string") return v.outcome.failure.code
  return undefined
}

function noteCleanup(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

function linked() {
  let extToCarrier: PassThrough | undefined
  let carrierToExt: PassThrough | undefined
  let carrier: ReturnType<typeof createFdCarrier> | undefined
  let ext: JsonRpcPeer | undefined
  try {
    extToCarrier = new PassThrough()
    carrierToExt = new PassThrough()
    carrier = createFdCarrier(extToCarrier, carrierToExt)
    ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    const out = { carrier: carrier as ReturnType<typeof createFdCarrier>, ext: ext as JsonRpcPeer }
    carrier = undefined
    ext = undefined
    extToCarrier = undefined
    carrierToExt = undefined
    return out
  } catch (err) {
    if (ext) {
      try {
        ext.dispose()
      } catch (cleanupErr) {
        noteCleanup("ext-dispose", cleanupErr)
      }
    }
    if (carrier) {
      try {
        carrier.dispose()
      } catch (cleanupErr) {
        noteCleanup("carrier-dispose", cleanupErr)
      }
    }
    if (extToCarrier) {
      try {
        extToCarrier.destroy()
      } catch (cleanupErr) {
        noteCleanup("extToCarrier-destroy", cleanupErr)
      }
    }
    if (carrierToExt) {
      try {
        carrierToExt.destroy()
      } catch (cleanupErr) {
        noteCleanup("carrierToExt-destroy", cleanupErr)
      }
    }
    throw err
  }
}

function statusReq(dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    requestId: "req-status-1",
    opId: "status:tok1",
    op: "session/status",
    idempotencyKey: "status:tok1",
    context: { directory: dir },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["session/status"],
    }),
  )
}

function ownParentPid(): () => void {
  const prior = process.env.KILO_PARENT_PID
  process.env.KILO_PARENT_PID = "1"
  return () => {
    if (prior === undefined) delete process.env.KILO_PARENT_PID
    else process.env.KILO_PARENT_PID = prior
  }
}

function scoped(ctx: InstanceContext, captured: Context.Context<never>) {
  return <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
    runInInstance(
      ctx,
      work.pipe(
        Effect.provide(captured as unknown as Context.Context<R>),
        Effect.provideService(InstanceRef, ctx),
      ),
    )
}

describe("fd-carrier session/status (B5 parity-only read-only)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises session/status capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("session/status")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("pre-init status rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext.request("session/status", statusReq("/tmp")).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("status returns same-directory StatusMap read-only", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const session = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-status" })
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const svc = yield* SessionStatus.Service
            yield* svc.set(session.id, { type: "busy" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const titleBefore = (
            yield* run(
              Effect.gen(function* () {
                const svc = yield* Session.Service
                return yield* svc.get(session.id)
              }),
            )
          ).title
          const res = asStatusResult(yield* Effect.promise(() => ext.request("session/status", statusReq(dir))))
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.requestId).toBe("req-status-1")
          expect(res.opId).toBe("status:tok1")
          expect(res.data?.statuses[session.id]?.type).toBe("busy")
          // read-only: no mutation of session row
          const titleAfter = (
            yield* run(
              Effect.gen(function* () {
                const svc = yield* Session.Service
                return yield* svc.get(session.id)
              }),
            )
          ).title
          expect(titleAfter).toBe(titleBefore)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("idle is not persisted (omitted from private map)", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const session = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-status-idle" })
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const svc = yield* SessionStatus.Service
            yield* svc.set(session.id, { type: "busy" })
            yield* svc.set(session.id, { type: "idle" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const res = asStatusResult(yield* Effect.promise(() => ext.request("session/status", statusReq(dir))))
          expect(res.status).toBe("succeeded")
          expect(res.data?.statuses[session.id]).toBeUndefined()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("strict validation fails closed without new authority", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        expect(path.isAbsolute(dir)).toBeTrue()
        const store = yield* InstanceStore.Service
        const beforeSnap = yield* store.snapshot(dir)
        expect(Option.isNone(beforeSnap)).toBeTrue()
        const beforeDirs = yield* store.directories()
        expect(beforeDirs.includes(dir)).toBeFalse()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases: Array<{ label: string; req: Record<string, unknown> }> = [
            { label: "relative directory", req: statusReq("relative/path") },
            { label: "non-empty payload", req: statusReq(dir, { payload: { filter: "busy" } }) },
            { label: "idempotency mismatch", req: statusReq(dir, { idempotencyKey: "status:other" }) },
            { label: "sessionRevision carried", req: statusReq(dir, { context: { directory: dir, sessionRevision: 1 } }) },
            { label: "configVersion carried", req: statusReq(dir, { context: { directory: dir, configVersion: 2 } }) },
            { label: "empty opId", req: statusReq(dir, { opId: "", idempotencyKey: "" }) },
            { label: "unexpected root field", req: statusReq(dir, { sessionRevision: 1 }) },
          ]
          for (const c of cases) {
            const res = asStatusResult(yield* Effect.promise(() => ext.request("session/status", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
          }
          const afterSnap = yield* store.snapshot(dir)
          expect(Option.isNone(afterSnap)).toBeTrue()
          const afterDirs = yield* store.directories()
          expect(afterDirs.includes(dir)).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("arbitrary non-empty opId accepted when idempotencyKey matches (LOCK-005)", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          for (const opId of ["status", "status:tok1", "opaque-token-123", "cancelQueued:ses_a:msg_b"]) {
            const res = asStatusResult(
              yield* Effect.promise(() =>
                ext.request("session/status", statusReq(dir, { requestId: `r-${opId}`, opId, idempotencyKey: opId })),
              ),
            )
            expect(res.status).toBe("succeeded")
            expect(res.opId).toBe(opId)
          }
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("directory isolation: other directory sees empty map", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: tmpA.path })
        yield* store.load({ directory: tmpB.path })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const session = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-status-iso" })
          }),
        )
        yield* runA(
          Effect.gen(function* () {
            const svc = yield* SessionStatus.Service
            yield* svc.set(session.id, { type: "busy" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const resB = asStatusResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/status",
                statusReq(tmpB.path, { requestId: "r-b", opId: "status:tokB", idempotencyKey: "status:tokB" }),
              ),
            ),
          )
          expect(resB.status).toBe("succeeded")
          expect(Object.keys(resB.data?.statuses ?? {})).toEqual([])
          const resA = asStatusResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/status",
                statusReq(tmpA.path, { requestId: "r-a", opId: "status:tokA", idempotencyKey: "status:tokA" }),
              ),
            ),
          )
          expect(resA.status).toBe("succeeded")
          expect(resA.data?.statuses[session.id]?.type).toBe("busy")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("unknown method still MethodNotFound after status added", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const err = yield* Effect.promise(() =>
            ext.request("session/unknown", {}).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect(asError(err).code).toBe(ErrorCode.MethodNotFound)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("restores preexisting KILO_PARENT_PID exactly", () =>
    Effect.gen(function* () {
      yield* Effect.void
      const saved = process.env.KILO_PARENT_PID
      try {
        process.env.KILO_PARENT_PID = "sentinel-pid-123"
        const restoreSentinel = ownParentPid()
        expect(process.env.KILO_PARENT_PID).toBe("1")
        restoreSentinel()
        expect(process.env.KILO_PARENT_PID).toBe("sentinel-pid-123")
        delete process.env.KILO_PARENT_PID
        const restoreAbsent = ownParentPid()
        expect(String(process.env.KILO_PARENT_PID)).toBe("1")
        restoreAbsent()
        expect("KILO_PARENT_PID" in process.env).toBeFalse()
      } finally {
        if (saved === undefined) delete process.env.KILO_PARENT_PID
        else process.env.KILO_PARENT_PID = saved
      }
    }),
  )

  it.live("setup failure after owning env still restores KILO_PARENT_PID (LOCK-020)", () =>
    Effect.gen(function* () {
      yield* Effect.void
      const saved = process.env.KILO_PARENT_PID
      try {
        process.env.KILO_PARENT_PID = "sentinel-setup-fail"
        const restorePresent = ownParentPid()
        const outcome = yield* Effect.fail(new Error("synthetic setup failure")).pipe(
          Effect.ensuring(Effect.sync(() => restorePresent())),
          Effect.flip,
        )
        expect(outcome.message).toBe("synthetic setup failure")
        expect(process.env.KILO_PARENT_PID).toBe("sentinel-setup-fail")
        delete process.env.KILO_PARENT_PID
        const restoreAbsent = ownParentPid()
        const outcomeAbsent = yield* Effect.fail(new Error("synthetic setup failure absent")).pipe(
          Effect.ensuring(Effect.sync(() => restoreAbsent())),
          Effect.flip,
        )
        expect(outcomeAbsent.message).toBe("synthetic setup failure absent")
        expect("KILO_PARENT_PID" in process.env).toBeFalse()
      } finally {
        if (saved === undefined) delete process.env.KILO_PARENT_PID
        else process.env.KILO_PARENT_PID = saved
      }
    }),
  )

  it.live("partial construction rollback destroys first stream when later allocation throws (LOCK-020)", () =>
    Effect.gen(function* () {
      yield* Effect.void
      const origDestroy = PassThrough.prototype.destroy
      let destroys = 0
      PassThrough.prototype.destroy = function (this: PassThrough, ...args: unknown[]) {
        destroys += 1
        return (origDestroy as (...a: unknown[]) => unknown).apply(this, args)
      } as typeof origDestroy
      try {
        let first: PassThrough | undefined
        let failed: unknown
        try {
          first = new PassThrough()
          throw new Error("synthetic second-allocation failure")
        } catch (err) {
          if (first) {
            try {
              first.destroy()
            } catch (cleanupErr) {
              noteCleanup("first-destroy", cleanupErr)
            }
          }
          failed = err
        }
        expect(failed).toBeDefined()
        expect((failed as Error).message).toContain("synthetic second-allocation failure")
        expect(destroys).toBeGreaterThanOrEqual(1)
        expect(first?.destroyed).toBeTrue()
      } finally {
        PassThrough.prototype.destroy = origDestroy
      }
    }),
  )
})
