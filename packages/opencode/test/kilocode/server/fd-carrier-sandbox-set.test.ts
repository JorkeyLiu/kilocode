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
  canonicalSandboxSetOpId,
  setSandboxPrivate,
  validateSandboxSetResult,
} from "@/kilocode/sandbox-set-private"
import { FD_CAPABILITIES } from "@/kilocode/server/fd-carrier-protocol"
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

function req(dir: string, sid: string, enabled: boolean, token = "tok1") {
  const opId = canonicalSandboxSetOpId(sid, token)
  return {
    v: 1 as const,
    requestId: "req-1",
    opId,
    op: "sandbox/set" as const,
    idempotencyKey: opId,
    context: { directory: dir, sessionId: sid },
    payload: { enabled, sessionId: sid },
  }
}

describe("fd sandbox/set", () => {
  it.live("advertises the capability and validates closed contract", () =>
    Effect.gen(function* () {
      expect([...FD_CAPABILITIES]).toContain("sandbox/set")
      const bad = yield* setSandboxPrivate({ nope: true }).pipe(Effect.map((v) => v))
      expect(bad.status).toBe("failed")
      if (bad.status === "failed") expect(bad.failure.code).toBe("validation.failed")
    }),
  )

  it.live("reaches the canonical policy owner with idempotent semantics", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "fd-sandbox-set" }))
      const support = yield* provideInstance(dir)(SandboxPolicy.configuredSupport())
      if (!support.available) return

      const first = yield* provideInstance(dir)(setSandboxPrivate(req(dir, info.id, true, "tokA")))
      expect(first.status).toBe("succeeded")
      if (first.status !== "succeeded") return
      validateSandboxSetResult(first, req(dir, info.id, true, "tokA"))
      expect(first.data.status.enabled).toBe(true)
      const v1 = first.data.status.version

      // Same target again is a no-op through the same store (no version bump).
      const again = yield* provideInstance(dir)(setSandboxPrivate(req(dir, info.id, true, "tokB")))
      expect(again.status).toBe("succeeded")
      if (again.status !== "succeeded") return
      expect(again.data.status.version).toBe(v1)

      // Canonical store matches the HTTP/policy owner view.
      const viaPolicy = yield* provideInstance(dir)(SandboxPolicy.status(info.id))
      expect(viaPolicy.version).toBe(v1)
      expect(viaPolicy.enabled).toBe(true)
      const stored = yield* Effect.promise(() => SandboxStore.read(dir, info.id))
      expect(stored?.version).toBe(v1)
      expect(stored?.enabled).toBe(true)

      // Unknown session fails closed as terminal non-retryable.
      const missing = yield* provideInstance(dir)(
        setSandboxPrivate(req(dir, "ses_doesnotexist00000000000001", true, "tokC")),
      )
      expect(missing.status).toBe("failed")
      if (missing.status === "failed") {
        expect(missing.failure.retryable).toBe(false)
        expect(missing.accepted).toBe(false)
      }
    }),
  )
})
