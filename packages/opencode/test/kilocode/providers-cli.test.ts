import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { ProvidersListCommand, ProvidersLogoutCommand, buildProviderOptions, matchProviderInput, resolvePluginProviders } from "../../src/cli/cmd/providers"
import { testEffect } from "../lib/effect"

describe("providers CLI — instance:false uses global config", () => {
  test("ProvidersListCommand is instance:false", () => {
    // effectCmd stores instance flag in the command definition; verify source does not require instance
    expect((ProvidersListCommand as any).instance ?? false).toBe(false)
  })
  test("ProvidersLogoutCommand is instance:false", () => {
    expect((ProvidersLogoutCommand as any).instance ?? false).toBe(false)
  })
  test("source does not call instance-scoped Config.get() in list/logout", async () => {
    const src = await Bun.file("src/cli/cmd/providers.ts").text()
    // Count get() vs getGlobal() in the file — list/logout should use getGlobal
    const hasGetGlobal = src.includes("getGlobal()")
    expect(hasGetGlobal).toBe(true)
    // Ensure list/logout handlers specifically use getGlobal
    const listSection = src.slice(src.indexOf("ProvidersListCommand"))
    expect(listSection).toContain("getGlobal()")
    const logoutSection = src.slice(src.indexOf("ProvidersLogoutCommand"))
    expect(logoutSection).toContain("getGlobal()")
  })
})

describe("providers helpers — catalog-independent", () => {
  test("buildProviderOptions sorts by name", () => {
    const providers = {
      "b": { id: "b", name: "B" },
      "a": { id: "a", name: "A" },
    }
    const pluginProviders = [{ id: "plug", name: "Plug" }]
    const opts = buildProviderOptions({ providers: providers as any, pluginProviders })
    expect(opts[0].label).toBe("A")
    expect(opts[1].label).toBe("B")
    expect(opts[2].label).toBe("Plug")
    expect(opts[2].hint).toBe("plugin")
  })

  test("matchProviderInput matches by id and name case-insensitive", () => {
    const opts = [
      { label: "Anthropic", value: "anthropic" },
      { label: "OpenAI", value: "openai" },
    ]
    expect(matchProviderInput("anthropic", opts)?.value).toBe("anthropic")
    expect(matchProviderInput("openai", opts)?.value).toBe("openai")
    expect(matchProviderInput("ANTHROPIC", opts)?.value).toBe("anthropic")
    expect(matchProviderInput("unknown", opts)).toBeUndefined()
  })

  test("resolvePluginProviders filters disabled and existing", () => {
    const hooks = [{ auth: { provider: "plug", methods: [] as any } }] as any
    const result = resolvePluginProviders({
      hooks,
      existingProviders: { plug: {} },
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([]) // already exists
    const result2 = resolvePluginProviders({
      hooks,
      existingProviders: {},
      disabled: new Set(["plug"]),
      providerNames: {},
    })
    expect(result2).toEqual([])
  })
})

describe("providers list/logout — real global config access without InstanceRef", () => {
  const it = testEffect(Layer.mergeAll(Config.defaultLayer, Auth.defaultLayer, FSUtil.defaultLayer))
  it.live("Config.getGlobal works without InstanceRef (instance:false path)", () =>
    Effect.gen(function* () {
      const cfg = yield* Config.Service.use((s) => s.getGlobal())
      expect(cfg).toBeDefined()
      // getGlobal should not throw InstanceRef not provided
      expect(typeof cfg).toBe("object")
    }),
  )
})
