import { afterEach, describe, expect } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import path from "path"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Provider } from "../../../src/provider/provider"
import { InstanceStore } from "../../../src/project/instance-store"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { testProviderConfig } from "../../lib/test-provider"
import { validateProviderModelsDiscoverData } from "../../../src/kilocode/provider-models-discover"

const it = testEffectShared(AppLayer)

const SECRET = "stored-secret-key"

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}
function str(r: Record<string, unknown>, k: string): string {
  const v = r[k]
  if (typeof v !== "string") throw new Error(`expected string response.${k}`)
  return v
}
function asResult(v: unknown) {
  const r = asRecord(v)
  if (r.v !== 1) throw new Error("expected v 1")
  const requestId = str(r, "requestId")
  const op = str(r, "op")
  if (op !== "provider/models-discover") throw new Error("expected op provider/models-discover")
  const status = str(r, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected succeeded/failed")
  if (r.opId !== undefined) throw new Error("requestId-only result must not carry opId")
  if (r.idempotencyKey !== undefined) throw new Error("requestId-only result must not carry idempotencyKey")
  return { r, requestId, status }
}
function failureOf(v: unknown): { code: string; message: string; retryable: unknown } | undefined {
  if (!isRecord(v)) return undefined
  const f = v.failure
  if (isRecord(f) && typeof f.code === "string" && typeof f.message === "string")
    return { code: f.code, message: f.message, retryable: f.retryable }
  return undefined
}
function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}
function req(dir: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: "req-discover-1",
    op: "provider/models-discover",
    context: { directory: dir },
    payload,
    ...overrides,
  }
}
async function init(ext: JsonRpcPeer) {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["provider/models-discover"],
    }),
  )
}
function ownParentPid(): () => void {
  const prior = process.env.KILO_PARENT_PID
  process.env.KILO_PARENT_PID = "1"
  return () => {
    if (prior === undefined) delete process.env.KILO_PARENT_PID
    else process.env.KILO_PARENT_PID = prior
  }
}
function capsOf(v: unknown): string[] {
  if (!isRecord(v)) return []
  const c = v.capabilities
  return Array.isArray(c) ? c.filter((e): e is string => typeof e === "string") : []
}
function providerConfig(url: string): Record<string, unknown> {
  const base = testProviderConfig(url) as unknown as Record<string, unknown>
  const provider = (base.provider as Record<string, Record<string, unknown>>).test
  return {
    ...(base as Record<string, unknown>),
    provider: { test: { ...provider, options: { ...(provider.options as object), baseURL: url } } },
  }
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

describe("fd-carrier provider/models-discover (private-first observation)", () => {
  afterEach(async () => {
    delete process.env.KILO_AUTH_CONTENT
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises provider/models-discover capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capsOf(res).includes("provider/models-discover")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("pre-init rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext
              .request(
                "provider/models-discover",
                req("/tmp", { providerID: "test", baseURL: "https://example.com/v1" }),
              )
              .then(
                () => undefined,
                (e: unknown) => e,
              ),
          )
          const rec = isRecord(err) ? err : {}
          expect((rec as Record<string, unknown>).code).toBe(ErrorCode.InvalidRequest)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("strict validation fails closed with fixed redacted failures", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const good = { providerID: "test", baseURL: "https://example.com/v1" }
          const cases = [
            req("relative/path", good),
            { ...req(dir, good), context: { directory: "/tmp\0" } },
            req(dir, { providerID: "", baseURL: "https://example.com/v1" }),
            req(dir, { providerID: "test", baseURL: "ftp://example.com/v1" }),
            req(dir, { providerID: "test", baseURL: "https://example.com/v1?q=1" }),
            req(dir, { providerID: "test" }),
            req(dir, {}),
            req(dir, { ...good, headers: { Authorization: "Bearer sk-leak" } }),
            req(dir, good, { sessionRevision: 1 }),
            req(dir, good, { op: "provider/catalog" }),
            req(dir, good, { opId: "x", idempotencyKey: "x" }),
          ]
          for (const c of cases) {
            const res = asRecord(yield* Effect.promise(() => ext.request("provider/models-discover", c)))
            expect(res.status).toBe("failed")
            expect(failureOf(res)?.code).toBe("validation.failed")
            expect(res.accepted).toBe(false)
            expect(res.data).toBeUndefined()
            const wire = JSON.stringify(res)
            expect(wire.includes("sk-leak")).toBeFalse()
          }
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("unknown provider and mismatched baseURL are terminal without contacting upstream", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const run = Effect.gen(function* () {
            const missing = asRecord(
              yield* Effect.promise(() =>
                ext.request(
                  "provider/models-discover",
                  req(dir, { providerID: "missing", baseURL: "https://example.com/v1" }, { requestId: "req-unknown" }),
                ),
              ),
            )
            expect(missing.status).toBe("failed")
            expect(failureOf(missing)?.code).toBe("validation.failed")
            const mismatch = asRecord(
              yield* Effect.promise(() =>
                ext.request(
                  "provider/models-discover",
                  req(dir, { providerID: "test", baseURL: "https://127.0.0.1:9/v1" }, { requestId: "req-mismatch" }),
                ),
              ),
            )
            expect(mismatch.status).toBe("failed")
            expect(failureOf(mismatch)?.code).toBe("validation.failed")
          })
          yield* withAuth(run, { test: { type: "api", key: SECRET } })
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("same-directory success discovers with the stored key and redacts the secret", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      const upstream = yield* Effect.acquireRelease(
        Effect.promise(() => {
          let count = 0
          let auth: string | undefined
          const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
            count += 1
            const header = req.headers.authorization
            auth = Array.isArray(header) ? header.join(",") : header
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ data: [{ id: "m2", name: "M Two" }, { id: "m1" }] }))
          })
          return new Promise<{ server: Server; url: string; seen: () => { count: number; auth?: string } }>(
            (resolve, reject) => {
              server.on("error", reject)
              server.listen(0, "127.0.0.1", () => {
                const address = server.address()
                if (!address || typeof address === "string") return reject(new Error("upstream did not bind"))
                resolve({
                  server,
                  url: `http://127.0.0.1:${(address as { port: number }).port}/v1`,
                  seen: () => ({ count, auth }),
                })
              })
            },
          )
        }),
        ({ server }) => Effect.sync(() => server.close()),
      )
      try {
        const tmp = yield* Effect.promise(() =>
          tmpdir({ git: true, retain: true, config: providerConfig(upstream.url) as never }),
        )
        const dir = tmp.path
        expect(path.isAbsolute(dir)).toBeTrue()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const run = Effect.gen(function* () {
            const raw = yield* Effect.promise(() =>
              ext.request(
                "provider/models-discover",
                req(dir, { providerID: "test", baseURL: upstream.url }, { requestId: "req-same" }),
              ),
            )
            const { r, requestId, status } = asResult(raw)
            expect(status).toBe("succeeded")
            expect(requestId).toBe("req-same")
            expect(r.accepted).toBe(true)
            validateProviderModelsDiscoverData(r.data)
            expect(r.data).toEqual({
              models: [
                { id: "m1", name: "m1" },
                { id: "m2", name: "M Two" },
              ],
            })
            const wire = JSON.stringify(r)
            expect(wire.includes(SECRET)).toBeFalse()
            expect(upstream.seen().auth).toBe(`Bearer ${SECRET}`)
            expect(upstream.seen().count).toBe(1)
            const store = yield* InstanceStore.Service
            const ctx = yield* store.load({ directory: dir })
            void ctx
            const svc = yield* Provider.Service
            void svc
          })
          yield* withAuth(run, { test: { type: "api", key: SECRET } })
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("upstream 401 maps to terminal unauthorized with zero SDK", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      const upstream = yield* Effect.acquireRelease(
        Effect.promise(() => {
          const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
            res.writeHead(401, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "bad key" }))
          })
          return new Promise<{ server: Server; url: string }>((resolve, reject) => {
            server.on("error", reject)
            server.listen(0, "127.0.0.1", () => {
              const address = server.address()
              if (!address || typeof address === "string") return reject(new Error("upstream did not bind"))
              resolve({ server, url: `http://127.0.0.1:${(address as { port: number }).port}/v1` })
            })
          })
        }),
        ({ server }) => Effect.sync(() => server.close()),
      )
      try {
        const tmp = yield* Effect.promise(() =>
          tmpdir({ git: true, retain: true, config: providerConfig(upstream.url) as never }),
        )
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const run = Effect.gen(function* () {
            const res = asRecord(
              yield* Effect.promise(() =>
                ext.request(
                  "provider/models-discover",
                  req(dir, { providerID: "test", baseURL: upstream.url }, { requestId: "req-auth" }),
                ),
              ),
            )
            expect(res.status).toBe("failed")
            const failure = failureOf(res)
            expect(failure?.code).toBe("unauthorized")
            expect(failure?.retryable).toBe(false)
            const wire = JSON.stringify(res)
            expect(wire.includes(SECRET)).toBeFalse()
            expect(wire.includes("bad key")).toBeFalse()
          })
          yield* withAuth(run, { test: { type: "api", key: SECRET } })
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )
})
