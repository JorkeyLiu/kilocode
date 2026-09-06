import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Context, Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Session } from "../../../src/session/session"
import { canonicalDirectory } from "../../../src/kilocode/session/canonical-directory"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type ListResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { sessions: unknown[]; nextCursor?: unknown }
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

function asListResult(v: unknown): ListResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "experimental/session/list") throw new Error("expected response.op to be experimental/session/list")
  const idempotencyKey = str(record, "idempotencyKey")
  if (idempotencyKey.length === 0) throw new Error("expected non-empty response.idempotencyKey")
  const status = str(record, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  const accepted = record.accepted
  if (typeof accepted !== "boolean") throw new Error("expected boolean response.accepted")
  if (status === "succeeded" && accepted !== true) throw new Error("expected accepted true for succeeded")
  if (status === "failed" && accepted !== false) throw new Error("expected accepted false for failed")
  const outcomeRaw = record.outcome
  if (!isRecord(outcomeRaw)) throw new Error("expected record response.outcome")
  const outcomeType = outcomeRaw.type
  if (typeof outcomeType !== "string") throw new Error("expected string response.outcome.type")
  const outcomeTime = outcomeRaw.time
  if (typeof outcomeTime !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeType !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: ListResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeType, time: outcomeTime }
      : { type: outcomeType, time: outcomeTime, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  let data: ListResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "sessions" && k !== "nextCursor") throw new Error(`unexpected response.data field ${k}`)
    const sessions = (record.data as Record<string, unknown>).sessions
    if (!Array.isArray(sessions)) throw new Error("expected array response.data.sessions")
    const next = (record.data as Record<string, unknown>).nextCursor
    if (next !== undefined && (typeof next !== "number" || !Number.isFinite(next) || next < 0))
      throw new Error("expected non-negative finite response.data.nextCursor")
    data = next !== undefined ? { sessions, nextCursor: next } : { sessions }
  }
  let failure: ListResult["failure"]
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

function messageOf(v: ListResult): string {
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

function failureCodeOf(v: ListResult): string | undefined {
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

function listReq(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `experimental-session-list:${token}`
  return {
    v: 1,
    requestId: "req-list-1",
    opId,
    op: "experimental/session/list",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { filter: {} },
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["experimental/session/list"],
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

function summaryOf(item: unknown): { id: string; directory: string; title: string; updated: number } {
  if (!isRecord(item)) throw new Error("expected record session summary")
  const { id, directory, title, updated } = item as Record<string, unknown>
  if (typeof id !== "string" || !id.startsWith("ses")) throw new Error("expected SessionID summary.id")
  if (typeof directory !== "string" || directory.length === 0) throw new Error("expected non-empty summary.directory")
  if (typeof title !== "string") throw new Error("expected string summary.title")
  if (typeof updated !== "number" || !Number.isFinite(updated) || updated < 0) throw new Error("expected non-negative finite summary.updated")
  const keys = Object.keys(item as Record<string, unknown>)
  for (const k of keys) if (k !== "id" && k !== "directory" && k !== "title" && k !== "updated") throw new Error(`unexpected summary field ${k}`)
  return { id, directory, title, updated }
}

const sleep = (ms: number) => Effect.promise(() => new Promise<void>((r) => setTimeout(r, ms)))

describe("fd-carrier experimental/session/list (parity-only read)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises experimental/session/list capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("experimental/session/list")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("pre-init list rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext.request("experimental/session/list", listReq("/tmp")).then(
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

  it.live("same-directory summaries project safe fields without cursor when not truncated", () =>
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
        const first = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-a" })
          }),
        )
        yield* sleep(15)
        const second = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-b" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() => ext.request("experimental/session/list", listReq(dir, "same-tok", { requestId: "req-same" })))
          const res = asListResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.data?.sessions.length).toBe(2)
          const summaries = (res.data?.sessions ?? []).map(summaryOf)
          const got = summaries.map((s) => s.id).sort()
          expect(got).toEqual([first.id, second.id].sort())
          for (const s of summaries) {
            expect(s.directory).toBe(canon)
            expect(typeof s.title).toBe("string")
            expect(s.updated).toBeGreaterThan(0)
          }
          // Not truncated: nextCursor omitted exactly like production x-next-cursor.
          expect(res.data?.nextCursor).toBeUndefined()
          // Production composition: direct service list matches carrier projection.
          const direct = yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.listGlobal({ directory: dir, limit: 3 })
            }),
          )
          expect(direct.map((d) => d.id as string).sort()).toEqual(got)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("limit truncation emits numeric nextCursor with cursor continuation", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const created: string[] = []
        for (const title of ["carrier-list-1", "carrier-list-2", "carrier-list-3"]) {
          const info = yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title })
            }),
          )
          created.push(info.id)
          yield* sleep(15)
        }
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const page1 = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dir, "page1", { requestId: "req-p1", payload: { filter: { limit: 2 } } }),
              ),
            ),
          )
          expect(page1.status).toBe("succeeded")
          expect(page1.data?.sessions.length).toBe(2)
          const cursor = page1.data?.nextCursor
          expect(typeof cursor).toBe("number")
          expect(Number.isFinite(cursor as number)).toBeTrue()
          expect((cursor as number) >= 0).toBeTrue()
          const page1summaries = (page1.data?.sessions ?? []).map(summaryOf)
          const lastUpdated = page1summaries[page1summaries.length - 1]!.updated
          expect(cursor).toBe(lastUpdated)
          // Production header equivalence: direct truncated list ends at the same updated.
          const direct = yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.listGlobal({ directory: dir, limit: 3 })
            }),
          )
          expect(direct.length).toBe(3)
          expect(cursor).toBe(direct[1]!.time.updated)
          const page2 = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dir, "page2", { requestId: "req-p2", payload: { filter: { limit: 2, cursor } } }),
              ),
            ),
          )
          expect(page2.status).toBe("succeeded")
          const page2summaries = (page2.data?.sessions ?? []).map(summaryOf)
          expect(page2summaries.length).toBe(1)
          for (const s of page2summaries) expect(s.updated).toBeLessThan(cursor as number)
          const page1ids = new Set(page1summaries.map((s) => s.id))
          for (const s of page2summaries) expect(page1ids.has(s.id)).toBeFalse()
          expect(created.sort()).toEqual([...page1summaries, ...page2summaries].map((s) => s.id).sort())
          // Exhausted: no further cursor.
          expect(page2.data?.nextCursor).toBeUndefined()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("timestamp tie group with timestamp-only cursor records current observed continuation (characterization only)", () =>
    Effect.gen(function* () {
      // Characterization-only: records the currently observable continuation when
      // every row in one tie group shares the same time.updated and the carrier
      // emits a timestamp-only nextCursor. This is not a desired ordering or
      // pagination contract, and it does not assert that any observed skip is
      // correct or incorrect.
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const canon = canonicalDirectory(dir)
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const created: string[] = []
        for (const title of ["carrier-list-tie-1", "carrier-list-tie-2", "carrier-list-tie-3"]) {
          const info = yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title })
            }),
          )
          created.push(info.id)
        }
        const pinned = 1700000000000
        yield* run(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            for (const id of created) {
              yield* db.update(SessionTable).set({ time_updated: pinned }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)
            }
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const page1 = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dir, "tie-p1", { requestId: "req-tie-p1", payload: { filter: { limit: 2 } } }),
              ),
            ),
          )
          expect(page1.status).toBe("succeeded")
          expect(page1.data?.sessions.length).toBe(2)
          const cursor = page1.data?.nextCursor
          expect(typeof cursor).toBe("number")
          expect(cursor).toBe(pinned)
          const page1summaries = (page1.data?.sessions ?? []).map(summaryOf)
          for (const s of page1summaries) {
            expect(s.directory).toBe(canon)
            expect(s.updated).toBe(pinned)
          }
          const page1ids = page1summaries.map((s) => s.id)
          const page2 = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dir, "tie-p2", { requestId: "req-tie-p2", payload: { filter: { limit: 2, cursor } } }),
              ),
            ),
          )
          expect(page2.status).toBe("succeeded")
          const page2summaries = (page2.data?.sessions ?? []).map(summaryOf)
          // Currently observed: the timestamp-only cursor filters with
          // time_updated < cursor, so no tie-group remainder is returned.
          // Recorded as observed behavior only, not as a correctness claim.
          expect(page2summaries.length).toBe(0)
          expect(page2.data?.nextCursor).toBeUndefined()
          const page1set = new Set(page1ids)
          for (const s of page2summaries) {
            expect(page1set.has(s.id)).toBeFalse()
            expect(s.directory).toBe(canon)
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

  it.live("strict validation fails closed with redacted bounded failures", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        expect(path.isAbsolute(dir)).toBeTrue()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases: Array<{ label: string; req: Record<string, unknown> }> = [
            { label: "relative directory", req: listReq("relative/path") },
            { label: "missing filter", req: listReq(dir, "tok1", { payload: {} }) },
            { label: "filter not object", req: listReq(dir, "tok1", { payload: { filter: "x" } }) },
            { label: "limit zero", req: listReq(dir, "tok1", { payload: { filter: { limit: 0 } } }) },
            { label: "limit negative", req: listReq(dir, "tok1", { payload: { filter: { limit: -2 } } }) },
            { label: "limit string", req: listReq(dir, "tok1", { payload: { filter: { limit: "2" } } }) },
            { label: "unknown filter field", req: listReq(dir, "tok1", { payload: { filter: { limit: 2, bogus: 1 } } }) },
            { label: "cursor string", req: listReq(dir, "tok1", { payload: { filter: { cursor: "x" } } }) },
            { label: "roots string", req: listReq(dir, "tok1", { payload: { filter: { roots: "yes" } } }) },
            { label: "idempotency mismatch", req: listReq(dir, "tok1", { idempotencyKey: "experimental-session-list:other" }) },
            { label: "extra root field", req: listReq(dir, "tok1", { sessionRevision: 1 }) },
            { label: "extra context field", req: { ...listReq(dir, "tok1"), context: { directory: dir, sessionId: "ses_x" } } },
            { label: "empty opId", req: listReq(dir, "tok1", { opId: "", idempotencyKey: "" }) },
            { label: "opId missing token", req: listReq(dir, "tok1", { opId: "experimental-session-list", idempotencyKey: "experimental-session-list" }) },
            { label: "opId token with colon", req: listReq(dir, "tok1", { opId: "experimental-session-list:a:b", idempotencyKey: "experimental-session-list:a:b" }) },
            { label: "wrong op", req: listReq(dir, "tok1", { op: "session/get" }) },
          ]
          for (const c of cases) {
            const res = asListResult(yield* Effect.promise(() => ext.request("experimental/session/list", c.req)))
            expect(res.status).toBe("failed")
            expect(failureCodeOf(res)).toBe("validation.failed")
            expect(res.accepted).toBeFalse()
            expect(res.data).toBeUndefined()
            expect(messageOf(res).length).toBeLessThanOrEqual(200)
            // Redaction: no session payload, cursor, or directory echo.
            const wire = JSON.stringify(res)
            expect(wire.includes("ses_")).toBeFalse()
            expect(wire.includes("sessions")).toBeFalse()
            expect(wire.includes("nextCursor")).toBeFalse()
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

  it.live("default excludes archived sessions while archived:true includes them", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const plain = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-plain" })
          }),
        )
        yield* sleep(15)
        const archived = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-archived" })
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.setArchived({ sessionID: archived.id, time: Date.now() })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const def = asListResult(
            yield* Effect.promise(() => ext.request("experimental/session/list", listReq(dir, "arch-def", { requestId: "req-arch-def" }))),
          )
          expect(def.status).toBe("succeeded")
          const defIds = (def.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(defIds.includes(plain.id)).toBeTrue()
          expect(defIds.includes(archived.id)).toBeFalse()
          const exp = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dir, "arch-exp", { requestId: "req-arch-exp", payload: { filter: { archived: true } } }),
              ),
            ),
          )
          expect(exp.status).toBe("succeeded")
          const expIds = (exp.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(expIds.includes(archived.id)).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("cross-directory queries stay isolated to the request directory", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        const canonA = canonicalDirectory(dirA)
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const ctxB = yield* store.load({ directory: dirB })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const runB = scoped(ctxB, captured)
        const inA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-dirA" })
          }),
        )
        yield* sleep(15)
        const inB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-dirB" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const resA = asListResult(yield* Effect.promise(() => ext.request("experimental/session/list", listReq(dirA, "iso-a", { requestId: "req-iso-a" }))))
          expect(resA.status).toBe("succeeded")
          const idsA = (resA.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(idsA.includes(inA.id)).toBeTrue()
          expect(idsA.includes(inB.id)).toBeFalse()
          for (const s of (resA.data?.sessions ?? []).map(summaryOf)) expect(s.directory).toBe(canonA)
          const resB = asListResult(yield* Effect.promise(() => ext.request("experimental/session/list", listReq(dirB, "iso-b", { requestId: "req-iso-b" }))))
          expect(resB.status).toBe("succeeded")
          const idsB = (resB.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(idsB.includes(inB.id)).toBeTrue()
          expect(idsB.includes(inA.id)).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("archived:true stays isolated across directories", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        const canonA = canonicalDirectory(dirA)
        const canonB = canonicalDirectory(dirB)
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const ctxB = yield* store.load({ directory: dirB })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const runB = scoped(ctxB, captured)
        const plainA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-arch-iso-plainA" })
          }),
        )
        const archivedA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-arch-iso-archivedA" })
          }),
        )
        yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.setArchived({ sessionID: archivedA.id, time: Date.now() })
          }),
        )
        const plainB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-arch-iso-plainB" })
          }),
        )
        const archivedB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-arch-iso-archivedB" })
          }),
        )
        yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.setArchived({ sessionID: archivedB.id, time: Date.now() })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const resA = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dirA, "arch-iso-a", { requestId: "req-arch-iso-a", payload: { filter: { archived: true } } }),
              ),
            ),
          )
          expect(resA.status).toBe("succeeded")
          const idsA = (resA.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(idsA.includes(archivedA.id)).toBeTrue()
          expect(idsA.includes(plainA.id)).toBeTrue()
          expect(idsA.includes(archivedB.id)).toBeFalse()
          expect(idsA.includes(plainB.id)).toBeFalse()
          for (const s of (resA.data?.sessions ?? []).map(summaryOf)) expect(s.directory).toBe(canonA)
          const resB = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dirB, "arch-iso-b", { requestId: "req-arch-iso-b", payload: { filter: { archived: true } } }),
              ),
            ),
          )
          expect(resB.status).toBe("succeeded")
          const idsB = (resB.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(idsB.includes(archivedB.id)).toBeTrue()
          expect(idsB.includes(plainB.id)).toBeTrue()
          expect(idsB.includes(archivedA.id)).toBeFalse()
          expect(idsB.includes(plainA.id)).toBeFalse()
          for (const s of (resB.data?.sessions ?? []).map(summaryOf)) expect(s.directory).toBe(canonB)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("filter search and roots stay isolated across directories", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        const canonA = canonicalDirectory(dirA)
        const canonB = canonicalDirectory(dirB)
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const ctxB = yield* store.load({ directory: dirB })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const runB = scoped(ctxB, captured)
        const token = "Qz7Tk9Xm2A4B8"
        const rootA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: `carrier-search-${token}-root` })
          }),
        )
        yield* sleep(15)
        const childA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-search-child-plain", parentID: rootA.id })
          }),
        )
        yield* sleep(15)
        const inB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-dirB-plain" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const searchA = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dirA, "search-iso-a", { requestId: "req-search-iso-a", payload: { filter: { search: token } } }),
              ),
            ),
          )
          expect(searchA.status).toBe("succeeded")
          const searchAIds = (searchA.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(searchAIds.includes(rootA.id)).toBeTrue()
          expect(searchAIds.includes(childA.id)).toBeFalse()
          expect(searchAIds.includes(inB.id)).toBeFalse()
          for (const s of (searchA.data?.sessions ?? []).map(summaryOf)) expect(s.directory).toBe(canonA)
          const searchB = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dirB, "search-iso-b", { requestId: "req-search-iso-b", payload: { filter: { search: token } } }),
              ),
            ),
          )
          expect(searchB.status).toBe("succeeded")
          const searchBIds = (searchB.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(searchBIds.includes(rootA.id)).toBeFalse()
          expect(searchBIds.includes(childA.id)).toBeFalse()
          expect(searchBIds.includes(inB.id)).toBeFalse()
          expect(searchBIds.length).toBe(0)
          const rootsA = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dirA, "roots-iso-a", { requestId: "req-roots-iso-a", payload: { filter: { roots: true } } }),
              ),
            ),
          )
          expect(rootsA.status).toBe("succeeded")
          const rootsAIds = (rootsA.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(rootsAIds.includes(rootA.id)).toBeTrue()
          expect(rootsAIds.includes(childA.id)).toBeFalse()
          expect(rootsAIds.includes(inB.id)).toBeFalse()
          for (const s of (rootsA.data?.sessions ?? []).map(summaryOf)) expect(s.directory).toBe(canonA)
          const rootsB = asListResult(
            yield* Effect.promise(() =>
              ext.request(
                "experimental/session/list",
                listReq(dirB, "roots-iso-b", { requestId: "req-roots-iso-b", payload: { filter: { roots: true } } }),
              ),
            ),
          )
          expect(rootsB.status).toBe("succeeded")
          const rootsBIds = (rootsB.data?.sessions ?? []).map(summaryOf).map((s) => s.id)
          expect(rootsBIds.includes(inB.id)).toBeTrue()
          expect(rootsBIds.includes(rootA.id)).toBeFalse()
          expect(rootsBIds.includes(childA.id)).toBeFalse()
          for (const s of (rootsB.data?.sessions ?? []).map(summaryOf)) expect(s.directory).toBe(canonB)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("completed remove omits victim while retaining sibling control", () =>
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
        const victim = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-remove-victim" })
          }),
        )
        const control = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-remove-control" })
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.remove(victim.id)
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const res = asListResult(
            yield* Effect.promise(() => ext.request("experimental/session/list", listReq(dir, "remove-omit", { requestId: "req-remove-omit" }))),
          )
          expect(res.status).toBe("succeeded")
          const summaries = (res.data?.sessions ?? []).map(summaryOf)
          const ids = summaries.map((s) => s.id)
          expect(ids.includes(victim.id)).toBeFalse()
          expect(ids.includes(control.id)).toBeTrue()
          for (const s of summaries) expect(s.directory).toBe(canon)
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
