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
import { canonicalDirectory } from "../../../src/kilocode/session/canonical-directory"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { GlobalBus } from "../../../src/bus/global"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type ChildResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { children: unknown[] }
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

function outcomeOf(v: unknown): ChildResult["outcome"] {
  if (!isRecord(v)) throw new Error("expected record response.outcome")
  const type = v.type
  if (typeof type !== "string") throw new Error("expected string response.outcome.type")
  const time = v.time
  if (typeof time !== "number") throw new Error("expected number response.outcome.time")
  if (v.failure === undefined) return { type, time }
  return { type, time, failure: failureOf(v.failure, "response.outcome.failure") }
}

function asChildResult(v: unknown): ChildResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "session/children") throw new Error("expected response.op to be session/children")
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
  if (typeof outcome.time !== "number" || !(outcome.time > 0)) throw new Error("expected positive response.outcome.time")
  let data: ChildResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "children") throw new Error(`unexpected response.data field ${k}`)
    const children = (record.data as Record<string, unknown>).children
    if (!Array.isArray(children)) throw new Error("expected array response.data.children")
    data = { children }
  }
  let failure: ChildResult["failure"]
  if (record.failure !== undefined) failure = failureOf(record.failure, "response.failure")
  if (status === "succeeded") {
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey for succeeded")
    if (data === undefined) throw new Error("expected response.data for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
    if (outcome.failure !== undefined) throw new Error("expected no response.outcome.failure for succeeded")
  } else {
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code) throw new Error("expected response.failure.code to equal response.outcome.failure.code")
    if (typeof failure.message === "string" && failure.message.length > 200) throw new Error("expected bounded response.failure.message")
  }
  return { v: 1, requestId, opId, op, idempotencyKey, status, outcome, accepted, ...(data !== undefined ? { data } : {}), ...(failure !== undefined ? { failure } : {}) }
}

function messageOf(v: ChildResult): string {
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

function failureCodeOf(v: ChildResult): string | undefined {
  if (typeof v.failure?.code === "string") return v.failure.code
  if (typeof v.outcome?.failure?.code === "string") return v.outcome.failure.code
  return undefined
}

function retryableOf(v: ChildResult): boolean | undefined {
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

function childReq(dir: string, pid: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `children:${pid}:${token}`
  return {
    v: 1,
    requestId: "req-child-1",
    opId,
    op: "session/children",
    idempotencyKey: opId,
    context: { directory: dir, parentSessionId: pid },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["session/children"],
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

function childIdOf(item: unknown): string {
  if (!isRecord(item)) throw new Error("expected record child")
  const id = item.id
  if (typeof id !== "string") throw new Error("expected string child.id")
  return id
}

const watched = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.diff",
  "session.error",
  "session.turn.open",
  "session.turn.close",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
])

function observe(dir: string, seen: string[]) {
  const handler = (event: { directory?: string; payload?: { type?: string } }) => {
    if (event.directory !== dir) return
    const type = event.payload?.type
    if (typeof type !== "string") return
    if (watched.has(type)) seen.push(type)
  }
  GlobalBus.on("event", handler)
  return () => GlobalBus.off("event", handler)
}

describe("fd-carrier session/children (B8 strict read-only)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises session/children capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("session/children")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("pre-init children rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext.request("session/children", childReq("/tmp", "ses_pre000000000000000001")).then(
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

  it.live("empty parent returns empty children without order claim", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const parent = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-empty" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request(
              "session/children",
              childReq(dir, parent.id, "empty-tok", { requestId: "req-empty", opId: `children:${parent.id}:empty-tok`, idempotencyKey: `children:${parent.id}:empty-tok` }),
            ),
          )
          const res = asChildResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.data?.children).toEqual([])
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("nonempty same-directory children preserve canonical directory with unordered set semantics", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const canon = canonicalDirectory(dir)
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const parent = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-parent" })
          }),
        )
        const first = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ parentID: parent.id, title: "carrier-children-a" })
          }),
        )
        const second = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ parentID: parent.id, title: "carrier-children-b" })
          }),
        )
        expect(first.parentID).toBe(parent.id)
        expect(second.parentID).toBe(parent.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request(
              "session/children",
              childReq(dir, parent.id, "full-tok", { requestId: "req-full", opId: `children:${parent.id}:full-tok`, idempotencyKey: `children:${parent.id}:full-tok` }),
            ),
          )
          const res = asChildResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.data?.children.length).toBe(2)
          for (const item of res.data?.children ?? []) {
            expect(Schema.is(Session.Info)(item)).toBeTrue()
            if (!isRecord(item)) throw new Error("expected record child")
            expect(item.parentID).toBe(parent.id)
            expect(typeof item.directory).toBe("string")
            expect(item.directory).toBe(canon)
            expect(canonicalDirectory(item.directory as string)).toBe(canon)
          }
          const got = (res.data?.children ?? []).map(childIdOf).sort()
          expect(got).toEqual([first.id, second.id].sort())
          const direct = yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.children(parent.id)
            }),
          )
          expect(direct.map((c) => c.id as string).sort()).toEqual(got)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("cross-directory parent-linked child excluded by parent-project scope", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        const canonB = canonicalDirectory(dirB)
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const ctxB = yield* store.load({ directory: dirB })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const runB = scoped(ctxB, captured)
        const parent = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-xparent" })
          }),
        )
        const same = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ parentID: parent.id, title: "carrier-children-same" })
          }),
        )
        const cross = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ parentID: parent.id, title: "carrier-children-cross" })
          }),
        )
        expect(cross.parentID).toBe(parent.id)
        expect(canonicalDirectory(cross.directory)).toBe(canonB)
        expect(cross.directory).not.toBe(canonicalDirectory(dirA))
        const direct = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.children(parent.id)
          }),
        )
        expect(direct.map((c) => c.id as string).sort()).toEqual([same.id].sort())
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request(
              "session/children",
              childReq(dirA, parent.id, "x-tok", { requestId: "req-x", opId: `children:${parent.id}:x-tok`, idempotencyKey: `children:${parent.id}:x-tok` }),
            ),
          )
          const res = asChildResult(raw)
          expect(res.status).toBe("succeeded")
          expect((res.data?.children ?? []).map(childIdOf).sort()).toEqual([same.id].sort())
          expect((res.data?.children ?? []).map(childIdOf).includes(cross.id)).toBeFalse()
          for (const item of res.data?.children ?? []) {
            expect(Schema.is(Session.Info)(item)).toBeTrue()
            if (!isRecord(item)) throw new Error("expected record child")
            expect(item.parentID).toBe(parent.id)
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
        const parent = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-strict" })
          }),
        )
        const pid = parent.id
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
            { label: "relative directory", req: childReq("relative/path", pid) },
            { label: "non-empty payload", req: childReq(dir, pid, "tok1", { payload: { filter: "x" } }) },
            { label: "idempotency mismatch", req: childReq(dir, pid, "tok1", { idempotencyKey: `children:${pid}:other` }) },
            { label: "extra root field", req: childReq(dir, pid, "tok1", { sessionRevision: 1 }) },
            { label: "extra context field", req: { ...childReq(dir, pid), context: { directory: dir, parentSessionId: pid, sessionId: pid } } },
            { label: "missing parentSessionId", req: { v: 1, requestId: "r-miss", opId: `children:${pid}:tok1`, op: "session/children", idempotencyKey: `children:${pid}:tok1`, context: { directory: dir }, payload: {} } },
            { label: "empty opId", req: childReq(dir, pid, "tok1", { opId: "", idempotencyKey: "" }) },
            { label: "opId missing token", req: childReq(dir, pid, "tok1", { opId: `children:${pid}`, idempotencyKey: `children:${pid}` }) },
            { label: "opId token with colon", req: childReq(dir, pid, "tok1", { opId: `children:${pid}:a:b`, idempotencyKey: `children:${pid}:a:b` }) },
            { label: "opId parent mismatch", req: childReq(dir, pid, "tok1", { opId: `children:ses_mismatch000000000001:tok1`, idempotencyKey: `children:ses_mismatch000000000001:tok1` }) },
            {
              label: "invalid parentSessionId",
              req: { v: 1, requestId: "r-bad", opId: "children:notasession:tok1", op: "session/children", idempotencyKey: "children:notasession:tok1", context: { directory: dir, parentSessionId: "notasession" }, payload: {} },
            },
            { label: "wrong op", req: childReq(dir, pid, "tok1", { op: "session/get" }) },
            { label: "fresh-target non-empty payload", req: childReq(freshDir, pid, "fresh-tok", { payload: { filter: "x" } }) },
            { label: "fresh-target opId parent mismatch", req: childReq(freshDir, pid, "fresh-tok", { opId: `children:ses_mismatch000000000001:fresh-tok`, idempotencyKey: `children:ses_mismatch000000000001:fresh-tok` }) },
          ]
          for (const c of cases) {
            const res = asChildResult(yield* Effect.promise(() => ext.request("session/children", c.req)))
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
          const colonPid = "ses:colon:00000000000001"
          expect(Schema.is(SessionID)(colonPid)).toBeTrue()
          const colonOpId = `children:${colonPid}:tok1`
          const colonReq = childReq(dir, colonPid, "tok1", { requestId: "req-colon", opId: colonOpId, idempotencyKey: colonOpId })
          const colonRes = asChildResult(yield* Effect.promise(() => ext.request("session/children", colonReq)))
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

  it.live("missing parent maps to session.not_found without data", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const missing = "ses_missing00000000000000001"
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const req = childReq(dir, missing, "nf-tok", { requestId: "req-nf", opId: `children:${missing}:nf-tok`, idempotencyKey: `children:${missing}:nf-tok` })
          const res = asChildResult(yield* Effect.promise(() => ext.request("session/children", req)))
          expect(res.status).toBe("failed")
          expect(failureCodeOf(res)).toBe("session.not_found")
          expect(retryableOf(res)).toBe(false)
          expect(res.accepted).toBeFalse()
          expect(res.data).toBeUndefined()
          expect(res.requestId).toBe("req-nf")
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

  it.live("cross-directory parent maps to scope_mismatch without data", () =>
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
        const parent = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-scope" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const bad = childReq(tmpB.path, parent.id, "scope-tok", { requestId: "req-scope", opId: `children:${parent.id}:scope-tok`, idempotencyKey: `children:${parent.id}:scope-tok` })
          const res = asChildResult(yield* Effect.promise(() => ext.request("session/children", bad)))
          expect(res.status).toBe("failed")
          expect(failureCodeOf(res)).toBe("scope_mismatch")
          expect(retryableOf(res)).toBe(false)
          expect(res.data).toBeUndefined()
          expect(messageOf(res).length).toBeLessThanOrEqual(200)
          expect(messageOf(res).includes(parent.id)).toBeFalse()
          const good = childReq(tmpA.path, parent.id, "scope-ok", { requestId: "req-scope-ok", opId: `children:${parent.id}:scope-ok`, idempotencyKey: `children:${parent.id}:scope-ok` })
          const hit = asChildResult(yield* Effect.promise(() => ext.request("session/children", good)))
          expect(hit.status).toBe("succeeded")
          expect(Array.isArray(hit.data?.children)).toBeTrue()
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
        const opId = `children:${fakeId}:fence-tok`
        const req = childReq(fenceDir, fakeId, "fence-tok", { requestId: "req-fence", opId, idempotencyKey: opId })
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(fenceDir)
        try {
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => init(ext))
            const res = asChildResult(yield* Effect.promise(() => ext.request("session/children", req)))
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

  it.live("reads emit no session/message events across success and failures", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirB = tmpB.path
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const parent = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-noevent" })
          }),
        )
        const child = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ parentID: parent.id, title: "carrier-children-noevent-kid" })
          }),
        )
        const seen: string[] = []
        const offA = observe(dirA, seen)
        const offB = observe(dirB, seen)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const hitRaw = yield* Effect.promise(() =>
            ext.request(
              "session/children",
              childReq(dirA, parent.id, "evt-hit", { requestId: "req-evt-hit", opId: `children:${parent.id}:evt-hit`, idempotencyKey: `children:${parent.id}:evt-hit` }),
            ),
          )
          const hit = asChildResult(hitRaw)
          expect(hit.status).toBe("succeeded")
          expect((hit.data?.children ?? []).map(childIdOf).sort()).toEqual([child.id].sort())
          const invalid = asChildResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/children",
                childReq(dirA, parent.id, "evt-bad", { requestId: "req-evt-bad", opId: `children:${parent.id}:evt-bad:extra`, idempotencyKey: `children:${parent.id}:evt-bad:extra`, payload: {} }),
              ),
            ),
          )
          expect(invalid.status).toBe("failed")
          expect(failureCodeOf(invalid)).toBe("validation.failed")
          expect(invalid.data).toBeUndefined()
          const missing = "ses_missing00000000000000001"
          const notfound = asChildResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/children",
                childReq(dirA, missing, "evt-nf", { requestId: "req-evt-nf", opId: `children:${missing}:evt-nf`, idempotencyKey: `children:${missing}:evt-nf` }),
              ),
            ),
          )
          expect(notfound.status).toBe("failed")
          expect(failureCodeOf(notfound)).toBe("session.not_found")
          expect(notfound.data).toBeUndefined()
          const scope = asChildResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/children",
                childReq(dirB, parent.id, "evt-scope", { requestId: "req-evt-scope", opId: `children:${parent.id}:evt-scope`, idempotencyKey: `children:${parent.id}:evt-scope` }),
              ),
            ),
          )
          expect(scope.status).toBe("failed")
          expect(failureCodeOf(scope)).toBe("scope_mismatch")
          expect(scope.data).toBeUndefined()
          expect(seen).toEqual([])
        } finally {
          carrier.dispose()
          ext.dispose()
          offA()
          offB()
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
        const parentA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-iso-a" })
          }),
        )
        const kidA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ parentID: parentA.id, title: "carrier-children-iso-kid" })
          }),
        )
        const parentB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-iso-b" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const hitARaw = yield* Effect.promise(() =>
            ext.request(
              "session/children",
              childReq(tmpA.path, parentA.id, "iso-a", { requestId: "r-iso-a", opId: `children:${parentA.id}:iso-a`, idempotencyKey: `children:${parentA.id}:iso-a` }),
            ),
          )
          const hitA = asChildResult(hitARaw)
          expect(hitA.status).toBe("succeeded")
          expect((hitA.data?.children ?? []).map(childIdOf).sort()).toEqual([kidA.id].sort())
          const cross = asChildResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/children",
                childReq(tmpA.path, parentB.id, "iso-x", { requestId: "r-iso-x", opId: `children:${parentB.id}:iso-x`, idempotencyKey: `children:${parentB.id}:iso-x` }),
              ),
            ),
          )
          expect(cross.status).toBe("failed")
          expect(failureCodeOf(cross)).toBe("scope_mismatch")
          expect(messageOf(cross).includes(parentB.id)).toBeFalse()
          const afterA = yield* runA(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.children(parentA.id)
            }),
          )
          expect(afterA.map((c) => c.id as string).sort()).toEqual([kidA.id].sort())
          const afterB = yield* runB(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.children(parentB.id)
            }),
          )
          expect(afterB).toEqual([])
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("fresh mismatched directory rejects scope_mismatch without booting target", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const parent = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-children-fresh-mismatch" })
          }),
        )
        const fresh = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const freshDir = fresh.path
        const freshCanon = canonicalDirectory(freshDir)
        const beforeSnap = yield* store.snapshot(freshDir)
        expect(Option.isNone(beforeSnap)).toBeTrue()
        const beforeDirs = yield* store.directories()
        expect(beforeDirs.includes(freshDir)).toBeFalse()
        expect(beforeDirs.includes(freshCanon)).toBeFalse()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const bad = childReq(freshDir, parent.id, "fresh-scope-tok", {
            requestId: "req-fresh-scope",
            opId: `children:${parent.id}:fresh-scope-tok`,
            idempotencyKey: `children:${parent.id}:fresh-scope-tok`,
          })
          const res = asChildResult(yield* Effect.promise(() => ext.request("session/children", bad)))
          expect(res.status).toBe("failed")
          expect(failureCodeOf(res)).toBe("scope_mismatch")
          expect(retryableOf(res)).toBe(false)
          expect(res.data).toBeUndefined()
          expect(messageOf(res).length).toBeLessThanOrEqual(200)
          expect(messageOf(res).includes(parent.id)).toBeFalse()
          const afterSnap = yield* store.snapshot(freshDir)
          expect(Option.isNone(afterSnap)).toBeTrue()
          const afterDirs = yield* store.directories()
          expect(afterDirs.includes(freshDir)).toBeFalse()
          expect(afterDirs.includes(freshCanon)).toBeFalse()
          const good = childReq(dirA, parent.id, "fresh-ok", {
            requestId: "req-fresh-ok",
            opId: `children:${parent.id}:fresh-ok`,
            idempotencyKey: `children:${parent.id}:fresh-ok`,
          })
          const hit = asChildResult(yield* Effect.promise(() => ext.request("session/children", good)))
          expect(hit.status).toBe("succeeded")
          expect(Array.isArray(hit.data?.children)).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("unknown method still MethodNotFound after children added", () =>
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
