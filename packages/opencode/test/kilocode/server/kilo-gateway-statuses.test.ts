import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../../src/auth"
import { KiloGatewayApi, KiloGatewayPaths } from "../../../src/kilocode/server/httpapi/groups/kilo-gateway"
import { kiloGatewayHandlers } from "../../../src/kilocode/server/httpapi/handlers/kilo-gateway"
import { InstanceStore } from "../../../src/project/instance-store"
import { ModelCache } from "../../../src/provider/model-cache"
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
const auth = Layer.mock(Auth.Service)({
  get: () => Effect.succeed(new Auth.Api({ type: "api", key: "test-token" })),
})
const store = Layer.mock(InstanceStore.Service)({})
const cache = Layer.mock(ModelCache.Service)({ clear: () => Effect.void })
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
const layer = HttpRouter.serve(
  HttpApiBuilder.layer(TestHttpApi).pipe(
    Layer.provide(kiloGatewayHandlers),
    Layer.provide(schemaErrorLayer),
    Layer.provide([
      passthroughAuthorization,
      passthroughInstanceContext,
      testWorkspaceRouting,
      auth,
      store,
      cache,
      session,
      EventV2Bridge.defaultLayer,
    ]),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  // The organization route persists provider auth through the canonical
  // coordinator (LOCK-002), which requires FSUtil/ModelCache at the handler
  // boundary. These statuses tests never hit that route, so an opaque handler
  // context satisfies the requirements — same pattern as
  // httpapi-global-sse.test.ts for controlHandlers.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  Layer.provide(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
)
const it = testEffect(layer)

function stub(run: () => Response | Promise<Response>) {
  // These tests run sequentially; scope the process-global override and delegate in-process server traffic.
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

describe("Kilo gateway HttpApi statuses", () => {
  it.live("reports locally stored API authentication without a Gateway request", () =>
    Effect.gen(function* () {
      yield* stub(() => Promise.reject(new Error("unexpected Gateway request")))

      const response = yield* HttpClient.get(KiloGatewayPaths.authStatus)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ authenticated: true, type: "api" })
    }),
  )
})
