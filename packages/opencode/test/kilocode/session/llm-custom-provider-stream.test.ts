import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { provideTmpdirServer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { TestLLMServer, reply } from "../../lib/llm-server"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { ModelMessage } from "ai"
import * as Log from "@opencode-ai/core/util/log"

const pid = (s: string) => (ProviderV2.ID as unknown as { make: (x: string) => ProviderV2.ID }).make(s)
const mid = (s: string) => (ModelV2.ID as unknown as { make: (x: string) => ModelV2.ID }).make(s)

Log.init({ print: false })

const deps = Layer.mergeAll(
  LLM.defaultLayer,
  Provider.defaultLayer,
  TestLLMServer.layer,
  NodeFileSystem.layer,
  CrossSpawnSpawner.defaultLayer,
  Database.defaultLayer,
  FSUtil.defaultLayer,
  Bus.layer,
  Storage.defaultLayer,
)

const it = testEffect(deps)

describe("LLM.Service custom-provider real HTTP stream — explicit config + generic adapter", () => {
  it.live("streams text-delta and finish via real local HTTP with endpoint and model assertions", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        yield* llm.push(reply().text("hello ").text("world").stop().item())
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(pid("test-custom"), mid("test-model"))
        expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
        expect(String(model.providerID)).toBe("test-custom")
        const svc = yield* LLM.Service
        const evts = yield* svc
          .stream({
            user: { id: "u1", model: { variant: undefined } } as unknown as never,
            sessionID: "test-session",
            model,
            agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never,
            system: [],
            messages: [{ role: "user", content: "hi" } as ModelMessage],
            tools: {},
          })
          .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))
        const types = evts.map((e) => e.type)
        expect(types).toContain("text-delta")
        expect(types).toContain("finish")
        const text = evts.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("")
        expect(text).toBe("hello world")
        const hits = yield* llm.hits
        expect(hits.length).toBeGreaterThan(0)
        const hit = hits[0]
        expect(hit.url.pathname).toBe("/v1/chat/completions")
        expect((hit.body as { model?: string }).model).toBe("test-model")
      }),
      {
        git: true,
        config: (url) => ({
          provider: {
            "test-custom": {
              name: "Test Custom",
              npm: "@ai-sdk/openai-compatible",
              api: url,
              models: { "test-model": { name: "Test Model" } },
              options: { apiKey: "test-key", baseURL: url },
            },
          },
        }),
      },
    ),
  )
})
