import { describe, expect, spyOn } from "bun:test"
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
import { InteractiveTerminal } from "@/kilocode/interactive-terminal"
import { Notebook } from "@/kilocode/notebook/service"
import * as SandboxActivation from "@/kilocode/sandbox/activation"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"
import { Changed } from "@/kilocode/sandbox/event"
import { SandboxPreference } from "@/kilocode/sandbox/preference"
import { SandboxStore } from "@/kilocode/sandbox/store"
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

describe("sandbox set idempotent", () => {
  // Direct side-effect proof for the material no-op claim. Version/guard
  // counters alone are not sufficient: same-target set must produce zero
  // SandboxStore writes, zero SandboxPreference writes, zero
  // Sandbox.Event.Changed publishes, zero enabling cleanup, and zero family
  // inheritance. Spies call through to the real services (actual test
  // layers); notebook.cancelSession has no static interception point, so the
  // guard gate (which owns all enabling cleanup in production handlers) plus
  // the BackgroundProcess/InteractiveTerminal spies are the closest
  // production-observable evidence for that leg.
  it.live("false->false and true->true are no-ops without version/event/side effects", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "sandbox-set-noop" }))
      const before = yield* provideInstance(dir)(SandboxPolicy.status(info.id))
      // Real family member (parent_id linkage): `family` only follows
      // `sessions.children`, which forks do not populate.
      const child = yield* provideInstance(dir)(sessions.create({ title: "sandbox-set-noop-child", parentID: info.id }))
      const childBefore = yield* provideInstance(dir)(SandboxPolicy.status(child.id))

      const storeSpy = spyOn(SandboxStore, "write")
      const prefSpy = spyOn(SandboxPreference, "write")
      const busSpy = spyOn(Bus, "publish")
      const bgSpy = spyOn(BackgroundProcess, "stopSession")
      const termSpy = spyOn(InteractiveTerminal, "stopSession")
      const restore = () => {
        storeSpy.mockRestore()
        prefSpy.mockRestore()
        busSpy.mockRestore()
        bgSpy.mockRestore()
        termSpy.mockRestore()
      }
      const changedFor = (id: string) =>
        busSpy.mock.calls.filter(
          (c) => (c[1] as unknown) === Changed && (c[2] as { sessionID?: string })?.sessionID === id,
        )
      const storeFor = (id: string) => storeSpy.mock.calls.filter((c) => (c[1] as string) === id)
      try {
        let guardCalls = 0
        let familyEvals = 0
        let cleanups = 0
        const guard = (enabling: boolean) =>
          enabling
            ? Effect.gen(function* () {
                guardCalls++
                cleanups++
                yield* Effect.promise(() => BackgroundProcess.stopSession(info.id))
                yield* Effect.promise(() => InteractiveTerminal.stopSession(info.id))
              })
            : Effect.sync(() => {
                guardCalls++
              })
        const family = Effect.gen(function* () {
          familyEvals++
          return yield* SandboxActivation.family(info.id)
        })

        storeSpy.mockClear()
        prefSpy.mockClear()
        busSpy.mockClear()
        bgSpy.mockClear()
        termSpy.mockClear()
        const first = yield* provideInstance(dir)(SandboxPolicy.setGuarded(info.id, before.enabled, guard, family))
        expect(first.version).toBe(before.version)
        expect(first.enabled).toBe(before.enabled)
        expect(guardCalls).toBe(0)
        expect(familyEvals).toBe(0)
        expect(cleanups).toBe(0)
        expect(storeFor(info.id).length).toBe(0)
        expect(storeFor(child.id).length).toBe(0)
        expect(prefSpy.mock.calls.length).toBe(0)
        expect(changedFor(info.id).length).toBe(0)
        expect(bgSpy.mock.calls.length).toBe(0)
        expect(termSpy.mock.calls.length).toBe(0)
        const childAfterNoop = yield* provideInstance(dir)(SandboxPolicy.status(child.id))
        expect(childAfterNoop.enabled).toBe(childBefore.enabled)
        expect(childAfterNoop.version).toBe(childBefore.version)

        // Transition then no-op on the new state
        const support = yield* provideInstance(dir)(SandboxPolicy.configuredSupport())
        if (!support.available) return
        storeSpy.mockClear()
        prefSpy.mockClear()
        busSpy.mockClear()
        bgSpy.mockClear()
        termSpy.mockClear()
        const on = yield* provideInstance(dir)(
          SandboxPolicy.setGuarded(info.id, true, guard, SandboxActivation.family(info.id)),
        )
        expect(on.enabled).toBe(true)
        const versionOn = on.version
        // Enabling cleanup ran through the production primitives exactly once.
        expect(cleanups).toBe(1)
        expect(bgSpy.mock.calls.length).toBe(1)
        expect(termSpy.mock.calls.length).toBe(1)

        storeSpy.mockClear()
        prefSpy.mockClear()
        busSpy.mockClear()
        bgSpy.mockClear()
        termSpy.mockClear()
        guardCalls = 0
        familyEvals = 0
        cleanups = 0
        const noop = yield* provideInstance(dir)(SandboxPolicy.setGuarded(info.id, true, guard, family))
        expect(noop.version).toBe(versionOn)
        expect(noop.enabled).toBe(true)
        expect(guardCalls).toBe(0)
        expect(familyEvals).toBe(0)
        expect(cleanups).toBe(0)
        expect(storeFor(info.id).length).toBe(0)
        expect(storeFor(child.id).length).toBe(0)
        expect(prefSpy.mock.calls.length).toBe(0)
        expect(changedFor(info.id).length).toBe(0)
        expect(bgSpy.mock.calls.length).toBe(0)
        expect(termSpy.mock.calls.length).toBe(0)

        storeSpy.mockClear()
        prefSpy.mockClear()
        busSpy.mockClear()
        const off = yield* provideInstance(dir)(SandboxPolicy.setGuarded(info.id, false, Effect.void))
        expect(off.enabled).toBe(false)
        guardCalls = 0
        familyEvals = 0
        storeSpy.mockClear()
        prefSpy.mockClear()
        busSpy.mockClear()
        const noopOff = yield* provideInstance(dir)(SandboxPolicy.setGuarded(info.id, false, guard, family))
        expect(noopOff.version).toBe(off.version)
        expect(guardCalls).toBe(0)
        expect(familyEvals).toBe(0)
        expect(storeFor(info.id).length).toBe(0)
        expect(storeFor(child.id).length).toBe(0)
        expect(prefSpy.mock.calls.length).toBe(0)
        expect(changedFor(info.id).length).toBe(0)
      } finally {
        restore()
      }
    }),
  )

  it.live("false->true and true->false preserve transition semantics", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "sandbox-set-transition" }))
      const support = yield* provideInstance(dir)(SandboxPolicy.configuredSupport())
      if (!support.available) return
      const storeSpy = spyOn(SandboxStore, "write")
      const prefSpy = spyOn(SandboxPreference, "write")
      const busSpy = spyOn(Bus, "publish")
      const restore = () => {
        storeSpy.mockRestore()
        prefSpy.mockRestore()
        busSpy.mockRestore()
      }
      try {
        storeSpy.mockClear()
        prefSpy.mockClear()
        busSpy.mockClear()
        const on = yield* provideInstance(dir)(SandboxPolicy.setGuarded(info.id, true, Effect.void))
        expect(on.enabled).toBe(true)
        expect(on.version).toBeGreaterThan(0)
        expect(storeSpy.mock.calls.filter((c) => (c[1] as string) === info.id).length).toBe(1)
        expect(prefSpy.mock.calls.length).toBe(1)
        expect(
          busSpy.mock.calls.filter(
            (c) => (c[1] as unknown) === Changed && (c[2] as { sessionID?: string })?.sessionID === info.id,
          ).length,
        ).toBe(1)
        storeSpy.mockClear()
        prefSpy.mockClear()
        busSpy.mockClear()
        const off = yield* provideInstance(dir)(SandboxPolicy.setGuarded(info.id, false, Effect.void))
        expect(off.enabled).toBe(false)
        expect(off.version).toBe(on.version + 1)
        expect(storeSpy.mock.calls.filter((c) => (c[1] as string) === info.id).length).toBe(1)
        expect(prefSpy.mock.calls.length).toBe(1)
        expect(
          busSpy.mock.calls.filter(
            (c) => (c[1] as unknown) === Changed && (c[2] as { sessionID?: string })?.sessionID === info.id,
          ).length,
        ).toBe(1)
      } finally {
        restore()
      }
    }),
  )

  it.live("concurrent same-target applies side effects once", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "sandbox-set-concurrent" }))
      const support = yield* provideInstance(dir)(SandboxPolicy.configuredSupport())
      if (!support.available) return
      const fork = yield* provideInstance(dir)(
        sessions.create({ title: "sandbox-set-concurrent-child", parentID: info.id }),
      )
      const storeSpy = spyOn(SandboxStore, "write")
      const prefSpy = spyOn(SandboxPreference, "write")
      const busSpy = spyOn(Bus, "publish")
      const bgSpy = spyOn(BackgroundProcess, "stopSession")
      const termSpy = spyOn(InteractiveTerminal, "stopSession")
      const restore = () => {
        storeSpy.mockRestore()
        prefSpy.mockRestore()
        busSpy.mockRestore()
        bgSpy.mockRestore()
        termSpy.mockRestore()
      }
      try {
        let calls = 0
        let cleanups = 0
        const guard = (enabling: boolean) =>
          Effect.gen(function* () {
            calls++
            if (enabling) {
              cleanups++
              yield* Effect.promise(() => BackgroundProcess.stopSession(info.id))
              yield* Effect.promise(() => InteractiveTerminal.stopSession(info.id))
            }
          })
        const family = SandboxActivation.family(info.id)
        storeSpy.mockClear()
        prefSpy.mockClear()
        busSpy.mockClear()
        bgSpy.mockClear()
        termSpy.mockClear()
        const run = (v: boolean) => provideInstance(dir)(SandboxPolicy.setGuarded(info.id, v, guard, family))
        const [a, b] = yield* Effect.all([run(true), run(true)], { concurrency: "unbounded" })
        expect(a.version).toBe(b.version)
        expect(calls).toBe(1)
        expect(cleanups).toBe(1)
        expect(storeSpy.mock.calls.filter((c) => (c[1] as string) === info.id).length).toBe(1)
        expect(storeSpy.mock.calls.filter((c) => (c[1] as string) === fork.id).length).toBe(1)
        expect(prefSpy.mock.calls.length).toBe(1)
        expect(
          busSpy.mock.calls.filter(
            (c) => (c[1] as unknown) === Changed && (c[2] as { sessionID?: string })?.sessionID === info.id,
          ).length,
        ).toBe(1)
        expect(bgSpy.mock.calls.length).toBe(1)
        expect(termSpy.mock.calls.length).toBe(1)
        const after = yield* provideInstance(dir)(SandboxPolicy.status(info.id))
        expect(after.enabled).toBe(true)
        expect(after.version).toBe(a.version)
      } finally {
        restore()
      }
    }),
  )

  it.live("unavailable enable fails closed with no write", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "sandbox-set-failclosed" }))
      const before = yield* provideInstance(dir)(SandboxPolicy.status(info.id))
      if (before.available) return
      let calls = 0
      const out = yield* provideInstance(dir)(
        SandboxPolicy.setGuarded(info.id, true, Effect.sync(() => calls++)),
      )
      expect(out.enabled).toBe(false)
      expect(out.version).toBe(before.version)
      expect(calls).toBe(0)
    }),
  )

  it.live("legacy toggle unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const dir = yield* tmpdirScoped({ git: true, config: { sandbox: { enabled: false } } })
      const info = yield* provideInstance(dir)(sessions.create({ title: "sandbox-toggle-legacy" }))
      const support = yield* provideInstance(dir)(SandboxPolicy.configuredSupport())
      if (!support.available) return
      const a = yield* provideInstance(dir)(SandboxPolicy.toggleGuarded(info.id, Effect.void))
      const b = yield* provideInstance(dir)(SandboxPolicy.toggleGuarded(info.id, Effect.void))
      expect(a.enabled).not.toBe(b.enabled)
    }),
  )
})
