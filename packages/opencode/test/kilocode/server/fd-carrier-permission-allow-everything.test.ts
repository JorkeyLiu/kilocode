import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Effect, Exit, Fiber, Layer } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { Permission } from "../../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { GlobalBus } from "../../../src/bus/global"
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

function allowReq(
  dir: string,
  token = "tok1",
  requestId = "req-ae",
  enable = true,
  extra: Record<string, unknown> = {},
) {
  const opId = `permission-allow-everything:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "permission/allow-everything" as const,
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { enable },
    ...extra,
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
    capabilities: ["permission/allow-everything"],
  })
}

function askPermission(dir: string, sid: string, rid: string) {
  return AppRuntime.runFork(
    provideInstance(dir)(
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
    ),
  )
}

function waitPending(dir: string) {
  return run(() =>
    AppRuntime.runPromise(
      provideInstance(dir)(
        pollWithTimeout(
          Effect.gen(function* () {
            const svc = yield* Permission.Service
            const list = yield* svc.list()
            if (list.length >= 1) return list
            return undefined
          }),
          "permission never became pending",
        ),
      ),
    ),
  )
}

function collect(dir: string, types: string[]) {
  const seen: Array<{ type: string; props: Record<string, unknown> }> = []
  const off = (evt: { directory?: string; payload?: { type?: string; properties?: Record<string, unknown> } }) => {
    if (evt.directory !== dir) return
    const t = evt.payload?.type
    if (typeof t === "string" && types.includes(t)) seen.push({ type: t, props: evt.payload?.properties ?? {} })
  }
  GlobalBus.on("event", off)
  return { seen, stop: () => GlobalBus.off("event", off) }
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

function debugState(dir: string) {
  return run(() =>
    AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Permission.Service
          return yield* svc.debugState()
        }),
      ),
    ),
  )
}

describe("fd-carrier permission/allow-everything", () => {
  it.live("initialize advertises the permission/allow-everything capability", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = (yield* Effect.promise(() => initPeer(ext))) as unknown as { capabilities?: unknown }
        const caps = res.capabilities as string[]
        expect(caps.includes("permission/allow-everything")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("global enable is idempotent and disable removes the marker", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const first = (yield* Effect.promise(() => ext.request("permission/allow-everything", allowReq(dir, "tok-g1", "req-g1", true)))) as unknown as {
          kind: string
          accepted: boolean
          terminal: boolean
          enable: boolean
        }
        expect(first.kind).toBe("terminal")
        expect(first.accepted).toBeTrue()
        expect(first.terminal).toBeTrue()
        expect(first.enable).toBe(true)
        const again = (yield* Effect.promise(() => ext.request("permission/allow-everything", allowReq(dir, "tok-g2", "req-g2", true)))) as unknown as { kind: string }
        expect(again.kind).toBe("terminal")
        const state = (yield* debugState(dir)) as unknown as { approved: Array<{ permission: string; pattern: string; action: string }> }
        expect(state.approved.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")).toBeTrue()
        const off = (yield* Effect.promise(() => ext.request("permission/allow-everything", allowReq(dir, "tok-g3", "req-g3", false)))) as unknown as {
          kind: string
          enable: boolean
        }
        expect(off.kind).toBe("terminal")
        expect(off.enable).toBe(false)
        const after = (yield* debugState(dir)) as unknown as { approved: Array<{ permission: string; pattern: string; action: string }> }
        expect(after.approved.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")).toBeFalse()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("session-scoped enable marks only that session and disable clears it", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-allow-everything-session")
      const sid = String(sess.id)
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const scoped = {
          ...allowReq(dir, "tok-s1", "req-s1", true),
          context: { directory: dir, sessionID: sid },
        }
        const out = (yield* Effect.promise(() => ext.request("permission/allow-everything", scoped))) as unknown as {
          kind: string
          sessionID: string
        }
        expect(out.kind).toBe("terminal")
        expect(out.sessionID).toBe(sid)
        const state = (yield* debugState(dir)) as unknown as { session: Record<string, Array<{ permission: string }>>; approved: unknown[] }
        expect(state.session[sid]?.length).toBeGreaterThan(0)
        expect(state.approved.length).toBe(0)
        const clears = {
          ...allowReq(dir, "tok-s2", "req-s2", false),
          context: { directory: dir, sessionID: sid },
        }
        const cleared = (yield* Effect.promise(() => ext.request("permission/allow-everything", clears))) as unknown as { kind: string }
        expect(cleared.kind).toBe("terminal")
        const after = (yield* debugState(dir)) as unknown as { session: Record<string, unknown> }
        expect(after.session[sid]).toBeUndefined()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("request-scoped enable drains the pending request and emits exactly one event", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-allow-everything-drain")
      const sid = String(sess.id)
      const rid = "per_carrier_allow_everything_1"
      const fiber = askPermission(dir, sid, rid)
      try {
        yield* waitPending(dir)
        const wire = collect(dir, ["permission.replied"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const scoped = {
            ...allowReq(dir, "tok-r1", "req-r1", true),
            context: { directory: dir, sessionID: sid, requestID: rid },
          }
          const out = (yield* Effect.promise(() => ext.request("permission/allow-everything", scoped))) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            requestID: string
          }
          expect(out.kind).toBe("terminal")
          expect(out.accepted).toBeTrue()
          expect(out.terminal).toBeTrue()
          expect(out.requestID).toBe(rid)
          const exit = (yield* run(() => AppRuntime.runPromise(Fiber.await(fiber as unknown as Fiber.Fiber<never>)))) as unknown as Exit.Exit<unknown>
          expect(Exit.isSuccess(exit)).toBeTrue()
          expect(wire.seen.length).toBe(1)
          expect(wire.seen[0]!.type).toBe("permission.replied")
        } finally {
          carrier.dispose()
          ext.dispose()
          wire.stop()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("op mismatch surfaces terminal scope_mismatch with no side effect", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const mismatched = { ...allowReq(dir, "tok-x", "req-x", true), op: "permission/reply" }
        const out = (yield* Effect.promise(() => ext.request("permission/allow-everything", mismatched))) as unknown as {
          kind: string
          failure: { code: string }
          sideEffect: boolean
        }
        expect(out.kind).toBe("terminal-failure")
        expect(out.failure.code).toBe("scope_mismatch")
        expect(out.sideEffect).toBeFalse()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("strict validation rejects unknown fields as InvalidParams", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const bad = { ...allowReq(dir, "tok-v", "req-v", true), extra: 1 }
        const badOut = (yield* Effect.promise(() =>
          ext.request("permission/allow-everything", bad).then(
            () => undefined,
            (e: unknown) => e,
          ),
        )) as unknown as { code?: number }
        expect(badOut?.code).toBe(-32602)
        const badPayload = { ...allowReq(dir, "tok-w", "req-w", true), payload: { enable: true, bogus: 1 } }
        const badPayloadOut = (yield* Effect.promise(() =>
          ext.request("permission/allow-everything", badPayload).then(
            () => undefined,
            (e: unknown) => e,
          ),
        )) as unknown as { code?: number }
        expect(badPayloadOut?.code).toBe(-32602)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )
})
