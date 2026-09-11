import { describe, expect, test, afterEach } from "bun:test"
import { Effect, Stream, Exit, Cause, Option, Fiber, ManagedRuntime, Layer } from "effect"
import { jsonSchema } from "ai"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { LLM } from "@/session/llm"
import { withConfigSnapshot } from "@/kilocode/session/config-snapshot"
import { withGenerationAdmission } from "@/kilocode/session/generation-admission"
import * as PrivatePeer from "@/kilocode/server/private-peer-registry"
import { provideInstance, tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { AppLayer } from "@/effect/app-runtime"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PassThrough } from "node:stream"
import { JsonRpcPeer } from "@/private-worker/peer"
import type { ModelMessage } from "ai"
import { GlobalBus } from "@/bus/global"
import path from "path"
import fs from "fs/promises"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })
const originalConfig = Global.Path.config
afterEach(async () => {
  ;(Global.Path as { config: string }).config = originalConfig
  GlobalBus.removeAllListeners("event")
  await disposeAllInstances()
})
function synthModel(p = "acme", m = "m1") {
  return {
    id: ModelV2.ID.make(m),
    providerID: ProviderV2.ID.make(p),
    api: { id: m, npm: "@ai-sdk/openai-compatible", url: "" },
    name: "M1",
    family: "",
    capabilities: { temperature: false, reasoning: false, attachment: false, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: {},
  } as unknown as import("@/provider/provider").Provider.Model
}
function sseBytes() {
  const sse = [
    `data: {"id":"chatcmpl_fixture","choices":[{"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}`,
    `data: {"id":"chatcmpl_fixture","choices":[{"delta":{"content":" world"},"finish_reason":null}],"usage":null}`,
    `data: {"id":"chatcmpl_fixture","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":null}],"usage":null}`,
    `data: {"id":"chatcmpl_fixture","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
  ].map(l=>`${l}\n\n`).join("")
  return Buffer.from(sse)
}
async function withFreshRuntime<T>(fn: (runtime: ManagedRuntime.ManagedRuntime<import("@/effect/app-runtime").AppServices, never>) => Promise<T>): Promise<T> {
  const runtime = ManagedRuntime.make(AppLayer)
  try {
    return await fn(runtime as unknown as ManagedRuntime.ManagedRuntime<import("@/effect/app-runtime").AppServices, never>)
  } finally {
    await runtime.dispose()
  }
}
describe("canonical LLM.live coverage", () => {
  test("1) LLM.live canonical hit via withConfigSnapshot/withGenerationAdmission uses pinned record, no legacy calls, streams events", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(path.join(g.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", provider: { acme: { name: "Acme", endpoint: "https://api.example.com/v1", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { name: "M1" } } } } }))
      await fs.mkdir(path.join(p.path, ".kilo"), { recursive: true })
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
      await withFreshRuntime(async (runtime) => {
        await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () { const c = yield* Config.Service; return yield* c.get() })))
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        let capturedRecord: unknown
        let capturedBody: string | undefined
        let brokerCallCount = 0
        const handler = async (method: string, params: unknown, ctx: import("@/private-worker/peer").RequestContext) => {
          if (method === "provider/httpExecute") {
            const inp = params as { record: unknown; body: string }
            capturedRecord = inp.record
            capturedBody = inp.body
            brokerCallCount++
            const bytes = sseBytes()
            ctx.emit({ seq: 0, status: 200, headers: { "content-type": "text/event-stream" } })
            for (let i=0;i<bytes.length;i+=50) ctx.emit({ seq: Math.floor(i/50)+1, bytes: bytes.slice(i,i+50).toString("base64") })
            return { seq: Math.ceil(bytes.length/50), chunks: Math.ceil(bytes.length/50), bytes: bytes.length }
          }
          throw new Error("unknown")
        }
        const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const b = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: handler as never })
        a.markInitialized()
        b.markInitialized()
        try {
          await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () {
            const peer = yield* PrivatePeer.Service
            const config = yield* Config.Service
            const llm = yield* LLM.Service
            const provider = yield* Provider.Service
            const auth = yield* Auth.Service
            let legacyGetLanguage = 0
            let legacyGetProvider = 0
            let legacyAuthGet = 0
            const origGetLanguage = provider.getLanguage.bind(provider)
            const origGetProvider = provider.getProvider.bind(provider)
            const origAuthGet = auth.get.bind(auth)
            ;(provider as unknown as Record<string, unknown>).getLanguage = ((...args: unknown[]) => { legacyGetLanguage++; return (origGetLanguage as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof provider.getLanguage
            ;(provider as unknown as Record<string, unknown>).getProvider = ((...args: unknown[]) => { legacyGetProvider++; return (origGetProvider as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof provider.getProvider
            ;(auth as unknown as Record<string, unknown>).get = ((...args: unknown[]) => { legacyAuthGet++; return (origAuthGet as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof auth.get
            const lease = yield* peer.install(a)
            yield* lease.negotiate(["provider/httpExecute"])
            yield* Effect.ensuring(Effect.gen(function* () {
              const model = synthModel("acme","m1")
              // Snapshot/admission must cover Stream subscription: LLM.run resolves
              // the canonical record when the stream is consumed, not when built.
              const evts = yield* withConfigSnapshot(config, Effect.gen(function* () {
                const s = llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "test", model, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: ["sys"], messages: [{ role: "user", content: "hi" } as unknown as ModelMessage], tools: { lookup: { description: "lookup", inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } } }) } as unknown as never } })
                return yield* Stream.runCollect(s).pipe(Effect.map(c=>Array.from(c)))
              }))
              const evts2 = yield* withGenerationAdmission(config, Effect.gen(function* () {
                const s2 = llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "test2", model, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi2" } as unknown as ModelMessage], tools: {} })
                return yield* Stream.runCollect(s2).pipe(Effect.map(c=>Array.from(c)))
              }))
              expect(brokerCallCount).toBe(2)
              expect(legacyGetLanguage).toBe(0)
              expect(legacyGetProvider).toBe(0)
              expect(legacyAuthGet).toBe(0)
              expect((capturedRecord as Record<string, unknown>).endpoint).toBe("https://api.example.com/v1")
              expect((capturedRecord as Record<string, unknown>).protocol).toBe("openai/completions")
              expect(capturedBody).toBeDefined()
              if (capturedBody) { const bodyJson = JSON.parse(capturedBody); expect(bodyJson.model).toBe("m1") }
              const types = evts.map(e=>(e as {type:string}).type)
              expect(types).toContain("text-delta")
              expect(evts.some(e=>(e as {type:string}).type==="tool-call")).toBe(true)
              expect(evts.some(e=>(e as {type:string}).type==="finish")).toBe(true)
              const types2 = evts2.map(e=>(e as {type:string}).type)
              expect(types2).toContain("text-delta")
              expect(types2).toContain("finish")
            }), lease.release)
            ;(provider as unknown as Record<string, unknown>).getLanguage = origGetLanguage
            ;(provider as unknown as Record<string, unknown>).getProvider = origGetProvider
            ;(auth as unknown as Record<string, unknown>).get = origAuthGet
          })))
        } finally {
          a.dispose(); b.dispose(); aToB.destroy(); bToA.destroy()
        }
      })
    } finally {
      await p[Symbol.asyncDispose](); await g[Symbol.asyncDispose]()
    }
  }, 60000)

  test("2) in-flight generation pinned record vs next admission sees new record", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(path.join(g.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", provider: { acme: { name: "Acme", endpoint: "https://api.example.com/v1", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { name: "M1" } } } } }))
      await fs.mkdir(path.join(p.path, ".kilo"), { recursive: true })
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
      await withFreshRuntime(async (runtime) => {
        await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () { const c = yield* Config.Service; return yield* c.get() })))
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const captured: unknown[] = []
        let firstHitResolve!: () => void
        let firstHitPromise = new Promise<void>(res => firstHitResolve = res)
        let releaseResolve!: () => void
        let releasePromise = new Promise<void>(res => releaseResolve = res)
        const handler = async (method: string, params: unknown, ctx: import("@/private-worker/peer").RequestContext) => {
          if (method === "provider/httpExecute") {
            const inp = params as { record: unknown }
            captured.push(inp.record)
            if (captured.length===1) { firstHitResolve(); await releasePromise }
            const bytes = sseBytes()
            ctx.emit({ seq: 0, status: 200, headers: { "content-type": "text/event-stream" } })
            for (let i=0;i<bytes.length;i+=50) ctx.emit({ seq: Math.floor(i/50)+1, bytes: bytes.slice(i,i+50).toString("base64") })
            return { seq: Math.ceil(bytes.length/50), chunks: Math.ceil(bytes.length/50), bytes: bytes.length }
          }
          throw new Error("unknown")
        }
        const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const b = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: handler as never })
        a.markInitialized()
        b.markInitialized()
        try {
          await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () {
            const peer = yield* PrivatePeer.Service
            const config = yield* Config.Service
            const llm = yield* LLM.Service
            const lease = yield* peer.install(a)
            yield* lease.negotiate(["provider/httpExecute"])
            yield* Effect.ensuring(Effect.gen(function* () {
              const model = synthModel("acme","m1")
              const fiber = yield* Effect.forkDetach(withGenerationAdmission(config, Effect.gen(function* () {
                const s = llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "pinned", model, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi" } as unknown as ModelMessage], tools: {} })
                const evts = yield* Stream.runCollect(s).pipe(Effect.map(c=>Array.from(c)))
                return evts
              })))
              yield* Effect.promise(() => firstHitPromise)
              expect((captured[0] as Record<string, unknown>).endpoint).toBe("https://api.example.com/v1")
              yield* Effect.promise(() => fs.writeFile(path.join(g.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", provider: { acme: { name: "Acme", endpoint: "https://api.new.example.com/v1", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { name: "M1 new" } } } } })))
              const cfg = yield* Config.Service
              yield* cfg.invalidate()
              const outside = yield* cfg.getWithCanonical()
              expect((outside.canonical.providers["acme"].record as unknown as Record<string, unknown>).endpoint).toBe("https://api.new.example.com/v1")
              releaseResolve()
              const firstEvts = yield* Fiber.join(fiber)
              expect(firstEvts.length).toBeGreaterThan(0)
              expect((captured[0] as Record<string, unknown>).endpoint).toBe("https://api.example.com/v1")
              const nextEvts = yield* withGenerationAdmission(config, Effect.gen(function* () {
                const s = llm.stream({ user: { id: "u2", model: { variant: undefined } } as unknown as never, sessionID: "next", model, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi2" } as unknown as ModelMessage], tools: {} })
                return yield* Stream.runCollect(s).pipe(Effect.map(c=>Array.from(c)))
              }))
              expect(nextEvts.length).toBeGreaterThan(0)
              expect(captured.length).toBe(2)
              expect((captured[1] as Record<string, unknown>).endpoint).toBe("https://api.new.example.com/v1")
            }), lease.release)
          })))
        } finally {
          a.dispose(); b.dispose(); aToB.destroy(); bToA.destroy()
        }
      })
    } finally {
      await p[Symbol.asyncDispose](); await g[Symbol.asyncDispose]()
    }
  }, 60000)

  test("3) CanonicalNotFound/hybrid uses legacy path and hybrid excluded from provenance", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(path.join(g.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", provider: { acme: { name: "Acme", endpoint: "https://api.example.com/v1", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { name: "M1" } }, }, hybrid: { name: "Hybrid", endpoint: "https://hybrid.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.hybrid", npm: "@ai-sdk/openai-compatible", api: "https://hybrid.test", models: { m1: { name: "M1" } }, options: { apiKey: "k" } } } }))
      await fs.mkdir(path.join(p.path, ".kilo"), { recursive: true })
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
      await withFreshRuntime(async (runtime) => {
        await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () { const c = yield* Config.Service; return yield* c.get() })))
        await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () {
          const config = yield* Config.Service
          const prov = yield* config.getCanonicalProvenance()
          expect(Object.hasOwn(prov.providers, "hybrid")).toBe(false)
          expect(Object.hasOwn(prov.providers, "acme")).toBe(true)
          const llm = yield* LLM.Service
          const provider = yield* Provider.Service
          const auth = yield* Auth.Service
          let legacyGetLanguage = 0
          let legacyGetProvider = 0
          let legacyAuthGet = 0
          const origGetLanguage = provider.getLanguage.bind(provider)
          const origGetProvider = provider.getProvider.bind(provider)
          const origAuthGet = auth.get.bind(auth)
          ;(provider as unknown as Record<string, unknown>).getLanguage = ((...args: unknown[]) => { legacyGetLanguage++; return (origGetLanguage as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args).pipe(Effect.catchCause(() => Effect.succeed({ specificationVersion: "v3", provider: "test", modelId: "m1", doStream: async () => ({ stream: new ReadableStream(), rawCall: { rawPrompt: null, rawSettings: {} }, warnings: [] }) } as unknown))) }) as unknown as typeof provider.getLanguage
          ;(provider as unknown as Record<string, unknown>).getProvider = ((...args: unknown[]) => { legacyGetProvider++; return (origGetProvider as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof provider.getProvider
          ;(auth as unknown as Record<string, unknown>).get = ((...args: unknown[]) => { legacyAuthGet++; return (origAuthGet as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof auth.get
          const hybridModel = synthModel("hybrid","m1")
          yield* Effect.exit(Stream.runCollect(llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "hybrid", model: hybridModel, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi" } as unknown as ModelMessage], tools: {} })))
          expect(legacyGetProvider + legacyGetLanguage + legacyAuthGet).toBeGreaterThan(0)
          legacyGetLanguage=0; legacyGetProvider=0; legacyAuthGet=0
          const missingModel = synthModel("missing","m1")
          yield* Effect.exit(Stream.runCollect(llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "missing", model: missingModel, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi" } as unknown as ModelMessage], tools: {} })))
          expect(legacyGetProvider + legacyGetLanguage + legacyAuthGet).toBeGreaterThan(0)
          ;(provider as unknown as Record<string, unknown>).getLanguage = origGetLanguage
          ;(provider as unknown as Record<string, unknown>).getProvider = origGetProvider
          ;(auth as unknown as Record<string, unknown>).get = origAuthGet
        })))
      })
    } finally {
      await p[Symbol.asyncDispose](); await g[Symbol.asyncDispose]()
    }
  }, 60000)

  test("4) Canonical conflict and model-not-found fail before legacy/broker with InvalidRequest; broker absent fails Transport Unavailable", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(path.join(g.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", provider: { acme: { name: "Acme", endpoint: "https://api.example.com/v1", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { name: "M1" } }, }, dup: { endpoint: "https://dup.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.dup", models: { m1: { name: "M1" } } } } }))
      await fs.mkdir(path.join(p.path, ".kilo"), { recursive: true })
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", provider: { dup: { endpoint: "https://dup2.test", protocol: "openai/completions", credential: "secret:kilo.credentials.project.provider.dup", models: { m1: { name: "M1" } } } } }))
      await withFreshRuntime(async (runtime) => {
        await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () { const c = yield* Config.Service; return yield* c.get() })))
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        let brokerHits = 0
        const handler = async (method: string, _p: unknown, ctx: import("@/private-worker/peer").RequestContext) => {
          if (method === "provider/httpExecute") {
            brokerHits++
            ctx.emit({ seq: 0, status: 200, headers: {} })
            const bytes = sseBytes()
            for (let i=0;i<bytes.length;i+=50) ctx.emit({ seq: i+1, bytes: bytes.slice(i,i+50).toString("base64") })
            return { seq: 1, chunks: 1, bytes: bytes.length }
          }
          throw new Error("unknown")
        }
        const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const b = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: handler as never })
        a.markInitialized()
        b.markInitialized()
        try {
          await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () {
            const peer = yield* PrivatePeer.Service
            const llm = yield* LLM.Service
            const provider = yield* Provider.Service
            const auth = yield* Auth.Service
            const lease = yield* peer.install(a)
            yield* lease.negotiate(["provider/httpExecute"])
            yield* Effect.ensuring(Effect.gen(function* () {
              let legacyCalls = 0
              const origGetLanguage = provider.getLanguage.bind(provider)
              const origGetProvider = provider.getProvider.bind(provider)
              const origAuthGet = auth.get.bind(auth)
              ;(provider as unknown as Record<string, unknown>).getLanguage = ((...args: unknown[]) => { legacyCalls++; return (origGetLanguage as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof provider.getLanguage
              ;(provider as unknown as Record<string, unknown>).getProvider = ((...args: unknown[]) => { legacyCalls++; return (origGetProvider as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof provider.getProvider
              ;(auth as unknown as Record<string, unknown>).get = ((...args: unknown[]) => { legacyCalls++; return (origAuthGet as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof auth.get
              const dupModel = synthModel("dup","m1")
              const exitDup = yield* Stream.runCollect(llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "dup", model: dupModel, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi" } as unknown as ModelMessage], tools: {} })).pipe(Effect.exit)
              expect(Exit.isFailure(exitDup)).toBe(true)
              if (Exit.isFailure(exitDup)) { const errOpt = Cause.findErrorOption(exitDup.cause); expect(Option.isSome(errOpt)).toBe(true); if (Option.isSome(errOpt)) { const err = errOpt.value as unknown as { reason: { _tag: string } }; expect(err.reason._tag).toBe("InvalidRequest"); expect(legacyCalls).toBe(0); expect(brokerHits).toBe(0) } }
              legacyCalls=0
              const mnfModel = synthModel("acme","nope")
              const exitMnf = yield* Stream.runCollect(llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "mnf", model: mnfModel, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi" } as unknown as ModelMessage], tools: {} })).pipe(Effect.exit)
              expect(Exit.isFailure(exitMnf)).toBe(true)
              if (Exit.isFailure(exitMnf)) { const errOpt = Cause.findErrorOption(exitMnf.cause); expect(Option.isSome(errOpt)).toBe(true); if (Option.isSome(errOpt)) { const err = errOpt.value as unknown as { reason: { _tag: string } }; expect(err.reason._tag).toBe("InvalidRequest"); expect(legacyCalls).toBe(0); expect(brokerHits).toBe(0) } }
            }), lease.release)
            let legacyCalls2 = 0
            const provider2 = yield* Provider.Service
            const auth2 = yield* Auth.Service
            const origGetLanguage2 = provider2.getLanguage.bind(provider2)
            const origGetProvider2 = provider2.getProvider.bind(provider2)
            const origAuthGet2 = auth2.get.bind(auth2)
            ;(provider2 as unknown as Record<string, unknown>).getLanguage = ((...args: unknown[]) => { legacyCalls2++; return (origGetLanguage2 as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof provider2.getLanguage
            ;(provider2 as unknown as Record<string, unknown>).getProvider = ((...args: unknown[]) => { legacyCalls2++; return (origGetProvider2 as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof provider2.getProvider
            ;(auth2 as unknown as Record<string, unknown>).get = ((...args: unknown[]) => { legacyCalls2++; return (origAuthGet2 as unknown as (...a: unknown[]) => Effect.Effect<unknown>)(...args) }) as unknown as typeof auth2.get
            const acmeModel = synthModel("acme","m1")
            const exitNoBroker = yield* Stream.runCollect(llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "no-broker", model: acmeModel, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi" } as unknown as ModelMessage], tools: {} })).pipe(Effect.exit)
            expect(Exit.isFailure(exitNoBroker)).toBe(true)
            if (Exit.isFailure(exitNoBroker)) { const errOpt = Cause.findErrorOption(exitNoBroker.cause); expect(Option.isSome(errOpt)).toBe(true); if (Option.isSome(errOpt)) { const err = errOpt.value as unknown as { reason: { _tag: string; kind?: string } }; expect(err.reason._tag).toBe("Transport"); expect(err.reason.kind).toBe("Unavailable"); expect(legacyCalls2).toBe(0) } }
            ;(provider2 as unknown as Record<string, unknown>).getLanguage = origGetLanguage2
            ;(provider2 as unknown as Record<string, unknown>).getProvider = origGetProvider2
            ;(auth2 as unknown as Record<string, unknown>).get = origAuthGet2
          })))
        } finally {
          a.dispose(); b.dispose(); aToB.destroy(); bToA.destroy()
        }
      })
    } finally {
      await p[Symbol.asyncDispose](); await g[Symbol.asyncDispose]()
    }
  }, 60000)

  test("5) Interrupt outer LLM.live canonical Stream before terminal sends exactly one cancel and cleans up", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(path.join(g.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", provider: { acme: { name: "Acme", endpoint: "https://api.example.com/v1", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { name: "M1" } } } } }))
      await fs.mkdir(path.join(p.path, ".kilo"), { recursive: true })
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
      await withFreshRuntime(async (runtime) => {
        await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () { const c = yield* Config.Service; return yield* c.get() })))
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        let drops = 0
        const handler = async (method: string, _p: unknown, ctx: import("@/private-worker/peer").RequestContext) => {
          if (method === "provider/httpExecute") {
            ctx.emit({ seq: 0, status: 200, headers: { "content-type": "text/event-stream" } })
            await new Promise(() => {})
            return { seq: 0, chunks: 0, bytes: 0 }
          }
          throw new Error("unknown")
        }
        const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const b = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: handler as never })
        a.markInitialized()
        b.markInitialized()
        const origCancel = (a as unknown as { cancel: (id: unknown) => boolean }).cancel.bind(a)
        ;(a as unknown as { cancel: (id: unknown) => boolean }).cancel = (id: unknown) => { drops++; return origCancel(id as never) }
        try {
          await runtime.runPromise(provideInstance(p.path)(Effect.gen(function* () {
            const peer = yield* PrivatePeer.Service
            const llm = yield* LLM.Service
            const lease = yield* peer.install(a)
            yield* lease.negotiate(["provider/httpExecute"])
            yield* Effect.ensuring(Effect.gen(function* () {
              const model = synthModel("acme","m1")
              const fiber = yield* Effect.forkDetach(Effect.scoped(Stream.runCollect(llm.stream({ user: { id: "u1", model: { variant: undefined } } as unknown as never, sessionID: "cancel", model, agent: { name: "build", mode: "build", prompt: "", options: {}, tools: {}, permission: [] } as unknown as never, system: [], messages: [{ role: "user", content: "hi" } as unknown as ModelMessage], tools: {} }))))
              for (let i=0;i<100;i++) { if (a.getPendingCount()===1) break; yield* Effect.sleep(20) }
              expect(a.getPendingCount()).toBe(1)
              expect(drops).toBe(0)
              yield* Fiber.interrupt(fiber)
              for (let i=0;i<100;i++) { if (drops===1) break; yield* Effect.sleep(20) }
              expect(drops).toBe(1)
              expect(a.getPendingCount()).toBe(0)
              expect(b.getPendingCount?.() ?? 0).toBe(0)
            }), lease.release)
          })))
        } finally {
          a.dispose(); b.dispose(); aToB.destroy(); bToA.destroy()
        }
      })
    } finally {
      await p[Symbol.asyncDispose](); await g[Symbol.asyncDispose]()
    }
  }, 60000)
})
