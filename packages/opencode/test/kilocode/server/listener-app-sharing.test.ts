import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../../src/server/server"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { SessionStatus } from "../../../src/session/status"
import type { InstanceContext } from "../../../src/project/instance-context"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { withTimeout } from "../../../src/util/timeout"

async function statusMap(listener: { url: URL }, dir: string) {
  const response = await fetch(new URL("/session/status", listener.url), {
    headers: { "x-kilo-directory": dir },
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, { type: string }>
}

async function createSession(listener: { url: URL }, dir: string) {
  const response = await fetch(new URL("/session", listener.url), {
    method: "POST",
    headers: { "x-kilo-directory": dir, "content-type": "application/json" },
    body: JSON.stringify({ title: "listener sharing" }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { id: string }
}

async function loadCtx(dir: string): Promise<InstanceContext> {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      return yield* store.load({ directory: dir })
    }),
  )
}

async function setBusy(ctx: InstanceContext, id: string) {
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const svc = yield* SessionStatus.Service
      yield* svc.set(id as never, { type: "busy" })
    }).pipe(Effect.provideService(InstanceRef, ctx)),
  )
}

async function getViaApp(ctx: InstanceContext, id: string) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const svc = yield* SessionStatus.Service
      return yield* svc.get(id as never)
    }).pipe(Effect.provideService(InstanceRef, ctx)),
  )
}

async function disposeDir(dir: string) {
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      yield* store.disposeDirectory(dir)
    }).pipe(Effect.ignore),
  ).catch(() => undefined)
}

describe("Server.listen standalone topology (canonical AppLayer, fresh transport)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test(
    "default listener and AppRuntime share canonical SessionStatus across two distinct transports",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = tmp.path
      const a = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      const b = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      try {
        // Transports are distinct: different ports/URLs, independent sockets.
        expect(a.port).not.toBe(b.port)
        expect(a.url.toString()).not.toBe(b.url.toString())
        const session = await createSession(a, dir)
        const ctx = await loadCtx(dir)
        await setBusy(ctx, session.id)
        // Canonical sharing: AppRuntime observes what the listener serves.
        expect((await getViaApp(ctx, session.id)).type).toBe("busy")
        expect((await statusMap(a, dir))[session.id]?.type).toBe("busy")
        // Second listener sees the same canonical state through its own transport.
        expect((await statusMap(b, dir))[session.id]?.type).toBe("busy")
      } finally {
        await withTimeout(a.stop(true), 10_000, "stop listener A").catch(() => undefined)
        await withTimeout(b.stop(true), 10_000, "stop listener B").catch(() => undefined)
        await disposeDir(dir)
      }
    },
    { timeout: 60_000 },
  )

  test(
    "stopping one listener does not close the other or dispose shared AppLayer state",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = tmp.path
      const a = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      const b = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      try {
        expect(a.port).not.toBe(b.port)
        const session = await createSession(a, dir)
        const ctx = await loadCtx(dir)
        await setBusy(ctx, session.id)
        expect((await statusMap(b, dir))[session.id]?.type).toBe("busy")
        // WebSocketTracker/HTTP close ownership is per listener: force-close
        // A must not take down B. B keeps serving the same canonical state.
        await withTimeout(a.stop(true), 10_000, "stop listener A")
        expect((await statusMap(b, dir))[session.id]?.type).toBe("busy")
        // Shared AppLayer state survives listener disposal: the process owner
        // (AppRuntime), not the listener scope, owns final disposal.
        expect((await getViaApp(ctx, session.id)).type).toBe("busy")
      } finally {
        await withTimeout(b.stop(true), 10_000, "stop listener B").catch(() => undefined)
        await disposeDir(dir)
      }
    },
    { timeout: 60_000 },
  )

  test(
    "custom appLayer is supplied outside transport freshness (deterministic override)",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = tmp.path
      const { Layer } = await import("effect")
      const fakeID = "ses_ffffffffffffffffffffffff"
      const mockStatus = SessionStatus.Service.of({
        get: () => Effect.succeed({ type: "busy" }) as never,
        list: () => Effect.succeed(new Map([[fakeID as never, { type: "busy" } as never]])) as never,
        set: () => Effect.void as never,
      })
      const { AppLayer } = await import("../../../src/effect/app-runtime")
      const appLayer = Layer.mergeAll(AppLayer, Layer.succeed(SessionStatus.Service, mockStatus))
      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, appLayer: appLayer as never })
      try {
        // The listener serves through its own fresh transport but resolves
        // SessionStatus from the supplied custom app (mock), not canonical.
        const seen = await statusMap(listener, dir)
        expect(seen[fakeID]?.type).toBe("busy")
        // Canonical AppRuntime is untouched by the custom mock.
        const ctx = await loadCtx(dir)
        const canonical = await getViaApp(ctx, fakeID)
        expect(canonical.type).toBe("idle")
      } finally {
        await withTimeout(listener.stop(true), 10_000, "stop custom listener").catch(() => undefined)
        await disposeDir(dir)
      }
    },
    { timeout: 60_000 },
  )
})
