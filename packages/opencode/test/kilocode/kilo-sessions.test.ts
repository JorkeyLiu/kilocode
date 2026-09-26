// kilocode_change - new file
import { expect, spyOn } from "bun:test"
import { symlink, unlink } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import type { Config } from "../../src/config/config"
import { AppRuntime } from "../../src/effect/app-runtime"
import { clearInFlightCache } from "../../src/kilo-sessions/inflight-cache"
import { KiloSessions } from "../../src/kilo-sessions/kilo-sessions"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionStatus } from "../../src/session/status"
import { Storage } from "../../src/storage/storage"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { markProjectConfigReady } from "../fixture/plugin"

const it = testEffect(CrossSpawnSpawner.defaultLayer)
const multi = testEffect(Layer.merge(CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))

function layer(overrides: Partial<Config.Interface> = {}) {
  return Layer.merge(
    KiloSessions.layer.pipe(
      Layer.provideMerge(Bus.layer),
      Layer.provide(TestConfig.layer(overrides)),
      // kilocode_change - provideMerge (not provide) so the same Session
      // instance the subscriber reads is also yielded by regression tests.
      Layer.provideMerge(Session.defaultLayer),
    ),
    Auth.defaultLayer,
  )
}

function reset(...tokens: string[]) {
  clearInFlightCache("kilo-sessions:token")
  clearInFlightCache("kilo-sessions:client")
  for (const token of tokens) clearInFlightCache(`kilo-sessions:token-valid:${token}`)
}

it.instance("initializes once per instance through Config.Service", () => {
  let reads = 0

  return Effect.gen(function* () {
    const sessions = yield* KiloSessions.Service
    yield* sessions.init()
    yield* sessions.init()
    expect(reads).toBe(1)
  }).pipe(
    Effect.provide(
      layer({
        getGlobal: () =>
          Effect.sync(() => {
            reads += 1
            return {}
          }),
      }),
    ),
  )
})

it.instance("bootstraps session ingest from KILO_API_KEY without stored auth", () => {
  const original = process.env.KILO_API_KEY
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/user")) {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "")
        return new Response("{}", { status: 200 })
      }
      if (url.endsWith("/api/session")) {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "")
        return Response.json({ id: "remote-env", ingestPath: "/api/ingest/env" })
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const request = spyOn(globalThis, "fetch").mockImplementation(fetch)

  process.env.KILO_API_KEY = "env-token"
  reset("env-token")

  return Effect.promise(() => KiloSessions.bootstrap("session-env")).pipe(
    Effect.andThen(() => Effect.sync(() => expect(calls).toEqual(["Bearer env-token", "Bearer env-token"]))),
    Effect.ensuring(
      Effect.sync(() => {
        if (original === undefined) delete process.env.KILO_API_KEY
        else process.env.KILO_API_KEY = original
        reset("env-token")
        request.mockRestore()
      }),
    ),
    Effect.provide(layer()),
  )
})

it.instance("prefers stored auth over KILO_API_KEY for session ingest", () => {
  const original = process.env.KILO_API_KEY
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/user")) {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "")
        return new Response("{}", { status: 200 })
      }
      if (url.endsWith("/api/session")) {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "")
        return Response.json({ id: "remote-auth", ingestPath: "/api/ingest/auth" })
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const request = spyOn(globalThis, "fetch").mockImplementation(fetch)

  process.env.KILO_API_KEY = "env-token"
  reset("env-token", "stored-token")

  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* auth.set("kilo", { type: "api", key: "stored-token" })
    yield* Effect.promise(() => KiloSessions.bootstrap("session-auth"))
    expect(calls).toEqual(["Bearer stored-token", "Bearer stored-token"])
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("kilo").pipe(Effect.orDie)
        if (original === undefined) delete process.env.KILO_API_KEY
        else process.env.KILO_API_KEY = original
        reset("env-token", "stored-token")
        request.mockRestore()
      }),
    ),
    Effect.provide(layer()),
  )
})

it.instance("does not duplicate created-session subscribers when init is repeated", () => {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/api/user")) return new Response("{}", { status: 200 })
      if (url.endsWith("/api/session")) {
        calls.push(url)
        return Response.json({ id: "remote-1", ingestPath: "/api/ingest/session-1" })
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const request = spyOn(globalThis, "fetch").mockImplementation(fetch)

  reset("test-token")
  const id = SessionID.descending("session-created")

  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    const instance = yield* TestInstance
    const sessions = yield* KiloSessions.Service
    yield* auth.set("kilo", { type: "api", key: "test-token" })
    yield* sessions.init()
    yield* sessions.init()
    yield* Effect.sleep(50)
    GlobalBus.emit("event", {
      directory: instance.directory,
      payload: {
        id: "test-event",
        type: Session.Event.Created.type,
        properties: {
          sessionID: id,
          info: {
            id,
            slug: "test",
            projectID: ProjectV2.ID.make("project-test"),
            directory: instance.directory,
            title: "test",
            version: "test",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      },
    })
    yield* Effect.sleep(50)
    expect(calls).toHaveLength(1)
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("kilo").pipe(Effect.orDie)
        reset("test-token")
        request.mockRestore()
      }),
    ),
    Effect.provide(layer()),
  )
})

multi.live("isolates the process-wide listener by instance directory", () => {
  const calls: string[] = []
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/api/user")) return new Response("{}", { status: 200 })
      if (url.endsWith("/api/session")) {
        calls.push(url)
        return Response.json({ id: "remote-1", ingestPath: "/api/ingest/session-1" })
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const request = spyOn(globalThis, "fetch").mockImplementation(fetch)

  reset("test-token")

  return Effect.gen(function* () {
    const first = yield* tmpdirScoped()
    const second = yield* tmpdirScoped()
    const auth = yield* Auth.Service
    const store = yield* InstanceStore.Service
    const sessions = yield* KiloSessions.Service
    yield* auth.set("kilo", { type: "api", key: "test-token" })
    yield* store.provide({ directory: first }, sessions.init())
    yield* store.provide({ directory: second }, sessions.init())

    const emit = (directory: string, value: string) => {
      const id = SessionID.descending(`session-${value}`)
      GlobalBus.emit("event", {
        directory,
        payload: {
          id: `event-${value}`,
          type: Session.Event.Created.type,
          properties: {
            sessionID: id,
            info: {
              id,
              slug: value,
              projectID: ProjectV2.ID.make(`project-${value}`),
              directory,
              title: value,
              version: "test",
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })
    }

    emit(first, "first")
    yield* Effect.sleep(50)
    expect(calls).toHaveLength(1)

    emit(second, "second")
    yield* Effect.sleep(50)
    expect(calls).toHaveLength(2)
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("kilo").pipe(Effect.orDie)
        reset("test-token")
        request.mockRestore()
      }),
    ),
    Effect.provide(layer()),
  )
})

// kilocode_change - persistent regression for the InstanceRef/ALS restoration fix:
// real GlobalBus.emit, real canonical runtime services (Storage shares,
// SessionStatus publish/derive), no mocked instance services. The detached
// status debounce and every GlobalBus handler re-enter the exact owner
// instance; without that, derive dies on instance-scoped services and no
// session_status ingest is ever flushed.
interface IngestHit {
  readonly path: string
  readonly items: Array<{ type: string; data: unknown }>
}

function watchIngest(hits: IngestHit[]) {
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("?v=2")) {
        try {
          const body = JSON.parse(String(init?.body ?? "{}")) as { data?: Array<{ type?: string; data?: unknown }> }
          hits.push({
            path: url,
            items: (body.data ?? []).map((item) => ({ type: item.type ?? "?", data: item.data })),
          })
        } catch {
          hits.push({ path: url, items: [] })
        }
      }
      return new Response("{}", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return spyOn(globalThis, "fetch").mockImplementation(fetch)
}

function writeShare(sessionID: string, slug: string) {
  return Effect.promise(() =>
    AppRuntime.runPromise(
      Storage.Service.use((svc) =>
        svc.write(["session_share", sessionID], { id: `remote-${slug}`, ingestPath: `/api/ingest/${slug}` }),
      ),
    ),
  )
}

function removeShare(sessionID: string) {
  return Effect.promise(() =>
    AppRuntime.runPromise(Storage.Service.use((svc) => svc.remove(["session_share", sessionID]))),
  ).pipe(Effect.ignore)
}

function setBusy(directory: string, sessionID: SessionID) {
  return Effect.promise(() =>
    AppRuntime.runPromise(
      provideInstance(directory)(
        Effect.gen(function* () {
          const svc = yield* SessionStatus.Service
          yield* svc.set(sessionID, { type: "busy" })
        }),
      ),
    ),
  )
}

function disposeRuntimeDir(directory: string) {
  return Effect.promise(() =>
    AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeDirectory(directory))),
  ).pipe(Effect.ignore)
}

function waitIngest(hits: IngestHit[], slug: string, type: string) {
  return pollWithTimeout(
    Effect.sync(() => hits.find((hit) => hit.path.includes(`/api/ingest/${slug}`) && hit.items.some((item) => item.type === type))),
    `ingest ${type} never flushed for ${slug}`,
  )
}

function statusesOf(hits: IngestHit[], slug: string) {
  return hits
    .filter((hit) => hit.path.includes(`/api/ingest/${slug}`))
    .flatMap((hit) => hit.items)
    .filter((item) => item.type === "session_status")
    .map((item) => (item.data as { status: string }).status)
}

function setupIngest(token: string) {
  return Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* Effect.acquireRelease(
      auth.set("kilo", { type: "api", key: token }),
      () => auth.remove("kilo").pipe(Effect.orDie),
    )
    const envKey = process.env.KILO_API_KEY
    delete process.env.KILO_API_KEY
    reset(token)
    const hits: IngestHit[] = []
    yield* Effect.acquireRelease(
      Effect.sync(() => watchIngest(hits)),
      (req) => Effect.sync(() => req.mockRestore()),
    )
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.sync(() => {
        if (envKey === undefined) delete process.env.KILO_API_KEY
        else process.env.KILO_API_KEY = envKey
        reset(token)
      }),
    )
    return hits
  })
}

multi.live("syncs status in the exact owner instance, isolated per directory", () =>
  Effect.gen(function* () {
    const dirA = yield* tmpdirScoped()
    const dirB = yield* tmpdirScoped()
    yield* Effect.promise(() => markProjectConfigReady(dirA))
    yield* Effect.promise(() => markProjectConfigReady(dirB))
    const hits = yield* setupIngest("regression-status-token")
    const store = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const kilocode = yield* KiloSessions.Service
    const infoA = yield* store.provide({ directory: dirA }, sessions.create({ title: "regression-a" }))
    const infoB = yield* store.provide({ directory: dirB }, sessions.create({ title: "regression-b" }))
    yield* Effect.acquireRelease(writeShare(infoA.id, "regression-a"), () => removeShare(infoA.id))
    yield* Effect.acquireRelease(writeShare(infoB.id, "regression-b"), () => removeShare(infoB.id))
    yield* Effect.acquireRelease(Effect.void, () => disposeRuntimeDir(dirA))
    yield* Effect.acquireRelease(Effect.void, () => disposeRuntimeDir(dirB))
    yield* store.provide({ directory: dirA }, kilocode.init())
    yield* store.provide({ directory: dirB }, kilocode.init())
    // Real publish path: set() emits through the canonical event bridge,
    // the detached debounce must derive in the exact owner instance.
    yield* setBusy(dirA, infoA.id)
    yield* setBusy(dirB, infoB.id)
    yield* waitIngest(hits, "regression-a", "session_status")
    yield* waitIngest(hits, "regression-b", "session_status")
    // Let a wrong-owner derivation flush if cross-talk existed (the ~1s
    // ingest debounce is the behavior under test, so the sleep is the test).
    yield* Effect.sleep(1200)
    // Exact context: each owner derived its own busy status from its own
    // instance-scoped services. A leaked cross-directory derivation would
    // observe idle (never set there) and overwrite the merged payload.
    expect(statusesOf(hits, "regression-a")).toContain("busy")
    expect(statusesOf(hits, "regression-a")).not.toContain("idle")
    expect(statusesOf(hits, "regression-b")).toContain("busy")
    expect(statusesOf(hits, "regression-b")).not.toContain("idle")
  }).pipe(Effect.provide(layer())),
)

multi.live("accepts symlink alias events and syncs message/session in owner context", () =>
  Effect.gen(function* () {
    const dirA = yield* tmpdirScoped()
    yield* Effect.promise(() => markProjectConfigReady(dirA))
    const hits = yield* setupIngest("regression-alias-token")
    const store = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const kilocode = yield* KiloSessions.Service
    const info = yield* store.provide({ directory: dirA }, sessions.create({ title: "regression-alias" }))
    yield* Effect.acquireRelease(writeShare(info.id, "regression-alias"), () => removeShare(info.id))
    yield* store.provide({ directory: dirA }, kilocode.init())
    // Same physical owner through a symlink spelling: accepted, while a
    // distinct physical directory would be rejected by the owner filter.
    const alias = `${dirA}-alias`
    yield* Effect.acquireRelease(
      Effect.promise(() => symlink(dirA, alias)),
      () => Effect.promise(() => unlink(alias).catch(() => undefined)),
    )
    GlobalBus.emit("event", {
      directory: alias,
      payload: {
        id: "evt-alias-message",
        type: MessageV2.Event.Updated.type,
        properties: {
          sessionID: info.id,
          info: { id: "msg-alias-1", sessionID: info.id, role: "assistant" },
        },
      },
    })
    yield* waitIngest(hits, "regression-alias", "message")
    GlobalBus.emit("event", {
      directory: alias,
      payload: {
        id: "evt-alias-updated",
        type: Session.Event.Updated.type,
        properties: { sessionID: info.id },
      },
    })
    yield* waitIngest(hits, "regression-alias", "session")
  }).pipe(Effect.provide(layer())),
)

multi.live("removes the owner listener on dispose and runs no further owner tasks", () =>
  Effect.gen(function* () {
    const dirA = yield* tmpdirScoped()
    const dirB = yield* tmpdirScoped()
    yield* Effect.promise(() => markProjectConfigReady(dirA))
    yield* Effect.promise(() => markProjectConfigReady(dirB))
    const hits = yield* setupIngest("regression-dispose-token")
    const store = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const kilocode = yield* KiloSessions.Service
    const infoA = yield* store.provide({ directory: dirA }, sessions.create({ title: "regression-dispose" }))
    const infoB = yield* store.provide({ directory: dirB }, sessions.create({ title: "regression-dispose-b" }))
    yield* Effect.acquireRelease(writeShare(infoA.id, "regression-dispose"), () => removeShare(infoA.id))
    yield* Effect.acquireRelease(writeShare(infoB.id, "regression-dispose-b"), () => removeShare(infoB.id))
    yield* Effect.acquireRelease(Effect.void, () => disposeRuntimeDir(dirA))
    yield* Effect.acquireRelease(Effect.void, () => disposeRuntimeDir(dirB))
    yield* store.provide({ directory: dirA }, kilocode.init())
    yield* store.provide({ directory: dirB }, kilocode.init())
    // Prove the owner listener is alive before disposal.
    yield* setBusy(dirA, infoA.id)
    yield* waitIngest(hits, "regression-dispose", "session_status")
    const before = GlobalBus.listenerCount("event")
    const ctxA = yield* store.load({ directory: dirA })
    yield* store.dispose(ctxA)
    // Disposal removes the owner listener (the canonical runtime boot owns a
    // sibling state for the same directory, reaped through the same global
    // per-directory disposer registry, so only a strict decrease is asserted).
    expect(GlobalBus.listenerCount("event")).toBeLessThan(before)
    const settled = hits.length
    // The disposed owner must neither handle new events nor flush orphan
    // debounce/sync work (past the ~1s ingest debounce on purpose).
    yield* setBusy(dirA, infoA.id)
    yield* Effect.sleep(1500)
    expect(hits.length).toBe(settled)
    expect(statusesOf(hits, "regression-dispose")).not.toContain("idle")
    // The sibling owner is unaffected by the disposal.
    yield* setBusy(dirB, infoB.id)
    yield* waitIngest(hits, "regression-dispose-b", "session_status")
    expect(statusesOf(hits, "regression-dispose-b")).toContain("busy")
  }).pipe(Effect.provide(layer())),
)
