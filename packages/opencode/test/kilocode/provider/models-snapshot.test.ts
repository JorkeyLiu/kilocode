import { describe, expect, test } from "bun:test"
import { parseModelsSnapshot } from "../../../src/kilocode/provider/models-snapshot-shape"

const fixture = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-test": {
        id: "claude-test",
        name: "Claude Test",
        release_date: "2026-01-01",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: {
          context: 200_000,
          output: 8_192,
        },
      },
    },
  },
}

describe("models snapshot validation", () => {
  test("accepts a valid snapshot and reports its size", () => {
    const parsed = parseModelsSnapshot(JSON.stringify(fixture))

    expect(parsed.data).toEqual(fixture)
    expect(parsed.stats).toEqual({ providers: 1, models: 1 })
    expect(JSON.stringify(parsed.data)).toBe(JSON.stringify(fixture))
  })

  test("fails invalid JSON", () => {
    expect(() => parseModelsSnapshot("{")).toThrow("not valid JSON")
  })

  test("fails empty snapshots", () => {
    expect(() => parseModelsSnapshot("{}")).toThrow("at least one provider")
  })

  test("fails malformed provider data", () => {
    const value = {
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        env: ["ANTHROPIC_API_KEY"],
        models: {
          broken: {
            id: "broken",
            name: "Broken",
            limit: {
              context: 100,
            },
          },
        },
      },
    }

    expect(() => parseModelsSnapshot(JSON.stringify(value))).toThrow("limit.output")
  })
})

describe("cost.tiers validation", () => {
  const tiered = (cost: unknown) => ({
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: {
        "claude-test": {
          id: "claude-test",
          name: "Claude Test",
          release_date: "2026-01-01",
          attachment: true,
          reasoning: true,
          temperature: true,
          tool_call: true,
          limit: { context: 200_000, output: 8_192 },
          ...(cost === undefined ? {} : { cost }),
        },
      },
    },
  })

  test("accepts each canonical tier shape unchanged", () => {
    const shapes = [
      { input: 10, output: 37.5, cache_read: 1, cache_write: 12.5, tier: { type: "context", size: 200_000 } },
      { input: 4, output: 18, cache_read: 0.4, tier: { type: "context", size: 200_000 } },
      { input: 60, output: 270, tier: { type: "context", size: 272_000 } },
    ]
    for (const shape of shapes) {
      const value = tiered({ input: 10, output: 30, cache_read: 1, cache_write: 2, tiers: [shape] })
      const parsed = parseModelsSnapshot(JSON.stringify(value))
      expect(parsed.stats).toEqual({ providers: 1, models: 1 })
      expect(JSON.stringify(parsed.data)).toBe(JSON.stringify(value))
    }
  })

  test("accepts tiers alongside a recursive context_over_200k cost", () => {
    const value = tiered({
      input: 10,
      output: 30,
      cache_read: 1,
      tiers: [{ input: 10, output: 37.5, cache_read: 1, cache_write: 12.5, tier: { type: "context", size: 200_000 } }],
      context_over_200k: { input: 5, output: 15, cache_read: 0.5 },
    })
    const parsed = parseModelsSnapshot(JSON.stringify(value))
    expect(parsed.stats).toEqual({ providers: 1, models: 1 })
  })

  test("accepts a cost with no tiers", () => {
    const parsed = parseModelsSnapshot(JSON.stringify(tiered({ input: 10, output: 30 })))
    expect(parsed.stats).toEqual({ providers: 1, models: 1 })
  })

  test("fails non-array tiers", () => {
    const value = tiered({
      input: 10,
      output: 30,
      tiers: { input: 1, output: 2, tier: { type: "context", size: 1 } },
    })
    expect(() => parseModelsSnapshot(JSON.stringify(value))).toThrow("cost.tiers must be an array")
  })

  test("fails malformed tier items", () => {
    const bad: Array<[unknown, string]> = [
      [{ output: 30, tier: { type: "context", size: 200_000 } }, "tiers[0].input must be a finite number"],
      [{ input: 10, tier: { type: "context", size: 200_000 } }, "tiers[0].output must be a finite number"],
      [{ input: "10", output: 30, tier: { type: "context", size: 200_000 } }, "tiers[0].input must be a finite number"],
      [{ input: 10, output: 30, cache_read: "1", tier: { type: "context", size: 200_000 } }, "tiers[0].cache_read must be a finite number when present"],
      [{ input: 10, output: 30, tier: { type: "window", size: 200_000 } }, "tiers[0].tier.type must be"],
      [{ input: 10, output: 30, tier: { size: 200_000 } }, "tiers[0].tier.type must be"],
      [{ input: 10, output: 30, tier: { type: "context" } }, "tiers[0].tier.size must be a finite number"],
      [{ input: 10, output: 30, tier: { type: "context", size: "big" } }, "tiers[0].tier.size must be a finite number"],
      [{ input: 10, output: 30, cache_write: "x", tier: { type: "context", size: 200_000 } }, "tiers[0].cache_write must be a finite number when present"],
      [{ input: 10, output: 30 }, "tiers[0].tier must be an object"],
      [{ input: 10, output: 30, tier: null }, "tiers[0].tier must be an object"],
      [null, "tiers[0] must be an object"],
    ]
    for (const [item, message] of bad) {
      const value = tiered({ input: 10, output: 30, tiers: [item] })
      expect(() => parseModelsSnapshot(JSON.stringify(value)), JSON.stringify(item)).toThrow(message)
    }
  })
})
