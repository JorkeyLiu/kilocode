import { expect } from "bun:test"
import { Auth } from "@/auth"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { InstanceStore } from "@/project/instance-store"
import { ModelCache } from "@/provider/model-cache"
import { ControlLease } from "../../../src/kilocode/server/control-lease"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import type { InstanceContext } from "../../../src/project/instance-context"
import { Effect, Layer, Option, Redacted, Ref } from "effect"
import * as Discovery from "../../../src/kilocode/anaconda-desktop/discovery"
import {
  decodeMetadata,
  PROVIDER_ID,
  type Metadata,
  type ReadyStatus,
} from "../../../src/kilocode/anaconda-desktop/domain"
import * as DesktopPlatform from "../../../src/kilocode/anaconda-desktop/platform"
import * as Desktop from "../../../src/kilocode/anaconda-desktop/service"
import { testEffect } from "../../lib/effect"

const it = testEffect(Layer.empty)

function ready(
  serverID: string,
  port: number,
  key: string,
  toolcall: Metadata["toolcall"] = "supported",
): Discovery.DiscoveryResult {
  const model = `${serverID}.gguf`
  const metadata: Metadata = {
    version: "1",
    serverID,
    baseURL: `http://127.0.0.1:${port}/v1`,
    models: [{ id: model, name: serverID, input: ["text"], output: ["text"] }],
    context: 8192,
    toolcall,
  }
  const status: ReadyStatus = {
    type: "ready",
    serverID,
    models: [{ id: model, name: serverID }],
    context: 8192,
    toolcall,
  }
  return {
    status,
    connection: { key: Redacted.make(key, { label: "fixture inference key" }), metadata },
  }
}

/** Captured pre-fence instance identity the coordinator's rebuild disposes. */
const fakeCtx: InstanceContext = {
  directory: "/tmp/project-a",
  worktree: "/tmp/project-a",
  project: { id: ProjectV2.ID.make("proj-a"), worktree: "/tmp/project-a", time: { created: 0, updated: 0 }, sandboxes: [] },
}

/**
 * Canonical coordinator graph (real gate, control leases, FSUtil) plus an
 * InstanceStore that tracks disposal: the rebuild disposes the captured
 * instance exactly once per registered rebuild and NEVER calls disposeAll.
 */
function storeLayer(events: Ref.Ref<string[]>) {
  return Layer.mergeAll(
    GenerationGate.defaultLayer,
    ConfigConvergence.defaultLayer,
    ControlLease.defaultLayer,
    FSUtil.defaultLayer,
    Layer.mock(InstanceStore.Service)({
      directories: () => Effect.succeed([fakeCtx.directory]),
      snapshot: () => Effect.succeed(Option.some(fakeCtx)),
      dispose: () => Ref.update(events, (items) => [...items, "dispose"]),
      load: () => Effect.succeed(fakeCtx),
      disposeAll: () => Ref.update(events, (items) => [...items, "dispose-all"]),
    }),
  ).pipe(Layer.provideMerge(GenerationGate.defaultLayer))
}

it.live("sync atomically replaces the standard auth record and invalidates via the canonical coordinator", () =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    const records = yield* Ref.make<Record<string, Auth.Info>>({})
    const events = yield* Ref.make<string[]>([])
    const values = [ready("first", 8080, "first-fixture-key"), ready("second", 8081, "second-fixture-key")]

    const discovery = Layer.succeed(
      Discovery.Service,
      Discovery.Service.of({ discover: () => Ref.get(index).pipe(Effect.map((value) => values[value])) }),
    )
    const platform = Layer.succeed(
      DesktopPlatform.Service,
      DesktopPlatform.Service.of({
        info: { platform: "linux", arch: "x64", home: "/tmp", env: {} },
        dataDir: () => Effect.succeed("/tmp"),
        installation: () => Effect.succeed({ path: "/usr/bin/anaconda-desktop" }),
        open: () => Effect.void,
      }),
    )
    const auth = Layer.succeed(
      Auth.Service,
      Auth.Service.of({
        get: (id) => Ref.get(records).pipe(Effect.map((items) => items[id])),
        all: () => Ref.get(records),
        set: (id, value) => Ref.update(records, (items) => ({ ...items, [id]: value })),
        remove: (id) =>
          Ref.update(records, (items) => Object.fromEntries(Object.entries(items).filter(([key]) => key !== id))),
      }),
    )
    const cache = Layer.mock(ModelCache.Service)({
      clear: (id) => Ref.update(events, (items) => [...items, `clear:${id}`]),
    })
    const layer = Desktop.layer.pipe(
      Layer.provide(discovery),
      Layer.provide(platform),
      Layer.provide(auth),
      Layer.provide(cache),
      Layer.provide(storeLayer(events)),
    )

    const first = yield* Desktop.Service.use((service) => service.sync()).pipe(Effect.provide(layer))
    expect(first.serverID).toBe("first")
    // Auth persisted and cache cleared immediately, under the fence.
    expect(yield* Ref.get(events)).toContain(`clear:${PROVIDER_ID}`)
    // The rebuild disposes the captured instance exactly once — never disposeAll.
    yield* awaitRebuilds()
    expect(yield* Ref.get(events)).toEqual([`clear:${PROVIDER_ID}`, "dispose"])

    // A no-op resync (same key + metadata) persists nothing and rebuilds nothing.
    const unchanged = yield* Desktop.Service.use((service) => service.sync()).pipe(Effect.provide(layer))
    expect(unchanged.serverID).toBe("first")
    yield* awaitRebuilds()
    expect(yield* Ref.get(events)).toEqual([`clear:${PROVIDER_ID}`, "dispose"])

    yield* Ref.set(index, 1)
    const second = yield* Desktop.Service.use((service) => service.sync()).pipe(Effect.provide(layer))
    expect(second.serverID).toBe("second")
    yield* awaitRebuilds()
    expect(yield* Ref.get(events)).toEqual([
      `clear:${PROVIDER_ID}`,
      "dispose",
      `clear:${PROVIDER_ID}`,
      "dispose",
    ])

    const stored = (yield* Ref.get(records))[PROVIDER_ID]
    expect(stored?.type).toBe("api")
    if (stored?.type !== "api") throw new Error("standard API auth record was not stored")
    expect(stored.key).toBe("second-fixture-key")
    const metadata = decodeMetadata(stored.metadata)
    expect(metadata?.serverID).toBe("second")
    expect(metadata?.baseURL).toBe("http://127.0.0.1:8081/v1")
    expect(yield* Ref.get(events)).not.toContain("dispose-all")
  }),
)

it.live("sync requires acknowledgement for limited tool support", () =>
  Effect.gen(function* () {
    const writes = yield* Ref.make(0)
    const events = yield* Ref.make<string[]>([])
    const discovery = Layer.succeed(
      Discovery.Service,
      Discovery.Service.of({ discover: () => Effect.succeed(ready("limited", 8080, "fixture-key", "unknown")) }),
    )
    const platform = Layer.mock(DesktopPlatform.Service)({
      info: { platform: "linux", arch: "x64", home: "/tmp", env: {} },
      open: () => Effect.void,
    })
    const auth = Layer.mock(Auth.Service)({
      get: () => Effect.succeed(undefined),
      set: () => Ref.update(writes, (count) => count + 1),
    })
    const cache = Layer.mock(ModelCache.Service)({ clear: () => Effect.void })
    const layer = Desktop.layer.pipe(
      Layer.provide(discovery),
      Layer.provide(platform),
      Layer.provide(auth),
      Layer.provide(cache),
      Layer.provide(storeLayer(events)),
    )

    const refused = yield* Desktop.Service.use((service) => service.sync()).pipe(Effect.provide(layer), Effect.result)
    expect(refused._tag).toBe("Failure")
    expect(yield* Ref.get(writes)).toBe(0)

    const accepted = yield* Desktop.Service.use((service) => service.sync(true)).pipe(Effect.provide(layer))
    expect(accepted.serverID).toBe("limited")
    expect(yield* Ref.get(writes)).toBe(1)
    yield* awaitRebuilds()
  }),
)
