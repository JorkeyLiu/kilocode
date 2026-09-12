import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Context, Effect, Fiber } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { Suggestion } from "../../../src/kilocode/suggestion"
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
  try {
    const list = await Suggestion.list()
    for (const entry of list) {
      try {
        await Suggestion.dismiss(entry.id)
      } catch {}
    }
  } catch {}
  await disposeAllInstances()
  await resetDatabase()
})

function listReq(dir: string, token = "tok1", requestId = "req-list") {
  const opId = `suggestion-list:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "suggestion/list" as const,
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
    capabilities: ["suggestion/list"],
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

describe("fd-carrier suggestion/list", () => {
  it.live("initialize advertises suggestion/list capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = (yield* Effect.promise(() => initPeer(ext))) as unknown as { capabilities?: unknown }
          const caps = res.capabilities as string[]
          expect(caps.includes("suggestion/list")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("success returns exact global pending shape in insertion order", () =>
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
            return yield* svc.create({ title: "carrier-suggestion-list" })
          }),
        )
        const sid = sess.id
        const mk = (text: string) =>
          run(
            Effect.gen(function* () {
              return yield* Effect.promise(() =>
                Suggestion.show({
                  sessionID: String(sid),
                  text,
                  actions: [{ label: "Run", prompt: "Run the test suite" }],
                }),
              )
            }),
          ).pipe(Effect.forkScoped)
        const f1 = yield* mk("First suggestion")
        const f2 = yield* mk("Second suggestion")
        try {
          const pending = yield* run(
            pollWithTimeout(
              Effect.gen(function* () {
                const list = yield* Effect.promise(() => Suggestion.list())
                if (list.length >= 2) return list
                return undefined
              }),
              "suggestion never became pending",
            ),
          )
          expect(pending[0]!.text).toBe("First suggestion")
          expect(pending[1]!.text).toBe("Second suggestion")
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => initPeer(ext))
            const out = (yield* Effect.promise(() => ext.request("suggestion/list", listReq(dir, "tok-exact", "req-exact")))) as unknown as {
              v: number
              requestId: string
              opId: string
              op: string
              idempotencyKey: string
              status: string
              accepted: boolean
              data: { suggestions: Array<Record<string, unknown>> }
            }
            expect(out.v).toBe(1)
            expect(out.requestId).toBe("req-exact")
            expect(out.opId).toBe("suggestion-list:tok-exact")
            expect(out.op).toBe("suggestion/list")
            expect(out.idempotencyKey).toBe("suggestion-list:tok-exact")
            expect(out.status).toBe("succeeded")
            expect(out.accepted).toBeTrue()
            expect(out.data.suggestions).toHaveLength(2)
            expect(out.data.suggestions[0]!.text).toBe("First suggestion")
            expect(out.data.suggestions[1]!.text).toBe("Second suggestion")
            const first = out.data.suggestions[0]!
            expect(String(first.id).startsWith("sug")).toBeTrue()
            expect(String(first.sessionID)).toBe(String(sid))
            expect(Array.isArray(first.actions)).toBeTrue()
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* Fiber.interrupt(f1).pipe(Effect.ignore)
          yield* Fiber.interrupt(f2).pipe(Effect.ignore)
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("empty success is authoritative", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const out = (yield* Effect.promise(() => ext.request("suggestion/list", listReq(dir, "tok-empty", "req-empty")))) as unknown as {
            status: string
            accepted: boolean
            data: { suggestions: unknown[] }
          }
          expect(out.status).toBe("succeeded")
          expect(out.accepted).toBeTrue()
          expect(out.data.suggestions).toEqual([])
        } finally {
          carrier.dispose()
          ext.dispose()
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
          const out = (yield* Effect.promise(() => ext.request("suggestion/list", bad))) as unknown as {
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
          const out2 = (yield* Effect.promise(() => ext.request("suggestion/list", badPayload))) as unknown as {
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
            const fenced = (yield* Effect.promise(() => ext.request("suggestion/list", listReq(fenceDir, "tok-f", "req-f")))) as unknown as {
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
          const ok = (yield* Effect.promise(() => e2.request("suggestion/list", listReq(fenceDir, "tok-g", "req-g")))) as unknown as {
            status: string
            accepted: boolean
            data: { suggestions: unknown[] }
          }
          expect(ok.status).toBe("succeeded")
          expect(ok.accepted).toBeTrue()
          expect(ok.data.suggestions).toEqual([])
        } finally {
          c2.dispose()
          e2.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("two-directory global compatibility repeats all pending in order", () =>
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
        const runB = scoped(ctxB, captured)
        const sessA = yield* runA(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-slist-global-a" })
          }),
        )
        const sessB = yield* runB(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.create({ title: "carrier-slist-global-b" })
          }),
        )
        const f1 = yield* runA(
          Effect.gen(function* () {
            return yield* Effect.promise(() =>
              Suggestion.show({
                sessionID: String(sessA.id),
                text: "Suggestion from A",
                actions: [{ label: "Run", prompt: "Run A" }],
              }),
            )
          }),
        ).pipe(Effect.forkScoped)
        const f2 = yield* runB(
          Effect.gen(function* () {
            return yield* Effect.promise(() =>
              Suggestion.show({
                sessionID: String(sessB.id),
                text: "Suggestion from B",
                actions: [{ label: "Skip", prompt: "Skip B" }],
                blocking: false,
                tool: { messageID: "m1", callID: "c1" },
              }),
            )
          }),
        ).pipe(Effect.forkScoped)
        try {
          yield* runA(
            pollWithTimeout(
              Effect.gen(function* () {
                const list = yield* Effect.promise(() => Suggestion.list())
                if (list.length >= 2) return list
                return undefined
              }),
              "suggestions never became pending",
            ),
          )
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => initPeer(ext))
            const resA = (yield* Effect.promise(() => ext.request("suggestion/list", listReq(dirA, "tok-a", "req-a")))) as unknown as {
              status: string
              data: { suggestions: Array<{ id: string; text: string; sessionID: string }> }
            }
            expect(resA.status).toBe("succeeded")
            expect(resA.data.suggestions).toHaveLength(2)
            expect(resA.data.suggestions.map((s) => s.text)).toEqual(["Suggestion from A", "Suggestion from B"])
            const resB = (yield* Effect.promise(() => ext.request("suggestion/list", listReq(dirB, "tok-b", "req-b")))) as unknown as {
              status: string
              data: { suggestions: Array<{ id: string; text: string }> }
            }
            expect(resB.status).toBe("succeeded")
            expect(resB.data.suggestions).toHaveLength(2)
            expect(resB.data.suggestions.map((s) => s.text)).toEqual(["Suggestion from A", "Suggestion from B"])
            expect(resB.data.suggestions.map((s) => s.id)).toEqual(resA.data.suggestions.map((s) => s.id))
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* Fiber.interrupt(f1).pipe(Effect.ignore)
          yield* Fiber.interrupt(f2).pipe(Effect.ignore)
        }
      } finally {
        restore()
      }
    }),
  )
})
