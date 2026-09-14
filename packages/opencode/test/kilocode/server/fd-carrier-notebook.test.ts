import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Effect, Exit, Fiber, Layer } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { Notebook } from "../../../src/kilocode/notebook/service"
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

const PATH = "b.ipynb"

function readResult(requestPath: string = PATH) {
  return { operation: "read", path: PATH, requestPath, revision: "r1", cells: [] }
}

function replyReq(dir: string, rid: string, token = "tok1", requestId = "req-reply", result: unknown = readResult()) {
  const opId = `notebook:${rid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "notebook/reply" as const,
    idempotencyKey: opId,
    context: { directory: dir, requestID: rid },
    payload: { result },
  }
}

function rejectReq(dir: string, rid: string, token = "tok1", requestId = "req-reject") {
  const opId = `notebook:${rid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "notebook/reject" as const,
    idempotencyKey: opId,
    context: { directory: dir, requestID: rid },
    payload: { error: { code: "timeout", message: "timed out" } },
  }
}

function listReq(dir: string, token = "tok1", requestId = "req-list") {
  const opId = `notebook-list:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "notebook/list" as const,
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
    capabilities: ["notebook/reply", "notebook/reject", "notebook/list"],
  })
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

function askRead(dir: string, sid: SessionID) {
  return AppRuntime.runFork(
    provideInstance(dir)(
      Effect.gen(function* () {
        const svc = yield* Notebook.Service
        return yield* svc.request({ sessionID: sid, path: PATH, operation: "read", includeOutputs: true })
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
            const svc = yield* Notebook.Service
            const list = yield* svc.list()
            if (list.length === 1) return list
            return undefined
          }),
          "notebook never became pending",
        ),
      ),
    ),
  )
}

function pendingCount(dir: string) {
  return run(() =>
    AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Notebook.Service
          return yield* svc.list()
        }),
      ),
    ),
  ) as unknown as Effect.Effect<unknown[], never, never>
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

describe("fd-carrier notebook/reply notebook/reject notebook/list handler", () => {
  it.live("initialize advertises notebook capabilities", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = (yield* Effect.promise(() => initPeer(ext))) as unknown as { capabilities?: unknown }
        const caps = res.capabilities as string[]
        expect(caps.includes("notebook/reply")).toBeTrue()
        expect(caps.includes("notebook/reject")).toBeTrue()
        expect(caps.includes("notebook/list")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("list returns exact pending shape with zero mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-notebook-list")
      const fiber = askRead(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: string; sessionID: string }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const out = (yield* Effect.promise(() =>
            ext.request("notebook/list", listReq(dir, "tok-exact", "req-exact")),
          )) as unknown as {
            v: number
            requestId: string
            opId: string
            op: string
            idempotencyKey: string
            status: string
            accepted: boolean
            data: { notebooks: Array<Record<string, unknown>> }
          }
          expect(out.v).toBe(1)
          expect(out.requestId).toBe("req-exact")
          expect(out.opId).toBe("notebook-list:tok-exact")
          expect(out.op).toBe("notebook/list")
          expect(out.idempotencyKey).toBe("notebook-list:tok-exact")
          expect(out.status).toBe("succeeded")
          expect(out.accepted).toBeTrue()
          expect(out.data.notebooks).toHaveLength(1)
          const entry = out.data.notebooks[0]!
          expect(entry.id).toBe(rid)
          expect(entry.sessionID).toBe(String(sess.id))
          expect(entry.operation).toBe("read")
          expect(entry.path).toBe(PATH)
          expect("cells" in entry).toBeFalse()
          expect("source" in entry).toBeFalse()
          expect("outputs" in entry).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("reply returns minimal terminal binding with no cell echo and settles the waiter", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-notebook-reply")
      const fiber = askRead(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() =>
            ext.request("notebook/reply", replyReq(dir, rid, "reply-tok", "req-r1")),
          )) as unknown as Record<string, unknown>
          expect(raw.kind).toBe("terminal")
          expect(raw.accepted).toBeTrue()
          expect(raw.terminal).toBeTrue()
          expect(raw.sessionID).toBe(sess.id)
          expect(raw.requestID).toBe(rid)
          expect(Object.keys(raw).sort()).toEqual(
            [
              "accepted",
              "idempotencyKey",
              "kind",
              "opId",
              "requestID",
              "requestId",
              "sessionID",
              "terminal",
              "v",
            ].sort(),
          )
          const exit = (yield* run(() =>
            AppRuntime.runPromise(Fiber.await(fiber as unknown as Fiber.Fiber<never>)),
          )) as unknown as Exit.Exit<unknown>
          expect(Exit.isSuccess(exit)).toBeTrue()
          expect(yield* pendingCount(dir)).toHaveLength(0)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("mismatched reply settles notebook.invalid_reply with pending intact", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-notebook-mismatch")
      const fiber = askRead(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const mismatch = {
          operation: "edit",
          path: PATH,
          requestPath: "other.ipynb",
          revision: "r2",
          index: 0,
          action: "replace",
        }
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() =>
            ext.request("notebook/reply", replyReq(dir, rid, "tok-m", "req-m", mismatch)),
          )) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            failure: { code: string; retryable: boolean }
            sideEffect: boolean
          }
          expect(raw.kind).toBe("terminal-failure")
          expect(raw.accepted).toBeFalse()
          expect(raw.terminal).toBeTrue()
          expect(raw.failure.code).toBe("notebook.invalid_reply")
          expect(raw.failure.retryable).toBeFalse()
          expect(raw.sideEffect).toBeFalse()
          expect(yield* pendingCount(dir)).toHaveLength(1)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("unknown and double submit return notebook.not_found with no side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-notebook-double")
      const fiber = askRead(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const wire = collect(dir, ["kilocode.notebook.requested", "kilocode.notebook.cancelled"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const first = (yield* Effect.promise(() =>
            ext.request("notebook/reply", replyReq(dir, rid, "tok-a", "req-a")),
          )) as unknown as { kind: string }
          expect(first.kind).toBe("terminal")
          const wireCount = wire.seen.length
          const second = (yield* Effect.promise(() =>
            ext.request("notebook/reply", replyReq(dir, rid, "tok-b", "req-b")),
          )) as unknown as { kind: string; failure: { code: string; retryable: boolean } }
          expect(second.kind).toBe("terminal-failure")
          expect(second.failure.code).toBe("notebook.not_found")
          expect(second.failure.retryable).toBeFalse()
          const missing = (yield* Effect.promise(() =>
            ext.request("notebook/reject", rejectReq(dir, "nbr_missing0000000001", "tok-c", "req-c")),
          )) as unknown as { kind: string; failure: { code: string } }
          expect(missing.kind).toBe("terminal-failure")
          expect(missing.failure.code).toBe("notebook.not_found")
          expect(wire.seen.length).toBe(wireCount)
          expect(yield* pendingCount(dir)).toHaveLength(0)
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

  it.live("reject settles the waiter as a host failure", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-notebook-reject")
      const fiber = askRead(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() =>
            ext.request("notebook/reject", rejectReq(dir, rid, "reject-tok", "req-j1")),
          )) as unknown as { kind: string; accepted: boolean; terminal: boolean; sessionID: string; requestID: string }
          expect(raw.kind).toBe("terminal")
          expect(raw.accepted).toBeTrue()
          expect(raw.terminal).toBeTrue()
          expect(raw.sessionID).toBe(sess.id)
          expect(raw.requestID).toBe(rid)
          const exit = (yield* run(() =>
            AppRuntime.runPromise(Fiber.await(fiber as unknown as Fiber.Fiber<never>)),
          )) as unknown as Exit.Exit<unknown>
          expect(Exit.isFailure(exit)).toBeTrue()
          expect(yield* pendingCount(dir)).toHaveLength(0)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("scope binding mismatch returns scope_mismatch with no side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-notebook-scope")
      const fiber = askRead(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const badOp = { ...replyReq(dir, rid, "tok-scope", "req-scope"), op: "notebook/reject" as const }
          const scoped = (yield* Effect.promise(() => ext.request("notebook/reply", badOp))) as unknown as {
            kind: string
            failure: { code: string }
            sideEffect: boolean
          }
          expect(scoped.kind).toBe("terminal-failure")
          expect(scoped.failure.code).toBe("scope_mismatch")
          expect(scoped.sideEffect).toBeFalse()
          const other = `notebook:nbr_other0000000001:tok-scope2`
          const mismatched = {
            ...replyReq(dir, rid, "tok-scope2", "req-scope2"),
            opId: other,
            idempotencyKey: other,
          }
          const scoped2 = (yield* Effect.promise(() => ext.request("notebook/reply", mismatched))) as unknown as {
            kind: string
            failure: { code: string }
          }
          expect(scoped2.kind).toBe("terminal-failure")
          expect(scoped2.failure.code).toBe("scope_mismatch")
          expect(yield* pendingCount(dir)).toHaveLength(1)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("malformed envelope rejects as InvalidParams with no side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-notebook-invalid")
      const fiber = askRead(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const badPayload = yield* Effect.promise(() =>
            ext.request("notebook/reply", { ...replyReq(dir, rid), payload: { result: { operation: "nope" } } }).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect((badPayload as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          const extra = yield* Effect.promise(() =>
            ext.request("notebook/reject", { ...rejectReq(dir, rid), extra: 1 }).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect((extra as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          expect(yield* pendingCount(dir)).toHaveLength(1)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )
})
