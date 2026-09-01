import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { Effect } from "effect"
import { LLM } from "../../src/session/llm"
import { LLMAISDK } from "@/session/llm/ai-sdk"

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })
  test("returns false for messages with only text content", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ]
    expect(LLM.hasToolCalls(msgs)).toBe(false)
  })
  test("returns true when messages contain tool-call", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "Run a command" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-123", toolName: "bash" }] },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(msgs)).toBe(true)
  })
  test("returns true when messages contain tool-result", () => {
    const msgs = [
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-123", toolName: "bash" }] },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(msgs)).toBe(true)
  })
  test("returns false for messages with string content", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there" },
    ]
    expect(LLM.hasToolCalls(msgs)).toBe(false)
  })
  test("returns true when tool-call is mixed with text content", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "text", text: "Let me run that command" }, { type: "tool-call", toolCallId: "call-456", toolName: "read" }] },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(msgs)).toBe(true)
  })
})

describe("session.llm.ai-sdk adapter", () => {
  type Evt = Parameters<typeof LLMAISDK.toLLMEvents>[1]
  const adapt = (evts: ReadonlyArray<Evt>) => {
    const state = LLMAISDK.adapterState()
    return Effect.runPromise(Effect.forEach(evts, (e) => LLMAISDK.toLLMEvents(state, e)).pipe(Effect.map((items) => items.flat())))
  }
  const unchecked = (input: unknown) => input as Evt
  test("maps AI SDK stream chunks without losing session-visible fields", async () => {
    const meta = { openai: { itemID: "item-1" } }
    const evts = await adapt([
      { type: "start" } as unknown as Evt,
      { type: "start-step", request: {}, warnings: [] } as unknown as Evt,
      { type: "text-start", id: "text-1", providerMetadata: meta } as unknown as Evt,
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } } as unknown as Evt,
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } } as unknown as Evt,
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } } as unknown as Evt,
      { type: "finish-step", providerMetadata: { openai: { stepDone: true } }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as unknown as never, warnings: [] as unknown as never, request: {}, response: { id: "r1", timestamp: new Date(0), modelId: "test" } } as unknown as Evt,
      { type: "finish", providerMetadata: { openai: { done: true } }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as unknown as never, warnings: [] as unknown as never, request: {}, response: { id: "r1", timestamp: new Date(0), modelId: "test" }, totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as unknown as never } as unknown as Evt,
    ])
    expect(evts.length).toBeGreaterThan(0)
  })
  test("explicitly ignores non-session-visible AI SDK chunks", async () => {
    const evts = await adapt([unchecked({ type: "unknown-chunk", foo: 1 })])
    expect(evts).toEqual([])
  })
  test("preserves tool-error cause", async () => {
    const evts = await adapt([
      { type: "start" } as unknown as Evt,
      { type: "start-step", request: {}, warnings: [] } as unknown as Evt,
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: "{}" } as unknown as Evt,
      { type: "tool-error", toolCallId: "c1", toolName: "bash", input: "{}", error: new Error("fail") } as unknown as Evt,
      { type: "finish-step", providerMetadata: {}, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as unknown as never, warnings: [] as unknown as never, request: {}, response: { id: "r1", timestamp: new Date(0), modelId: "test" } } as unknown as Evt,
      { type: "finish", providerMetadata: {}, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as unknown as never, warnings: [] as unknown as never, request: {}, response: { id: "r1", timestamp: new Date(0), modelId: "test" }, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as unknown as never } as unknown as Evt,
    ])
    expect(evts.length).toBeGreaterThan(0)
  })
})
