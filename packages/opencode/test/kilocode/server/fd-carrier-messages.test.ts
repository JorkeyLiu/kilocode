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
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../../src/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
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

type MsgResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { messages: unknown[]; nextCursor?: string }
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

function outcomeOf(v: unknown): MsgResult["outcome"] {
  if (!isRecord(v)) throw new Error("expected record response.outcome")
  const type = v.type
  if (typeof type !== "string") throw new Error("expected string response.outcome.type")
  const time = v.time
  if (typeof time !== "number") throw new Error("expected number response.outcome.time")
  if (v.failure === undefined) return { type, time }
  return { type, time, failure: failureOf(v.failure, "response.outcome.failure") }
}

function asMsgResult(v: unknown): MsgResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  if (requestId.length === 0) throw new Error("expected non-empty response.requestId")
  const opId = str(record, "opId")
  if (opId.length === 0) throw new Error("expected non-empty response.opId")
  const op = str(record, "op")
  if (op !== "session/messages") throw new Error("expected response.op to be session/messages")
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
  let data: MsgResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "messages" && k !== "nextCursor") throw new Error(`unexpected response.data field ${k}`)
    const messages = (record.data as Record<string, unknown>).messages
    if (!Array.isArray(messages)) throw new Error("expected array response.data.messages")
    const next = (record.data as Record<string, unknown>).nextCursor
    if (next !== undefined && typeof next !== "string") throw new Error("expected string response.data.nextCursor")
    data = next !== undefined ? { messages, nextCursor: next } : { messages }
  }
  let failure: MsgResult["failure"]
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
    if (failure.code !== outcome.failure.code)
      throw new Error("expected response.failure.code to equal response.outcome.failure.code")
    if (typeof failure.message === "string" && failure.message.length > 200)
      throw new Error("expected bounded response.failure.message")
  }
  return { v: 1, requestId, opId, op, idempotencyKey, status, outcome, accepted, ...(data !== undefined ? { data } : {}), ...(failure !== undefined ? { failure } : {}) }
}

function messageOf(v: MsgResult): string {
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

function failureCodeOf(v: MsgResult): string | undefined {
  if (typeof v.failure?.code === "string") return v.failure.code
  if (typeof v.outcome?.failure?.code === "string") return v.outcome.failure.code
  return undefined
}

function retryableOf(v: MsgResult): boolean | undefined {
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

function msgsReq(
  dir: string,
  sid: string,
  token = "tok1",
  payload: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const opId = `messages:${sid}:${token}`
  return {
    v: 1,
    requestId: "req-msg-1",
    opId,
    op: "session/messages",
    idempotencyKey: opId,
    context: { directory: dir, sessionId: sid },
    payload,
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["session/messages"],
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

function infoIdOf(item: unknown): string {
  if (!isRecord(item)) throw new Error("expected record message item")
  const info = item.info
  if (!isRecord(info)) throw new Error("expected record message.info")
  if (typeof info.id !== "string") throw new Error("expected string message.info.id")
  return info.id
}

function clean(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v))
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

describe("fd-carrier session/messages (B7 diagnostic-only read-only)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises session/messages capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("session/messages")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("pre-init messages rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext.request("session/messages", msgsReq("/tmp", "ses_pre000000000000000001")).then(
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

  it.live("full and paged reads match app-layer semantics with cursor only if more", () =>
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
            return yield* svc.create({ title: "carrier-messages" })
          }),
        )
        const base = Date.now()
        const seeded: string[] = []
        for (let i = 0; i < 3; i++) {
          const mid = MessageID.ascending()
          seeded.push(mid)
          yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              yield* svc.updateMessage({
                id: mid,
                sessionID: session.id,
                role: "user",
                time: { created: base + i * 1000 },
                agent: "test",
                model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
                tools: {},
              } satisfies SessionV1.User)
              yield* svc.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: mid,
                type: "text",
                text: `seeded ${i}`,
              })
            }),
          )
        }
        const expectedFull = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.messages({ sessionID: session.id })
          }),
        )
        expect(expectedFull.length).toBe(3)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const fullRaw = yield* Effect.promise(() =>
            ext.request(
              "session/messages",
              msgsReq(dir, session.id, "full-tok", {}, { requestId: "req-full", opId: `messages:${session.id}:full-tok`, idempotencyKey: `messages:${session.id}:full-tok` }),
            ),
          )
          const full = asMsgResult(fullRaw)
          expect(full.status).toBe("succeeded")
          expect(full.accepted).toBeTrue()
          expect(full.data?.messages.length).toBe(3)
          expect((full.data as Record<string, unknown>).nextCursor).toBeUndefined()
          const fullIds = (full.data?.messages ?? []).map(infoIdOf)
          const expectedIds = expectedFull.map((m) => m.info.id)
          expect(fullIds).toEqual(expectedIds)
          for (const item of full.data?.messages ?? []) {
            expect(Schema.is(SessionV1.WithParts)(item)).toBeTrue()
          }
          expect(clean(full.data?.messages)).toEqual(clean(expectedFull))
          const zeroRaw = yield* Effect.promise(() =>
            ext.request(
              "session/messages",
              msgsReq(dir, session.id, "zero-tok", { limit: 0 }, { requestId: "req-zero", opId: `messages:${session.id}:zero-tok`, idempotencyKey: `messages:${session.id}:zero-tok` }),
            ),
          )
          const zero = asMsgResult(zeroRaw)
          expect(zero.status).toBe("succeeded")
          expect(zero.data?.messages.length).toBe(3)
          expect((zero.data as Record<string, unknown>).nextCursor).toBeUndefined()
          expect((zero.data?.messages ?? []).map(infoIdOf)).toEqual(expectedIds)
          expect(clean(zero.data?.messages)).toEqual(clean(expectedFull))
          const pageRaw = yield* Effect.promise(() =>
            ext.request(
              "session/messages",
              msgsReq(dir, session.id, "page-tok", { limit: 2 }, { requestId: "req-page", opId: `messages:${session.id}:page-tok`, idempotencyKey: `messages:${session.id}:page-tok` }),
            ),
          )
          const page = asMsgResult(pageRaw)
          expect(page.status).toBe("succeeded")
          const expectedPage = yield* run(
            Effect.gen(function* () {
              return yield* MessageV2.page({ sessionID: session.id, limit: 2 })
            }),
          )
          expect((page.data?.messages ?? []).map(infoIdOf)).toEqual(expectedPage.items.map((m) => m.info.id))
          expect(clean(page.data?.messages)).toEqual(clean(expectedPage.items))
          for (const item of page.data?.messages ?? []) {
            expect(Schema.is(SessionV1.WithParts)(item)).toBeTrue()
          }
          if (expectedPage.cursor) {
            expect(typeof page.data?.nextCursor).toBe("string")
            expect(page.data?.nextCursor).toBe(expectedPage.cursor)
            const nextRaw = yield* Effect.promise(() =>
              ext.request(
                "session/messages",
                msgsReq(
                  dir,
                  session.id,
                  "page2-tok",
                  { limit: 2, before: expectedPage.cursor as string },
                  { requestId: "req-page2", opId: `messages:${session.id}:page2-tok`, idempotencyKey: `messages:${session.id}:page2-tok` },
                ),
              ),
            )
            const next = asMsgResult(nextRaw)
            expect(next.status).toBe("succeeded")
            const expectedNext = yield* run(
              Effect.gen(function* () {
                return yield* MessageV2.page({ sessionID: session.id, limit: 2, before: expectedPage.cursor as string })
              }),
            )
            expect((next.data?.messages ?? []).map(infoIdOf)).toEqual(expectedNext.items.map((m) => m.info.id))
            expect(clean(next.data?.messages)).toEqual(clean(expectedNext.items))
            for (const item of next.data?.messages ?? []) {
              expect(Schema.is(SessionV1.WithParts)(item)).toBeTrue()
            }
            if (!expectedNext.cursor) expect((next.data as Record<string, unknown>).nextCursor).toBeUndefined()
          } else {
            expect((page.data as Record<string, unknown>).nextCursor).toBeUndefined()
          }
          const badCursor = asMsgResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/messages",
                msgsReq(dir, session.id, "badcur-tok", { limit: 2, before: "bad" }, { requestId: "r-badcur", opId: `messages:${session.id}:badcur-tok`, idempotencyKey: `messages:${session.id}:badcur-tok` }),
              ),
            ),
          )
          expect(badCursor.status).toBe("failed")
          expect(failureCodeOf(badCursor)).toBe("validation.failed")
          expect(badCursor.data).toBeUndefined()
          const badZero = asMsgResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/messages",
                msgsReq(dir, session.id, "badzero-tok", { limit: 0, before: "bad" }, { requestId: "r-badzero", opId: `messages:${session.id}:badzero-tok`, idempotencyKey: `messages:${session.id}:badzero-tok` }),
              ),
            ),
          )
          expect(badZero.status).toBe("failed")
          expect(failureCodeOf(badZero)).toBe("validation.failed")
          expect(badZero.data).toBeUndefined()
          if (expectedPage.cursor) {
            const validZero = asMsgResult(
              yield* Effect.promise(() =>
                ext.request(
                  "session/messages",
                  msgsReq(
                    dir,
                    session.id,
                    "validzero-tok",
                    { limit: 0, before: expectedPage.cursor as string },
                    { requestId: "r-validzero", opId: `messages:${session.id}:validzero-tok`, idempotencyKey: `messages:${session.id}:validzero-tok` },
                  ),
                ),
              ),
            )
            expect(validZero.status).toBe("succeeded")
            expect((validZero.data?.messages ?? []).map(infoIdOf)).toEqual(expectedIds)
            expect(clean(validZero.data?.messages)).toEqual(clean(expectedFull))
            expect((validZero.data as Record<string, unknown>).nextCursor).toBeUndefined()
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
        const session = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-messages-strict" })
          }),
        )
        const sid = session.id
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
            { label: "relative directory", req: msgsReq("relative/path", sid) },
            { label: "before without limit", req: msgsReq(dir, sid, "tok1", { before: "abc" }) },
            { label: "malformed before with zero limit", req: msgsReq(dir, sid, "tok1", { limit: 0, before: "abc" }) },
            { label: "negative limit", req: msgsReq(dir, sid, "tok1", { limit: -1 }) },
            { label: "fractional limit", req: msgsReq(dir, sid, "tok1", { limit: 1.5 }) },
            { label: "string limit", req: msgsReq(dir, sid, "tok1", { limit: "2" }) },
            { label: "NaN limit", req: msgsReq(dir, sid, "tok1", { limit: Number.NaN }) },
            { label: "empty before", req: msgsReq(dir, sid, "tok1", { limit: 2, before: "" }) },
            { label: "non-string before", req: msgsReq(dir, sid, "tok1", { limit: 2, before: 42 }) },
            { label: "extra payload field", req: msgsReq(dir, sid, "tok1", { limit: 2, revision: 1 }) },
            { label: "idempotency mismatch", req: msgsReq(dir, sid, "tok1", {}, { idempotencyKey: `messages:${sid}:other` }) },
            { label: "extra root field", req: msgsReq(dir, sid, "tok1", {}, { sessionRevision: 1 }) },
            { label: "extra context field", req: { ...msgsReq(dir, sid), context: { directory: dir, sessionId: sid, sessionRevision: 1 } } },
            { label: "empty opId", req: msgsReq(dir, sid, "tok1", {}, { opId: "", idempotencyKey: "" }) },
            { label: "opId missing token", req: msgsReq(dir, sid, "tok1", {}, { opId: `messages:${sid}`, idempotencyKey: `messages:${sid}` }) },
            { label: "opId token with colon", req: msgsReq(dir, sid, "tok1", {}, { opId: `messages:${sid}:a:b`, idempotencyKey: `messages:${sid}:a:b` }) },
            { label: "opId session mismatch", req: msgsReq(dir, sid, "tok1", {}, { opId: `messages:ses_mismatch000000000001:tok1`, idempotencyKey: `messages:ses_mismatch000000000001:tok1` }) },
            {
              label: "invalid sessionId",
              req: { v: 1, requestId: "r-bad", opId: "messages:notasession:tok1", op: "session/messages", idempotencyKey: "messages:notasession:tok1", context: { directory: dir, sessionId: "notasession" }, payload: {} },
            },
            { label: "wrong op", req: msgsReq(dir, sid, "tok1", {}, { op: "session/get" }) },
            { label: "fresh-target before without limit", req: msgsReq(freshDir, sid, "fresh-tok", { before: "abc" }) },
            { label: "fresh-target malformed cursor", req: msgsReq(freshDir, sid, "fresh-badcur", { limit: 2, before: "bad" }) },
            { label: "fresh-target malformed cursor zero limit", req: msgsReq(freshDir, sid, "fresh-badzero", { limit: 0, before: "bad" }) },
          ]
          for (const c of cases) {
            const res = asMsgResult(yield* Effect.promise(() => ext.request("session/messages", c.req)))
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
        } finally {
          carrier.dispose()
          ext.dispose()
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
        const session = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-messages-noevent" })
          }),
        )
        const base = Date.now()
        for (let i = 0; i < 2; i++) {
          const mid = MessageID.ascending()
          yield* runA(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              yield* svc.updateMessage({
                id: mid,
                sessionID: session.id,
                role: "user",
                time: { created: base + i * 1000 },
                agent: "test",
                model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
                tools: {},
              } satisfies SessionV1.User)
              yield* svc.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: mid,
                type: "text",
                text: `noevent ${i}`,
              })
            }),
          )
        }
        const expectedFull = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.messages({ sessionID: session.id })
          }),
        )
        const expectedPage = yield* runA(
          Effect.gen(function* () {
            return yield* MessageV2.page({ sessionID: session.id, limit: 1 })
          }),
        )
        const seen: string[] = []
        const offA = observe(dirA, seen)
        const offB = observe(dirB, seen)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const fullRaw = yield* Effect.promise(() =>
            ext.request(
              "session/messages",
              msgsReq(dirA, session.id, "evt-full", {}, { requestId: "req-evt-full", opId: `messages:${session.id}:evt-full`, idempotencyKey: `messages:${session.id}:evt-full` }),
            ),
          )
          const full = asMsgResult(fullRaw)
          expect(full.status).toBe("succeeded")
          expect(clean(full.data?.messages)).toEqual(clean(expectedFull))
          const pagedRaw = yield* Effect.promise(() =>
            ext.request(
              "session/messages",
              msgsReq(dirA, session.id, "evt-page", { limit: 1 }, { requestId: "req-evt-page", opId: `messages:${session.id}:evt-page`, idempotencyKey: `messages:${session.id}:evt-page` }),
            ),
          )
          const paged = asMsgResult(pagedRaw)
          expect(paged.status).toBe("succeeded")
          expect(clean(paged.data?.messages)).toEqual(clean(expectedPage.items))
          const invalid = asMsgResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/messages",
                msgsReq(dirA, session.id, "evt-bad", { limit: 1, before: "bad" }, { requestId: "req-evt-bad", opId: `messages:${session.id}:evt-bad`, idempotencyKey: `messages:${session.id}:evt-bad` }),
              ),
            ),
          )
          expect(invalid.status).toBe("failed")
          expect(failureCodeOf(invalid)).toBe("validation.failed")
          expect(invalid.data).toBeUndefined()
          const missing = "ses_missing00000000000000001"
          const notfound = asMsgResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/messages",
                msgsReq(dirA, missing, "evt-nf", {}, { requestId: "req-evt-nf", opId: `messages:${missing}:evt-nf`, idempotencyKey: `messages:${missing}:evt-nf` }),
              ),
            ),
          )
          expect(notfound.status).toBe("failed")
          expect(failureCodeOf(notfound)).toBe("session.not_found")
          expect(notfound.data).toBeUndefined()
          const scope = asMsgResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/messages",
                msgsReq(dirB, session.id, "evt-scope", {}, { requestId: "req-evt-scope", opId: `messages:${session.id}:evt-scope`, idempotencyKey: `messages:${session.id}:evt-scope` }),
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
          const req = msgsReq(dir, missing, "nf-tok", {}, { requestId: "req-nf", opId: `messages:${missing}:nf-tok`, idempotencyKey: `messages:${missing}:nf-tok` })
          const res = asMsgResult(yield* Effect.promise(() => ext.request("session/messages", req)))
          expect(res.status).toBe("failed")
          expect(failureCodeOf(res)).toBe("session.not_found")
          expect(retryableOf(res)).toBe(false)
          expect(res.accepted).toBeFalse()
          expect(res.data).toBeUndefined()
          expect(res.requestId).toBe("req-nf")
          expect(messageOf(res).length).toBeLessThanOrEqual(200)
          expect(messageOf(res).includes(missing)).toBeFalse()
          const paged = msgsReq(dir, missing, "nf2-tok", { limit: 2 }, { requestId: "req-nf2", opId: `messages:${missing}:nf2-tok`, idempotencyKey: `messages:${missing}:nf2-tok` })
          const pagedRes = asMsgResult(yield* Effect.promise(() => ext.request("session/messages", paged)))
          expect(pagedRes.status).toBe("failed")
          expect(failureCodeOf(pagedRes)).toBe("session.not_found")
          expect(pagedRes.data).toBeUndefined()
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
            return yield* svc.create({ title: "carrier-messages-scope" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const bad = msgsReq(tmpB.path, session.id, "scope-tok", {}, { requestId: "req-scope", opId: `messages:${session.id}:scope-tok`, idempotencyKey: `messages:${session.id}:scope-tok` })
          const res = asMsgResult(yield* Effect.promise(() => ext.request("session/messages", bad)))
          expect(res.status).toBe("failed")
          expect(failureCodeOf(res)).toBe("scope_mismatch")
          expect(retryableOf(res)).toBe(false)
          expect(res.data).toBeUndefined()
          expect(messageOf(res).length).toBeLessThanOrEqual(200)
          expect(messageOf(res).includes(session.id)).toBeFalse()
          const good = msgsReq(tmpA.path, session.id, "scope-ok", {}, { requestId: "req-scope-ok", opId: `messages:${session.id}:scope-ok`, idempotencyKey: `messages:${session.id}:scope-ok` })
          const goodRaw = yield* Effect.promise(() => ext.request("session/messages", good))
          const hit = asMsgResult(goodRaw)
          expect(hit.status).toBe("succeeded")
          expect(Array.isArray(hit.data?.messages)).toBeTrue()
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
        const opId = `messages:${fakeId}:fence-tok`
        const req = msgsReq(fenceDir, fakeId, "fence-tok", {}, { requestId: "req-fence", opId, idempotencyKey: opId })
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(fenceDir)
        try {
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => init(ext))
            const res = asMsgResult(yield* Effect.promise(() => ext.request("session/messages", req)))
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
            return yield* svc.create({ title: "carrier-messages-iso-a" })
          }),
        )
        const sessionB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-messages-iso-b" })
          }),
        )
        const base = Date.now()
        yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            const mid = MessageID.ascending()
            yield* svc.updateMessage({
              id: mid,
              sessionID: sessionA.id,
              role: "user",
              time: { created: base },
              agent: "test",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
              tools: {},
            } satisfies SessionV1.User)
            yield* svc.updatePart({ id: PartID.ascending(), sessionID: sessionA.id, messageID: mid, type: "text", text: "iso-a" })
          }),
        )
        const beforeA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.messages({ sessionID: sessionA.id })
          }),
        )
        const beforeB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.messages({ sessionID: sessionB.id })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const hitARaw = yield* Effect.promise(() =>
            ext.request(
              "session/messages",
              msgsReq(tmpA.path, sessionA.id, "iso-a", {}, { requestId: "r-iso-a", opId: `messages:${sessionA.id}:iso-a`, idempotencyKey: `messages:${sessionA.id}:iso-a` }),
            ),
          )
          const hitA = asMsgResult(hitARaw)
          expect(hitA.status).toBe("succeeded")
          expect((hitA.data?.messages ?? []).map(infoIdOf)).toEqual(beforeA.map((m) => m.info.id))
          const cross = asMsgResult(
            yield* Effect.promise(() =>
              ext.request(
                "session/messages",
                msgsReq(tmpA.path, sessionB.id, "iso-x", {}, { requestId: "r-iso-x", opId: `messages:${sessionB.id}:iso-x`, idempotencyKey: `messages:${sessionB.id}:iso-x` }),
              ),
            ),
          )
          expect(cross.status).toBe("failed")
          expect(failureCodeOf(cross)).toBe("scope_mismatch")
          expect(messageOf(cross).includes(sessionB.id)).toBeFalse()
          const afterA = yield* runA(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.messages({ sessionID: sessionA.id })
            }),
          )
          const afterB = yield* runB(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.messages({ sessionID: sessionB.id })
            }),
          )
          expect(afterA.map((m) => m.info.id)).toEqual(beforeA.map((m) => m.info.id))
          expect(afterB.map((m) => m.info.id)).toEqual(beforeB.map((m) => m.info.id))
          const titleA = yield* runA(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(sessionA.id)
            }),
          )
          expect(titleA.title).toBe("carrier-messages-iso-a")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("unknown method still MethodNotFound after messages added", () =>
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
