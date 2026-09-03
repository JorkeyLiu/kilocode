import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Context, Effect, Option, Schema } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type GetResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: {
    session: {
      id: string
      slug: string
      projectID: string
      directory: string
      title: string
      version: string
      time: Record<string, unknown>
    }
  }
  failure?: { code: string; message?: string; retryable?: boolean }
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

function failureOf(v: unknown, p: string): { code: string; message?: string; retryable?: boolean } {
  if (!isRecord(v)) throw new Error(`expected record ${p}`)
  const code = v.code
  if (typeof code !== "string") throw new Error(`expected string ${p}.code`)
  const out: { code: string; message?: string; retryable?: boolean } = { code }
  if (v.message !== undefined) {
    if (typeof v.message !== "string") throw new Error(`expected string ${p}.message`)
    out.message = v.message
  }
  if (typeof v.retryable === "boolean") out.retryable = v.retryable
  return out
}

function outcomeOf(v: unknown): GetResult["outcome"] {
  if (!isRecord(v)) throw new Error("expected record response.outcome")
  const type = v.type
  if (typeof type !== "string") throw new Error("expected string response.outcome.type")
  const time = v.time
  if (typeof time !== "number") throw new Error("expected number response.outcome.time")
  if (v.failure === undefined) return { type, time }
  return { type, time, failure: failureOf(v.failure, "response.outcome.failure") }
}

function sessionOf(v: unknown): GetResult["data"] extends { session: infer S } | undefined ? S : never {
  if (!isRecord(v)) throw new Error("expected record response.data.session")
  const id = v.id
  if (typeof id !== "string" || id.length === 0) throw new Error("expected non-empty response.data.session.id")
  const slug = v.slug
  if (typeof slug !== "string" || slug.length === 0) throw new Error("expected non-empty response.data.session.slug")
  const projectID = v.projectID
  if (typeof projectID !== "string" || projectID.length === 0)
    throw new Error("expected non-empty response.data.session.projectID")
  const dir = v.directory
  if (typeof dir !== "string" || dir.length === 0)
    throw new Error("expected non-empty response.data.session.directory")
  const title = v.title
  if (typeof title !== "string") throw new Error("expected string response.data.session.title")
  const version = v.version
  if (typeof version !== "string" || version.length === 0)
    throw new Error("expected non-empty response.data.session.version")
  const time = v.time
  if (!isRecord(time)) throw new Error("expected record response.data.session.time")
  return { id, slug, projectID, directory: dir, title, version, time } as never
}

function asGetResult(v: unknown): GetResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "session/get") throw new Error("expected response.op to be session/get")
  const idempotencyKey = str(record, "idempotencyKey")
  if (idempotencyKey.length === 0) throw new Error("expected non-empty response.idempotencyKey")
  const status = str(record, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  const accepted = record.accepted
  if (typeof accepted !== "boolean") throw new Error("expected boolean response.accepted")
  if (status === "succeeded" && accepted !== true) throw new Error("expected accepted true for succeeded")
  if (status === "failed" && accepted !== false) throw new Error("expected accepted false for failed")
  const outcome = outcomeOf(record.outcome)
  if (outcome.type !== status) throw new Error("expected response.outcome.type to match response.status")
  if (typeof outcome.time !== "number" || !(outcome.time > 0))
    throw new Error("expected positive response.outcome.time")
  let data: GetResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    data = { session: sessionOf(record.data.session) as never }
  }
  let failure: GetResult["failure"]
  if (record.failure !== undefined) failure = failureOf(record.failure, "response.failure")
  if (status === "succeeded") {
    if (opId !== idempotencyKey)
      throw new Error("expected response.opId to equal response.idempotencyKey for succeeded")
    if (data === undefined) throw new Error("expected response.data for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
    if (outcome.failure !== undefined) throw new Error("expected no response.outcome.failure for succeeded")
  } else {
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code)
      throw new Error("expected response.failure.code to equal response.outcome.failure.code")
    if (typeof failure.message === "string" && failure.message.length > 200)
      throw new Error("expected bounded response.failure.message")
  }
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

function messageOf(v: GetResult): string {
  return v.failure?.message ?? v.outcome.failure?.message ?? ""
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

function failureCodeOf(v: GetResult): string | undefined {
  if (typeof v.failure?.code === "string") return v.failure.code
  if (typeof v.outcome?.failure?.code === "string") return v.outcome.failure.code
  return undefined
}

function retryableOf(v: GetResult): boolean | undefined {
  if (typeof v.failure?.retryable === "boolean") return v.failure.retryable
  if (typeof v.outcome?.failure?.retryable === "boolean") return v.outcome.failure.retryable
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

function getReq(dir: string, sid: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `get:${sid}:${token}`
  return {
    v: 1,
    requestId: "req-get-1",
    opId,
    op: "session/get",
    idempotencyKey: opId,
    context: { directory: dir, sessionId: sid },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["session/get"],
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

describe("fd-carrier session/get (B6 parity-only read-only)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises session/get capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("session/get")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("pre-init get rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext.request("session/get", getReq("/tmp", "ses_pre000000000000000001")).then(
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

  it.live("get returns same-directory hit read-only", () =>
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
            return yield* svc.create({ title: "carrier-get" })
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
          const req = getReq(dir, session.id, "hit-tok", { requestId: "req-hit", opId: `get:${session.id}:hit-tok`, idempotencyKey: `get:${session.id}:hit-tok` })
          const raw = yield* Effect.promise(() => ext.request("session/get", req))
          const res = asGetResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.requestId).toBe("req-hit")
          expect(res.opId).toBe(`get:${session.id}:hit-tok`)
          expect(res.idempotencyKey).toBe(`get:${session.id}:hit-tok`)
          expect(res.op).toBe("session/get")
          expect(res.v).toBe(1)
          expect(res.outcome.type).toBe("succeeded")
          expect(res.data?.session.id).toBe(session.id)
          expect(res.data?.session.title).toBe(titleBefore)
          expect(res.data?.session.directory).toBe(session.directory)
          expect(typeof res.data?.session.slug).toBe("string")
          expect(typeof res.data?.session.projectID).toBe("string")
          expect(typeof res.data?.session.version).toBe("string")
          expect(isRecord(res.data?.session.time)).toBeTrue()
          expect(Schema.is(Session.Info)((asRecord(raw).data as Record<string, unknown>).session)).toBeTrue()
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

  it.live("strict validation fails closed without new authority", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        expect(path.isAbsolute(dir)).toBeTrue()
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const session = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-get-strict" })
          }),
        )
        const sid = session.id
        // fresh dir for no-authority proof
        const fresh = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const freshDir = fresh.path
        const beforeSnap = yield* store.snapshot(freshDir)
        expect(Option.isNone(beforeSnap)).toBeTrue()
        const beforeDirs = yield* store.directories()
        expect(beforeDirs.includes(freshDir)).toBeFalse()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases: Array<{ label: string; req: Record<string, unknown> }> = [
            { label: "relative directory", req: getReq("relative/path", sid) },
            { label: "non-empty payload", req: getReq(dir, sid, "tok1", { payload: { filter: "x" } }) },
            { label: "idempotency mismatch", req: getReq(dir, sid, "tok1", { idempotencyKey: `get:${sid}:other` }) },
            { label: "extra root field", req: getReq(dir, sid, "tok1", { sessionRevision: 1 }) },
            { label: "extra context field", req: { ...getReq(dir, sid), context: { directory: dir, sessionId: sid, sessionRevision: 1 } } },
            { label: "empty opId", req: getReq(dir, sid, "tok1", { opId: "", idempotencyKey: "" }) },
            { label: "opId missing token", req: getReq(dir, sid, "tok1", { opId: `get:${sid}`, idempotencyKey: `get:${sid}` }) },
            { label: "opId token with colon", req: getReq(dir, sid, "tok1", { opId: `get:${sid}:a:b`, idempotencyKey: `get:${sid}:a:b` }) },
            { label: "opId session mismatch", req: getReq(dir, sid, "tok1", { opId: `get:ses_mismatch000000000001:tok1`, idempotencyKey: `get:ses_mismatch000000000001:tok1` }) },
            { label: "invalid sessionId", req: { v: 1, requestId: "r-bad", opId: "get:notasession:tok1", op: "session/get", idempotencyKey: "get:notasession:tok1", context: { directory: dir, sessionId: "notasession" }, payload: {} } },
            { label: "wrong op", req: getReq(dir, sid, "tok1", { op: "session/status" }) },
            { label: "fresh-target non-empty payload", req: getReq(freshDir, sid, "fresh-tok", { payload: { filter: "x" } }) },
            { label: "fresh-target opId session mismatch", req: getReq(freshDir, sid, "fresh-tok", { opId: `get:ses_mismatch000000000001:fresh-tok`, idempotencyKey: `get:ses_mismatch000000000001:fresh-tok` }) },
          ]
          for (const c of cases) {
            const res = asGetResult(yield* Effect.promise(() => ext.request("session/get", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            expect(retryableOf(res)).toBe(false)
            expect(res.accepted).toBeFalse()
            expect(res.data).toBeUndefined()
            expect(messageOf(res).length).toBeLessThanOrEqual(200)
          }
          const afterSnap = yield* store.snapshot(freshDir)
          expect(Option.isNone(afterSnap)).toBeTrue()
          const afterDirs = yield* store.directories()
          expect(afterDirs.includes(freshDir)).toBeFalse()
          const colonSid = "ses:colon:00000000000001"
          expect(Schema.is(SessionID)(colonSid)).toBeTrue()
          const colonOpId = `get:${colonSid}:tok1`
          const colonReq = getReq(dir, colonSid, "tok1", { requestId: "req-colon", opId: colonOpId, idempotencyKey: colonOpId })
          const colonRes = asGetResult(yield* Effect.promise(() => ext.request("session/get", colonReq)))
          expect(failureCodeOf(colonRes)).not.toBe("validation.failed")
          expect(colonRes.data).toBeUndefined()
          expect(messageOf(colonRes).length).toBeLessThanOrEqual(200)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("missing session maps to session.not_found without data", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const missing = "ses_missing00000000000000001"
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const req = getReq(dir, missing, "nf-tok", { requestId: "req-nf", opId: `get:${missing}:nf-tok`, idempotencyKey: `get:${missing}:nf-tok` })
          const res = asGetResult(yield* Effect.promise(() => ext.request("session/get", req)))
          expect(res.status).toBe("failed")
          expect(failureCodeOf(res)).toBe("session.not_found")
          expect(retryableOf(res)).toBe(false)
          expect(res.accepted).toBeFalse()
          expect(res.data).toBeUndefined()
          expect(res.requestId).toBe("req-nf")
          expect(res.opId).toBe(`get:${missing}:nf-tok`)
          expect(res.idempotencyKey).toBe(`get:${missing}:nf-tok`)
          expect(messageOf(res).length).toBeLessThanOrEqual(200)
          expect(messageOf(res).includes(missing)).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("cross-directory session maps to scope_mismatch without data", () =>
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
            return yield* svc.create({ title: "carrier-get-scope" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const bad = getReq(tmpB.path, session.id, "scope-tok", { requestId: "req-scope", opId: `get:${session.id}:scope-tok`, idempotencyKey: `get:${session.id}:scope-tok` })
          const res = asGetResult(yield* Effect.promise(() => ext.request("session/get", bad)))
          expect(res.status).toBe("failed")
          expect(failureCodeOf(res)).toBe("scope_mismatch")
          expect(retryableOf(res)).toBe(false)
          expect(res.data).toBeUndefined()
          expect(messageOf(res).length).toBeLessThanOrEqual(200)
          expect(messageOf(res).includes(session.id)).toBeFalse()
          const good = getReq(tmpA.path, session.id, "scope-ok", { requestId: "req-scope-ok", opId: `get:${session.id}:scope-ok`, idempotencyKey: `get:${session.id}:scope-ok` })
          const goodRaw = yield* Effect.promise(() => ext.request("session/get", good))
          const hit = asGetResult(goodRaw)
          expect(hit.status).toBe("succeeded")
          expect(hit.data?.session.id).toBe(session.id)
          expect(Schema.is(Session.Info)((asRecord(goodRaw).data as Record<string, unknown>).session)).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("config fence maps to InstanceUnavailableDuringConfigRebuild without data", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const fenceTmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const fenceDir = fenceTmp.path
        const fakeId = "ses_fence000000000000000001"
        const opId = `get:${fakeId}:fence-tok`
        const req = getReq(fenceDir, fakeId, "fence-tok", { requestId: "req-fence", opId, idempotencyKey: opId })
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(fenceDir)
        try {
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => init(ext))
            const res = asGetResult(yield* Effect.promise(() => ext.request("session/get", req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("InstanceUnavailableDuringConfigRebuild")
            expect(res.data).toBeUndefined()
            expect(messageOf(res).length).toBeLessThanOrEqual(200)
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* ticket.release.pipe(Effect.ignore)
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("directory isolation holds with no side effects", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: tmpA.path })
        const ctxB = yield* store.load({ directory: tmpB.path })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const runB = scoped(ctxB, captured)
        const sessionA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-get-iso-a" })
          }),
        )
        const sessionB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-get-iso-b" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const hitARaw = yield* Effect.promise(() =>
            ext.request(
              "session/get",
              getReq(tmpA.path, sessionA.id, "iso-a", { requestId: "r-iso-a", opId: `get:${sessionA.id}:iso-a`, idempotencyKey: `get:${sessionA.id}:iso-a` }),
            ),
          )
          const hitA = asGetResult(hitARaw)
          expect(hitA.status).toBe("succeeded")
          expect(hitA.data?.session.id).toBe(sessionA.id)
          expect(Schema.is(Session.Info)((asRecord(hitARaw).data as Record<string, unknown>).session)).toBeTrue()
          // sessionB via directory A is out of scope
          const cross = asGetResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/get",
                getReq(tmpA.path, sessionB.id, "iso-x", { requestId: "r-iso-x", opId: `get:${sessionB.id}:iso-x`, idempotencyKey: `get:${sessionB.id}:iso-x` }),
              ),
            ),
          )
          expect(cross.status).toBe("failed")
          expect(failureCodeOf(cross)).toBe("scope_mismatch")
          expect(messageOf(cross).includes(sessionB.id)).toBeFalse()
          expect(messageOf(cross).length).toBeLessThanOrEqual(200)
          // no side effects: rows unchanged, counts stable
          const afterA = yield* runA(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(sessionA.id)
            }),
          )
          expect(afterA.title).toBe("carrier-get-iso-a")
          const afterB = yield* runB(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(sessionB.id)
            }),
          )
          expect(afterB.title).toBe("carrier-get-iso-b")
          const listA = yield* runA(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.list()
            }),
          )
          const listB = yield* runB(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.list()
            }),
          )
          expect(listA.length).toBe(1)
          expect(listB.length).toBe(1)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("unknown method still MethodNotFound after get added", () =>
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
})
