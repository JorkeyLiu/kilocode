import { describe, expect } from "bun:test"
import { Config, Context, Effect, Layer } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import * as Socket from "effect/unstable/socket/Socket"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})

const listenerServed: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.createListenerRoutes(), {
  disableListenLog: true,
  disableLogger: true,
})

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const listenerServerLayer = listenerServed.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const itRoutes = testEffect(Layer.mergeAll(testStateLayer, httpApiServerLayer))
const itListener = testEffect(Layer.mergeAll(testStateLayer, listenerServerLayer))

describe("P4.4 global health removal — production listener denial", () => {
  itRoutes.live("GET /global/health is 404 JSON on App routes (not UI fallback)", () =>
    Effect.gen(function* () {
      const res = yield* HttpClient.get("/global/health")
      expect(res.status).toBe(404)
      const body = yield* res.json
      expect(body).toMatchObject({ error: "Not Found" })
      const ct = res.headers["content-type"] ?? ""
      expect(ct).toContain("application/json")
      const text = JSON.stringify(body)
      expect(text).not.toContain("<html")
      expect(text).not.toContain("<!DOCTYPE")
    }),
  )

  itListener.live("GET /global/health is 404 JSON on Listener routes (production listener)", () =>
    Effect.gen(function* () {
      const res = yield* HttpClient.get("/global/health")
      expect(res.status).toBe(404)
      const body = yield* res.json
      expect(body).toMatchObject({ error: "Not Found" })
      expect((res.headers["content-type"] ?? "").toLowerCase()).toContain("application/json")
    }),
  )

  itRoutes.live("GET /global/health via webHandler is 404 JSON (no SDK OpenAPI exposure)", () =>
    Effect.gen(function* () {
      const handler = HttpApiApp.webHandler().handler
      const ctx = Context.empty() as Context.Context<unknown>
      const res = yield* Effect.promise(() =>
        handler(new Request("http://localhost/global/health", { method: "GET" }), ctx),
      )
      expect(res.status).toBe(404)
      const body = yield* Effect.promise(() => res.json() as Promise<unknown>)
      expect(body).toMatchObject({ error: "Not Found" })
      const ct = res.headers.get("content-type") ?? ""
      expect(ct.toLowerCase()).toContain("application/json")
      // Ensure OpenAPI still does not expose the path
      const doc = yield* Effect.promise(() =>
        handler(new Request("http://localhost/doc", { method: "GET" }), ctx).then((r) => r.json() as Promise<{ paths: Record<string, unknown> }>),
      )
      expect(doc.paths["/global/health"]).toBeUndefined()
      expect(doc.paths["/global/event"]).toBeDefined()
    }),
  )

  itRoutes.live("embedded UI fallback does not capture /global/health (returns JSON not HTML)", () =>
    Effect.gen(function* () {
      // Even though UI catch-all exists, /global/health must not return HTML
      const res = yield* HttpClient.get("/global/health")
      const bodyText = yield* res.text
      expect(bodyText).not.toContain("<html")
      expect(bodyText).not.toContain("opencode-web-ui")
      expect(res.status).toBe(404)
    }),
  )
})
