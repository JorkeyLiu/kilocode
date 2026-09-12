import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Effect, Exit, Fiber, Layer } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { Suggestion } from "../../../src/kilocode/suggestion"
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

function acceptReq(dir: string, rid: string, index = 0, token = "tok1", requestId = "req-accept") {
  const opId = `suggestion:${rid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "suggestion/accept" as const,
    idempotencyKey: opId,
    context: { directory: dir, requestID: rid },
    payload: { index },
  }
}

function dismissReq(dir: string, rid: string, token = "tok1", requestId = "req-dismiss") {
  const opId = `suggestion:${rid}:${token}`
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "suggestion/dismiss" as const,
    idempotencyKey: opId,
    context: { directory: dir, requestID: rid },
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
    capabilities: ["suggestion/accept", "suggestion/dismiss"],
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

function showSuggestion(dir: string, sid: SessionID) {
  return AppRuntime.runFork(
    provideInstance(dir)(
      Effect.promise(() =>
        Suggestion.show({
          sessionID: String(sid),
          text: "Run tests?",
          actions: [
            { label: "Run", prompt: "Run the test suite" },
            { label: "Skip", prompt: "Skip for now" },
          ],
        }),
      ) as unknown as Effect.Effect<unknown>,
    ),
  )
}

function waitPending(dir: string, sid?: SessionID) {
  return run(() =>
    AppRuntime.runPromise(
      provideInstance(dir)(
        pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* Effect.promise(() => Suggestion.list())
            const scoped = sid ? list.filter((e) => String(e.sessionID) === String(sid)) : list
            if (scoped.length === 1) return scoped
            if (scoped.length > 1) return scoped
            return undefined
          }),
          "suggestion never became pending",
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

describe("fd-carrier suggestion/accept suggestion/dismiss handler", () => {
  it.live("initialize advertises suggestion capabilities", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = (yield* Effect.promise(() => initPeer(ext))) as unknown as { capabilities?: unknown }
        const caps = res.capabilities as string[]
        expect(caps.includes("suggestion/accept")).toBeTrue()
        expect(caps.includes("suggestion/dismiss")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("accept returns terminal with echoed index/action, resolves waiter, emits event", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-suggestion-accept")
      const fiber = showSuggestion(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir, sess.id)) as unknown as Array<{ id: string; sessionID: string }>
        const rid = String(pending[0]!.id)
        const wire = collect(dir, ["suggestion.accepted"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() =>
            ext.request("suggestion/accept", acceptReq(dir, rid, 1, "accept-tok", "req-a1")),
          )) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            sessionID: string
            requestID: string
            index: number
            action: { label: string; prompt: string }
          }
          expect(raw.kind).toBe("terminal")
          expect(raw.accepted).toBeTrue()
          expect(raw.terminal).toBeTrue()
          expect(raw.sessionID).toBe(sess.id)
          expect(raw.requestID).toBe(rid)
          expect(raw.index).toBe(1)
          expect(raw.action.label).toBe("Skip")
          expect(raw.action.prompt).toBe("Skip for now")
          const exit = (yield* run(() => AppRuntime.runPromise(Fiber.await(fiber as unknown as Fiber.Fiber<never>)))) as unknown as Exit.Exit<unknown>
          expect(Exit.isSuccess(exit)).toBeTrue()
          if (Exit.isSuccess(exit))
            expect(exit.value).toEqual({ label: "Skip", prompt: "Skip for now" })
          expect(wire.seen.length).toBe(1)
          expect(wire.seen[0]!.type).toBe("suggestion.accepted")
          expect(wire.seen[0]!.props.requestID).toBe(rid)
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

  it.live("dismiss returns terminal, rejects waiter with DismissedError, emits event", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-suggestion-dismiss")
      const fiber = showSuggestion(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir, sess.id)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const wire = collect(dir, ["suggestion.dismissed"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const raw = (yield* Effect.promise(() =>
            ext.request("suggestion/dismiss", dismissReq(dir, rid, "dismiss-tok", "req-d1")),
          )) as unknown as { kind: string; accepted: boolean; terminal: boolean; sessionID: string; requestID: string }
          expect(raw.kind).toBe("terminal")
          expect(raw.accepted).toBeTrue()
          expect(raw.terminal).toBeTrue()
          expect(raw.sessionID).toBe(sess.id)
          expect(raw.requestID).toBe(rid)
          const exit = (yield* run(() => AppRuntime.runPromise(Fiber.await(fiber as unknown as Fiber.Fiber<never>)))) as unknown as Exit.Exit<unknown>
          expect(Exit.isFailure(exit)).toBeTrue()
          expect(wire.seen.length).toBe(1)
          expect(wire.seen[0]!.props.requestID).toBe(rid)
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

  it.live("unknown and double submit return suggestion.not_found with no extra events", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-suggestion-double")
      const fiber = showSuggestion(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir, sess.id)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const wire = collect(dir, ["suggestion.accepted", "suggestion.dismissed"])
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const first = (yield* Effect.promise(() =>
            ext.request("suggestion/accept", acceptReq(dir, rid, 0, "tok-a", "req-a")),
          )) as unknown as { kind: string }
          expect(first.kind).toBe("terminal")
          const wireCount = wire.seen.length
          const second = (yield* Effect.promise(() =>
            ext.request("suggestion/accept", acceptReq(dir, rid, 0, "tok-b", "req-b")),
          )) as unknown as {
            kind: string
            accepted: boolean
            terminal: boolean
            failure: { code: string; retryable: boolean }
            sideEffect: boolean
          }
          expect(second.kind).toBe("terminal-failure")
          expect(second.accepted).toBeFalse()
          expect(second.terminal).toBeTrue()
          expect(second.failure.code).toBe("suggestion.not_found")
          expect(second.failure.retryable).toBeFalse()
          expect(second.sideEffect).toBeFalse()
          // Failure diagnostics carry no untrusted content or paths: only
          // code/retryable/time, no message/detail/prompt/directory.
          expect(Object.keys(second.failure).sort()).toEqual(["code", "retryable", "time"])
          expect(JSON.stringify(second.failure).includes(dir)).toBeFalse()
          expect("message" in (second as Record<string, unknown>)).toBeFalse()
          const late = (yield* Effect.promise(() =>
            ext.request("suggestion/dismiss", dismissReq(dir, rid, "tok-c", "req-c")),
          )) as unknown as { kind: string; failure: { code: string }; sideEffect: boolean }
          expect(late.kind).toBe("terminal-failure")
          expect(late.failure.code).toBe("suggestion.not_found")
          expect(late.sideEffect).toBeFalse()
          expect(wire.seen.length).toBe(wireCount)
          const list = (yield* run(() =>
            AppRuntime.runPromise(provideInstance(dir)(Effect.promise(() => Suggestion.list()))),
          )) as unknown as unknown[]
          expect(list.length).toBe(0)
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

  it.live("invalid accept index runs current side effect then returns suggestion.not_found", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-suggestion-bad-index")
      const fiber = showSuggestion(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir, sess.id)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const bad = (yield* Effect.promise(() =>
            ext.request("suggestion/accept", acceptReq(dir, rid, 9, "tok-bad", "req-bad")),
          )) as unknown as {
            kind: string
            failure: { code: string; retryable: boolean }
            sideEffect: boolean
          }
          expect(bad.kind).toBe("terminal-failure")
          expect(bad.failure.code).toBe("suggestion.not_found")
          expect(bad.failure.retryable).toBeFalse()
          expect(bad.sideEffect).toBeFalse()
          // Current side-effect semantics preserved: pending removed, waiter rejected.
          const list = (yield* run(() =>
            AppRuntime.runPromise(provideInstance(dir)(Effect.promise(() => Suggestion.list()))),
          )) as unknown as unknown[]
          expect(list.length).toBe(0)
          const exit = (yield* run(() => AppRuntime.runPromise(Fiber.await(fiber as unknown as Fiber.Fiber<never>)))) as unknown as Exit.Exit<unknown>
          expect(Exit.isFailure(exit)).toBeTrue()
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
      const sess = yield* makeSession(dir, "carrier-suggestion-scope")
      const fiber = showSuggestion(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir, sess.id)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          // Op mismatch: dismiss envelope on the accept method.
          const badOp = { ...dismissReq(dir, rid, "tok-scope", "req-scope"), op: "suggestion/dismiss" as const }
          const scoped = (yield* Effect.promise(() => ext.request("suggestion/accept", badOp))) as unknown as {
            kind: string
            failure: { code: string }
            sideEffect: boolean
          }
          expect(scoped.kind).toBe("terminal-failure")
          expect(scoped.failure.code).toBe("scope_mismatch")
          expect(scoped.sideEffect).toBeFalse()
          // opId binding mismatch: opId requestID differs from context requestID.
          const other = `sug${Date.now()}other`
          const mismatched = {
            ...acceptReq(dir, rid, 0, "tok-scope2", "req-scope2"),
            opId: `suggestion:${other}:tok-scope2`,
            idempotencyKey: `suggestion:${other}:tok-scope2`,
          }
          const scoped2 = (yield* Effect.promise(() => ext.request("suggestion/accept", mismatched))) as unknown as {
            kind: string
            failure: { code: string }
          }
          expect(scoped2.kind).toBe("terminal-failure")
          expect(scoped2.failure.code).toBe("scope_mismatch")
          // No side effects: pending still present.
          const list = (yield* run(() =>
            AppRuntime.runPromise(provideInstance(dir)(Effect.promise(() => Suggestion.list()))),
          )) as unknown as unknown[]
          expect(list.length).toBe(1)
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
      const sess = yield* makeSession(dir, "carrier-suggestion-invalid")
      const fiber = showSuggestion(dir, sess.id)
      try {
        const pending = (yield* waitPending(dir, sess.id)) as unknown as Array<{ id: string }>
        const rid = String(pending[0]!.id)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => initPeer(ext))
          const badPayload = yield* Effect.promise(() =>
            ext.request("suggestion/accept", { ...acceptReq(dir, rid), payload: { index: "broken" } }).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect((badPayload as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          const extra = yield* Effect.promise(() =>
            ext.request("suggestion/dismiss", { ...dismissReq(dir, rid), extra: 1 }).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect((extra as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          const badDir = yield* Effect.promise(() =>
            ext.request("suggestion/accept", { ...acceptReq(dir, rid), context: { directory: "relative", requestID: rid } }).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect((badDir as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          const list = (yield* run(() =>
            AppRuntime.runPromise(provideInstance(dir)(Effect.promise(() => Suggestion.list()))),
          )) as unknown as unknown[]
          expect(list.length).toBe(1)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(fiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("accept and dismiss complete through acquireDrainControl under an active fence with cached snapshot", () =>
    Effect.gen(function* () {
      // Active-barrier proof: hold a real convergence fence with the instance
      // cached, then route accept + dismiss through the fd-carrier lane. Both
      // must settle (waiter + event) before the fence releases — the
      // snapshot-first acquireDrainControl never waits on the barrier.
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* makeSession(dir, "carrier-suggestion-fence")
      const acceptFiber = showSuggestion(dir, sess.id)
      const dismissFiber = showSuggestion(dir, sess.id)
      try {
        const both = (yield* run(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              pollWithTimeout(
                Effect.gen(function* () {
                  const list = yield* Effect.promise(() => Suggestion.list())
                  const scoped = list.filter((e) => String(e.sessionID) === String(sess.id))
                  if (scoped.length >= 2) return scoped
                  return undefined
                }),
                "two suggestions never became pending",
              ),
            ),
          ),
        )) as unknown as Array<{ id: string }>
        const acceptID = String(both[0]!.id)
        const dismissID = String(both[1]!.id)
        const ticket = yield* run(() =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const gate = yield* GenerationGate.Service
              return yield* gate.beginFence(dir)
            }),
          ),
        )
        try {
          const wire = collect(dir, ["suggestion.accepted", "suggestion.dismissed"])
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => initPeer(ext))
            const accepted = (yield* Effect.promise(() =>
              ext.request("suggestion/accept", acceptReq(dir, acceptID, 0, "fence-tok-a", "req-fence-a")),
            )) as unknown as { kind: string; accepted: boolean; terminal: boolean; requestID: string; index: number }
            expect(accepted.kind).toBe("terminal")
            expect(accepted.accepted).toBeTrue()
            expect(accepted.terminal).toBeTrue()
            expect(accepted.requestID).toBe(acceptID)
            expect(accepted.index).toBe(0)
            const dismissed = (yield* Effect.promise(() =>
              ext.request("suggestion/dismiss", dismissReq(dir, dismissID, "fence-tok-d", "req-fence-d")),
            )) as unknown as { kind: string; accepted: boolean; terminal: boolean; requestID: string }
            expect(dismissed.kind).toBe("terminal")
            expect(dismissed.accepted).toBeTrue()
            expect(dismissed.terminal).toBeTrue()
            expect(dismissed.requestID).toBe(dismissID)
            // Both waiters settled while the fence was still held: accept
            // resolves with the action, dismiss rejects with DismissedError.
            const acceptExit = (yield* run(() =>
              AppRuntime.runPromise(Fiber.await(acceptFiber as unknown as Fiber.Fiber<never>)),
            )) as unknown as Exit.Exit<unknown>
            expect(Exit.isSuccess(acceptExit)).toBeTrue()
            const dismissExit = (yield* run(() =>
              AppRuntime.runPromise(Fiber.await(dismissFiber as unknown as Fiber.Fiber<never>)),
            )) as unknown as Exit.Exit<unknown>
            expect(Exit.isFailure(dismissExit)).toBeTrue()
            expect(wire.seen.length).toBe(2)
            expect(wire.seen.map((s) => s.type).sort()).toEqual(["suggestion.accepted", "suggestion.dismissed"])
          } finally {
            carrier.dispose()
            ext.dispose()
            wire.stop()
          }
        } finally {
          yield* run(() => AppRuntime.runPromise(ticket.release.pipe(Effect.ignore)))
        }
      } finally {
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(acceptFiber as unknown as Fiber.Fiber<never>))))
        yield* run(() => AppRuntime.runPromise(Effect.ignore(Fiber.interrupt(dismissFiber as unknown as Fiber.Fiber<never>))))
      }
    }),
  )

  it.live("no-snapshot barrier surfaces unavailable for suggestion accept", () =>
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
            ext.request("suggestion/accept", acceptReq(fenceDir, "sug_fence_unknown_1", 0, "tok-f", "req-f")).then(
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
      // After the fence releases with no pending entry, the lane falls through
      // to the normal boot and surfaces suggestion.not_found (not a hang).
      const { carrier: c2, ext: e2 } = linked()
      try {
        yield* Effect.promise(() => initPeer(e2))
        const rep = (yield* Effect.promise(() =>
          e2.request("suggestion/accept", acceptReq(fenceDir, "sug_fence_unknown_1", 0, "tok-g", "req-g")),
        )) as unknown as { kind: string; failure: { code: string } }
        expect(rep.kind).toBe("terminal-failure")
        expect(rep.failure.code).toBe("suggestion.not_found")
      } finally {
        c2.dispose()
        e2.dispose()
      }
    }),
  )
})
