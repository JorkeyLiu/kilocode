import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV2 } from "@opencode-ai/core/session"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundProcess } from "@/kilocode/background-process"
import { Notebook } from "@/kilocode/notebook/service"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"
import { SandboxStore } from "@/kilocode/sandbox/store"
import {
  FENCE_MESSAGE,
  INTERNAL_MESSAGE,
  NOT_FOUND_MESSAGE,
  SCOPE_MESSAGE,
  VALIDATION_MESSAGE,
  isSettledSandboxStatusResult,
  statusSandboxPrivate,
  validateSandboxStatusRequest,
  validateSandboxStatusResult,
} from "@/kilocode/sandbox-status-private"
import { FD_CAPABILITIES } from "@/kilocode/server/fd-carrier-protocol"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import * as Ownership from "@/retention/ownership"

const ownership = Ownership.layer
const status = SessionStatus.defaultLayer
const bg = BackgroundJob.defaultLayer
const runState = SessionRunState.layer.pipe(Layer.provide(status), Layer.provide(bg), Layer.provide(ownership))
const session = Session.layer.pipe(
  Layer.provide(runState),
  Layer.provide(Bus.layer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(ownership),
  Layer.provide(bg),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(SessionV2.defaultLayer),
)

const it = testEffect(
  Layer.mergeAll(
    session,
    runState,
    status,
    bg,
    ownership,
    Bus.layer,
    Config.defaultLayer,
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
    Notebook.defaultLayer,
  ),
)

function req(dir: string, sid: string, requestId = "req-1") {
  return {
    v: 1 as const,
    requestId,
    op: "sandbox/status" as const,
    context: { directory: dir, sessionId: sid },
    payload: {},
  }
}

describe("fd sandbox/status", () => {
  it.live("advertises the capability and validates closed contract", () =>
    Effect.gen(function* () {
      expect([...FD_CAPABILITIES]).toContain("sandbox/status")
      const bad = yield* statusSandboxPrivate({ nope: true }).pipe(Effect.map((v) => v))
      expect(bad.status).toBe("failed")
      if (bad.status === "failed") {
        expect(bad.failure.code).toBe("validation.failed")
        expect(bad.failure.message).toBe(VALIDATION_MESSAGE)
        expect(bad.failure.retryable).toBe(false)
      }
      // Durable identity is rejected for a read: no opId/idempotency semantics.
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const sessions = yield* Session.Service
      const info = yield* provideInstance(dir)(sessions.create({ title: "fd-sandbox-status-closed" }))
      const withOpId = yield* provideInstance(dir)(
        statusSandboxPrivate({ ...req(dir, info.id), opId: "x", idempotencyKey: "x" }),
      )
      expect(withOpId.status).toBe("failed")
      if (withOpId.status === "failed") expect(withOpId.failure.code).toBe("validation.failed")
      const withPayload = yield* provideInstance(dir)(
        statusSandboxPrivate({ ...req(dir, info.id), payload: { extra: 1 } } as unknown),
      )
      expect(withPayload.status).toBe("failed")
      if (withPayload.status === "failed") expect(withPayload.failure.code).toBe("validation.failed")
      expect(() => validateSandboxStatusRequest({ ...req(dir, info.id), opId: "x" })).toThrow()
    }),
  )

  it.live("success returns exact SandboxPolicy.status shape with cold seed semantics", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "fd-sandbox-status-ok" }))
      const out = yield* provideInstance(dir)(statusSandboxPrivate(req(dir, info.id, "req-ok")))
      expect(out.status).toBe("succeeded")
      if (out.status !== "succeeded") return
      expect(out.accepted).toBe(true)
      expect(out.requestId).toBe("req-ok")
      validateSandboxStatusResult(out, req(dir, info.id, "req-ok"))
      // Exact shape: available:false is succeeded domain data, not failure.
      expect(typeof out.data.status.directory).toBe("string")
      expect(typeof out.data.status.enabled).toBe("boolean")
      expect(typeof out.data.status.available).toBe("boolean")
      expect(typeof out.data.status.version).toBe("number")
      // Same canonical owner: private result matches SandboxPolicy.status and store.
      const viaPolicy = yield* provideInstance(dir)(SandboxPolicy.status(info.id))
      expect(viaPolicy.directory).toBe(out.data.status.directory)
      expect(viaPolicy.enabled).toBe(out.data.status.enabled)
      expect(viaPolicy.available).toBe(out.data.status.available)
      expect(viaPolicy.version).toBe(out.data.status.version)
      const stored = yield* Effect.promise(() => SandboxStore.read(dir, info.id))
      expect(stored?.version).toBe(out.data.status.version)
      expect(isSettledSandboxStatusResult(out, req(dir, info.id, "req-ok"))).toBe(true)
    }),
  )

  it.live("scope mismatch and missing session are terminal non-retryable", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const other = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "fd-sandbox-status-scope" }))
      const mismatch = yield* provideInstance(dir)(statusSandboxPrivate(req(other, info.id, "req-scope")))
      expect(mismatch.status).toBe("failed")
      if (mismatch.status === "failed") {
        expect(mismatch.failure.code).toBe("scope_mismatch")
        expect(mismatch.failure.message).toBe(SCOPE_MESSAGE)
        expect(mismatch.failure.retryable).toBe(false)
        expect(isSettledSandboxStatusResult(mismatch, req(other, info.id, "req-scope"))).toBe(true)
      }
      const missing = yield* provideInstance(dir)(
        statusSandboxPrivate(req(dir, "ses_doesnotexist00000000000001", "req-missing")),
      )
      expect(missing.status).toBe("failed")
      if (missing.status === "failed") {
        expect(missing.failure.code).toBe("session.not_found")
        expect(missing.failure.message).toBe(NOT_FOUND_MESSAGE)
        expect(missing.failure.retryable).toBe(false)
      }
    }),
  )

  it.live("rebuild and internal stay retryable fallback-eligible, never synthesized terminal", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "fd-sandbox-status-retry" }))
      // Fence the lane with a barrier-active gate stub: no snapshot + barrier
      // must surface retryable InstanceUnavailableDuringConfigRebuild.
      const fenceStub = {
        isBarrierActive: () => true,
        acquire: () => Effect.void,
        beginFence: () => Effect.fail(new Error("unused")),
        beginFenceGlobal: () => Effect.fail(new Error("unused")),
      } as unknown as GenerationGate
      const fenced = yield* provideInstance(dir)(
        statusSandboxPrivate(req(dir, info.id, "req-fence")).pipe(Effect.provideService(GenerationGate.Service, fenceStub)),
      )
      // When the test store already holds a snapshot the lane serves it; when
      // no snapshot exists the fence maps to retryable. Either way the outcome
      // is never a synthesized terminal internal.
      if (fenced.status === "failed") {
        expect(["InstanceUnavailableDuringConfigRebuild", "internal"]).toContain(fenced.failure.code)
        expect(fenced.failure.retryable).toBe(true)
        expect(isSettledSandboxStatusResult(fenced, req(dir, info.id, "req-fence"))).toBe(false)
        if (fenced.failure.code === "InstanceUnavailableDuringConfigRebuild")
          expect(fenced.failure.message).toBe(FENCE_MESSAGE)
        else expect(fenced.failure.message).toBe(INTERNAL_MESSAGE)
      } else {
        expect(fenced.status).toBe("succeeded")
      }
      // Internal contract: retryable true stays unsettled (fallback-eligible).
      const terminal = {
        v: 1 as const,
        requestId: "req-1",
        op: "sandbox/status" as const,
        status: "failed" as const,
        outcome: { type: "failed" as const, time: 1, failure: { code: "internal", message: INTERNAL_MESSAGE, retryable: true } },
        accepted: false as const,
        failure: { code: "internal", message: INTERNAL_MESSAGE, retryable: true },
      }
      expect(isSettledSandboxStatusResult(terminal, req(dir, info.id))).toBe(false)
    }),
  )
})
