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
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"

void Log.init({ print: false })

const it = testEffect(Layer.empty)
const run = <T>(fn: () => Promise<T>) => Effect.promise(fn) as unknown as Effect.Effect<T, unknown, never>

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function saveReq(dir: string, rid: string, token = "tok1", requestId = "req-save", approvedAlways: string[] = ["npm install lodash"]) {
  const opId = `permission:${rid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "permission/save-always-rules" as const,
    idempotencyKey: opId,
    context: { directory: dir, requestID: rid },
    payload: { approvedAlways },
  }
}

function replyReq(dir: string, rid: string, token = "tok1", requestId = "req-reply", reply: "once" | "always" | "reject" = "once") {
  const opId = `permission:${rid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "permission/reply" as const,
    idempotencyKey: opId,
    context: { directory: dir, requestID: rid },
    payload: { reply },
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
    capabilities: ["permission/save-always-rules", "permission/reply"],
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

describe("fd-carrier permission/save-always-rules + permission/reply", () => {
  it.live("initialize advertises permission capabilities", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = (yield* Effect.promise(() => initPeer(ext))) as unknown as { capabilities?: unknown }
        const caps = res.capabilities as string[]
        expect(caps.includes("permission/save-always-rules")).toBeTrue()
        expect(caps.includes("permission/reply")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("save success persists idempotently, reply settles once and emits exactly one event", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-permission")
      const sid = String(sess.id)
      const rid = "per_carrier_save_reply_1"
      const fiber = askPermission(dir, sid, rid)
      try {
        yield* waitPending(dir)
        const wire = collect(dir, ["permission.replied"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const first = (yield* Effect.promise(() => ext.request("permission/save-always-rules", saveReq(dir, rid, "tok-s1", "req-s1")))) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            requestID: string
          }
          expect(first.kind).toBe("terminal")
          expect(first.accepted).toBeTrue()
          expect(first.terminal).toBeTrue()
          expect(first.requestID).toBe(rid)
          const again = (yield* Effect.promise(() => ext.request("permission/save-always-rules", saveReq(dir, rid, "tok-s2", "req-s2")))) as unknown as { kind: string }
          expect(again.kind).toBe("terminal")
          const rep = (yield* Effect.promise(() => ext.request("permission/reply", replyReq(dir, rid, "tok-r1", "req-r1", "once")))) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            sessionID: string
            requestID: string
            reply: string
          }
          expect(rep.kind).toBe("terminal")
          expect(rep.accepted).toBeTrue()
          expect(rep.terminal).toBeTrue()
          expect(rep.sessionID).toBe(sid)
          expect(rep.requestID).toBe(rid)
          expect(rep.reply).toBe("once")
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

  it.live("unknown and double reply map to terminal permission.not_found with no side effect", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-permission-double")
      const sid = String(sess.id)
      const rid = "per_carrier_double_reply_1"
      const fiber = askPermission(dir, sid, rid)
      try {
        yield* waitPending(dir)
        const wire = collect(dir, ["permission.replied"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const first = (yield* Effect.promise(() => ext.request("permission/reply", replyReq(dir, rid, "tok-a", "req-a", "once")))) as unknown as { kind: string }
          expect(first.kind).toBe("terminal")
          const count = wire.seen.length
          const second = (yield* Effect.promise(() => ext.request("permission/reply", replyReq(dir, rid, "tok-b", "req-b", "once")))) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            failure: { code: string; retryable: boolean }
            sideEffect: boolean
          }
          expect(second.kind).toBe("terminal-failure")
          expect(second.accepted).toBeFalse()
          expect(second.terminal).toBeTrue()
          expect(second.failure.code).toBe("permission.not_found")
          expect(second.failure.retryable).toBeFalse()
          expect(second.sideEffect).toBeFalse()
          const missing = (yield* Effect.promise(() =>
            ext.request("permission/reply", replyReq(dir, "per_missing_permission_1", "tok-c", "req-c", "once")),
          )) as unknown as { kind: string; failure: { code: string }; sideEffect: boolean }
          expect(missing.kind).toBe("terminal-failure")
          expect(missing.failure.code).toBe("permission.not_found")
          expect(missing.sideEffect).toBeFalse()
          expect(wire.seen.length).toBe(count)
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

  it.live("scope mismatch when opId/requestID binding diverges", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => initPeer(ext))
        const mismatched = {
          ...replyReq(dir, "per_scope_mismatch_1", "tok-x", "req-x", "once"),
          context: { directory: dir, requestID: "per_other_permission_1" },
        }
        const out = (yield* Effect.promise(() => ext.request("permission/reply", mismatched))) as unknown as {
          kind: string
          failure: { code: string }
          sideEffect: boolean
        }
        expect(out.kind).toBe("terminal-failure")
        expect(out.failure.code).toBe("scope_mismatch")
        expect(out.sideEffect).toBeFalse()
        const saveMismatch = {
          ...saveReq(dir, "per_scope_save_1", "tok-y", "req-y"),
          context: { directory: dir, requestID: "per_other_permission_1" },
        }
        const sout = (yield* Effect.promise(() => ext.request("permission/save-always-rules", saveMismatch))) as unknown as {
          kind: string
          failure: { code: string }
        }
        expect(sout.kind).toBe("terminal-failure")
        expect(sout.failure.code).toBe("scope_mismatch")
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
        const bad = { ...replyReq(dir, "per_validation_1", "tok-v", "req-v", "once"), extra: 1 }
        const badOut = (yield* Effect.promise(() =>
          ext.request("permission/reply", bad).then(
            () => undefined,
            (e: unknown) => e,
          ),
        )) as unknown as { code?: number }
        expect(badOut?.code).toBe(-32602)
        const badSave = { ...saveReq(dir, "per_validation_2", "tok-w", "req-w"), payload: { approvedAlways: ["x"], bogus: 1 } }
        const badSaveOut = (yield* Effect.promise(() =>
          ext.request("permission/save-always-rules", badSave).then(
            () => undefined,
            (e: unknown) => e,
          ),
        )) as unknown as { code?: number }
        expect(badSaveOut?.code).toBe(-32602)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("active fence surfaces retryable convergence failure", () =>
    Effect.gen(function* () {
      const fenceTmp = yield* run(() => tmpdir({ git: true }))
      const fenceDir = fenceTmp.path
      const ticket = yield* run(() =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const gate = yield* GenerationGate.Service
            return yield* gate.beginFence(fenceDir)
          }),
        ),
      )
      try {
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const fenced = (yield* Effect.promise(() =>
            ext.request("permission/reply", replyReq(fenceDir, "per_fence_unknown_1", "tok-f", "req-f", "once")).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )) as unknown as { message?: unknown; code?: unknown }
          const msg = String((fenced as { message?: unknown })?.message ?? fenced)
          expect(msg.includes("unavailable") || msg.includes("InstanceUnavailable")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(ticket.release.pipe(Effect.ignore)))
      }
      const { carrier: c2, ext: e2 } = linked()
      try {
        yield* Effect.promise(() => initPeer(e2))
        const rep = (yield* Effect.promise(() =>
          e2.request("permission/reply", replyReq(fenceDir, "per_fence_unknown_1", "tok-g", "req-g", "once")),
        )) as unknown as { kind: string; failure: { code: string } }
        expect(rep.kind).toBe("terminal-failure")
        expect(rep.failure.code).toBe("permission.not_found")
      } finally {
        c2.dispose()
        e2.dispose()
      }
    }),
  )
})
