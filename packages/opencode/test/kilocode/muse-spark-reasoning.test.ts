import { describe, expect, test } from "bun:test"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

describe("opencode-go/muse-spark-1.2-contributor catalog reasoning", () => {
  test("snapshot entry matches authoritative upstream metadata", async () => {
    const text = await Bun.file(`${import.meta.dir}/../../src/kilocode/provider/models-api.json`).text()
    const data = JSON.parse(text) as Record<string, any>
    const provider = data["opencode-go"]
    expect(provider).toBeDefined()
    expect(provider.npm).toBe("@ai-sdk/openai-compatible")
    const model = provider.models["muse-spark-1.2-contributor"]
    expect(model).toBeDefined()
    expect(model.id).toBe("muse-spark-1.2-contributor")
    expect(model.name).toBe("Muse Spark 1.2 Contributor")
    expect(model.description).toBe(
      "Muse Spark 1.2 is a coding-focused update to Muse Spark 1.1 with improvements in code generation, complex debugging, codebase understanding, and end-to-end developer workflows.",
    )
    expect(model.family).toBe("muse")
    expect(model.attachment).toBe(true)
    expect(model.reasoning).toBe(true)
    expect(model.reasoning_options).toEqual([{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }])
    expect(model.tool_call).toBe(true)
    expect(model.structured_output).toBe(true)
    expect(model.temperature).toBe(true)
    expect(model.release_date).toBe("2026-08-05")
    expect(model.last_updated).toBe("2026-08-05")
    expect(model.modalities).toEqual({ input: ["text", "image", "video", "pdf", "audio"], output: ["text"] })
    expect(model.open_weights).toBe(false)
    expect(model.limit).toEqual({ context: 1048576, output: 131072 })
    expect(model.provider).toEqual({ npm: "@ai-sdk/openai" })
    expect(model.cost).toEqual({ input: 0.1, output: 0.2, cache_read: 0.002 })
  })

  test("resolved model has reasoning enabled and per-model openai provider mapping", async () => {
    const text = await Bun.file(`${import.meta.dir}/../../src/kilocode/provider/models-api.json`).text()
    const data = JSON.parse(text) as Record<string, any>
    const rawProvider = data["opencode-go"]
    const info = Provider.fromModelsDevProvider(rawProvider as any)
    const model = info.models["muse-spark-1.2-contributor"]
    expect(model).toBeDefined()
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.api.npm).toBe("@ai-sdk/openai")
    expect(model.api.id).toBe("muse-spark-1.2-contributor")
  })

  test("variants derive from per-model npm and authoritative reasoning_options — generic contract with minimal limitation", async () => {
    const text = await Bun.file(`${import.meta.dir}/../../src/kilocode/provider/models-api.json`).text()
    const data = JSON.parse(text) as Record<string, any>
    const rawProvider = data["opencode-go"]
    const rawModel = rawProvider.models["muse-spark-1.2-contributor"]
    const authoritativeValues: string[] = rawModel.reasoning_options[0].values

    // Upstream metadata declares minimal-tier; the generic provider path is unchanged in this change.
    expect(authoritativeValues).toEqual(["minimal", "low", "medium", "high", "xhigh"])

    const info = Provider.fromModelsDevProvider(rawProvider as any)
    const model = info.models["muse-spark-1.2-contributor"]
    // Variants are generated via the generic ProviderTransform path based on per-model api.npm = @ai-sdk/openai.
    const variants = ProviderTransform.variants(model as any)

    // Generic contract for @ai-sdk/openai with release_date 2026-08-05 and non-gpt id:
    // openai reasoning efforts yields ["none","low","medium","high","xhigh"] (none via 2025-11-13 gate, xhigh via 2025-12-04 gate).
    // Upstream "minimal" is therefore not exposed by the generic path; "none" is exposed instead.
    // This discrepancy is documented and does not block reasoning capability.
    const expectedGeneric = ["none", "low", "medium", "high", "xhigh"] as const
    expect(Object.keys(variants).sort()).toEqual([...expectedGeneric].sort())
    expect(Object.keys(model.variants ?? {}).sort()).toEqual([...expectedGeneric].sort())

    // Explicitly assert the minimal-tier limitation and the exposed generic set
    expect(authoritativeValues).toContain("minimal")
    expect(variants["minimal"]).toBeUndefined()
    expect(model.variants?.["minimal"]).toBeUndefined()
    expect(variants["none"]).toBeDefined()
    expect(variants["none"].reasoningEffort).toBe("none")

    expect(model.capabilities.reasoning).toBe(true)
    // low/medium/high/xhigh are present in both authoritative and generic sets
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      expect(authoritativeValues).toContain(effort)
      expect(variants[effort]).toBeDefined()
      expect(variants[effort].reasoningEffort).toBe(effort)
      expect(model.variants?.[effort]).toBeDefined()
    }
    // Verify variant payload shape matches openai provider expectations
    expect(variants["low"]).toEqual({
      reasoningEffort: "low",
      reasoningSummary: expect.anything() as any,
      include: ["reasoning.encrypted_content"],
    })
    expect(variants["none"]).toEqual({
      reasoningEffort: "none",
      reasoningSummary: expect.anything() as any,
      include: ["reasoning.encrypted_content"],
    })
  })
})
