// kilocode_change - canonical native request/runtime helper over ProviderHttpExecuteBroker
import { Effect, Stream, Layer, Cause, FiberSet, Queue } from "effect"
import { LLM, SystemPart, ToolRuntime, toDefinitions, type LLMEvent } from "@opencode-ai/llm"
import { Auth } from "@opencode-ai/llm/route"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { InvalidRequestReason, LLMError } from "@opencode-ai/llm"
import { ProviderTransform } from "@/provider/transform"
import { LLMNativeRuntime } from "./native-runtime"
import * as Native from "./native-request"
import type { Provider } from "@/provider/provider"
import * as Broker from "@/kilocode/server/provider-http-execute-broker"
import { make as makeExecutor } from "@/kilocode/provider/canonical-request-executor"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import type { CanonicalProviderPayload } from "@opencode-ai/core/kilocode/canonical-record"
import type { ModelMessage } from "ai"

export function selectRoute(providerId: string, modelId: string, record: unknown) {
  const rec = record as CanonicalProviderPayload & { protocol?: string; endpoint?: string }
  const protocol = rec.protocol
  const endpoint = rec.endpoint
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new Error("canonical record missing endpoint")
  if (protocol === "openai/completions") {
    return OpenAIChat.route.with({ provider: providerId, endpoint: { baseURL: endpoint }, auth: Auth.none }).model({ id: modelId })
  }
  if (protocol === "openai/responses") {
    return OpenAIResponses.route.with({ provider: providerId, endpoint: { baseURL: endpoint }, auth: Auth.none }).model({ id: modelId })
  }
  if (protocol === "anthropic/messages") {
    return AnthropicMessages.route.with({ provider: providerId, endpoint: { baseURL: endpoint }, auth: Auth.none }).model({ id: modelId })
  }
  throw new Error(`unsupported canonical protocol ${String(protocol)}`)
}

function canonicalProviderOptions(record: unknown, flat: Record<string, unknown>): Record<string, Record<string, unknown>> | undefined {
  if (!flat || Object.keys(flat).length === 0) return undefined
  const rec = record as CanonicalProviderPayload & { protocol?: string }
  const protocol = rec.protocol
  if (protocol === "openai/completions" || protocol === "openai/responses") return { openai: flat } as unknown as Record<string, Record<string, unknown>>
  if (protocol === "anthropic/messages") return { anthropic: flat } as unknown as Record<string, Record<string, unknown>>
  throw new Error(`unsupported canonical protocol ${String(protocol)}`)
}

export function buildLLMRequest(input: {
  readonly model: Provider.Model
  readonly record: unknown
  readonly prepared: {
    readonly system: readonly string[]
    readonly messages: readonly ModelMessage[]
    readonly tools: Record<string, import("ai").Tool>
    readonly params: { readonly temperature?: number; readonly topP?: number; readonly topK?: number; readonly maxOutputTokens?: number; readonly options: Record<string, any> }
    readonly messageTransformOptions: Record<string, any>
    readonly headers: Record<string, string>
  }
  readonly toolChoice?: "auto" | "required" | "none"
  readonly abort: AbortSignal
}) {
  const llmModel = selectRoute(input.model.providerID, input.model.id, input.record)
  const transformed = ProviderTransform.message(input.prepared.messages as ModelMessage[], input.model, input.prepared.messageTransformOptions)
  const nativeTools = LLMNativeRuntime.nativeTools(input.prepared.tools as Record<string, import("ai").Tool>, {
    messages: transformed,
    abort: input.abort,
  })
  // Reuse native generation helper exactly (pure, same output)
  const generation = Native.generation({
    model: input.model,
    temperature: input.prepared.params.temperature,
    topP: input.prepared.params.topP,
    topK: input.prepared.params.topK,
    maxOutputTokens: input.prepared.params.maxOutputTokens,
    messages: [] as unknown as ModelMessage[],
  } as unknown as Native.RequestInput)
  const hasGen = generation !== undefined
  // Re-key flat prepared options to protocol-namespace (do not use arbitrary providerId)
  const flatOptions = input.prepared.params.options as Record<string, unknown>
  const providerOptions = canonicalProviderOptions(input.record, flatOptions)

  // Reuse native message/tools helpers exactly — resolves media/image/file/tool-result and schema parity
  const converted = Native.messages(transformed as unknown as readonly ModelMessage[])
  const systemParts = [...input.prepared.system.map(SystemPart.make), ...converted.system]
  const llmTools = Native.tools(input.prepared.tools as Record<string, { description?: string; inputSchema?: unknown }>)

  const request = LLM.request({
    model: llmModel,
    system: systemParts,
    messages: converted.messages,
    tools: llmTools,
    toolChoice: input.toolChoice,
    generation: hasGen ? generation : undefined,
    providerOptions: providerOptions,
    http: Object.keys(input.prepared.headers).length ? { headers: input.prepared.headers } : undefined,
  })
  return { request, nativeTools, llmModel }
}

function toInvalidRequestError(e: unknown): LLMError {
  const message = e instanceof Error ? e.message : String(e)
  return new LLMError({
    module: "CanonicalNative",
    method: "build",
    reason: new InvalidRequestReason({ message }),
  })
}

export function stream(input: {
  readonly model: Provider.Model
  readonly record: unknown
  readonly prepared: {
    readonly system: readonly string[]
    readonly messages: readonly ModelMessage[]
    readonly tools: Record<string, import("ai").Tool>
    readonly params: { readonly temperature?: number; readonly topP?: number; readonly topK?: number; readonly maxOutputTokens?: number; readonly options: Record<string, any> }
    readonly messageTransformOptions: Record<string, any>
    readonly headers: Record<string, string>
  }
  readonly toolChoice?: "auto" | "required" | "none"
  readonly abort: AbortSignal
  readonly broker: Broker.Broker
  readonly providerId: string
  readonly modelId: string
  readonly timeoutMs?: number
}): Stream.Stream<LLMEvent, unknown> {
  // Safe route/error: selectRoute/build failures become typed InvalidRequest, not defects
  return Stream.unwrap(
    Effect.gen(function* () {
      const built = yield* Effect.try({
        try: () => buildLLMRequest({ model: input.model, record: input.record, prepared: input.prepared, toolChoice: input.toolChoice, abort: input.abort }),
        catch: (e) => toInvalidRequestError(e),
      })
      const { request, nativeTools } = built
      const ctx = { providerId: input.providerId, modelId: input.modelId, record: input.record }
      const executor =
        typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? makeExecutor(ctx, input.broker, { timeoutMs: input.timeoutMs })
          : makeExecutor(ctx, input.broker)
      const executorLayer = Layer.succeed(RequestExecutor.Service, executor)
      // Fresh build per request: the module-level LLMClient.layer node is
      // already memoized with the ambient (real-HTTP) executor inside a shared
      // runtime, so providing a per-request executor without fresh would reuse
      // the stale memoized client and bypass the broker.
      const llmLayer = Layer.fresh(LLMClient.layer.pipe(Layer.provide(executorLayer)))
      const tools = nativeTools
      const enriched = LLM.updateRequest(request, { tools: [...request.tools, ...toDefinitions(tools)] })

      const inner = Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const settlements = yield* FiberSet.make<void>()
            const results = yield* Queue.unbounded<LLMEvent, Cause.Done>()
            const client = yield* LLMClient.Service
            const providerStream = client.stream(enriched).pipe(
              Stream.flatMap((event) =>
                event.type !== "tool-call" || event.providerExecuted
                  ? Stream.make(event)
                  : Stream.make(event).pipe(
                      Stream.concat(
                        Stream.fromEffectDrain(
                          ToolRuntime.dispatch(tools, event).pipe(
                            Effect.flatMap((dispatched) => Queue.offerAll(results, dispatched.events)),
                            Effect.catchCause((cause) => Queue.failCause(results, cause)),
                            Effect.asVoid,
                            FiberSet.run(settlements, { startImmediately: true }),
                          ),
                        ),
                      ),
                    ),
              ),
              Stream.concat(Stream.fromEffectDrain(FiberSet.awaitEmpty(settlements).pipe(Effect.andThen(Queue.end(results)), Effect.asVoid))),
            )
            return providerStream.pipe(Stream.concat(Stream.fromQueue(results)))
          }).pipe(Effect.provide(llmLayer)),
        ),
      )
      return inner
    }),
  )
}

export * as CanonicalNative from "./canonical-native"
