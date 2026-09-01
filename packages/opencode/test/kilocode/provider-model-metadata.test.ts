import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Provider } from "../../src/provider/provider"
import { patchConfigModel } from "../../src/kilocode/provider/provider"

describe("Kilo provider model metadata — config patch (G2)", () => {
  test("patchConfigModel preserves explicit Kilo fields and merges variants", () => {
    const cfg = {
      isFree: true,
      prompt: "kilo-prompt" as const,
      ai_sdk_provider: "openai" as const,
      recommendedIndex: 2,
      variants: { fast: { disabled: true }, keep: { hello: "world" } },
    }
    const existing = {
      isFree: false,
      prompt: "old" as const,
      terminalBench: { overallScore: 1, avgAttemptCostUsd: 2 },
      autoRouting: { models: ["a"] },
      ai_sdk_provider: "anthropic" as const,
      recommendedIndex: 1,
    }
    const patched = patchConfigModel(cfg as never, existing as never) as Record<string, unknown>
    expect(patched.isFree).toBe(true)
    expect(patched.prompt).toBe("kilo-prompt")
    expect(patched.ai_sdk_provider).toBe("openai")
    expect(patched.recommendedIndex).toBe(2)
    expect((patched as { terminalBench?: unknown }).terminalBench).toEqual(existing.terminalBench)
    expect((patched as { autoRouting?: unknown }).autoRouting).toEqual(existing.autoRouting)
    expect((patched as { variants?: unknown }).variants).toEqual({ keep: { hello: "world" } })
  })

  test("Provider.Model schema accepts Auto Efficient routing models", () => {
    const model = Schema.decodeUnknownSync(Provider.Model)({
      id: "kilo-auto/efficient",
      providerID: "kilo",
      api: { id: "kilo", url: "https://kilocode.ai", npm: "@kilocode/kilo-gateway" },
      name: "Kilo Auto Efficient",
      family: "kilo-auto",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128000, output: 16384 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-06-26",
      variants: {},
      autoRouting: { models: ["google/gemini-2.5-flash"] },
    })

    expect(model.autoRouting).toEqual({ models: ["google/gemini-2.5-flash"] })
  })
})
