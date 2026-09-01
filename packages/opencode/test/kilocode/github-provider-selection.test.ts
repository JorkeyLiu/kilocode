import { describe, expect, test } from "bun:test"
import { buildGithubModelOptions, buildGithubProviderOptions, buildGithubWorkflowEnv } from "../../src/cli/cmd/github.handler"

describe("github provider selection — custom-provider-only", () => {
  test("buildGithubProviderOptions sorts by name", () => {
    const providers = {
      "openai-compatible": { id: "openai-compatible", name: "OpenAI Compatible" },
      "custom-b": { id: "custom-b", name: "B Provider" },
      "custom-a": { id: "custom-a", name: "A Provider" },
    }
    const opts = buildGithubProviderOptions(providers)
    expect(opts.map((o) => o.value)).toEqual(["custom-a", "custom-b", "openai-compatible"])
    expect(opts[0].label).toBe("A Provider")
  })

  test("buildGithubProviderOptions handles empty providers (explicit empty-state)", () => {
    const opts = buildGithubProviderOptions({})
    expect(opts).toEqual([])
  })

  test("buildGithubProviderOptions handles single provider", () => {
    const providers = { "my-provider": { id: "my-provider", name: "My Provider" } }
    const opts = buildGithubProviderOptions(providers)
    expect(opts).toEqual([{ label: "My Provider", value: "my-provider" }])
  })

  test("provider filtering respects disabled/enabled (logic reproduced)", () => {
    const cfg = {
      provider: {
        "keep": { name: "Keep", models: { m: { name: "M" } } },
        "disabled": { name: "Disabled", models: { m: { name: "M" } } },
        "not-enabled": { name: "Not Enabled", models: { m: { name: "M" } } },
      },
      disabled_providers: ["disabled"],
      enabled_providers: ["keep"],
    }
    const disabled = new Set(cfg.disabled_providers)
    const enabled = new Set(cfg.enabled_providers)
    const providers: Record<string, { id: string; name: string; env: string[]; models: unknown }> = {}
    for (const [id, p] of Object.entries(cfg.provider as Record<string, { name: string; models: unknown }>)) {
      if (disabled.has(id)) continue
      if (enabled && !enabled.has(id)) continue
      providers[id] = { id, name: p.name, env: [], models: p.models as Record<string, unknown> }
    }
    expect(Object.keys(providers)).toEqual(["keep"])
    const opts = buildGithubProviderOptions(providers)
    expect(opts.length).toBe(1)
    expect(opts[0].value).toBe("keep")
  })

  test("github install preserves secrets behavior (env list)", () => {
    const providers = {
      "custom": { id: "custom", name: "Custom", env: ["CUSTOM_API_KEY", "CUSTOM_OTHER"], models: { m: { name: "M" } } },
    }
    const envList = providers["custom"].env
    expect(envList).toContain("CUSTOM_API_KEY")
    // Workflow generation would create env strings for each secret
    const envStr = envList.map((e) => `\n          ${e}: \${{ secrets.${e} }}`).join("")
    expect(envStr).toContain("CUSTOM_API_KEY")
    expect(envStr).toContain("CUSTOM_OTHER")
  })

  test("buildGithubModelOptions uses record-key fallback when model.id is omitted", () => {
    const models = {
      "keyed-model": { name: "Keyed Model" },
      "explicit-id": { id: "explicit-id", name: "Explicit" },
      "no-name-key": {},
    }
    const opts = buildGithubModelOptions(models as unknown as Record<string, { id?: string; name?: string }>)
    const keyed = opts.find((o) => o.value === "keyed-model")
    expect(keyed).toBeDefined()
    expect(keyed!.label).toBe("Keyed Model")
    expect(keyed!.value).toBe("keyed-model")
    const explicit = opts.find((o) => o.value === "explicit-id")
    expect(explicit!.label).toBe("Explicit")
    const fallback = opts.find((o) => o.value === "no-name-key")
    expect(fallback!.label).toBe("no-name-key")
    expect(fallback!.value).toBe("no-name-key")
    // no provider/undefined path
    expect(opts.every((o) => o.value && !o.value.includes("undefined"))).toBe(true)
  })

  test("production-path workflow generation — keyed model without id, env secrets, manual fallback", () => {
    // configured custom provider with keyed model that omits embedded id
    const provider = "custom-test"
    const models = {
      "my-keyed-model": { name: "My Model" },
    }
    const env = ["CUSTOM_API_KEY", "CUSTOM_OTHER"]
    const modelOpts = buildGithubModelOptions(models as unknown as Record<string, { id?: string; name?: string }>)
    expect(modelOpts[0].value).toBe("my-keyed-model")
    expect(modelOpts[0].label).toBe("My Model")
    // provider/ model string must be provider/key, not provider/undefined
    const providerModel = `${provider}/${modelOpts[0].value}`
    expect(providerModel).toBe("custom-test/my-keyed-model")
    expect(providerModel).not.toContain("undefined")

    // env secrets generate workflow env block
    const envStr = buildGithubWorkflowEnv(provider, env)
    expect(envStr).toContain("CUSTOM_API_KEY: ${{ secrets.CUSTOM_API_KEY }}")
    expect(envStr).toContain("CUSTOM_OTHER: ${{ secrets.CUSTOM_OTHER }}")
    expect(envStr).toContain("env:")

    // amazon-bedrock omits provider env but kilo gateway adds its own
    expect(buildGithubWorkflowEnv("amazon-bedrock", env)).toBe("")
    const kiloEnv = buildGithubWorkflowEnv("kilo", [])
    expect(kiloEnv).toContain("KILO_API_KEY")
    expect(kiloEnv).toContain("KILO_ORG_ID")

    // manual fallback when no providers/models configured
    const emptyOpts = buildGithubProviderOptions({})
    expect(emptyOpts).toEqual([])
    const emptyModelOpts = buildGithubModelOptions({})
    expect(emptyModelOpts).toEqual([])
    // empty state would prompt manual entry — ensure no undefined values leak
    expect(emptyModelOpts.every((o) => o.value !== undefined)).toBe(true)
  })
})
