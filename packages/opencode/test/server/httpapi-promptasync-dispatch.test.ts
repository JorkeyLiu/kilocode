import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Database } from "@opencode-ai/core/database/database"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

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
  await disposeAllInstances()
})

type WireMessage = { info: { id: string; role: string } }

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function post(path: string, dir: string, body: unknown) {
  return HttpServer.HttpServer.pipe(
    Effect.flatMap((server) =>
      Effect.promise(async () => {
        const base = HttpServer.formatAddress(server.address)
        const url = new URL(path, base)
        return fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-kilo-directory": dir },
          body: JSON.stringify(body),
        })
      }),
    ),
  )
}

function createSessionHttp(dir: string, title: string) {
  return post("/session", dir, { title }).pipe(
    Effect.flatMap((res) =>
      Effect.promise(async () => {
        expect(res.status).toBe(200)
        const body = (await res.json()) as { id: string }
        return body.id
      }),
    ),
  )
}

function readMessagesHttp(sessionID: string, dir: string) {
  return HttpServer.HttpServer.pipe(
    Effect.flatMap((server) =>
      Effect.promise(async () => {
        const base = HttpServer.formatAddress(server.address)
        const url = new URL(pathFor(SessionPaths.messages, { sessionID }), base)
        const res = await fetch(url, { headers: { "x-kilo-directory": dir } })
        expect(res.status).toBe(200)
        return (await res.json()) as WireMessage[]
      }),
    ),
  )
}

function abortHttp(sessionID: string, dir: string) {
  return HttpServer.HttpServer.pipe(
    Effect.flatMap((server) =>
      Effect.promise(async () => {
        const base = HttpServer.formatAddress(server.address)
        const url = new URL(pathFor(SessionPaths.abort, { sessionID }), base)
        const res = await fetch(url, { method: "POST", headers: { "x-kilo-directory": dir } })
        await res.text().catch(() => undefined)
      }),
    ),
    Effect.ignore,
  )
}

// Narrowly named setup helper (per server test guide): persists the supplied
// user message directly so the duplicate-POST assertions below read real state
// instead of racing the accept-only background intake.
function seedSuppliedUserMessage(dir: string, sessionID: string, messageID: string, text: string) {
  const sid = SessionID.make(sessionID)
  const mid = MessageID.make(messageID)
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory: dir },
      SessionNs.Service.use((svc) =>
        Effect.gen(function* () {
          yield* svc.updateMessage({
            id: mid,
            sessionID: sid,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            tools: {},
          } satisfies SessionV1.User)
          yield* svc.updatePart({
            id: PartID.ascending(),
            sessionID: sid,
            messageID: mid,
            type: "text",
            text,
          } satisfies SessionV1.TextPart)
        }),
      ).pipe(Effect.provide(SessionNs.defaultLayer)),
    ),
  )
}

describe("prompt_async progressive owner", () => {
  it.instance(
    "with messageID accepts twice via dispatch owner",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const id = yield* createSessionHttp(test.directory, "prompt async dispatch")
        const mid = "msg_dispatch000000000001"
        const body = {
          messageID: mid,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "dispatch hello" }],
        }
        // This harness has no provider-backed generation (a sync prompt 500s
        // here), so the accept-only background intake cannot persist on its
        // own. Seed the supplied message first: both POSTs below then exercise
        // the dispatch existing-message replay path deterministically, and the
        // final real-HTTP read cannot false-pass while a first background is
        // still running. The create-then-replay prompt-owner count is covered
        // by the dispatch unit test.
        yield* seedSuppliedUserMessage(test.directory, id, mid, "dispatch hello")
        const first = yield* post(pathFor(SessionPaths.promptAsync, { sessionID: id }), test.directory, body)
        expect(first.status).toBe(204)
        const second = yield* post(pathFor(SessionPaths.promptAsync, { sessionID: id }), test.directory, body)
        expect(second.status).toBe(204)
        // The replay must hit the existing-message fast path, not fork a second
        // prompt owner. Observable over real HTTP: the supplied user message
        // still exists exactly once after both POSTs settle.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* readMessagesHttp(id, test.directory)
            return list.some((item) => item.info?.id === mid) ? (true as const) : undefined
          }),
          "supplied prompt_async user message missing after duplicate POST",
        )
        const final = yield* readMessagesHttp(id, test.directory)
        expect(final.filter((item) => item.info?.id === mid)).toHaveLength(1)
        expect(final.filter((item) => item.info?.role === "user")).toHaveLength(1)
        yield* abortHttp(id, test.directory)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "without messageID keeps legacy compat",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const id = yield* createSessionHttp(test.directory, "prompt async legacy")
        const res = yield* post(
          pathFor(SessionPaths.promptAsync, { sessionID: id }),
          test.directory,
          { agent: "build", noReply: true, parts: [{ type: "text", text: "legacy hello" }] },
        )
        expect(res.status).toBe(204)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "with messageID unknown session maps to 404 instead of silent accept",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const res = yield* post(
          pathFor(SessionPaths.promptAsync, { sessionID: "ses_missing000000000001" }),
          test.directory,
          { messageID: "msg_missing000000000001", agent: "build", parts: [{ type: "text", text: "hi" }] },
        )
        expect(res.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
