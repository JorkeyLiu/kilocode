import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { handleE2ERevertSeed } from "@/kilocode/server/e2e-revert-seed-handler"
import { buildInitializeResult, FD_CAPABILITIES } from "@/kilocode/server/fd-carrier-protocol"
import { ErrorCode } from "@/private-worker/json-rpc"
import { tmpdir } from "../../fixture/fixture"
import { SessionRevertDispatchService } from "@/kilocode/session/session-revert-dispatch"
import { InstanceStore } from "@/project/instance-store"
import { AppRuntime } from "@/effect/app-runtime"

describe("e2eRevertSeed fd capability", () => {
  test("hidden without fixture", () => {
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "0"
    try {
      const res = buildInitializeResult()
      expect(res.capabilities.includes("session/e2eRevertSeed" as never)).toBeFalse()
      expect([...FD_CAPABILITIES].includes("session/e2eRevertSeed")).toBeTrue()
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })

  test("advertised with fixture", () => {
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "1"
    try {
      const res = buildInitializeResult()
      expect(res.capabilities.includes("session/e2eRevertSeed" as never)).toBeTrue()
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })
})

describe("e2eRevertSeed handler gate and strict request", () => {
  test("requires fixture", async () => {
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "0"
    try {
      let code: number | undefined
      try {
        await handleE2ERevertSeed({ v: 1, requestId: "r1", opId: "o1", op: "session/e2eRevertSeed", idempotencyKey: "o1", context: { directory: "/tmp/ws" }, payload: {} })
      } catch (e) {
        code = (e as { code?: number }).code
      }
      expect(code).toBe(ErrorCode.InvalidRequest)
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })

  test("strict v and fields", async () => {
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "1"
    try {
      const bads: unknown[] = [
        { v: 2, requestId: "r", opId: "o", op: "session/e2eRevertSeed", idempotencyKey: "k", context: { directory: "/tmp/ws" } },
        { v: 1, requestId: "", opId: "o", op: "session/e2eRevertSeed", idempotencyKey: "k", context: { directory: "/tmp/ws" } },
        { v: 1, requestId: "r", opId: "", op: "session/e2eRevertSeed", idempotencyKey: "k", context: { directory: "/tmp/ws" } },
        { v: 1, requestId: "r", opId: "o", op: "session/e2eRevertSeed", idempotencyKey: "", context: { directory: "/tmp/ws" } },
        { v: 1, requestId: "r", opId: "o", op: "session/e2eRevertSeed", idempotencyKey: "k", context: { directory: "" } },
        { v: 1, requestId: "r", opId: "o", op: "wrong", idempotencyKey: "k", context: { directory: "/tmp/ws" } },
      ]
      for (const bad of bads) {
        let threw = false
        try {
          await handleE2ERevertSeed(bad)
        } catch {
          threw = true
        }
        expect(threw).toBeTrue()
      }
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })
})

describe("e2eRevertSeed real checkpoint usable by production revert", () => {
  test("seed creates real session/message/part and production revert consumes it", async () => {
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "1"
    await using tmp = await tmpdir({ git: false })
    const dir = tmp.path
    try {
      const raw = await handleE2ERevertSeed({
        v: 1,
        requestId: "req-seed-1",
        opId: "e2eRevertSeed:tok-seed",
        op: "session/e2eRevertSeed",
        idempotencyKey: "e2eRevertSeed:tok-seed",
        context: { directory: dir },
        payload: { title: "seed for revert proof" },
      } as unknown)
      const data = (raw as { data: { sessionId: string; messageId: string; partId: string; revision: number } }).data
      expect(typeof data.sessionId).toBe("string")
      expect(data.sessionId.startsWith("ses")).toBeTrue()
      expect(typeof data.messageId).toBe("string")
      expect(data.messageId.startsWith("msg")).toBeTrue()
      expect(typeof data.revision).toBe("number")
      const revertRes = (await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: dir },
            Effect.gen(function* () {
              const svc = yield* SessionRevertDispatchService
              return yield* (svc.dispatchRevert as (p: unknown) => Effect.Effect<unknown>)({
                v: 1,
                requestId: "req-revert-1",
                opId: `revert:${data.sessionId}:tok-revert`,
                op: "session/revert",
                idempotencyKey: `revert:${data.sessionId}:tok-revert`,
                context: { directory: dir, sessionId: data.sessionId, parentSessionId: null },
                payload: { messageId: data.messageId, partId: data.partId },
              })
            }),
          ),
        ),
      )) as { status: string; accepted: boolean; revision?: { session: number } }
      expect(revertRes.status).toBe("succeeded")
      expect(revertRes.accepted).toBeTrue()
      expect(typeof revertRes.revision?.session).toBe("number")
      expect(revertRes.revision!.session).toBe(data.revision + 1)
      const replay = (await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: dir },
            Effect.gen(function* () {
              const svc = yield* SessionRevertDispatchService
              return yield* (svc.dispatchRevert as (p: unknown) => Effect.Effect<unknown>)({
                v: 1,
                requestId: "req-revert-1",
                opId: `revert:${data.sessionId}:tok-revert`,
                op: "session/revert",
                idempotencyKey: `revert:${data.sessionId}:tok-revert`,
                context: { directory: dir, sessionId: data.sessionId, parentSessionId: null },
                payload: { messageId: data.messageId, partId: data.partId },
              })
            }),
          ),
        ),
      )) as { status: string; revision?: { session: number } }
      expect(replay.status).toBe("succeeded")
      expect(replay.revision?.session).toBe(revertRes.revision?.session)
      const unrevertRes = (await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: dir },
            Effect.gen(function* () {
              const svc = yield* SessionRevertDispatchService
              return yield* (svc.dispatchUnrevert as (p: unknown) => Effect.Effect<unknown>)({
                v: 1,
                requestId: "req-unrevert-1",
                opId: `unrevert:${data.sessionId}:tok-unrevert`,
                op: "session/unrevert",
                idempotencyKey: `unrevert:${data.sessionId}:tok-unrevert`,
                context: { directory: dir, sessionId: data.sessionId, parentSessionId: null },
                payload: {},
              })
            }),
          ),
        ),
      )) as { status: string; accepted: boolean; revision?: { session: number } }
      expect(unrevertRes.status).toBe("succeeded")
      expect(unrevertRes.accepted).toBeTrue()
      expect(unrevertRes.revision!.session).toBe(revertRes.revision!.session + 1)
      const noOp = (await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: dir },
            Effect.gen(function* () {
              const svc = yield* SessionRevertDispatchService
              return yield* (svc.dispatchUnrevert as (p: unknown) => Effect.Effect<unknown>)({
                v: 1,
                requestId: "req-unrevert-2",
                opId: `unrevert:${data.sessionId}:tok-unrevert-2`,
                op: "session/unrevert",
                idempotencyKey: `unrevert:${data.sessionId}:tok-unrevert-2`,
                context: { directory: dir, sessionId: data.sessionId, parentSessionId: null },
                payload: {},
              })
            }),
          ),
        ),
      )) as { status: string; revision?: { session: number } }
      expect(noOp.status).toBe("succeeded")
      if (noOp.revision) expect(noOp.revision.session).toBe(unrevertRes.revision!.session)
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })
})
