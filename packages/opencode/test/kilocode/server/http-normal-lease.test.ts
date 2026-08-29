// @ts-nocheck
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { InstanceRef, WorkspaceRef } from "../../../src/effect/instance-ref"
import { InstanceStore } from "../../../src/project/instance-store"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { ControlLease } from "../../../src/kilocode/server/control-lease"
import { InstanceContextMiddleware, instanceContextLayer } from "../../../src/server/routes/instance/httpapi/middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, workspaceRoutingLayer } from "../../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect, pollWithTimeout } from "../../lib/effect"
import { tmpdirScoped } from "../../fixture/fixture"
import { Project } from "../../../src/project/project"
import { InstanceLayer } from "../../../src/project/instance-layer"
import { workspaceLayerWithRuntimeFlags } from "../../fixture/workspace"
import * as Socket from "effect/unstable/socket/Socket"

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer, InstanceLayer.layer, Project.defaultLayer, workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true })))

describe("HTTP normal-load ControlLease", () => {
  it.live("normal-load acquires lease and releases after handler", () =>
    Effect.gen(function* () {
      let acquired = false
      let released = false
      const fakeCtx = { directory: "/tmp/fake-normal", worktree: "/tmp/fake-normal", project: { id: "proj" } } as any
      const mockStore: InstanceStore.Interface = {
        snapshot: () => Effect.succeed(Option.none()),
        load: () => Effect.succeed(fakeCtx),
        dispose: () => Effect.void,
        disposeSafe: () => Effect.void,
        disposeDirectory: () => Effect.void,
        disposeAll: () => Effect.void,
        provide: (_i: any, e: any) => e,
        directories: () => Effect.succeed([]),
        reload: () => Effect.succeed(fakeCtx),
      } as unknown as InstanceStore.Interface
      const mockGate: GenerationGate = {
        isBarrierActive: () => false,
        acquire: () => Effect.succeed(Effect.void),
        beginFence: () => Effect.succeed({ release: Effect.void } as any),
        beginFenceGlobal: () => Effect.succeed({ release: Effect.void } as any),
        prepareWrite: () => Effect.succeed(Effect.void),
      } as unknown as GenerationGate
      const mockLease: ControlLease = {
        acquire: (ctx) => {
          acquired = true
          expect(ctx).toBe(fakeCtx)
          return Option.some(Effect.sync(() => { released = true }))
        },
        acquireWrite: () => Option.some(Effect.void),
        sealAndDrain: () => Effect.void,
      }
      const storeLayer = Layer.succeed(InstanceStore.Service, mockStore)
      const gateLayer = Layer.succeed(GenerationGate.Service, mockGate)
      const leaseLayer = Layer.succeed(ControlLease.Service, mockLease)

      const ProbeApi = HttpApi.make("probe-normal-lease").add(
        HttpApiGroup.make("probe")
          .add(HttpApiEndpoint.get("get", "/probe-normal", { query: WorkspaceRoutingQuery, success: Schema.String }))
          .middleware(InstanceContextMiddleware)
          .middleware(WorkspaceRoutingMiddleware),
      )
      const handlers = HttpApiBuilder.group(ProbeApi, "probe", (h) =>
        h.handle("get", () =>
          Effect.gen(function* () {
            const ref = yield* InstanceRef
            expect(ref).toBe(fakeCtx)
            return "ok"
          }),
        ),
      )
      const apiLayer = HttpApiBuilder.layer(ProbeApi).pipe(
        Layer.provide(handlers),
        Layer.provide(Layer.mergeAll(instanceContextLayer.pipe(Layer.provide(storeLayer), Layer.provide(gateLayer), Layer.provide(leaseLayer)), workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)))),
      )
      yield* apiLayer.pipe(HttpRouter.serve, Layer.build)
      const dir = yield* tmpdirScoped({ git: true })
      yield* Project.use.fromDirectory(dir)
      const response = yield* HttpClient.get(`/probe-normal?directory=${encodeURIComponent(dir)}`)
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
      // Lease should have been acquired and released
      expect(acquired).toBe(true)
      // Use poll to wait for release (ensuring Effect.ensuring ran)
      yield* pollWithTimeout(Effect.sync(() => (released ? (true as const) : undefined)), "lease not released")
      expect(released).toBe(true)
    }),
  )

  it.live("normal-load sealed lease returns 409", () =>
    Effect.gen(function* () {
      const fakeCtx = { directory: "/tmp/fake-sealed", worktree: "/tmp/fake-sealed", project: { id: "proj" } } as any
      const mockStore: InstanceStore.Interface = {
        snapshot: () => Effect.succeed(Option.none()),
        load: () => Effect.succeed(fakeCtx),
        dispose: () => Effect.void,
        disposeSafe: () => Effect.void,
        disposeDirectory: () => Effect.void,
        disposeAll: () => Effect.void,
        provide: (_i: any, e: any) => e,
        directories: () => Effect.succeed([]),
        reload: () => Effect.succeed(fakeCtx),
      } as unknown as InstanceStore.Interface
      const mockGate: GenerationGate = {
        isBarrierActive: () => false,
        acquire: () => Effect.succeed(Effect.void),
        beginFence: () => Effect.succeed({ release: Effect.void } as any),
        beginFenceGlobal: () => Effect.succeed({ release: Effect.void } as any),
        prepareWrite: () => Effect.succeed(Effect.void),
      } as unknown as GenerationGate
      const mockLease: ControlLease = {
        acquire: () => Option.none(),
        acquireWrite: () => Option.some(Effect.void),
        sealAndDrain: () => Effect.void,
      }
      const storeLayer = Layer.succeed(InstanceStore.Service, mockStore)
      const gateLayer = Layer.succeed(GenerationGate.Service, mockGate)
      const leaseLayer = Layer.succeed(ControlLease.Service, mockLease)

      const ProbeApi = HttpApi.make("probe-sealed").add(
        HttpApiGroup.make("probe")
          .add(HttpApiEndpoint.get("get", "/probe-sealed", { query: WorkspaceRoutingQuery, success: Schema.String }))
          .middleware(InstanceContextMiddleware)
          .middleware(WorkspaceRoutingMiddleware),
      )
      const handlers = HttpApiBuilder.group(ProbeApi, "probe", (h) => h.handle("get", () => Effect.succeed("should not reach")))
      const apiLayer = HttpApiBuilder.layer(ProbeApi).pipe(
        Layer.provide(handlers),
        Layer.provide(Layer.mergeAll(instanceContextLayer.pipe(Layer.provide(storeLayer), Layer.provide(gateLayer), Layer.provide(leaseLayer)), workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)))),
      )
      yield* apiLayer.pipe(HttpRouter.serve, Layer.build)
      const dir = yield* tmpdirScoped({ git: true })
      yield* Project.use.fromDirectory(dir)
      const response = yield* HttpClient.get(`/probe-sealed?directory=${encodeURIComponent(dir)}`)
      expect(response.status).toBe(409)
      const body: any = yield* response.json
      expect(body._tag).toBe("InstanceUnavailableDuringConfigRebuild")
    }),
  )
})
