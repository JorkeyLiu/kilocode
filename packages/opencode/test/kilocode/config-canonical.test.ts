import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import path from "path"
import fs from "fs/promises"

const decodeV1 = Schema.decodeUnknownSync(ConfigV1.Info)

describe("canonical config via Config.Service with isolated global/project files", () => {
  test("endpoint/protocol/credential and nested models survive project precedence/null semantics", async () => {
    const globalTmp = await tmpdir()
    const projectTmp = await tmpdir()
    try {
      const prev = Global.Path.config
      ;(Global.Path as { config: string }).config = globalTmp.path
      try {
        await fs.writeFile(
          path.join(globalTmp.path, "kilo.jsonc"),
          JSON.stringify({
            $schema: "https://app.kilo.ai/config.json",
            provider: {
              acme: {
                endpoint: "https://global.example.com",
                protocol: "openai/completions",
                credential: "secret:kilo.credentials.global.provider.acme",
                name: "global",
                models: { m1: { name: "M1 global" }, m2: { name: "M2 global" } },
              },
              other: {
                endpoint: "https://global.other.test",
                protocol: "openai/completions",
                credential: "secret:kilo.credentials.global.provider.other",
                name: "other-global",
              },
            },
          }),
        )
        await fs.mkdir(path.join(projectTmp.path, ".kilo"), { recursive: true })
        await fs.writeFile(
          path.join(projectTmp.path, ".kilo", "kilo.jsonc"),
          JSON.stringify({
            $schema: "https://app.kilo.ai/config.json",
            provider: {
              acme: {
                endpoint: "https://project.example.com",
                protocol: "openai/responses",
                models: { m2: null, m3: { name: "M3 project" } },
              },
            },
          }),
        )
        const layer = Config.defaultLayer
        const result = await Effect.runPromise(
          Config.Service.use((svc) =>
            svc.get().pipe(Effect.provideService(InstanceRef, { directory: projectTmp.path } as unknown as InstanceContext)),
          ).pipe(Effect.provide(layer), Effect.scoped),
        )
        const acme = (result as unknown as { provider: Record<string, Record<string, unknown>> }).provider?.acme
        expect(acme).toBeDefined()
        expect(acme.endpoint).toBe("https://project.example.com")
        expect(acme.protocol).toBe("openai/responses")
        expect(acme.credential).toBe("secret:kilo.credentials.global.provider.acme")
        expect(acme.name).toBe("global")
        const models = acme.models as Record<string, unknown>
        expect(models.m1).toBeDefined()
        expect(models.m2 == null).toBe(true)
        expect(models.m3).toBeDefined()
        const other = (result as unknown as { provider: Record<string, Record<string, unknown>> }).provider?.other
        expect(other.endpoint).toBe("https://global.other.test")
        const decoded = decodeV1(result as unknown as Record<string, unknown>)
        expect(decoded.provider?.acme?.endpoint).toBe("https://project.example.com")
      } finally {
        ;(Global.Path as { config: string }).config = prev
      }
    } finally {
      await globalTmp[Symbol.asyncDispose]()
      await projectTmp[Symbol.asyncDispose]()
    }
  })
})

describe("legacy Provider DB canonical exclusion via actual Provider.Service", () => {
  const layer = Provider.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
  )
  const it = testEffect(layer)

  it.instance("excludes canonical-only provider, retains hybrid", () =>
    Effect.gen(function* () {
      const svc = yield* Provider.Service
      const all = yield* svc.list()
      expect(all[ProviderV2.ID.make("canon-only")]).toBeUndefined()
      const hybrid = all[ProviderV2.ID.make("hybrid")]
      expect(hybrid).toBeDefined()
      expect(hybrid?.name).toBe("Hybrid")
    }),
    {
      config: {
        provider: {
          "canon-only": {
            endpoint: "https://canon.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.canon-only",
            name: "Canon",
            models: { m1: { name: "M1" } },
          },
          hybrid: {
            endpoint: "https://hybrid.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.hybrid",
            name: "Hybrid",
            npm: "@ai-sdk/openai-compatible",
            api: "https://hybrid.test",
            models: { m1: { name: "M1" } },
            options: { apiKey: "k" },
          },
        },
      },
    },
  )

  it.instance("partial built-in override and hybrid with legacy model keys remain operational", () =>
    Effect.gen(function* () {
      const svc = yield* Provider.Service
      const all = yield* svc.list()
      const anon = all[ProviderV2.ID.make("anthropic")]
      expect(anon).toBeDefined()
      const custom = all[ProviderV2.ID.make("custom-hybrid")]
      expect(custom).toBeDefined()
      expect(all[ProviderV2.ID.make("canon-partial")]).toBeUndefined()
    }),
    {
      config: {
        provider: {
          anthropic: {
            models: { "claude-test": { name: "Claude Test Override" } },
          },
          "custom-hybrid": {
            endpoint: "https://custom.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.custom-hybrid",
            models: { m1: { name: "M1", cost: { input: 1, output: 2 } } },
          },
          "canon-partial": {
            endpoint: "https://canon.partial.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.canon-partial",
            models: { m1: { name: "M1" } },
          },
        },
      },
    },
  )

  it.instance("retains hybrids with prompt/isFree/ai_sdk_provider, excludes canonical-only", () =>
    Effect.gen(function* () {
      const svc = yield* Provider.Service
      const all = yield* svc.list()
      expect(all[ProviderV2.ID.make("canon-only2")]).toBeUndefined()
      const hp = all[ProviderV2.ID.make("hybrid-prompt")]
      expect(hp).toBeDefined()
      const hf = all[ProviderV2.ID.make("hybrid-free")]
      expect(hf).toBeDefined()
      const hs = all[ProviderV2.ID.make("hybrid-sdk")]
      expect(hs).toBeDefined()
      // ensure canonical-only remains excluded
      expect(all[ProviderV2.ID.make("canon-only2")]?.name).toBeUndefined()
    }),
    {
      config: {
        provider: {
          "canon-only2": {
            endpoint: "https://canon2.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.canon-only2",
            name: "Canon2",
            models: { m1: { name: "M1" } },
          },
          "hybrid-prompt": {
            endpoint: "https://prompt.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.hybrid-prompt",
            name: "HybridPrompt",
            models: { m1: { name: "M1", prompt: "codex" } },
          },
          "hybrid-free": {
            endpoint: "https://free.test",
            protocol: "anthropic/messages",
            credential: "secret:kilo.credentials.global.provider.hybrid-free",
            name: "HybridFree",
            models: { m1: { name: "M1", isFree: true } },
          },
          "hybrid-sdk": {
            endpoint: "https://sdk.test",
            protocol: "openai/responses",
            credential: "secret:kilo.credentials.global.provider.hybrid-sdk",
            name: "HybridSdk",
            models: { m1: { name: "M1", ai_sdk_provider: "openai" } },
          },
        },
      },
    },
  )

  it.instance("retains hybrid with disabled variant, excludes canonical-approved variant", () =>
    Effect.gen(function* () {
      const svc = yield* Provider.Service
      const all = yield* svc.list()
      expect(all[ProviderV2.ID.make("canon-approved-variant")]).toBeUndefined()
      const hd = all[ProviderV2.ID.make("hybrid-disabled")]
      expect(hd).toBeDefined()
      expect(hd?.name).toBe("HybridDisabled")
      const hdc = all[ProviderV2.ID.make("hybrid-disabled-combo")]
      expect(hdc).toBeDefined()
      expect(hdc?.name).toBe("HybridDisabledCombo")
    }),
    {
      config: {
        provider: {
          "canon-approved-variant": {
            endpoint: "https://canon.variant.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.canon-approved-variant",
            name: "CanonVariant",
            models: { m1: { name: "M1", variants: { v1: { enable_thinking: true } } } },
          },
          "hybrid-disabled": {
            endpoint: "https://disabled.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.hybrid-disabled",
            name: "HybridDisabled",
            models: { m1: { name: "M1", variants: { v1: { disabled: true } } } },
          },
          "hybrid-disabled-combo": {
            endpoint: "https://disabled.combo.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.hybrid-disabled-combo",
            name: "HybridDisabledCombo",
            models: { m1: { name: "M1", variants: { v1: { disabled: true, enable_thinking: true } } } },
          },
        },
      },
    },
  )
})
