import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Scope, Stream } from "effect"
import * as Option from "effect/Option"
import { HttpBody, HttpClientRequest } from "effect/unstable/http"
import * as Broker from "@/kilocode/server/provider-http-execute-broker"
import { make as makeExecutor } from "@/kilocode/provider/canonical-request-executor"
import { LLMError } from "@opencode-ai/llm"

const baseRecord = () => ({
  name: "Acme",
  endpoint: "https://api.example.com/v1",
  protocol: "openai/completions" as const,
  models: { m1: { name: "M1" } },
  credential: "secret:kilo.credentials.global.provider.acme",
})
const validBody = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })
const req = () =>
  HttpClientRequest.post("https://api.example.com/v1/chat/completions").pipe(
    HttpClientRequest.setBody(HttpBody.text(validBody, "application/json")),
  )

const errOf = (exit: Exit.Exit<unknown, unknown>): LLMError => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  const errOpt = Cause.findErrorOption(exit.cause)
  if (Option.isNone(errOpt)) throw new Error("expected LLMError")
  return errOpt.value as LLMError
}

const isAbortShaped = (err: unknown): boolean => {
  if (err instanceof DOMException && err.name === "AbortError") return true
  const name = (err as { name?: unknown })?.name
  return name === "MessageAbortedError" || name === "AbortedError"
}

describe("canonical-request-executor peer-close", () => {
  test("post-exposure broker loss while web pull held: pull settles, single attempt, scope closes once", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    const gate = await Effect.runPromise(Deferred.make<void>())
    let attempts = 0
    let drops = 0
    const broker: Broker.Broker = {
      stream: () =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => { drops++ }))
          attempts++
          const s = Stream.make(new TextEncoder().encode("part1")).pipe(
            Stream.concat(
              Stream.fromEffect(Deferred.await(gate)).pipe(
                Stream.flatMap(() => Stream.fail(new Broker.ProviderHttpProtocolError({ message: "Peer closed" }))),
              ),
            ),
          )
          return { status: 200, headers: {}, stream: s }
        }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker)
    const response = await Effect.runPromise(executor.execute(req()))
    expect(response.status).toBe(200)
    const reader = (response as unknown as { source: Response }).source.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect((first.value as Uint8Array).length).toBe(5)
    const pending = reader.read()
    await Effect.runPromise(Deferred.succeed(gate, void 0))
    // pending pull must settle promptly: never hangs permanently
    const second = await Promise.race([
      pending.then(
        () => ({ settled: true as const, errored: false as const }),
        (e) => ({ settled: true as const, errored: true as const, abortShaped: isAbortShaped(e), msg: String((e as Error)?.message ?? e).slice(0, 120) }),
      ),
      new Promise((r) => setTimeout(() => r({ settled: false as const }), 2000)) as Promise<{ settled: boolean }>,
    ])
    expect(second.settled).toBe(true)
    if (second.settled && "errored" in second && second.errored) {
      // provider loss is a failure, never user-abort shaped
      expect(second.abortShaped).toBe(false)
    }
    if (second.settled && "errored" in second) {
      expect(second.errored).toBe(true)
    }
    try {
      await reader.cancel()
    } catch {}
    await new Promise((r) => setTimeout(r, 30))
    // post-exposure: exactly one broker attempt, never auto retry/replay
    expect(attempts).toBe(1)
    expect(drops).toBe(1)
  })

  test("pre-exposure peer-close class: single attempt, non-retryable, never abort-shaped", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    const cases: Array<{ name: string; fail: Broker.BrokerError; reason: "Transport" | "InvalidProviderOutput" }> = [
      { name: "unavailable", fail: new Broker.ProviderHttpUnavailable({ message: "Private peer unavailable" }), reason: "Transport" },
      { name: "unsupported", fail: new Broker.ProviderHttpUnsupported({ capability: "provider/httpExecute", message: "no" }), reason: "Transport" },
      { name: "protocol", fail: new Broker.ProviderHttpProtocolError({ message: "Peer closed" }), reason: "InvalidProviderOutput" },
      { name: "aborted", fail: new Broker.ProviderHttpFailure({ code: "aborted", message: "Request cancelled" }), reason: "Transport" },
    ]
    for (const c of cases) {
      let attempts = 0
      const broker: Broker.Broker = {
        stream: () => {
          attempts++
          return Effect.fail(c.fail)
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
      }
      const executor = makeExecutor(ctx, broker)
      const exit = await Effect.runPromiseExit(executor.execute(req()))
      expect(Exit.isFailure(exit)).toBe(true)
      const err = errOf(exit)
      expect(err.reason._tag).toBe(c.reason)
      expect(err.retryable).toBe(false)
      expect(isAbortShaped(err)).toBe(false)
      // pre-exposure peer loss never resubmits the accepted prompt
      expect(attempts).toBe(1)
    }
  })

  test("pre-exposure retry budget preserved: retryable 429 then 2xx still converges in two attempts", async () => {
    const ctx = { providerId: "acme", modelId: "m1", record: baseRecord() }
    let attempts = 0
    const broker: Broker.Broker = {
      stream: () =>
        Effect.gen(function* () {
          attempts++
          if (attempts === 1) {
            return { status: 429, headers: { "retry-after-ms": "0" }, stream: Stream.succeed(new TextEncoder().encode("busy")) } as Broker.HttpStream
          }
          return { status: 200, headers: {}, stream: Stream.make(new TextEncoder().encode("ok")) } as Broker.HttpStream
        }),
      execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "" })),
    }
    const executor = makeExecutor(ctx, broker)
    const response = await Effect.runPromise(executor.execute(req()))
    expect(response.status).toBe(200)
    expect(attempts).toBe(2)
    const text = await Effect.runPromise(response.text)
    expect(text).toBe("ok")
  })
})
