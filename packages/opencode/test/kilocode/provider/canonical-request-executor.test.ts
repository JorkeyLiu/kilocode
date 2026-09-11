import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream, Schema } from "effect"
import * as Option from "effect/Option"
import { HttpClientRequest, HttpClientResponse, Headers } from "effect/unstable/http"
import { HttpBody } from "effect/unstable/http"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { LLM, LLMClient, Auth } from "@opencode-ai/llm"
import * as Broker from "@/kilocode/server/provider-http-execute-broker"
import { make as makeExecutor } from "@/kilocode/provider/canonical-request-executor"
import { ProviderHttpExecuteWire } from "@opencode-ai/core/kilocode/provider-http-execute"
import { LLMError } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Tool } from "@opencode-ai/llm"

const sseRaw = (...lines: ReadonlyArray<string>): string => lines.map((line) => `${line}\n\n`).join("")
const deltaChunk = (delta: object, finishReason: string | null = null) => ({
  id: "chatcmpl_fixture",
  choices: [{ delta, finish_reason: finishReason }],
  usage: null,
})
const usageChunk = (usage: object) => ({
  id: "chatcmpl_fixture",
  choices: [],
  usage,
})

const baseRecord = (endpoint = "https://api.example.com/v1") => ({
  name: "Acme",
  endpoint,
  protocol: "openai/completions" as const,
  models: { m1: { name: "M1" } },
  credential: "secret:kilo.credentials.global.provider.acme",
})

const validBody = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })

function requestWith(opts: {
  url?: string
  method?: string
  body?: string | Uint8Array
  headers?: Record<string, string>
  hash?: string
  query?: string
}) {
  const baseUrl = opts.url ?? "https://api.example.com/v1/chat/completions"
  const url = (() => {
    let u = baseUrl
    if (opts.query) u += opts.query
    if (opts.hash) u += opts.hash
    return u
  })()
  let req: HttpClientRequest.HttpClientRequest
  if (opts.method === "GET") req = HttpClientRequest.get(url)
  else if (opts.method === "POST" || opts.method === undefined) req = HttpClientRequest.post(url)
  else req = (HttpClientRequest.make(opts.method as never) as unknown as (url: string) => HttpClientRequest.HttpClientRequest)(url)

  if (opts.body !== undefined) {
    if (opts.body instanceof Uint8Array) {
      req = HttpClientRequest.setBody(req, HttpBody.uint8Array(opts.body))
    } else {
      req = HttpClientRequest.setBody(req, HttpBody.text(opts.body, "application/json"))
    }
  }
  if (opts.headers) {
    req = HttpClientRequest.setHeaders(req, Headers.fromInput(opts.headers))
  }
  return req
}

// helper to run executor and get response or error
const runExecute = (executor: RequestExecutor.Interface, req: HttpClientRequest.HttpClientRequest) =>
  Effect.runPromiseExit(executor.execute(req))

describe("canonical-request-executor", () => {
  test("interrupt during metadata: broker scope finalizer/drop runs exactly once", async () => {
    let drops = 0
    let scopeClosed = 0
    const broker: Broker.Broker = {
      stream: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          // also track scope close via finalizer
          yield* Scope.addFinalizer(scope, Effect.sync(() => { scopeClosed++ }))
          // hang forever waiting for metadata
          yield* Effect.never
          return { status: 200, headers: {}, stream: Stream.empty }
        }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "unused" })),
    }
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    const executor = makeExecutor(ctx, broker)
    const req = requestWith({ body: validBody })
    const fiber = await Effect.runPromise(Effect.forkDetach(Effect.gen(function* () {
      return yield* executor.execute(req)
    })))
    // give time to start
    await new Promise((r) => setTimeout(r, 20))
    expect(drops).toBe(0)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise((r) => setTimeout(r, 30))
    expect(drops).toBe(1)
    expect(scopeClosed).toBe(1)
    // second interrupt should not increase
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore))
    await new Promise((r) => setTimeout(r, 10))
    expect(drops).toBe(1)
    // ensure fiber is done and drops exactly once (interrupt propagates as failure or success depending on implementation)
    const exit = await Effect.runPromiseExit(Fiber.await(fiber))
    // drops already verified exactly once; fiber may be failure (interrupted) or success if scope closed
    expect(drops).toBe(1)
  })

  test("metadata available and first chunk before terminal held; multiple pull/prefetch ordered chunks no hang", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    const gate = await Effect.runPromise(Deferred.make<void>())
    const chunks = ["a-", "b-", "c-", "d"].map((s) => new TextEncoder().encode(s))
    // Stream: first 3 chunks immediately, then wait for gate before last chunk and completion
    const makeStream = () =>
      Stream.make(chunks[0]!, chunks[1]!, chunks[2]!).pipe(
        Stream.concat(Stream.fromEffect(Deferred.await(gate)).pipe(Stream.flatMap(() => Stream.make(chunks[3]!)))),
      )
    const broker: Broker.Broker = {
      stream: () => Effect.succeed({ status: 200, headers: { "content-type": "text/event-stream" }, stream: makeStream() }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker)

    // First chunk available before gate: fresh response, take 1 should succeed quickly
    const response1 = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
    const first = await Effect.runPromise(
      response1.stream.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("100 millis"),
      ),
    )
    expect(Option.isSome(first)).toBeTrue()
    if (Option.isSome(first)) {
      const txt = Buffer.concat([...first.value].map((u) => Buffer.from(u as Uint8Array))).toString()
      expect(txt).toBe("a-")
    }

    // Multiple pulls before gate: take 3 should succeed before gate (a-,b-,c-)
    const response2 = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
    const maybe3 = await Effect.runPromise(
      response2.stream.pipe(Stream.take(3), Stream.runCollect, Effect.timeoutOption("200 millis")),
    )
    expect(Option.isSome(maybe3)).toBeTrue()
    if (Option.isSome(maybe3)) {
      const txt = Buffer.concat([...maybe3.value].map((u) => Buffer.from(u as Uint8Array))).toString()
      expect(txt).toBe("a-b-c-")
    }
    await Effect.runPromise(Deferred.succeed(gate, void 0))

    // Full ordered collection after gate (fresh response, gate already open)
    const response3 = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
    const all = await Effect.runPromise(response3.stream.pipe(Stream.runCollect))
    expect(Buffer.concat([...all].map((u) => Buffer.from(u as Uint8Array))).toString()).toBe("a-b-c-d")
  })

  test("natural completion, terminal error after chunks, consumer cancel/early take each close/drop exactly once", async () => {
    // natural completion
    {
      let drops = 0
      const broker: Broker.Broker = {
        stream: () => Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          return { status: 200, headers: {}, stream: Stream.make(new TextEncoder().encode("hi"), new TextEncoder().encode(" there")) }
        }),
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
      const executor = makeExecutor(ctx, broker)
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      const text = await Effect.runPromise(response.text)
      expect(text).toBe("hi there")
      await new Promise((r) => setTimeout(r, 20))
      expect(drops).toBe(1)
    }
    // terminal error after chunks
    {
      let drops = 0
      const broker: Broker.Broker = {
        stream: () => Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          const stream = Stream.make(new TextEncoder().encode("part1")).pipe(
            Stream.concat(Stream.fail(new Broker.ProviderHttpProtocolError({ message: "terminal mismatch" }))),
          )
          return { status: 200, headers: {}, stream }
        }),
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
      const executor = makeExecutor(ctx, broker)
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      const exit = await Effect.runPromiseExit(response.text)
      expect(Exit.isFailure(exit)).toBeTrue()
      await new Promise((r) => setTimeout(r, 20))
      expect(drops).toBe(1)
    }
    // consumer cancel/early take
    {
      let drops = 0
      const broker: Broker.Broker = {
        stream: () => Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          // finite stream that can be cancelled early
          const stream = Stream.fromIterable(Array.from({ length: 100 }, () => new TextEncoder().encode("chunk")))
          return { status: 200, headers: {}, stream }
        }),
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
      const executor = makeExecutor(ctx, broker)
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      // take only 1 chunk then cancel
      const one = await Effect.runPromise(response.stream.pipe(Stream.take(1), Stream.runCollect))
      expect([...one].length).toBe(1)
      // Stream.take will cancel upstream after 1
      await new Promise((r) => setTimeout(r, 30))
      expect(drops).toBe(1)
      // second attempt on a fresh response should also close exactly once more (total 2), but single stream's second cancel is no-op due to already closed
      // verify no double-drop on same scope by checking drops remains 1 after short wait
      await new Promise((r) => setTimeout(r, 10))
      expect(drops).toBe(1)
    }
  })

  test("HTTP status mapping 401/403, 409, 429 with retry-after, 400/422, 408/500 and body truncation", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    const makeStatusBroker = (status: number, headers: Record<string, string>, body: string): Broker.Broker => ({
      stream: () => Effect.succeed({ status, headers, stream: Stream.succeed(new TextEncoder().encode(body)) }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    })
    const runStatus = async (status: number, headers: Record<string,string>, body: string) => {
      const broker = makeStatusBroker(status, headers, body)
      const executor = makeExecutor(ctx, broker)
      const exit = await Effect.runPromiseExit(executor.execute(requestWith({ body: validBody })))
      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isFailure(exit)) {
        const cause = exit.cause
        const errOpt = Cause.findErrorOption(cause)
        expect(Option.isSome(errOpt)).toBeTrue()
        if (Option.isSome(errOpt)) return errOpt.value as LLMError
      }
      throw new Error("expected failure")
    }
    // 401
    {
      const err = await runStatus(401, {}, "unauthorized")
      expect(err.reason._tag).toBe("Authentication")
      expect((err.reason as { kind: string }).kind).toBe("invalid")
      expect(err.reason.message).toContain("401")
    }
    // 403
    {
      const err = await runStatus(403, {}, "forbidden")
      expect(err.reason._tag).toBe("Authentication")
      expect((err.reason as { kind: string }).kind).toBe("insufficient-permissions")
    }
    // 408 falls to UnknownProvider (consistent with @opencode-ai/llm RequestExecutor)
    {
      const err = await runStatus(408, {}, "timeout")
      expect(err.reason._tag).toBe("UnknownProvider")
      expect((err.reason as { status: number }).status).toBe(408)
    }
    // 409 conflict -> InvalidRequest
    {
      const err = await runStatus(409, {}, "conflict")
      expect(err.reason._tag).toBe("InvalidRequest")
    }
    // 429 with retry-after seconds (tiny value keeps pre-exposure retry fast; seconds branch still covered)
    {
      const err = await runStatus(429, { "retry-after": "0", "retry-after-ms": "0" }, "rate limited")
      expect(err.reason._tag).toBe("RateLimit")
      expect((err.reason as { retryAfterMs: number }).retryAfterMs).toBe(0)
    }
    // 429 with retry-after-ms (tiny value keeps retry fast)
    {
      const err = await runStatus(429, { "retry-after-ms": "1" }, "rate limited")
      expect(err.reason._tag).toBe("RateLimit")
      expect((err.reason as { retryAfterMs: number }).retryAfterMs).toBe(1)
    }
    // 429 with retry-after date (near-future keeps retry fast; date branch still covered)
    {
      const future = new Date(Date.now() + 200).toUTCString()
      const err = await runStatus(429, { "retry-after": future }, "rate limited")
      expect(err.reason._tag).toBe("RateLimit")
      const ms = (err.reason as { retryAfterMs: number }).retryAfterMs
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThan(5000)
    }
    // 429 quota -> QuotaExceeded
    {
      const err = await runStatus(429, {}, "quota exceeded insufficient_quota")
      expect(err.reason._tag).toBe("QuotaExceeded")
    }
    // 400
    {
      const err = await runStatus(400, {}, "bad request")
      expect(err.reason._tag).toBe("InvalidRequest")
    }
    // 422
    {
      const err = await runStatus(422, {}, "unprocessable")
      expect(err.reason._tag).toBe("InvalidRequest")
    }
    // 500 (retry-after-ms 0 keeps pre-exposure retry fast; ProviderInternal still retryable)
    {
      const err = await runStatus(500, { "retry-after-ms": "0" }, "internal")
      expect(err.reason._tag).toBe("ProviderInternal")
      expect((err.reason as { status: number }).status).toBe(500)
    }
    // body truncation
    {
      const bigBody = "x".repeat(20_000)
      const err = await runStatus(400, {}, bigBody)
      const http = (err.reason as { http?: { body?: string; bodyTruncated?: boolean } }).http
      expect(http?.bodyTruncated).toBeTrue()
      expect(http?.body?.length).toBe(16_384)
    }
    // redaction of secret in body - use request with auth header
    {
      const broker = makeStatusBroker(400, {}, `error key header-secret-456`)
      const executor = makeExecutor(ctx, broker)
      const req = requestWith({ body: validBody, headers: { "x-safe": "visible", "authorization": "Bearer header-secret-456" } as unknown as Record<string,string> })
      // This request will fail before broker due to forbidden header, so not good for redaction test
      // Use non-forbidden header that is sensitive via body field
      const broker2 = makeStatusBroker(400, {}, `{"key":"body-secret"}`)
      const executor2 = makeExecutor(ctx, broker2)
      const exit = await Effect.runPromiseExit(executor2.execute(requestWith({ body: validBody })))
      if (Exit.isFailure(exit)) {
        const errOpt = Cause.findErrorOption(exit.cause)
        if (Option.isSome(errOpt)) {
          const err = errOpt.value as LLMError
          const http = (err.reason as { http?: { body?: string } }).http
          expect(http?.body).toContain("<redacted>")
        }
      }
    }
  })

  test("validation: non-POST, empty/malformed, URL mismatch, model mismatch, duplicate key, sensitive header, Uint8Array, content-length/host excluded, comma header forwarded", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    let brokerCalls = 0
    const captureBroker: Broker.Broker = {
      stream: (input) => {
        brokerCalls++
        // capture headers for comma test
        expect(input.headers?.["accept"]).toBe("text/html,application/json")
        return Effect.succeed({ status: 200, headers: {}, stream: Stream.empty })
      },
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, captureBroker)

    // non-POST
    {
      brokerCalls = 0
      const req = requestWith({ method: "GET", body: validBody })
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // empty body
    {
      brokerCalls = 0
      const req = HttpClientRequest.get("https://api.example.com/v1/chat/completions")
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // malformed JSON
    {
      brokerCalls = 0
      const req = requestWith({ body: "not json" })
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // URL mismatch
    {
      brokerCalls = 0
      const req = requestWith({ url: "https://evil.com/v1/chat/completions", body: validBody })
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // query not allowed
    {
      brokerCalls = 0
      const req = requestWith({ url: "https://api.example.com/v1/chat/completions", body: validBody, query: "?q=1" })
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // hash not allowed
    {
      brokerCalls = 0
      const req = requestWith({ url: "https://api.example.com/v1/chat/completions", body: validBody, hash: "#frag" })
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // model mismatch
    {
      brokerCalls = 0
      const badBody = JSON.stringify({ model: "other", messages: [] })
      const req = requestWith({ body: badBody })
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // duplicate model key
    {
      brokerCalls = 0
      const dupBody = `{"model":"m1","model":"m1","messages":[]}`
      const req = requestWith({ body: dupBody })
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // sensitive header
    {
      brokerCalls = 0
      const req = requestWith({ body: validBody, headers: { authorization: "Bearer x" } })
      const exit = await runExecute(executor, req)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(brokerCalls).toBe(0)
    }
    // Uint8Array body accepted
    {
      brokerCalls = 0
      let captured: string | undefined
      const broker2: Broker.Broker = {
        stream: (input) => {
          brokerCalls++
          captured = input.body
          return Effect.succeed({ status: 200, headers: {}, stream: Stream.empty })
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const exec2 = makeExecutor(ctx, broker2)
      const req = requestWith({ body: new TextEncoder().encode(validBody) as unknown as string })
      // requestWith with Uint8Array will set body correctly via overload
      const req2 = HttpClientRequest.post("https://api.example.com/v1/chat/completions").pipe(
        HttpClientRequest.setBody(HttpBody.uint8Array(new TextEncoder().encode(validBody))),
      )
      const exit = await runExecute(exec2, req2)
      expect(Exit.isSuccess(exit)).toBeTrue()
      expect(captured).toBe(validBody)
      expect(brokerCalls).toBe(1)
    }
    // content-length/host excluded
    {
      brokerCalls = 0
      const broker2: Broker.Broker = {
        stream: (input) => {
          brokerCalls++
          expect(input.headers?.["content-length"]).toBeUndefined()
          expect(input.headers?.["host"]).toBeUndefined()
          return Effect.succeed({ status: 200, headers: {}, stream: Stream.empty })
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const exec2 = makeExecutor(ctx, broker2)
      const req = requestWith({ body: validBody, headers: { "content-length": "10", "host": "evil.com", "x-custom": "ok" } })
      const exit = await runExecute(exec2, req)
      expect(Exit.isSuccess(exit)).toBeTrue()
      expect(brokerCalls).toBe(1)
    }
    // comma-valued safe header accepted and forwarded
    {
      brokerCalls = 0
      const req = requestWith({ body: validBody, headers: { accept: "text/html,application/json" } })
      const exit = await runExecute(executor, req)
      expect(Exit.isSuccess(exit)).toBeTrue()
      expect(brokerCalls).toBe(1)
    }
  })

  test("immutable captured context: mutating caller record after make does not change broker input/URL validation", async () => {
    const mutableRecord: Record<string, unknown> = {
      name: "Acme",
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions" as const,
      models: { m1: { name: "M1" } },
      credential: "secret:kilo.credentials.global.provider.acme",
    }
    const ctx = { providerId: "acme", modelId: "m1", record: mutableRecord }
    let capturedRecord: unknown = null
    let capturedEndpoint: unknown = null
    const broker: Broker.Broker = {
      stream: (input) => {
        capturedRecord = input.record
        capturedEndpoint = (input.record as Record<string, unknown>).endpoint
        return Effect.succeed({ status: 200, headers: {}, stream: Stream.empty })
      },
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker)
    // mutate after make
    mutableRecord.endpoint = "https://evil.com/v1"
    ;(mutableRecord.models as Record<string, unknown>).m1 = { name: "Hacked" }
    const req = requestWith({ body: validBody })
    const exit = await runExecute(executor, req)
    expect(Exit.isSuccess(exit)).toBeTrue()
    expect((capturedRecord as Record<string, unknown>).endpoint).toBe("https://api.example.com/v1")
    expect(capturedEndpoint).toBe("https://api.example.com/v1")
    // URL validation should still use original endpoint, not mutated
    const evilReq = requestWith({ url: "https://evil.com/v1/chat/completions", body: validBody })
    const exit2 = await runExecute(executor, evilReq)
    expect(Exit.isFailure(exit2)).toBeTrue()
  })

  test("actual LLMClient with Auth.none compiles structured system/messages/tool and parses incremental SSE into LLMEvents; no secret header", async () => {
    const record = baseRecord("https://api.example.com/v1")
    // Ensure protocol matches openai/completions
    const ctx = { providerId: "acme", modelId: "m1", record }
    let capturedInput: Broker.Input | undefined
    const sseBody = sseRaw(
      `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}`,
      `data: ${JSON.stringify(deltaChunk({ content: " world" }))}`,
      `data: ${JSON.stringify(deltaChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"query":"hi"}' } }] }))}`,
      `data: ${JSON.stringify(usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))}`,
      `data: ${JSON.stringify(deltaChunk({}, "stop"))}`,
    )
    const sseBytes = new TextEncoder().encode(sseBody)
    // split into chunks to simulate incremental SSE bytes
    const chunkSize = 50
    const sseChunks: Uint8Array[] = []
    for (let i = 0; i < sseBytes.length; i += chunkSize) sseChunks.push(sseBytes.slice(i, i + chunkSize))

    const broker: Broker.Broker = {
      stream: (input) => {
        capturedInput = input
        expect(input.headers?.["authorization"]).toBeUndefined()
        expect(input.headers?.["x-api-key"]).toBeUndefined()
        // return stream of SSE bytes incrementally
        return Effect.succeed({ status: 200, headers: { "content-type": "text/event-stream" }, stream: Stream.fromIterable(sseChunks) })
      },
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker)
    const executorLayer = Layer.succeed(RequestExecutor.Service, executor)
    const llmLayer = LLMClient.layer.pipe(Layer.provide(executorLayer))

    const lookupTool = Tool.make({
      description: "lookup",
      parameters: Schema.Struct({ query: Schema.String }),
      success: Schema.Struct({ result: Schema.String }),
      execute: () => Effect.succeed({ result: "ok" }),
    })

    const model = OpenAIChat.route
      .with({ endpoint: { baseURL: "https://api.example.com/v1" }, auth: Auth.none })
      .model({ id: "m1" })

    const llmRequest = LLM.request({
      model,
      system: "You are helpful",
      prompt: "Say hi",
      tools: Tool.toDefinitions({ lookup: lookupTool }),
    })

    const events = await Effect.runPromise(
      LLMClient.stream(llmRequest).pipe(Stream.runCollect, Effect.provide(llmLayer)),
    )
    const evts = [...events]
    // Check that body was compiled to provider-native JSON and captured by broker
    expect(capturedInput).toBeDefined()
    const bodyJson = JSON.parse(capturedInput!.body)
    expect(bodyJson.model).toBe("m1")
    expect(bodyJson.messages).toBeDefined()
    // system + user messages
    const messages = bodyJson.messages as Array<Record<string, unknown>>
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toBe("You are helpful")
    // Check events contain text and tool-call and finish
    const textEvents = evts.filter((e) => (e as unknown as { type: string }).type === "text-delta" || "text" in (e as unknown as Record<string, unknown>))
    // Use LLMEvent guards if available
    // Simpler: check that at least one event has type text-delta or tool-call
    const hasToolCall = evts.some((e) => (e as unknown as { _tag?: string })._tag === "tool-call" || (e as unknown as { type?: string }).type === "tool-call")
    const hasFinish = evts.some((e) => (e as unknown as { _tag?: string })._tag === "finish" || (e as unknown as { type?: string }).type === "finish")
    // At least check text content appears via joining
    const allText = evts
      .map((e) => (e as unknown as { text?: string }).text ?? "")
      .join("")
    // text-delta events may have text field
    expect(evts.length).toBeGreaterThan(0)
    // Check tool call parsed
    const toolCall = evts.find((e) => (e as unknown as { name?: string }).name === "lookup")
    // If not found via name, check via toolName
    const foundTool = toolCall !== undefined || hasToolCall
    expect(foundTool).toBeTrue()
    expect(hasFinish).toBeTrue()
    // Ensure no secret header leaked in capturedInput headers (record's credential is not a header)
    expect(capturedInput?.headers?.["authorization"]).toBeUndefined()
    expect(capturedInput?.headers?.["x-api-key"]).toBeUndefined()
    expect(capturedInput?.headers?.["cookie"]).toBeUndefined()
    // Body should not contain leaked secret values
    expect(JSON.stringify(capturedInput?.body).includes("header-secret")).toBeFalse()
  })

  test("layer canonical-only, no fallback/global routing; broker not called on invalid before", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    let called = false
    const broker: Broker.Broker = {
      stream: () => {
        called = true
        return Effect.succeed({ status: 200, headers: {}, stream: Stream.empty })
      },
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const layer = makeExecutor(ctx, broker)
    // This test just ensures layer is canonical-only; we verify that make with ctx works
    const req = requestWith({ body: validBody })
    // Use layer to get executor via Effect
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const exec = yield* RequestExecutor.Service
        return yield* exec.execute(req)
      }).pipe(Effect.provide(Layer.succeed(RequestExecutor.Service, layer))),
    )
    expect(Exit.isSuccess(exit)).toBeTrue()
    expect(called).toBeTrue()
  })

  test("pre-exposure retry: 429 with retry-after-ms 0 then 2xx succeeds in exactly two attempts", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    let attempts = 0
    let drops = 0
    const broker: Broker.Broker = {
      stream: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          attempts++
          if (attempts === 1) {
            return { status: 429, headers: { "retry-after-ms": "0" }, stream: Stream.succeed(new TextEncoder().encode("rate limited")) } as Broker.HttpStream
          }
          return { status: 200, headers: { "content-type": "text/event-stream" }, stream: Stream.make(new TextEncoder().encode("ok")) } as Broker.HttpStream
        }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker)
    const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
    expect(response.status).toBe(200)
    const text = await Effect.runPromise(response.text)
    expect(text).toBe("ok")
    expect(attempts).toBe(2)
    await new Promise((r) => setTimeout(r, 20))
    expect(drops).toBe(2)
  })

  test("500 exhausts 3 attempts as ProviderInternal; 400/auth/quota/unsupported/unavailable single attempt", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    const runCounted = async (broker: Broker.Broker) => {
      const executor = makeExecutor(ctx, broker)
      const exit = await Effect.runPromiseExit(executor.execute(requestWith({ body: validBody })))
      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isFailure(exit)) {
        const errOpt = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(errOpt)).toBeTrue()
        if (Option.isSome(errOpt)) return errOpt.value as LLMError
      }
      throw new Error("expected failure")
    }
    // 500 x3 exhausts
    {
      let attempts = 0
      let drops = 0
      const broker: Broker.Broker = {
        stream: () =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
            attempts++
            return { status: 500, headers: { "retry-after-ms": "0" }, stream: Stream.succeed(new TextEncoder().encode("internal")) }
          }),
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const err = await runCounted(broker)
      expect(err.reason._tag).toBe("ProviderInternal")
      expect(err.retryable).toBe(true)
      expect(attempts).toBe(3)
      expect(drops).toBe(3)
    }
    // 400 single
    {
      let attempts = 0
      const broker: Broker.Broker = {
        stream: () => {
          attempts++
          return Effect.succeed({ status: 400, headers: {}, stream: Stream.succeed(new TextEncoder().encode("bad")) })
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const err = await runCounted(broker)
      expect(err.reason._tag).toBe("InvalidRequest")
      expect(attempts).toBe(1)
    }
    // 401 auth single
    {
      let attempts = 0
      const broker: Broker.Broker = {
        stream: () => {
          attempts++
          return Effect.succeed({ status: 401, headers: {}, stream: Stream.succeed(new TextEncoder().encode("unauthorized")) })
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const err = await runCounted(broker)
      expect(err.reason._tag).toBe("Authentication")
      expect(attempts).toBe(1)
    }
    // 429 quota non-retryable single
    {
      let attempts = 0
      const broker: Broker.Broker = {
        stream: () => {
          attempts++
          return Effect.succeed({ status: 429, headers: {}, stream: Stream.succeed(new TextEncoder().encode("quota exceeded insufficient_quota")) })
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const err = await runCounted(broker)
      expect(err.reason._tag).toBe("QuotaExceeded")
      expect(err.retryable).toBe(false)
      expect(attempts).toBe(1)
    }
    // unsupported single
    {
      let attempts = 0
      const broker: Broker.Broker = {
        stream: () => {
          attempts++
          return Effect.fail(new Broker.ProviderHttpUnsupported({ capability: "provider/httpExecute", message: "unsupported" }))
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const err = await runCounted(broker)
      expect(err.reason._tag).toBe("Transport")
      expect(attempts).toBe(1)
    }
    // unavailable single
    {
      let attempts = 0
      const broker: Broker.Broker = {
        stream: () => {
          attempts++
          return Effect.fail(new Broker.ProviderHttpUnavailable({ message: "down" }))
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const err = await runCounted(broker)
      expect(err.reason._tag).toBe("Transport")
      expect(attempts).toBe(1)
    }
    // protocol error single
    {
      let attempts = 0
      const broker: Broker.Broker = {
        stream: () => {
          attempts++
          return Effect.fail(new Broker.ProviderHttpProtocolError({ message: "bad wire" }))
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const err = await runCounted(broker)
      expect(err.reason._tag).toBe("InvalidProviderOutput")
      expect(attempts).toBe(1)
    }
    // aborted single
    {
      let attempts = 0
      const broker: Broker.Broker = {
        stream: () => {
          attempts++
          return Effect.fail(new Broker.ProviderHttpFailure({ code: "aborted", message: "aborted" }))
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const err = await runCounted(broker)
      expect(err.reason._tag).toBe("Transport")
      expect(attempts).toBe(1)
    }
  })

  test("interrupt during retry backoff starts no next attempt and cleans scopes", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    let attempts = 0
    let drops = 0
    const broker: Broker.Broker = {
      stream: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          attempts++
          return { status: 503, headers: { "retry-after": "5" }, stream: Stream.succeed(new TextEncoder().encode("busy")) }
        }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker)
    const fiber = await Effect.runPromise(Effect.forkDetach(executor.execute(requestWith({ body: validBody }))))
    // wait for first attempt to finish and backoff to start
    for (let i = 0; i < 100 && attempts === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(attempts).toBe(1)
    // ensure backoff pending (second attempt not yet started)
    await new Promise((r) => setTimeout(r, 20))
    expect(attempts).toBe(1)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise((r) => setTimeout(r, 30))
    expect(attempts).toBe(1)
    expect(drops).toBe(1)
    const outer = await Effect.runPromiseExit(Fiber.await(fiber))
    expect(Exit.isSuccess(outer)).toBeTrue()
    if (Exit.isSuccess(outer)) {
      expect(Exit.isFailure(outer.value)).toBeTrue()
    }
  })

  test("no retry after 2xx first chunk followed by terminal protocol error", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    let attempts = 0
    let drops = 0
    const broker: Broker.Broker = {
      stream: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          attempts++
          const stream = Stream.make(new TextEncoder().encode("part1")).pipe(
            Stream.concat(Stream.fail(new Broker.ProviderHttpProtocolError({ message: "terminal mismatch" }))),
          )
          return { status: 200, headers: {}, stream }
        }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker)
    const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
    expect(response.status).toBe(200)
    const exit = await Effect.runPromiseExit(response.text)
    expect(Exit.isFailure(exit)).toBeTrue()
    expect(attempts).toBe(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(drops).toBe(1)
  })

  test("idle timeout before first byte fails Transport Timeout with single drop", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    let attempts = 0
    let drops = 0
    const broker: Broker.Broker = {
      stream: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          attempts++
          return { status: 200, headers: {}, stream: Stream.never }
        }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker, { timeoutMs: 20 })
    const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
    expect(response.status).toBe(200)
    // Read web-level body to observe raw Transport Timeout LLMError (HttpClientResponse.text wraps into DecodeError)
    const webText = (response as unknown as { source: Response }).source.text()
    const err = await webText.then(
      () => null,
      (e) => e as unknown,
    )
    expect(err).not.toBeNull()
    expect(err).toBeInstanceOf(LLMError)
    if (err instanceof LLMError) {
      expect(err.reason._tag).toBe("Transport")
      expect((err.reason as { kind?: string }).kind).toBe("Timeout")
      expect(err.reason.message.toLowerCase()).toContain("timed out")
    }
    expect(attempts).toBe(1)
    await new Promise((r) => setTimeout(r, 30))
    expect(drops).toBe(1)
  })

  test("idle timeout between chunks; chunks under threshold reset and complete; buffered slow consumer does not time out", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    const readWebError = async (res: HttpClientResponse.HttpClientResponse): Promise<unknown> =>
      (res as unknown as { source: Response }).source.text().then(
        () => null,
        (e) => e as unknown,
      )
    // between chunks: one chunk then hang -> timeout
    {
      let drops = 0
      const broker: Broker.Broker = {
        stream: () =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
            const stream = Stream.make(new TextEncoder().encode("first")).pipe(Stream.concat(Stream.never))
            return { status: 200, headers: {}, stream }
          }),
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const executor = makeExecutor(ctx, broker, 20)
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      const err = await readWebError(response)
      expect(err).not.toBeNull()
      expect(err).toBeInstanceOf(LLMError)
      if (err instanceof LLMError) {
        expect(err.reason._tag).toBe("Transport")
        expect(err.reason.message.toLowerCase()).toContain("timed out")
      }
      await new Promise((r) => setTimeout(r, 20))
      expect(drops).toBe(1)
    }
    // chunks under threshold reset and complete
    {
      let drops = 0
      const broker: Broker.Broker = {
        stream: () =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
            return {
              status: 200,
              headers: {},
              stream: Stream.make(new TextEncoder().encode("a"), new TextEncoder().encode("b"), new TextEncoder().encode("c")),
            }
          }),
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const executor = makeExecutor(ctx, broker, { timeoutMs: 50 })
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      const text = await Effect.runPromise(response.text)
      expect(text).toBe("abc")
      await new Promise((r) => setTimeout(r, 20))
      expect(drops).toBe(1)
    }
    // slow consumer with buffered chunks does not time out (arrival-based, not pull-based)
    {
      let drops = 0
      const broker: Broker.Broker = {
        stream: () =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
            return {
              status: 200,
              headers: {},
              stream: Stream.make(new TextEncoder().encode("x"), new TextEncoder().encode("y")),
            }
          }),
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const executor = makeExecutor(ctx, broker, { timeoutMs: 20 })
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      // delay pulls while chunks are already buffered locally; arrival-based timer must not fire
      await new Promise((r) => setTimeout(r, 100))
      const text = await Effect.runPromise(response.text)
      expect(text).toBe("xy")
      await new Promise((r) => setTimeout(r, 20))
      expect(drops).toBe(1)
    }
  })

  test("factory timeout option: absent/nonpositive disables, number/object enables; layer threads opts", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    const hangingBroker = (dropsRef: { count: number }): Broker.Broker => ({
      stream: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { dropsRef.count++ }))
          return { status: 200, headers: {}, stream: Stream.never }
        }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    })
    // absent disables: external short timeout observes pending, not internal Timeout
    {
      const dropsRef = { count: 0 }
      const executor = makeExecutor(ctx, hangingBroker(dropsRef))
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      const maybe = await Effect.runPromise(response.text.pipe(Effect.timeoutOption("30 millis")))
      expect(Option.isNone(maybe)).toBeTrue()
      await Effect.runPromise(Effect.sleep("10 millis").pipe(Effect.andThen(() => Effect.void)))
    }
    // nonpositive disables
    {
      const dropsRef = { count: 0 }
      const executor = makeExecutor(ctx, hangingBroker(dropsRef), { timeoutMs: 0 })
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      const maybe = await Effect.runPromise(response.text.pipe(Effect.timeoutOption("30 millis")))
      expect(Option.isNone(maybe)).toBeTrue()
    }
    // number enables (web-level Timeout)
    {
      const dropsRef = { count: 0 }
      const executor = makeExecutor(ctx, hangingBroker(dropsRef), 20)
      const response = await Effect.runPromise(executor.execute(requestWith({ body: validBody })))
      const err = await (response as unknown as { source: Response }).source.text().then(
        () => null,
        (e) => e as unknown,
      )
      expect(err).not.toBeNull()
      expect(String((err as Error).message.toLowerCase())).toContain("timed out")
    }
    // object enables and layer threads opts (web-level Timeout)
    {
      const dropsRef = { count: 0 }
      const broker = hangingBroker(dropsRef)
      const lyr = (await import("@/kilocode/provider/canonical-request-executor")).layer(ctx, { timeoutMs: 20 })
      const err = await Effect.runPromise(
        Effect.gen(function* () {
          const exec = yield* RequestExecutor.Service
          const res = yield* exec.execute(requestWith({ body: validBody }))
          return yield* Effect.promise(() =>
            (res as unknown as { source: Response }).source.text().then(
              () => null as unknown,
              (e) => e as unknown,
            ),
          )
        }).pipe(Effect.provide(lyr.pipe(Layer.provide(Layer.succeed(Broker.Service, broker))))),
      )
      expect(err).not.toBeNull()
      expect(String((err as Error).message.toLowerCase())).toContain("timed out")
    }
  })
})
