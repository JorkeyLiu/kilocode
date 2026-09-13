import { afterEach, describe, expect } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { HttpClient, HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Log from "@opencode-ai/core/util/log"
import { createKiloClient } from "@kilocode/sdk/v2"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

void Log.init({ print: false })

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
    Database.defaultLayer,
    httpApiLayer,
  ),
)

afterEach(async () => {
  delete process.env.KILO_AUTH_CONTENT
  await disposeAllInstances()
  await resetDatabase()
})

const SECRET = "stored-secret-key"

type TestServices =
  | FSUtil.Service
  | ChildProcessSpawner.ChildProcessSpawner
  | InstanceStore.Service
  | HttpServer.HttpServer
  | HttpClient.HttpClient
type TestScope = Scope.Scope | TestServices

type Seen = { auth?: string; count: number }

function startUpstream(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  return Effect.acquireRelease(
    Effect.promise(() => {
      const seen: Seen = { count: 0 }
      const server: Server = createServer((req, res) => {
        seen.count += 1
        const header = req.headers.authorization
        seen.auth = Array.isArray(header) ? header.join(",") : header
        handler(req, res, seen)
      })
      return new Promise<{ server: Server; url: string; seen: Seen }>((resolve, reject) => {
        server.on("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          if (!address || typeof address === "string") return reject(new Error("upstream did not bind"))
          resolve({ server, url: `http://127.0.0.1:${address.port}/v1`, seen })
        })
      })
    }),
    ({ server }) => Effect.sync(() => server.close()),
  )
}

function modelsBody(models: Array<Record<string, unknown>>) {
  return JSON.stringify({ data: models })
}

function respond(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

function providerConfig(url: string, stored?: string): Partial<ConfigV1.Info> {
  const base = testProviderConfig(url) as unknown as Record<string, unknown>
  const provider = (base.provider as Record<string, Record<string, unknown>>).test
  return {
    ...(base as Partial<ConfigV1.Info>),
    provider: { test: { ...provider, options: { ...(provider.options as object), baseURL: stored ?? url } } } as never,
  }
}

function withProject<A, E, E2>(
  upstream: { url: string },
  run: (directory: string) => Effect.Effect<A, E, TestScope>,
): Effect.Effect<A, E | E2, TestScope> {
  return Effect.gen(function* () {
    const directory: string = yield* tmpdirScoped({ config: providerConfig(upstream.url) }) as Effect.Effect<
      string,
      E2,
      TestScope
    >
    return yield* run(directory)
  })
}

function withAuth<A, E, R>(self: Effect.Effect<A, E, R>, value: Record<string, unknown>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.KILO_AUTH_CONTENT
      process.env.KILO_AUTH_CONTENT = JSON.stringify(value)
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.KILO_AUTH_CONTENT
        else process.env.KILO_AUTH_CONTENT = previous
      }),
  )
}

function discover(directory: string, providerID: string, baseURL: string) {
  return Effect.gen(function* () {
    const response = yield* requestInDirectory(`/provider/${providerID}/models`, directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseURL }),
    })
    const text = yield* response.text
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {}
    return { status: response.status, body, text }
  })
}

function serverFetch() {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      const baseUrl = HttpServer.formatAddress(server.address)
      return Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          const url = new URL(source.url)
          return globalThis.fetch(new Request(new URL(`${url.pathname}${url.search}`, baseUrl), source))
        },
        { preconnect: globalThis.fetch.preconnect },
      ) satisfies typeof globalThis.fetch
    }),
  )
}

function errorName(body: unknown) {
  if (body && typeof body === "object" && "name" in body) return (body as { name: unknown }).name
  return undefined
}

describe("provider models discovery endpoint", () => {
  it.live("discovers models with the stored key over Bearer auth via the generated SDK", () =>
    Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) =>
        respond(res, 200, modelsBody([{ id: "m2", name: "M Two" }, { id: "m1" }])),
      )
      const fetch = yield* serverFetch()
      const directory = yield* tmpdirScoped({ config: providerConfig(upstream.url) })
      const sdk = createKiloClient({ baseUrl: "http://localhost", directory, fetch })
      const run = Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          sdk.provider.models.discover({ providerID: "test", baseURL: upstream.url }),
        )
        expect(result.response.status).toBe(200)
        expect(result.data).toEqual({ models: [{ id: "m1", name: "m1" }, { id: "m2", name: "M Two" }] })
        expect(upstream.seen.auth).toBe(`Bearer ${SECRET}`)
        expect(upstream.seen.count).toBe(1)
        expect(JSON.stringify(result.data)).not.toContain(SECRET)
      })
      yield* withAuth(run, { test: { type: "api", key: SECRET } })
    }),
  )

  it.live("rejects a mismatched baseURL without contacting the upstream", () =>
    Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => respond(res, 200, modelsBody([{ id: "m1" }])))
      yield* withProject(upstream, (directory) =>
        withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "test", "http://127.0.0.1:9/v1")
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("BadRequest")
            expect(upstream.seen.count).toBe(0)
            expect(result.text).not.toContain(SECRET)
          }),
          { test: { type: "api", key: SECRET } },
        ),
      )
    }),
  )

  it.live("rejects unknown providers without contacting the upstream", () =>
    Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => respond(res, 200, modelsBody([{ id: "m1" }])))
      yield* withProject(upstream, (directory) =>
        withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "missing", upstream.url)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("BadRequest")
            expect(upstream.seen.count).toBe(0)
          }),
          { test: { type: "api", key: SECRET } },
        ),
      )
    }),
  )

  it.live("rejects providers with no stored key and never uses options.apiKey", () =>
    Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => respond(res, 200, modelsBody([{ id: "m1" }])))
      yield* withProject(upstream, (directory) =>
        withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "test", upstream.url)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("BadRequest")
            expect(upstream.seen.count).toBe(0)
          }),
          {},
        ),
      )
    }),
  )

  it.live("rejects kilo without contacting the upstream", () =>
    Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => respond(res, 200, modelsBody([{ id: "m1" }])))
      yield* withProject(upstream, (directory) =>
        withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "kilo", upstream.url)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("BadRequest")
            expect(upstream.seen.count).toBe(0)
          }),
          { test: { type: "api", key: SECRET } },
        ),
      )
    }),
  )

  it.live("rejects userinfo/query/fragment URLs on either side without contacting the upstream", () =>
    Effect.gen(function* () {
      const clean = yield* startUpstream((_req, res) => respond(res, 200, modelsBody([{ id: "m1" }])))
      const variants = [
        `${clean.url}?v=1`,
        `${clean.url}#frag`,
        clean.url.replace("http://", "http://user:pass@"),
      ]
      yield* withAuth(
        Effect.gen(function* () {
          for (const unusual of variants) {
            // Stored and requested URLs are identical, so only the strict
            // shape gate can reject — the exact-match check would pass.
            const directory = yield* tmpdirScoped({ config: providerConfig(unusual, unusual) })
            const result = yield* discover(directory, "test", unusual)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("BadRequest")
            expect(result.text).not.toContain(SECRET)
            expect(result.text).not.toContain("user:pass")
          }
          expect(clean.seen.count).toBe(0)
        }),
        { test: { type: "api", key: SECRET } },
      )
    }),
  )

  it.live("never follows same-origin redirects", () =>
    Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => {
        res.writeHead(301, { location: "/v1/other" })
        res.end()
      })
      yield* withProject(upstream, (directory) =>
        withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "test", upstream.url)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("UpstreamError")
            // A followed redirect would hit the upstream a second time.
            expect(upstream.seen.count).toBe(1)
            expect(upstream.seen.auth).toBe(`Bearer ${SECRET}`)
            expect(result.text).not.toContain("/v1/other")
            expect(result.text).not.toContain(SECRET)
          }),
          { test: { type: "api", key: SECRET } },
        ),
      )
    }),
  )

  it.live("never follows cross-origin redirects carrying the credential", () =>
    Effect.gen(function* () {
      const target = yield* startUpstream((_req, res) => respond(res, 200, modelsBody([{ id: "m1" }])))
      const upstream = yield* startUpstream((_req, res) => {
        res.writeHead(302, { location: `${target.url}/models` })
        res.end()
      })
      yield* withProject(upstream, (directory) =>
        withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "test", upstream.url)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("UpstreamError")
            expect(upstream.seen.count).toBe(1)
            expect(target.seen.count).toBe(0)
            expect(result.text).not.toContain(SECRET)
          }),
          { test: { type: "api", key: SECRET } },
        ),
      )
    }),
  )

  it.live(
    "stops an infinite chunked body at the byte bound",
    () =>
      Effect.gen(function* () {
        // Infinite chunked body: the request completing with "oversized"
        // proves the client stopped at the 1 MiB bound instead of
        // consuming the stream. The pooled socket is destroyed explicitly
        // afterwards so teardown never waits on the endless response.
        const state = { ended: false, socket: undefined as { destroy(): void } | undefined }
        const upstream = yield* startUpstream((req, res) => {
          state.socket = req.socket as unknown as { destroy(): void }
          res.on("error", () => {})
          res.writeHead(200, { "content-type": "application/json" })
          const piece = "x".repeat(65536)
          const pump = (): void => {
            try {
              for (let i = 0; i < 64; i++) {
                if (!res.write(piece)) break
              }
            } catch {
              return
            }
          }
          res.on("drain", () => pump())
          pump()
        })
        yield* withProject(upstream, (directory) =>
          withAuth(
            Effect.gen(function* () {
              const result = yield* discover(directory, "test", upstream.url)
              expect(result.status).toBe(400)
              expect(errorName(result.body)).toBe("InvalidResponse")
              expect(result.text).toContain("oversized")
              expect(result.text).not.toContain(SECRET)
              expect(state.ended).toBe(false)
              yield* Effect.sync(() => {
                try {
                  state.socket?.destroy()
                } catch {}
              })
            }),
            { test: { type: "api", key: SECRET } },
          ),
        )
      }),
    30000,
  )

  it.live("maps upstream 401 to redacted Unauthorized", () =>
    Effect.gen(function* () {
      const upstream = yield* startUpstream((_req, res) => respond(res, 401, JSON.stringify({ error: "bad key" })))
      yield* withProject(upstream, (directory) =>
        withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "test", upstream.url)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("Unauthorized")
            expect(result.text).toContain("HTTP 401")
            expect(result.text).not.toContain(SECRET)
            expect(result.text).not.toContain("bad key")
          }),
          { test: { type: "api", key: SECRET } },
        ),
      )
    }),
  )

  it.live("treats a Basic-only upstream as Unauthorized (Bearer only, no Basic fallback)", () =>
    Effect.gen(function* () {
      const upstream = yield* startUpstream((req, res) => {
        const header = req.headers.authorization ?? ""
        if (header.startsWith("Basic ")) return respond(res, 200, modelsBody([{ id: "m1" }]))
        return respond(res, 401, JSON.stringify({ error: "basic required" }))
      })
      yield* withProject(upstream, (directory) =>
        withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "test", upstream.url)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("Unauthorized")
            expect(upstream.seen.auth).toBe(`Bearer ${SECRET}`)
          }),
          { test: { type: "api", key: SECRET } },
        ),
      )
    }),
  )

  it.live("maps malformed, oversize, and too-many responses to InvalidResponse", () =>
    Effect.gen(function* () {
      const malformed = yield* startUpstream((_req, res) => respond(res, 200, "not-json{{{"))
      yield* withAuth(
        Effect.gen(function* () {
          const onlyMalformed = yield* tmpdirScoped({ config: providerConfig(malformed.url) })
          const bad = yield* discover(onlyMalformed, "test", malformed.url)
          expect(bad.status).toBe(400)
          expect(errorName(bad.body)).toBe("InvalidResponse")

          const oversize = yield* startUpstream((_req, res) => respond(res, 200, "x".repeat(1_000_001)))
          const onlyOversize = yield* tmpdirScoped({ config: providerConfig(oversize.url) })
          const big = yield* discover(onlyOversize, "test", oversize.url)
          expect(big.status).toBe(400)
          expect(errorName(big.body)).toBe("InvalidResponse")

          const many = Array.from({ length: 501 }, (_, i) => ({ id: `m${i}` }))
          const crowded = yield* startUpstream((_req, res) => respond(res, 200, modelsBody(many)))
          const onlyCrowded = yield* tmpdirScoped({ config: providerConfig(crowded.url) })
          const full = yield* discover(onlyCrowded, "test", crowded.url)
          expect(full.status).toBe(400)
          expect(errorName(full.body)).toBe("InvalidResponse")
          expect(full.text).not.toContain(SECRET)
        }),
        { test: { type: "api", key: SECRET } },
      )
    }),
  )

  it.live("maps refused connections to UpstreamError", () =>
    Effect.gen(function* () {
      const closed = yield* Effect.promise(() => {
        const server: Server = createServer(() => {})
        return new Promise<string>((resolve, reject) => {
          server.on("error", reject)
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (!address || typeof address === "string") return reject(new Error("probe did not bind"))
            const url = `http://127.0.0.1:${(address as { port: number }).port}/v1`
            server.close(() => resolve(url))
          })
        })
      })
      const directory = yield* tmpdirScoped({ config: providerConfig(closed) })
      yield* withAuth(
        Effect.gen(function* () {
          const result = yield* discover(directory, "test", closed)
          expect(result.status).toBe(400)
          expect(errorName(result.body)).toBe("UpstreamError")
          expect(result.text).not.toContain(SECRET)
        }),
        { test: { type: "api", key: SECRET } },
      )
    }),
  )

  it.live(
    "maps a hanging upstream to UpstreamError after the 15s timeout",
    () =>
      Effect.gen(function* () {
        const upstream = yield* startUpstream(() => {})
        const directory = yield* tmpdirScoped({ config: providerConfig(upstream.url) })
        yield* withAuth(
          Effect.gen(function* () {
            const result = yield* discover(directory, "test", upstream.url)
            expect(result.status).toBe(400)
            expect(errorName(result.body)).toBe("UpstreamError")
            expect(result.text).not.toContain(SECRET)
          }),
          { test: { type: "api", key: SECRET } },
        )
      }),
    40000,
  )
})
