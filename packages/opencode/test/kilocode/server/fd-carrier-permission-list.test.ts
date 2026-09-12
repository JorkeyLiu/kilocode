import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Context, Effect, Fiber } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { Permission } from "../../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { AppLayer } from "../../../src/effect/app-runtime"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import * as Log from "@opencode-ai/core/util/log"
import { testEffectShared, pollWithTimeout } from "../../lib/effect"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"

void Log.init({ print: false })

const it = testEffectShared(AppLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function listReq(dir: string, token = "tok1", requestId = "req-list") {
  const opId = `permission-list:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "permission/list" as const,
    idempotencyKey: opId,
    context: { directory: dir },
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
    capabilities: ["permission/list"],
  })
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
      work.pipe(Effect.provide(captured as unknown as Context.Context<R>), Effect.provideService(InstanceRef, ctx)),
    )
}

describe("fd-carrier permission/list", () => {
  it.live("initialize advertises permission/list capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = (yield* Effect.promise(() => initPeer(ext))) as unknown as { capabilities?: unknown }
          const caps = res.capabilities as string[]
          expect(caps.includes("permission/list")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("success returns exact pending shape", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const sess = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-permission-list" })
          }),
        )
        const sid = String(sess.id)
        const rid = "per_carrier_list_exact_1"
        const fiber = yield* run(
          Effect.gen(function* () {
            const svc = yield* Permission.Service
            return yield* svc.ask({
              id: PermissionV1.ID.make(rid),
              sessionID: SessionID.make(sid),
              permission: "bash",
              patterns: ["npm install lodash"],
              metadata: { rules: ["npm install lodash"] },
              always: ["npm install lodash"],
              ruleset: [],
            })
          }),
        ).pipe(Effect.forkScoped)
        try {
          yield* run(
            pollWithTimeout(
              Effect.gen(function* () {
                const svc = yield* Permission.Service
                const list = yield* svc.list()
                if (list.length >= 1) return list
                return undefined
              }),
              "permission never became pending",
            ),
          )
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => initPeer(ext))
            const out = (yield* Effect.promise(() => ext.request("permission/list", listReq(dir, "tok-exact", "req-exact")))) as unknown as {
              v: number
              requestId: string
              opId: string
              op: string
              idempotencyKey: string
              status: string
              accepted: boolean
              data: { permissions: Array<Record<string, unknown>> }
            }
            expect(out.v).toBe(1)
            expect(out.requestId).toBe("req-exact")
            expect(out.opId).toBe("permission-list:tok-exact")
            expect(out.op).toBe("permission/list")
            expect(out.idempotencyKey).toBe("permission-list:tok-exact")
            expect(out.status).toBe("succeeded")
            expect(out.accepted).toBeTrue()
            expect(out.data.permissions).toHaveLength(1)
            const entry = out.data.permissions[0]!
            expect(entry.id).toBe(rid)
            expect(entry.sessionID).toBe(sid)
            expect(entry.permission).toBe("bash")
            expect(entry.patterns).toEqual(["npm install lodash"])
            expect(Array.isArray(entry.always)).toBeTrue()
            expect(typeof entry.metadata).toBe("object")
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("strict validation rejects unknown fields as failed validation", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const bad = { ...listReq(dir, "tok-v", "req-v"), extra: 1 }
          const out = (yield* Effect.promise(() => ext.request("permission/list", bad))) as unknown as {
            status: string
            accepted: boolean
            failure: { code: string; retryable: boolean }
            data?: unknown
          }
          expect(out.status).toBe("failed")
          expect(out.accepted).toBeFalse()
          expect(out.failure.code).toBe("validation.failed")
          expect(out.failure.retryable).toBeFalse()
          expect(out.data).toBeUndefined()
          const badPayload = { ...listReq(dir, "tok-w", "req-w"), payload: { filter: {} } }
          const out2 = (yield* Effect.promise(() => ext.request("permission/list", badPayload))) as unknown as {
            status: string
            failure: { code: string; retryable: boolean }
          }
          expect(out2.status).toBe("failed")
          expect(out2.failure.code).toBe("validation.failed")
          expect(out2.failure.retryable).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("active fence surfaces retryable failure and no stale boot after release", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const fenceTmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const fenceDir = fenceTmp.path
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(fenceDir)
        try {
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => initPeer(ext))
            const fenced = (yield* Effect.promise(() => ext.request("permission/list", listReq(fenceDir, "tok-f", "req-f")))) as unknown as {
              status: string
              failure: { code: string; retryable: boolean }
            }
            expect(fenced.status).toBe("failed")
            expect(fenced.failure.code).toBe("InstanceUnavailableDuringConfigRebuild")
            expect(fenced.failure.retryable).toBeTrue()
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* ticket.release.pipe(Effect.ignore)
        }
        const { carrier: c2, ext: e2 } = linked()
        try {
          yield* Effect.promise(() => initPeer(e2))
          const ok = (yield* Effect.promise(() => e2.request("permission/list", listReq(fenceDir, "tok-g", "req-g")))) as unknown as {
            status: string
            accepted: boolean
            data: { permissions: unknown[] }
          }
          expect(ok.status).toBe("succeeded")
          expect(ok.accepted).toBeTrue()
          expect(ok.data.permissions).toEqual([])
        } finally {
          c2.dispose()
          e2.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("directory isolation holds pending per directory", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dirA = tmpA.path
        const dirB = tmpB.path
        const store = yield* InstanceStore.Service
        const ctxA = yield* store.load({ directory: dirA })
        const ctxB = yield* store.load({ directory: dirB })
        const captured = yield* Effect.context()
        const runA = scoped(ctxA, captured)
        const sessA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-list-iso-a" })
          }),
        )
        const sidA = String(sessA.id)
        const rid = "per_carrier_list_iso_1"
        const fiber = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Permission.Service
            return yield* svc.ask({
              id: PermissionV1.ID.make(rid),
              sessionID: SessionID.make(sidA),
              permission: "bash",
              patterns: ["npm install lodash"],
              metadata: { rules: ["npm install lodash"] },
              always: ["npm install lodash"],
              ruleset: [],
            })
          }),
        ).pipe(Effect.forkScoped)
        try {
          yield* runA(
            pollWithTimeout(
              Effect.gen(function* () {
                const svc = yield* Permission.Service
                const list = yield* svc.list()
                if (list.length >= 1) return list
                return undefined
              }),
              "permission never became pending",
            ),
          )
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => initPeer(ext))
            const resA = (yield* Effect.promise(() => ext.request("permission/list", listReq(dirA, "tok-a", "req-a")))) as unknown as {
              status: string
              data: { permissions: Array<{ id: string }> }
            }
            expect(resA.status).toBe("succeeded")
            expect(resA.data.permissions.map((p) => p.id)).toContain(rid)
            const resB = (yield* Effect.promise(() => ext.request("permission/list", listReq(dirB, "tok-b", "req-b")))) as unknown as {
              status: string
              data: { permissions: unknown[] }
            }
            expect(resB.status).toBe("succeeded")
            expect(resB.data.permissions).toEqual([])
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        }
      } finally {
        restore()
      }
    }),
  )
})
