import { afterEach, describe, expect, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Config } from "../../../src/config/config"
import { isHotPatch } from "../../../src/kilocode/config/hot-keys"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

const original = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("isHotPatch", () => {
  test("returns true for console key", () => {
    expect(isHotPatch({ console: { diff_style: "split" } })).toBe(true)
  })

  test("returns true for model key", () => {
    expect(isHotPatch({ model: "anthropic/claude-sonnet-4-20250514" })).toBe(true)
  })

  test("returns true for small_model key", () => {
    expect(isHotPatch({ small_model: "anthropic/claude-haiku-3-5-20241022" })).toBe(true)
  })

  test("returns true for model_variant key", () => {
    expect(isHotPatch({ model_variant: "high" })).toBe(true)
  })

  test("returns true for model_variant_overrides key", () => {
    expect(isHotPatch({ model_variant_overrides: { "anthropic/claude-sonnet-4-20250514": "low" } })).toBe(true)
  })

  test("returns true for subagent_model key", () => {
    expect(isHotPatch({ subagent_model: "anthropic/claude-haiku-3-5-20241022" })).toBe(true)
  })

  test("returns true for subagent_variant key", () => {
    expect(isHotPatch({ subagent_variant: "medium" })).toBe(true)
  })

  test("returns true for subagent_variant_overrides key", () => {
    expect(isHotPatch({ subagent_variant_overrides: { code: "high" } })).toBe(true)
  })

  test("returns true for agent override key (LOCK-001)", () => {
    expect(isHotPatch({ agent: { code: { model: "anthropic/claude-sonnet-4-20250514" } } })).toBe(true)
  })

  test("returns true for default_agent key (LOCK-001)", () => {
    expect(isHotPatch({ default_agent: "code" })).toBe(true)
  })

  test("returns true for legacy mode key (LOCK-001)", () => {
    expect(isHotPatch({ mode: { build: { model: "test/model" } } })).toBe(true)
  })

  test("returns true for a named per-agent model/variant override (LOCK-001)", () => {
    expect(isHotPatch({ agent: { scout: { model: "test/model", variant: "low" } } })).toBe(true)
  })

  test("returns true for multiple hot keys", () => {
    expect(isHotPatch({ model: "test", model_variant: "low", console: {} })).toBe(true)
  })

  test("returns true for agent plus model hot keys together (LOCK-001)", () => {
    expect(isHotPatch({ agent: { code: { model: "test/model" } }, default_agent: "code" })).toBe(true)
  })

  test("returns false for empty patch", () => {
    expect(isHotPatch({})).toBe(false)
  })

  test("returns false for provider key (cold)", () => {
    expect(isHotPatch({ provider: { openai: { apiKey: "sk-123" } } })).toBe(false)
  })

  test("returns false for enabled_providers key (cold)", () => {
    expect(isHotPatch({ enabled_providers: ["openai"] })).toBe(false)
  })

  test("returns false for disabled_providers key (cold)", () => {
    expect(isHotPatch({ disabled_providers: ["anthropic"] })).toBe(false)
  })

  test("returns true for permission key (LOCK-002)", () => {
    expect(isHotPatch({ permission: { bash: "ask" } })).toBe(true)
  })

  test("returns false for mixed hot and cold keys", () => {
    expect(isHotPatch({ model: "test", provider: { openai: { apiKey: "sk-123" } } })).toBe(false)
  })

  test("returns false for agent mixed with a cold key (LOCK-001)", () => {
    expect(isHotPatch({ agent: { code: { model: "test/model" } }, provider: { openai: { apiKey: "sk-123" } } })).toBe(
      false,
    )
  })

  test("returns true for permission mixed with other hot keys (LOCK-002)", () => {
    expect(isHotPatch({ model: "test", permission: { bash: "ask" } })).toBe(true)
  })

  test("returns false for unknown key (cold)", () => {
    expect(isHotPatch({ unknown_key: "value" })).toBe(false)
  })

  test("all locked hot keys are classified hot", () => {
    const lockedHotKeys = [
      "console",
      "model",
      "small_model",
      "model_variant",
      "model_variant_overrides",
      "subagent_model",
      "subagent_variant",
      "subagent_variant_overrides",
      "agent",
      "default_agent",
      "mode",
      "permission", // LOCK-002
    ]
    for (const key of lockedHotKeys) {
      expect(isHotPatch({ [key]: "test" })).toBe(true)
    }
  })

  test("all locked cold keys are classified cold", () => {
    const lockedColdKeys = ["provider", "enabled_providers", "disabled_providers", "mcp"]
    for (const key of lockedColdKeys) {
      expect(isHotPatch({ [key]: "test" })).toBe(false)
    }
  })
})
