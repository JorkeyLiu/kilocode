import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
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
import {
  FENCE_MESSAGE,
  INTERNAL_MESSAGE,
  SCOPE_MESSAGE,
  VALIDATION_MESSAGE,
  isSettledSandboxSupportResult,
  supportSandboxPrivate,
  validateSandboxSupportData,
  validateSandboxSupportRequest,
  validateSandboxSupportResult,
} from "@/kilocode/sandbox-support-private"
import { FD_CAPABILITIES } from "@/kilocode/server/fd-carrier-protocol"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { InstanceStore } from "@/project/instance-store"
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

function req(dir: string, requestId = "req-1") {
  return {
    v: 1 as const,
    requestId,
    op: "sandbox/support" as const,
    context: { directory: dir },
    payload: {},
  }
}

describe("fd sandbox/support", () => {
  it.live("advertises the capability and validates closed contract", () =>
    Effect.gen(function* () {
      expect([...FD_CAPABILITIES]).toContain("sandbox/support")
      const bad = yield* supportSandboxPrivate({ nope: true }).pipe(Effect.map((v) => v))
      expect(bad.status).toBe("failed")
      if (bad.status === "failed") {
        expect(bad.failure.code).toBe("validation.failed")
        expect(bad.failure.message).toBe(VALIDATION_MESSAGE)
        expect(bad.failure.retryable).toBe(false)
      }
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const withOpId = yield* provideInstance(dir)(
        supportSandboxPrivate({ ...req(dir), opId: "x", idempotencyKey: "x" }),
      )
      expect(withOpId.status).toBe("failed")
      if (withOpId.status === "failed") expect(withOpId.failure.code).toBe("validation.failed")
      const withPayload = yield* provideInstance(dir)(
        supportSandboxPrivate({ ...req(dir), payload: { extra: 1 } } as unknown),
      )
      expect(withPayload.status).toBe("failed")
      if (withPayload.status === "failed") expect(withPayload.failure.code).toBe("validation.failed")
      const withSession = yield* provideInstance(dir)(
        supportSandboxPrivate({ ...req(dir), context: { directory: dir, sessionId: "ses_x" } } as unknown),
      )
      expect(withSession.status).toBe("failed")
      if (withSession.status === "failed") expect(withSession.failure.code).toBe("validation.failed")
      expect(() => validateSandboxSupportRequest({ ...req(dir), opId: "x" })).toThrow()
      expect(() => validateSandboxSupportRequest({ ...req(dir), context: { directory: "rel" } })).toThrow()
    }),
  )

  it.live("success returns exact SandboxPolicy.configuredSupport shape; available:false stays success", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const out = yield* provideInstance(dir)(supportSandboxPrivate(req(dir, "req-ok")))
      expect(out.status).toBe("succeeded")
      if (out.status !== "succeeded") return
      expect(out.accepted).toBe(true)
      expect(out.requestId).toBe("req-ok")
      validateSandboxSupportResult(out, req(dir, "req-ok"))
      expect(typeof out.data.available).toBe("boolean")
      if (out.data.reason !== undefined) expect(typeof out.data.reason).toBe("string")
      expect(Object.keys(out.data).sort()).toEqual(
        out.data.reason === undefined ? ["available"] : ["available", "reason"],
      )
      // Same canonical owner: private result matches SandboxPolicy.configuredSupport.
      const viaPolicy = yield* provideInstance(dir)(SandboxPolicy.configuredSupport())
      expect(viaPolicy.available).toBe(out.data.available)
      expect(viaPolicy.reason).toBe(out.data.reason)
      expect(isSettledSandboxSupportResult(out, req(dir, "req-ok"))).toBe(true)
      // Exact payload: available:false with optional reason is domain-success, never failure.
      validateSandboxSupportData({ available: false, reason: "no backend" })
      validateSandboxSupportData({ available: false })
      validateSandboxSupportData({ available: true })
      expect(() => validateSandboxSupportData({ available: false, reason: 1 })).toThrow()
      expect(() => validateSandboxSupportData({ available: true, extra: 1 })).toThrow()
    }),
  )

  it.live("scope mismatch is terminal non-retryable", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const other = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const stub = {
        snapshot: () => Effect.succeed(Option.some({ directory: other } as never)),
        load: () => Effect.succeed({ directory: other } as never),
      }
      const mismatch = yield* provideInstance(dir)(
        supportSandboxPrivate(req(dir, "req-scope")).pipe(
          Effect.provideService(InstanceStore.Service, stub as never),
        ),
      )
      expect(mismatch.status).toBe("failed")
      if (mismatch.status === "failed") {
        expect(mismatch.failure.code).toBe("scope_mismatch")
        expect(mismatch.failure.message).toBe(SCOPE_MESSAGE)
        expect(mismatch.failure.retryable).toBe(false)
        expect(isSettledSandboxSupportResult(mismatch, req(dir, "req-scope"))).toBe(true)
      }
    }),
  )

  it.live("rebuild and internal stay retryable fallback-eligible, never synthesized terminal", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const fenceStub = {
        isBarrierActive: () => true,
        acquire: () => Effect.void,
        beginFence: () => Effect.fail(new Error("unused")),
        beginFenceGlobal: () => Effect.fail(new Error("unused")),
      } as unknown as GenerationGate
      const fenced = yield* provideInstance(dir)(
        supportSandboxPrivate(req(dir, "req-fence")).pipe(Effect.provideService(GenerationGate.Service, fenceStub)),
      )
      if (fenced.status === "failed") {
        expect(["InstanceUnavailableDuringConfigRebuild", "internal"]).toContain(fenced.failure.code)
        expect(fenced.failure.retryable).toBe(true)
        expect(isSettledSandboxSupportResult(fenced, req(dir, "req-fence"))).toBe(false)
        if (fenced.failure.code === "InstanceUnavailableDuringConfigRebuild")
          expect(fenced.failure.message).toBe(FENCE_MESSAGE)
        else expect(fenced.failure.message).toBe(INTERNAL_MESSAGE)
      } else {
        expect(fenced.status).toBe("succeeded")
      }
      const terminal = {
        v: 1 as const,
        requestId: "req-1",
        op: "sandbox/support" as const,
        status: "failed" as const,
        outcome: { type: "failed" as const, time: 1, failure: { code: "internal", message: INTERNAL_MESSAGE, retryable: true } },
        accepted: false as const,
        failure: { code: "internal", message: INTERNAL_MESSAGE, retryable: true },
      }
      expect(isSettledSandboxSupportResult(terminal, req(dir))).toBe(false)
    }),
  )

  it.live("canonical effective config projection: same owner, no second store", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const out = yield* provideInstance(dir)(supportSandboxPrivate(req(dir, "req-owner")))
      if (out.status !== "succeeded") return
      const viaPolicy = yield* provideInstance(dir)(SandboxPolicy.configuredSupport())
      expect(out.data).toEqual(viaPolicy)
      const src = yield* Effect.promise(() => Bun.file("src/kilocode/sandbox-support-private.ts").text()).pipe(
        Effect.catch(() => Effect.succeed("")),
      )
      if (src.length > 0) {
        expect(src).toContain("SandboxPolicy.configuredSupport")
        expect(src).toContain("acquireDrainControl")
        expect(src).toContain("InstanceRef")
        expect(src).not.toContain("sandbox/store")
        expect(src).not.toContain("SandboxStore.read")
        expect(src).not.toContain("SandboxStore.write")
        expect(src).not.toContain("SandboxPreference")
      }
    }),
  )
})
