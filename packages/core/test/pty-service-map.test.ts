import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Pty } from "@opencode-ai/core/pty"
import { PtyServiceMap } from "@opencode-ai/core/pty-service-map"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Project } from "@opencode-ai/core/project"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  PtyServiceMap.layer.pipe(Layer.provide(Layer.mergeAll(Project.defaultLayer, EventV2.defaultLayer))),
)

function scoped(dirs: string[]) {
  return Effect.acquireRelease(Effect.succeed(dirs), () => Effect.promise(() => Promise.resolve()))
}

describe("PtyServiceMap", () => {
  it.live("same directory shares one owner across gets", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((d) => d[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([a]) =>
        Effect.gen(function* () {
          const map = yield* PtyServiceMap
          const ref = { directory: AbsolutePath.make(a.path) }
          const first = map.get(ref)
          const second = map.get(ref)
          const info = yield* Pty.Service.use((svc) =>
            svc.create({ command: "/bin/cat", args: [], cwd: a.path, title: "shared", env: {} }),
          ).pipe(Effect.provide(first), Effect.scoped)
          const seen = yield* Pty.Service.use((svc) => svc.get(info.id)).pipe(Effect.provide(second), Effect.scoped)
          expect(seen.id).toBe(info.id)
          yield* Pty.Service.use((svc) => svc.remove(info.id)).pipe(Effect.provide(first), Effect.scoped, Effect.ignore)
        }),
      ),
    ),
  )

  it.live("different directories isolate owners", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((d) => d[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([a, b]) =>
        Effect.gen(function* () {
          const map = yield* PtyServiceMap
          const layerA = map.get({ directory: AbsolutePath.make(a.path) })
          const layerB = map.get({ directory: AbsolutePath.make(b.path) })
          const info = yield* Pty.Service.use((svc) =>
            svc.create({ command: "/bin/cat", args: [], cwd: a.path, title: "isolated", env: {} }),
          ).pipe(Effect.provide(layerA), Effect.scoped)
          try {
            const isolated = yield* Pty.Service.use((svc) => svc.get(info.id)).pipe(
              Effect.provide(layerB),
              Effect.scoped,
              Effect.map(() => false),
              Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(true)),
            )
            expect(isolated).toBeTrue()
          } finally {
            yield* Pty.Service.use((svc) => svc.remove(info.id)).pipe(
              Effect.provide(layerA),
              Effect.scoped,
              Effect.ignore,
            )
          }
        }),
      ),
    ),
  )

  it.live("invalidate reaps the directory entry", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (d) => Effect.promise(() => d[Symbol.asyncDispose]().then(() => undefined)),
    ).pipe(
      Effect.flatMap((a) =>
        Effect.gen(function* () {
          const map = yield* PtyServiceMap
          const ref = { directory: AbsolutePath.make(a.path) }
          const layer = map.get(ref)
          const info = yield* Pty.Service.use((svc) =>
            svc.create({ command: "/bin/cat", args: [], cwd: a.path, title: "reap", env: {} }),
          ).pipe(Effect.provide(layer), Effect.scoped)
          yield* map.invalidate(ref)
          const gone = yield* Pty.Service.use((svc) => svc.get(info.id)).pipe(
            Effect.provide(map.get(ref)),
            Effect.scoped,
            Effect.map(() => false),
            Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(true)),
          )
          expect(gone).toBeTrue()
        }),
      ),
    ),
  )

  it.live("LocationServiceMap no longer owns Pty", () =>
    Effect.gen(function* () {
      const file = Bun.file(new URL("../src/location-layer.ts", import.meta.url))
      const src = yield* Effect.promise(() => file.text())
      expect(src.includes("Pty.locationLayer")).toBe(false)
      expect(LocationServiceMap !== undefined).toBeTrue()
      void scoped
    }),
  )
})
