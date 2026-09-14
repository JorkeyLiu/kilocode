import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { Pty } from "@opencode-ai/core/pty"
import { PtyServiceMap } from "@opencode-ai/core/pty-service-map"
import { Project } from "@opencode-ai/core/project"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as PtyMap from "../../../src/kilocode/pty/map"
import { disposeInstance } from "../../../src/effect/instance-registry"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { InstanceStore } from "../../../src/project/instance-store"
import { Server } from "../../../src/server/server"
import { PtyPaths } from "../../../src/server/routes/instance/httpapi/groups/pty"
import { withTimeout } from "../../../src/util/timeout"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const deps = Layer.mergeAll(Project.defaultLayer, EventV2.defaultLayer)
const provided = PtyMap.layer.pipe(Layer.provide(deps))

const auth = { username: "opencode", password: "pty-lifecycle-proof" }

function authorization() {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

async function startListener() {
  Flag.KILO_SERVER_PASSWORD = auth.password
  Flag.KILO_SERVER_USERNAME = auth.username
  process.env.KILO_SERVER_PASSWORD = auth.password
  process.env.KILO_SERVER_USERNAME = auth.username
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

const originalAuth = {
  password: Flag.KILO_SERVER_PASSWORD,
  username: Flag.KILO_SERVER_USERNAME,
  envPassword: process.env.KILO_SERVER_PASSWORD,
  envUsername: process.env.KILO_SERVER_USERNAME,
}

describe("pty map AppLayer-owned lifecycle", () => {
  afterEach(async () => {
    Flag.KILO_SERVER_PASSWORD = originalAuth.password
    Flag.KILO_SERVER_USERNAME = originalAuth.username
    if (originalAuth.envPassword === undefined) delete process.env.KILO_SERVER_PASSWORD
    else process.env.KILO_SERVER_PASSWORD = originalAuth.envPassword
    if (originalAuth.envUsername === undefined) delete process.env.KILO_SERVER_USERNAME
    else process.env.KILO_SERVER_USERNAME = originalAuth.envUsername
    await disposeAllInstances()
    await resetDatabase()
  })

  test.skipIf(process.platform === "win32")(
    "layer scope close unregisters invalidation and finalizes entries",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = tmp.path
      const ref = { directory: AbsolutePath.make(dir) }
      const scope = Effect.runSync(Scope.make())
      const ctx = await Effect.runPromise(Layer.buildWithScope(provided, scope))
      const map = Context.get(ctx, PtyServiceMap)
      let calls = 0
      const orig = map.invalidate.bind(map)
      map.invalidate = ((key: Parameters<typeof orig>[0]) => {
        calls++
        return orig(key)
      }) as typeof orig
      const layer = map.get(ref)
      const info = await Effect.runPromise(
        Pty.Service.use((svc) =>
          svc.create({ command: "/bin/cat", args: [], cwd: dir, title: "lifecycle", env: {} }),
        ).pipe(Effect.provide(layer), Effect.scoped),
      )
      await disposeInstance(dir)
      expect(calls).toBe(1)
      const seen = await Effect.runPromise(
        Pty.Service.use((svc) => svc.get(info.id)).pipe(
          Effect.provide(map.get(ref)),
          Effect.scoped,
          Effect.map(() => true),
          Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
        ),
      )
      expect(seen).toBe(false)
      await Effect.runPromise(Scope.close(scope, Exit.void))
      const before = calls
      await disposeInstance(dir)
      expect(calls).toBe(before)
      const scopeB = Effect.runSync(Scope.make())
      try {
        const ctxB = await Effect.runPromise(Layer.buildWithScope(provided, scopeB))
        const mapB = Context.get(ctxB, PtyServiceMap)
        const gone = await Effect.runPromise(
          Pty.Service.use((svc) => svc.get(info.id)).pipe(
            Effect.provide(mapB.get(ref)),
            Effect.scoped,
            Effect.map(() => false),
            Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(true)),
          ),
        )
        expect(gone).toBe(true)
      } finally {
        await Effect.runPromise(Scope.close(scopeB, Exit.void).pipe(Effect.ignore))
      }
      await Effect.runPromise(
        Pty.Service.use((svc) => svc.remove(info.id)).pipe(Effect.provide(layer), Effect.scoped, Effect.ignore),
      ).catch(() => undefined)
    },
    { timeout: 60000 },
  )

  test.skipIf(process.platform === "win32")(
    "same-listener directory dispose reaps the AppLayer-owned PTY entry",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = tmp.path
      const listener = await startListener()
      try {
        const created = await fetch(new URL(PtyPaths.create, listener.url), {
          method: "POST",
          headers: {
            authorization: authorization(),
            "x-kilo-directory": dir,
            "content-type": "application/json",
          },
          body: JSON.stringify({ command: "/bin/cat", title: "pty-layer-owned" }),
        })
        expect(created.status).toBe(200)
        const info = (await created.json()) as { id: string }
        const before = await fetch(new URL(PtyPaths.get.replace(":ptyID", info.id), listener.url), {
          headers: { authorization: authorization(), "x-kilo-directory": dir },
        })
        expect(before.status).toBe(200)
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* InstanceStore.Service
            yield* store.load({ directory: dir })
          }),
        )
        await disposeAllInstances()
        const after = await fetch(new URL(PtyPaths.get.replace(":ptyID", info.id), listener.url), {
          headers: { authorization: authorization(), "x-kilo-directory": dir },
        })
        expect(after.status).toBe(404)
      } finally {
        await withTimeout(listener.stop(true), 10_000, "timed out stopping pty lifecycle listener").catch(
          () => undefined,
        )
      }
    },
    { timeout: 60000 },
  )

  test.skipIf(process.platform === "win32")(
    "directory reload reaps the AppLayer-owned PTY entry",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dir = tmp.path
      const listener = await startListener()
      try {
        const created = await fetch(new URL(PtyPaths.create, listener.url), {
          method: "POST",
          headers: {
            authorization: authorization(),
            "x-kilo-directory": dir,
            "content-type": "application/json",
          },
          body: JSON.stringify({ command: "/bin/cat", title: "pty-reload-owned" }),
        })
        expect(created.status).toBe(200)
        const info = (await created.json()) as { id: string }
        const before = await fetch(new URL(PtyPaths.get.replace(":ptyID", info.id), listener.url), {
          headers: { authorization: authorization(), "x-kilo-directory": dir },
        })
        expect(before.status).toBe(200)
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* InstanceStore.Service
            yield* store.reload({ directory: dir })
          }),
        )
        const after = await fetch(new URL(PtyPaths.get.replace(":ptyID", info.id), listener.url), {
          headers: { authorization: authorization(), "x-kilo-directory": dir },
        })
        expect(after.status).toBe(404)
      } finally {
        await withTimeout(listener.stop(true), 10_000, "timed out stopping pty reload listener").catch(
          () => undefined,
        )
      }
    },
    { timeout: 60000 },
  )
})
