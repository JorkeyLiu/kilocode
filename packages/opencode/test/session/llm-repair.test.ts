import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { LLMEvent, Tool as NativeTool, ToolRuntime, toDefinitions } from "@opencode-ai/llm"
import type { LLMClientShape } from "@opencode-ai/llm/route"
import { repair, repaired, repairToolCall } from "@/session/llm/repair"
import { CanonicalNative } from "@/session/llm/canonical-native"
import * as Broker from "@/kilocode/server/provider-http-execute-broker"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import type { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "gpt-5-mini", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as unknown as Provider.Model

const providerInfo: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
}

const lookup: Tool = {
  description: "Lookup",
  inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } } }),
  execute: async (args: unknown) => ({ output: `ok:${JSON.stringify(args)}` }),
} as unknown as Tool

const invalid: Tool = {
  description: "Do not use",
  inputSchema: jsonSchema({
    type: "object",
    properties: { tool: { type: "string" }, error: { type: "string" } },
    required: ["tool", "error"],
  }),
  execute: async (args: unknown) => {
    const p = args as { tool: string; error: string }
    return { output: `The arguments provided to the tool are invalid: ${p.error}`, title: "Invalid Tool", metadata: {} }
  },
} as unknown as Tool

describe("llm repair helper", () => {
  test("exact preserves input reference", () => {
    const input = { q: "hi" }
    const out = repair("lookup", input, { lookup, invalid })
    expect(out.name).toBe("lookup")
    expect(out.input).toBe(input)
  })

  test("trim and case maps to registered lowercase", () => {
    const input = { q: "hi" }
    const out = repair(" Lookup ", input, { lookup, invalid })
    expect(out.name).toBe("lookup")
    expect(out.input).toBe(input)
  })

  test("unknown builds deterministic invalid payload excluding invalid", () => {
    const out = repair("nope", { q: 1 }, { bash: {}, lookup: {}, invalid: {} })
    expect(out.name).toBe("invalid")
    expect(typeof out.input).toBe("string")
    const parsed = JSON.parse(out.input as string)
    expect(parsed.tool).toBe("nope")
    expect(parsed.error).toBe("Model tried to call unavailable tool 'nope'. Available tools: bash, lookup.")
  })

  test("empty tools yields no-tools message", () => {
    const out = repair("nope", {}, {})
    expect(out.name).toBe("invalid")
    const parsed = JSON.parse(out.input as string)
    expect(parsed.error).toBe("Model tried to call unavailable tool 'nope'. No tools are available.")
  })

  test("does not mutate original event", () => {
    const event = LLMEvent.toolCall({ id: "c1", name: " Lookup ", input: { q: 1 } })
    const name = event.name
    const next = repaired(event, { lookup })
    expect(event.name).toBe(name)
    expect(next.name).toBe("lookup")
    expect(next.id).toBe("c1")
  })
})

describe("ai-sdk repair regression", () => {
  const old = (toolName: string, tools: Record<string, unknown>, message: string) => {
    const lower = toolName.trim().toLowerCase()
    if (lower !== toolName && (tools as Record<string, unknown>)[lower]) return { toolName: lower }
    return { toolName: "invalid", input: JSON.stringify({ tool: toolName, error: message }) }
  }

  test("case-match unchanged", () => {
    const tools = { lookup, bash: {} }
    const message = "Model tried to call unavailable tool ' Lookup '. Available tools: lookup, bash."
    const fromOld = old(" Lookup ", tools, message)
    const fixed = repair(" Lookup ", `{"q":"hi"}`, tools)
    expect({ toolName: fixed.name }).toEqual({ toolName: fromOld.toolName })
  })

  test("unknown unchanged when invalid absent", () => {
    const tools = { bash: {}, lookup: {} }
    const error = "Model tried to call unavailable tool 'nope'. Available tools: bash, lookup."
    const fromOld = old("nope", tools, error)
    const fixed = repair("nope", `{"q":1}`, tools)
    expect(fixed.name).toBe("invalid")
    expect(fixed.input).toBe(fromOld.input)
  })
})

async function collect(stream: Stream.Stream<LLMEvent, unknown>) {
  return Array.from(await Effect.runPromise(Stream.runCollect(stream)))
}

describe("legacy native repair dispatch", () => {
  test("case-mismatched executes intended tool with normal result", async () => {
    const llmClient = {
      prepare: () => Effect.die("unused"),
      stream: () =>
        Stream.fromIterable([
          LLMEvent.toolCall({
            id: "call-1",
            name: " Lookup ",
            input: { q: "hi" },
            providerMetadata: { openai: { itemId: "item-1" } },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
      generate: () => Effect.die("unused"),
    } as unknown as LLMClientShape
    const native = LLMNativeRuntime.stream({
      model: baseModel,
      provider: providerInfo,
      auth: undefined,
      llmClient,
      messages: [] as ModelMessage[],
      tools: { lookup, invalid },
      headers: {},
      abort: new AbortController().signal,
    })
    if (native.type === "unsupported") throw new Error(native.reason)
    const events = await collect(native.stream)
    const call = events.find(LLMEvent.is.toolCall)!
    expect(call.name).toBe("lookup")
    expect(call.id).toBe("call-1")
    expect(call.providerMetadata).toEqual({ openai: { itemId: "item-1" } })
    const errors = events.filter(LLMEvent.is.toolError)
    expect(errors).toEqual([])
    const results = events.filter(LLMEvent.is.toolResult)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("call-1")
    expect(results[0].name).toBe("lookup")
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("tool-call")
    expect(types).toContain("tool-result")
  })

  test("unknown routes through InvalidTool successfully", async () => {
    const llmClient = {
      prepare: () => Effect.die("unused"),
      stream: () =>
        Stream.fromIterable([
          LLMEvent.toolCall({ id: "call-9", name: "nope", input: { q: 1 } }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
      generate: () => Effect.die("unused"),
    } as unknown as LLMClientShape
    const native = LLMNativeRuntime.stream({
      model: baseModel,
      provider: providerInfo,
      auth: undefined,
      llmClient,
      messages: [] as ModelMessage[],
      tools: { lookup, invalid },
      headers: {},
      abort: new AbortController().signal,
    })
    if (native.type === "unsupported") throw new Error(native.reason)
    const events = await collect(native.stream)
    expect(events.filter(LLMEvent.is.toolError)).toEqual([])
    const results = events.filter(LLMEvent.is.toolResult)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("invalid")
    expect(results[0].id).toBe("call-9")
  })

  test("providerExecuted is untouched and not dispatched", async () => {
    const llmClient = {
      prepare: () => Effect.die("unused"),
      stream: () =>
        Stream.fromIterable([
          LLMEvent.toolCall({ id: "call-p", name: " WEIRD ", input: {}, providerExecuted: true }),
          LLMEvent.finish({ reason: "stop" }),
        ]),
      generate: () => Effect.die("unused"),
    } as unknown as LLMClientShape
    const native = LLMNativeRuntime.stream({
      model: baseModel,
      provider: providerInfo,
      auth: undefined,
      llmClient,
      messages: [] as ModelMessage[],
      tools: { lookup, invalid },
      headers: {},
      abort: new AbortController().signal,
    })
    if (native.type === "unsupported") throw new Error(native.reason)
    const events = await collect(native.stream)
    const call = events.find(LLMEvent.is.toolCall)!
    expect(call.name).toBe(" WEIRD ")
    expect(events.filter(LLMEvent.is.toolResult)).toEqual([])
    expect(events.filter(LLMEvent.is.toolError)).toEqual([])
  })
})

describe("ai-sdk repairToolCall production adapter", () => {
  const tools = { lookup, invalid } as unknown as Record<string, unknown>

  test("case-match retains original input but normalizes name", () => {
    const input = `{"q":"hi"}`
    const out = repairToolCall(
      { toolCall: { type: "tool-call" as const, toolCallId: "c1", toolName: " Lookup ", input }, error: { message: "No such tool" } },
      tools,
    )
    expect(out).toEqual({ type: "tool-call" as const, toolCallId: "c1", toolName: "lookup", input })
  })

  test("exact-name validation failure follows invalid branch", () => {
    const input = `{"q":1}`
    const out = repairToolCall(
      { toolCall: { type: "tool-call" as const, toolCallId: "c2", toolName: "lookup", input }, error: { message: "Invalid input" } },
      tools,
    )
    expect(out).toEqual({
      type: "tool-call",
      toolCallId: "c2",
      toolName: "invalid",
      input: JSON.stringify({ tool: "lookup", error: "Invalid input" }),
    })
  })

  test("unknown uses failed.error.message, not helper list", () => {
    const input = `{"q":1}`
    const out = repairToolCall(
      { toolCall: { type: "tool-call" as const, toolCallId: "c3", toolName: "nope", input }, error: { message: "No such tool: nope" } },
      tools,
    )
    expect(out.toolName).toBe("invalid")
    expect(out.toolCallId).toBe("c3")
    expect(out.input).toBe(JSON.stringify({ tool: "nope", error: "No such tool: nope" }))
    expect(out.input).not.toContain("Available tools")
  })

  test("error.message differences change invalid payload exactly", () => {
    const input = `{"q":1}`
    const a = repairToolCall(
      { toolCall: { type: "tool-call" as const, toolCallId: "c4", toolName: "nope", input }, error: { message: "first" } },
      tools,
    )
    const b = repairToolCall(
      { toolCall: { type: "tool-call" as const, toolCallId: "c4", toolName: "nope", input }, error: { message: "second" } },
      tools,
    )
    expect(a.input).toBe(JSON.stringify({ tool: "nope", error: "first" }))
    expect(b.input).toBe(JSON.stringify({ tool: "nope", error: "second" }))
    expect(a.input).not.toBe(b.input)
  })
})

describe("canonical native repair parity", () => {
  test("shared helper drives canonical dispatch identically", async () => {
    const tools = LLMNativeRuntime.nativeTools(
      { lookup, invalid },
      { messages: [] as ModelMessage[], abort: new AbortController().signal },
    )
    const original = LLMEvent.toolCall({ id: "c2", name: " LOOKUP ", input: { q: "x" } })
    const fixed = repaired(original, tools)
    expect(fixed.name).toBe("lookup")
    expect(fixed.id).toBe("c2")
    const dispatched = await Effect.runPromise(ToolRuntime.dispatch(tools, fixed))
    expect(dispatched.events.filter((e) => e.type === "tool-error")).toEqual([])
    expect(dispatched.events.some((e) => e.type === "tool-result")).toBe(true)

    const unknown = LLMEvent.toolCall({ id: "c3", name: "nope", input: { q: 1 } })
    const fixedUnknown = repaired(unknown, tools)
    expect(fixedUnknown.name).toBe("invalid")
    const dispatchedUnknown = await Effect.runPromise(ToolRuntime.dispatch(tools, fixedUnknown))
    expect(dispatchedUnknown.events.filter((e) => e.type === "tool-error")).toEqual([])
    const result = dispatchedUnknown.events.find((e) => e.type === "tool-result")!
    expect(result.name).toBe("invalid")

    expect(original.name).toBe(" LOOKUP ")
    void toDefinitions(tools)
  })
})

describe("canonical native repair via CanonicalNative.stream", () => {
  const canonicalModel = {
    ...baseModel,
    id: ModelV2.ID.make("m1"),
    providerID: ProviderV2.ID.make("acme"),
  } as unknown as Provider.Model
  const completionsRecord = {
    name: "Acme",
    endpoint: "https://api.example.com/v1",
    protocol: "openai/completions" as const,
    credential: "secret:kilo.credentials.global.provider.acme",
    models: { m1: { name: "M1" } },
  }
  const responsesRecord = { ...completionsRecord, protocol: "openai/responses" as const }

  const stub = (sse: string): Broker.Broker => ({
    stream: () =>
      Effect.succeed({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: Stream.make(new TextEncoder().encode(sse)),
      }),
    execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "unused" })),
  })
  const sse = (...lines: ReadonlyArray<string>) => lines.map((l) => `${l}\n\n`).join("")

  test("case-mismatched executes lookup, unknown executes InvalidTool with tool-result", async () => {
    const body = sse(
      `data: {"id":"chatcmpl_fixture","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":" Lookup ","arguments":"{\\"q\\":\\"hi\\"}"}}]},"finish_reason":null}],"usage":null}`,
      `data: {"id":"chatcmpl_fixture","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-9","function":{"name":"nope","arguments":"{\\"q\\":1}"}}]},"finish_reason":null}],"usage":null}`,
      `data: {"id":"chatcmpl_fixture","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
    )
    const prepared = {
      system: [],
      messages: [{ role: "user", content: "hi" } as ModelMessage],
      tools: { lookup, invalid } as unknown as Record<string, import("ai").Tool>,
      params: { options: {} },
      messageTransformOptions: {},
      headers: {},
    }
    const stream = CanonicalNative.stream({
      model: canonicalModel,
      record: completionsRecord,
      prepared: prepared as unknown as Parameters<typeof CanonicalNative.stream>[0]["prepared"],
      abort: new AbortController().signal,
      broker: stub(body),
      providerId: "acme",
      modelId: "m1",
    })
    const events = await collect(stream)
    expect(events.filter(LLMEvent.is.toolError)).toEqual([])
    const calls = events.filter(LLMEvent.is.toolCall)
    expect(calls.map((c) => c.id)).toEqual(["call-1", "call-9"])
    expect(calls.map((c) => c.name)).toEqual(["lookup", "invalid"])
    expect(calls[0].input).toEqual({ q: "hi" })
    const results = events.filter(LLMEvent.is.toolResult)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id)).toEqual(["call-1", "call-9"])
    expect(results.map((r) => r.name)).toEqual(["lookup", "invalid"])
    expect(JSON.stringify(results[0])).toContain("ok:")
    const types = events.map((e) => e.type)
    expect(types).toContain("tool-call")
    expect(types).toContain("finish")
    expect(types).toContain("tool-result")
    expect(types.indexOf("tool-call")).toBeLessThan(types.indexOf("tool-result"))
  })

  test("providerExecuted passes through without local dispatch", async () => {
    const body = sse(
      `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"ws_1","action":{"query":"hi"}}}`,
      `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}`,
    )
    const prepared = {
      system: [],
      messages: [{ role: "user", content: "hi" } as ModelMessage],
      tools: { lookup, invalid } as unknown as Record<string, import("ai").Tool>,
      params: { options: {} },
      messageTransformOptions: {},
      headers: {},
    }
    const stream = CanonicalNative.stream({
      model: canonicalModel,
      record: responsesRecord,
      prepared: prepared as unknown as Parameters<typeof CanonicalNative.stream>[0]["prepared"],
      abort: new AbortController().signal,
      broker: stub(body),
      providerId: "acme",
      modelId: "m1",
    })
    const events = await collect(stream)
    expect(events.filter(LLMEvent.is.toolError)).toEqual([])
    const calls = events.filter(LLMEvent.is.toolCall)
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe("ws_1")
    expect(calls[0].name).toBe("web_search")
    expect((calls[0] as { providerExecuted?: boolean }).providerExecuted).toBe(true)
    expect(calls[0].providerMetadata).toEqual({ openai: { itemId: "ws_1" } })
    const results = events.filter(LLMEvent.is.toolResult)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("ws_1")
    expect(results[0].name).toBe("web_search")
    expect((results[0] as { providerExecuted?: boolean }).providerExecuted).toBe(true)
    expect(results.every((r) => r.name !== "invalid")).toBe(true)
  })
})
