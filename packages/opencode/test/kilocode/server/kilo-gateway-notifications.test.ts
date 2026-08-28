import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../../src/auth"
import { KiloGatewayApi, KiloGatewayPaths } from "../../../src/kilocode/server/httpapi/groups/kilo-gateway"
import { kiloGatewayHandlers } from "../../../src/kilocode/server/httpapi/handlers/kilo-gateway"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import { Authorization } from "../../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../../src/server/routes/instance/httpapi/middleware/schema-error"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../../lib/effect"

const TestHttpApi = HttpApi.make("opencode-instance").addHttpApi(KiloGatewayApi)

const store = Layer.mock(InstanceStore.Service)({})
const session = Layer.mock(Session.Service)({})
const passthroughAuthorization = Layer.succeed(
  Authorization,
  Authorization.of((effect) => effect),
)
const passthroughInstanceContext = Layer.succeed(
  InstanceContextMiddleware,
  InstanceContextMiddleware.of((effect) => effect),
)
const testWorkspaceRouting = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: process.cwd() }))),
  ),
)

function makeLayer(auth: Layer.Layer<Auth.Service>) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(TestHttpApi).pipe(
      Layer.provide(kiloGatewayHandlers),
      Layer.provide(schemaErrorLayer),
      Layer.provide([passthroughAuthorization, passthroughInstanceContext, testWorkspaceRouting, auth, store, session, EventV2Bridge.defaultLayer]),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    Layer.provide(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  )
}

function stub(run: () => Response | Promise<Response>) {
  const original = globalThis.fetch
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith("http://127.0.0.1:")) return original(input, init)
      return run()
    },
    { preconnect: original.preconnect },
  )
  return Effect.acquireRelease(
    Effect.sync(() => {
      globalThis.fetch = fetch
    }),
    () =>
      Effect.sync(() => {
        globalThis.fetch = original
      }),
  )
}

const cloudNotifications = [
  { id: "cloud-1", title: "Cloud notice", message: "hello" },
  { id: "cloud-2", title: "Second", message: "world", action: { actionText: "Open", actionURL: "https://example.com" } },
]

describe("Kilo gateway HttpApi notifications — runtime (P4.4 bounded removal)", () => {
  const authCloud = Layer.mock(Auth.Service)({
    get: () => Effect.succeed(new Auth.Api({ type: "api", key: "test-token" })),
  })
  const liveCloud = testEffect(makeLayer(authCloud))

  liveCloud.live("authenticated cloud array is returned unchanged with no synthetic local notice", () =>
    Effect.gen(function* () {
      let called = false
      yield* stub(() => {
        called = true
        return Promise.resolve(
          new Response(JSON.stringify({ notifications: cloudNotifications }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
      })

      const response = yield* HttpClient.get(KiloGatewayPaths.notifications)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as unknown[]
      expect(body).toEqual(cloudNotifications)
      expect(called).toBe(true)
      // no synthetic local notice ever appended
      const ids = (body as Array<{ id: string }>).map((n) => n.id)
      expect(ids).not.toContain("kilo.local.opencode-config-detected")
      // passthrough is exact — no appended synthetic entry
      expect(body.length).toBe(cloudNotifications.length)
    }),
  )

  const authNone = Layer.mock(Auth.Service)({
    get: () => Effect.succeed(undefined),
  })
  const liveNone = testEffect(makeLayer(authNone))

  liveNone.live("unauthenticated/no-token returns [] without a Gateway request", () =>
    Effect.gen(function* () {
      let called = false
      yield* stub(() => {
        called = true
        return Promise.resolve(
          new Response(JSON.stringify({ notifications: [{ id: "should-not-appear", title: "x", message: "y" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
      })

      const response = yield* HttpClient.get(KiloGatewayPaths.notifications)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as unknown[]
      expect(body).toEqual([])
      expect(called).toBe(false)
    }),
  )
})
