import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Context, Effect, Schema } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Session } from "../../../src/session/session"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { ModelUsage } from "../../../src/kilocode/session/model-usage"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function usageReq(dir: string, sid: string, token = "tok1", overrides: Record<string, unknown> = {}) {
  const opId = `session-model-usage:${sid}:${token}`
  return {
    v: 1,
    requestId: "req-usage-1",
    opId,
    op: "session/model-usage",
    idempotencyKey: opId,
    context: { directory: dir, sessionId: sid },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer) {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["session/model-usage"],
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

describe("fd-carrier session/model-usage (read-only private-first)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises session/model-usage capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          const caps = (res.capabilities as unknown[]) ?? []
          expect((caps as string[]).includes("session/model-usage")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("success returns exact ModelUsage shape/order", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
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
            return yield* svc.create({ title: "carrier-usage" })
          }),
        )
        const expected = yield* run(
          Effect.gen(function* () {
            return yield* ModelUsage.get(session.id)
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const req = usageReq(dir, session.id, "hit-tok", {
            requestId: "req-hit",
            opId: `session-model-usage:${session.id}:hit-tok`,
            idempotencyKey: `session-model-usage:${session.id}:hit-tok`,
          })
          const raw = yield* Effect.promise(() => ext.request("session/model-usage", req))
          const rec = asRecord(raw)
          expect(rec.v).toBe(1)
          expect(rec.op).toBe("session/model-usage")
          expect(rec.status).toBe("succeeded")
          expect(rec.accepted).toBeTrue()
          const data = asRecord(rec.data)
          const usage = data.usage
          expect(Schema.is(ModelUsage.Info)(usage)).toBeTrue()
          expect(JSON.stringify(usage)).toBe(JSON.stringify(expected))
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("missing session maps to session.not_found terminal", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const missing = "ses_missing00000000000000001"
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("session/model-usage", usageReq(tmp.path, missing, "nf-tok")),
          )
          const rec = asRecord(raw)
          expect(rec.status).toBe("failed")
          expect(rec.accepted).toBeFalse()
          expect(asRecord(rec.failure).code).toBe("session.not_found")
          expect(asRecord(rec.failure).retryable).toBeFalse()
          expect(rec.data).toBeUndefined()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("cross-directory maps to scope_mismatch terminal", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
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
            return yield* svc.create({ title: "carrier-usage-scope" })
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() => ext.request("session/model-usage", usageReq(tmpB.path, session.id)))
          const rec = asRecord(raw)
          expect(rec.status).toBe("failed")
          expect(asRecord(rec.failure).code).toBe("scope_mismatch")
          expect(asRecord(rec.failure).retryable).toBeFalse()
          expect(rec.data).toBeUndefined()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("strict validation fails closed", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const sid = "ses_abc00000000000000000001"
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases = [
            usageReq("relative/path", sid),
            usageReq(tmp.path, sid, "tok1", { payload: { filter: "x" } }),
            usageReq(tmp.path, sid, "tok1", { idempotencyKey: `session-model-usage:${sid}:other` }),
            usageReq(tmp.path, sid, "tok1", { extra: 1 }),
            { ...usageReq(tmp.path, sid), context: { directory: tmp.path, sessionId: sid, workspace: "w" } },
            usageReq(tmp.path, sid, "tok1", {
              opId: `session-model-usage:ses_other00000000000001:tok1`,
              idempotencyKey: `session-model-usage:ses_other00000000000001:tok1`,
            }),
          ]
          for (const req of cases) {
            const raw = yield* Effect.promise(() => ext.request("session/model-usage", req))
            const rec = asRecord(raw)
            expect(rec.status).toBe("failed")
            expect(asRecord(rec.failure).code).toBe("validation.failed")
            expect(asRecord(rec.failure).retryable).toBeFalse()
          }
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("unknown method still MethodNotFound", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
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
          const rec = isRecord(err) ? err : {}
          expect((rec as Record<string, unknown>).code).toBe(ErrorCode.MethodNotFound)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )
})
