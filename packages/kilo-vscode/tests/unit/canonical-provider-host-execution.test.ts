/**
 * Canonical provider host execution seam checks (local HTTP fixture scope).
 *
 * Uses a real localhost HTTP server per case so the shared llm protocol
 * adapters (body lowering, SSE framing, stream parsing) run unmocked; only
 * the network boundary is a local fixture. Not a full runtime E2E: no UI,
 * no session generation, no CLI child.
 */

import { describe, expect, it } from "bun:test"
import {
  execute,
  executeFromService,
  CanonicalExecuteError,
  type CanonicalHostDeps,
} from "../../src/canonical-provider/canonical-executor"
import type { CanonicalProviderPayload } from "../../src/config/types"

interface Seen {
  path: string
  auth: string | null
  key: string | null
  version: string | null
  body: string
}

const sse = (...chunks: ReadonlyArray<unknown>): string =>
  `${chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`

const chatBody = () =>
  sse(
    { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
  )

const responsesBody = () =>
  sse(
    { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    },
  )

const messagesBody = () =>
  sse(
    { type: "message_start", message: { usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  )

const serve = (body: () => string, seen: Seen) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      seen.path = url.pathname
      seen.auth = req.headers.get("authorization")
      seen.key = req.headers.get("x-api-key")
      seen.version = req.headers.get("anthropic-version")
      seen.body = await req.text()
      return new Response(body(), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return server
}

const blank = (): Seen => ({ path: "", auth: null, key: null, version: null, body: "" })

const record = (endpoint: string, protocol: CanonicalProviderPayload["protocol"], ref?: string): CanonicalProviderPayload => ({
  name: "Acme",
  endpoint,
  protocol,
  models: { m1: { name: "M1" } },
  ...(ref === undefined ? {} : { credential: ref }),
})

const store = (secret: string | undefined, calls: string[]) => {
  const deps: CanonicalHostDeps = {
    resolveSecret: async (ref) => {
      calls.push(ref)
      return secret
    },
  }
  return deps
}

describe("canonical host execution seam over local HTTP fixtures", () => {
  it("materializes openai/completions to the chat route with bearer auth", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const calls: string[] = []
      const result = await execute(
        { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "Say hello." },
        store("sk-chat", calls),
      )
      expect(seen.path).toBe("/chat/completions")
      expect(seen.auth).toBe("Bearer sk-chat")
      expect(JSON.parse(seen.body).model).toBe("m1")
      expect(result.text).toBe("Hello")
      expect(result.events.some((event) => event.type === "text-delta")).toBe(true)
      expect(result.events.at(-1)?.type).toBe("finish")
      expect(calls).toEqual([ref])
      expect(JSON.stringify(result)).not.toContain("sk-chat")
    } finally {
      server.stop()
    }
  })

  it("materializes openai/responses to the responses route with bearer auth", async () => {
    const seen = blank()
    const server = serve(responsesBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const calls: string[] = []
      const result = await execute(
        { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/responses", ref), prompt: "Say hello." },
        store("sk-responses", calls),
      )
      expect(seen.path).toBe("/responses")
      expect(seen.auth).toBe("Bearer sk-responses")
      expect(JSON.parse(seen.body).model).toBe("m1")
      expect(result.text).toBe("Hello")
      expect(result.events.some((event) => event.type === "text-delta")).toBe(true)
      expect(calls).toEqual([ref])
      expect(JSON.stringify(result)).not.toContain("sk-responses")
    } finally {
      server.stop()
    }
  })

  it("materializes anthropic/messages to the messages route with key auth and version header", async () => {
    const seen = blank()
    const server = serve(messagesBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const calls: string[] = []
      const result = await execute(
        { providerId: "acme", modelId: "m1", record: record(endpoint, "anthropic/messages", ref), prompt: "Say hello." },
        store("sk-anthropic", calls),
      )
      expect(seen.path).toBe("/messages")
      expect(seen.key).toBe("sk-anthropic")
      expect(seen.version).toBe("2023-06-01")
      expect(JSON.parse(seen.body).model).toBe("m1")
      expect(result.text).toBe("Hello")
      expect(result.events.some((event) => event.type === "text-delta")).toBe(true)
      expect(calls).toEqual([ref])
      expect(JSON.stringify(result)).not.toContain("sk-anthropic")
    } finally {
      server.stop()
    }
  })

  it("reads the exact ref lazily on every call so rotation takes effect", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const calls: string[] = []
      let secret: string | undefined = "sk-first"
      const deps: CanonicalHostDeps = {
        resolveSecret: async (next) => {
          calls.push(next)
          return secret
        },
      }
      const input = { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "Say hello." }
      await execute(input, deps)
      expect(seen.auth).toBe("Bearer sk-first")
      secret = "sk-second"
      await execute(input, deps)
      expect(seen.auth).toBe("Bearer sk-second")
      expect(calls).toEqual([ref, ref])
    } finally {
      server.stop()
    }
  })

  it("reads the exact record from the config service without rebuilding the ref", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const calls: string[] = []
      const result = await executeFromService(
        {
          getScopeConfig: (scope) =>
            scope === "global" ? { provider: { acme: record(endpoint, "openai/completions", ref) } } : {},
          resolveSecret: async (next) => {
            calls.push(next)
            return "sk-service"
          },
        },
        "global",
        "acme",
        "m1",
        "Say hello.",
      )
      expect(seen.path).toBe("/chat/completions")
      expect(seen.auth).toBe("Bearer sk-service")
      expect(result.text).toBe("Hello")
      expect(calls).toEqual([ref])
    } finally {
      server.stop()
    }
  })

  it("redacts raw and encoded provider-echoed secrets from success output", async () => {
    const seen = blank()
    const secret = "sk echo/7"
    const encoded = encodeURIComponent(secret)
    const server = serve(
      () =>
        sse(
          { choices: [{ delta: { content: `raw ${secret} and encoded ${encoded} done` }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ),
      seen,
    )
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const result = await execute(
        { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "Say hello." },
        store(secret, []),
      )
      expect(result.text).toBe("raw [REDACTED] and encoded [REDACTED] done")
      const delta = result.events.find((event) => event.type === "text-delta")
      expect(delta).toMatchObject({ type: "text-delta", text: "raw [REDACTED] and encoded [REDACTED] done" })
      expect(result.events.at(-1)?.type).toBe("finish")
      expect(result.text).not.toContain(secret)
      expect(result.text).not.toContain(encoded)
      expect(JSON.stringify(result.events)).not.toContain(secret)
      expect(JSON.stringify(result.events)).not.toContain(encoded)
      expect(JSON.stringify(result)).not.toContain(secret)
    } finally {
      server.stop()
    }
  })

  it("redacts 1-3 character secrets echoed in provider errors", async () => {
    for (const secret of ["q", "qz", "qzx"]) {
      const seen = blank()
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
          seen.path = new URL(req.url).pathname
          await req.text()
          return new Response(JSON.stringify({ error: { message: `bad ${secret} key`, type: "invalid_request_error" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        },
      })
      try {
        const endpoint = `http://127.0.0.1:${server.port}`
        const ref = "secret:kilo.credentials.global.provider.acme"
        const err = await execute(
          { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "Say hello." },
          store(secret, []),
        ).catch((caught: unknown) => caught)
        expect(err).toBeInstanceOf(CanonicalExecuteError)
        expect((err as CanonicalExecuteError).code).toBe("provider")
        expect((err as Error).message).not.toContain(secret)
        expect(String(err)).not.toContain(secret)
        expect(JSON.stringify(err)).not.toContain(secret)
        expect((err as Error).cause).toBeUndefined()
      } finally {
        server.stop()
      }
    }
  })

  it("fails closed on malformed refs and records without secret or network use", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const base = record(endpoint, "openai/completions", ref)
      const cases: ReadonlyArray<{ name: string; record: CanonicalProviderPayload }> = [
        { name: "illegal prefix", record: record(endpoint, "openai/completions", "secret:other") },
        { name: "wrong kind", record: record(endpoint, "openai/completions", "secret:kilo.credentials.global.mcp.acme") },
        { name: "empty id", record: record(endpoint, "openai/completions", "secret:kilo.credentials.global.provider.") },
        {
          name: "consecutive dots",
          record: record(endpoint, "openai/completions", "secret:kilo.credentials.global.provider.acme..x"),
        },
        { name: "plaintext", record: record(endpoint, "openai/completions", "sk-plaintext") },
        { name: "extra key", record: { ...base, npm: "x" } as CanonicalProviderPayload },
        {
          name: "bad protocol",
          record: { ...base, protocol: "openai/unknown" } as unknown as CanonicalProviderPayload,
        },
        { name: "empty models", record: { ...base, models: {} } },
      ]
      for (const item of cases) {
        const calls: string[] = []
        const err = await execute(
          { providerId: "acme", modelId: "m1", record: item.record, prompt: "Say hello." },
          store("sk-chat", calls),
        ).catch((caught: unknown) => caught)
        expect(err, item.name).toBeInstanceOf(CanonicalExecuteError)
        expect(calls, item.name).toEqual([])
        expect(seen.path, item.name).toBe("")
        expect(String(err), item.name).not.toContain("sk-chat")
      }
    } finally {
      server.stop()
    }
  })

  it("malformed nested provider/model fields never reach HTTP and map to invalid-record while granular codes are preserved", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const base = record(endpoint, "openai/completions", ref)
      const malformed: ReadonlyArray<{ name: string; rec: unknown }> = [
        { name: "reasoning not boolean", rec: { ...base, models: { m1: { name: "M1", reasoning: "yes" as unknown } } } },
        { name: "modalities input not array", rec: { ...base, models: { m1: { name: "M1", modalities: { input: "bad" as unknown } } } } },
        { name: "modalities extra key", rec: { ...base, models: { m1: { name: "M1", modalities: { input: ["text"], extra: 1 as unknown } } } } },
        { name: "variants thinking wrong type", rec: { ...base, models: { m1: { name: "M1", variants: { v1: { thinking: { type: "bad" as unknown } } } } } } },
        {
          name: "variants chat_template_args wrong shape",
          rec: { ...base, models: { m1: { name: "M1", variants: { v1: { chat_template_args: { enable_thinking: "yes" as unknown } } } } } },
        },
        { name: "variants extra key", rec: { ...base, models: { m1: { name: "M1", variants: { v1: { unknownKey: true as unknown } } } } } },
        { name: "model extra key", rec: { ...base, models: { m1: { name: "M1", extra: "x" as unknown } } } },
        { name: "provider extra key", rec: { ...(base as Record<string, unknown>), extraKey: "x" } },
        { name: "model name empty", rec: { ...base, models: { m1: { name: "" } } } },
        { name: "model missing name", rec: { ...base, models: { m1: {} as unknown } } },
        { name: "models not object", rec: { ...base, models: "bad" as unknown } },
        { name: "models array", rec: { ...base, models: [] as unknown } },
        {
          name: "models null prototype",
          rec: (() => {
            const r = { ...base } as Record<string, unknown>
            const m = Object.create(null) as Record<string, unknown>
            m.m1 = { name: "M1" }
            r.models = m as unknown as typeof base.models
            return r
          })(),
        },
      ]
      for (const item of malformed) {
        const calls: string[] = []
        seen.path = ""
        const err = await execute(
          { providerId: "acme", modelId: "m1", record: item.rec, prompt: "hi" },
          store("sk-chat", calls),
        ).catch((caught: unknown) => caught)
        expect(err, item.name).toBeInstanceOf(CanonicalExecuteError)
        expect((err as CanonicalExecuteError).code, item.name).toBe("invalid-record")
        expect(calls, item.name).toEqual([])
        expect(seen.path, item.name).toBe("")
      }
      const granular: ReadonlyArray<{ name: string; rec: unknown; code: string; mid: string }> = [
        { name: "invalid-endpoint ftp", rec: { ...base, endpoint: "ftp://bad" }, code: "invalid-endpoint", mid: "m1" },
        { name: "unknown-protocol", rec: { ...base, protocol: "openai/unknown" as unknown }, code: "unknown-protocol", mid: "m1" },
        { name: "unknown-model", rec: base, code: "unknown-model", mid: "unknown" },
        { name: "missing-credential-ref", rec: { name: "Acme", endpoint, protocol: "openai/completions" as const, models: { m1: { name: "M1" } } }, code: "missing-credential-ref", mid: "m1" },
        {
          name: "invalid-credential-ref",
          rec: { ...base, credential: "secret:kilo.credentials.global.provider.other" },
          code: "invalid-credential-ref",
          mid: "m1",
        },
      ]
      for (const g of granular) {
        const calls: string[] = []
        seen.path = ""
        const err = await execute(
          { providerId: "acme", modelId: g.mid, record: g.rec, prompt: "hi" },
          store("sk-chat", calls),
        ).catch((caught: unknown) => caught)
        expect((err as CanonicalExecuteError).code, g.name).toBe(g.code)
        expect(calls, g.name).toEqual([])
        expect(seen.path, g.name).toBe("")
      }
    } finally {
      server.stop()
    }
  })

  it("fails closed on missing ref without touching secrets or the network", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const calls: string[] = []
      const err = await execute(
        { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions"), prompt: "Say hello." },
        store("sk-chat", calls),
      ).catch((caught: unknown) => caught)
      expect(err).toBeInstanceOf(CanonicalExecuteError)
      expect((err as CanonicalExecuteError).code).toBe("missing-credential-ref")
      expect(calls).toEqual([])
      expect(seen.path).toBe("")
    } finally {
      server.stop()
    }
  })

  it("fails closed on mismatched ref without touching the network", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const calls: string[] = []
      const err = await execute(
        {
          providerId: "acme",
          modelId: "m1",
          record: record(endpoint, "openai/completions", "secret:kilo.credentials.global.provider.other"),
          prompt: "Say hello.",
        },
        store("sk-chat", calls),
      ).catch((caught: unknown) => caught)
      expect(err).toBeInstanceOf(CanonicalExecuteError)
      expect(calls).toEqual([])
      expect(seen.path).toBe("")
      expect(String(err)).not.toContain("sk-chat")
    } finally {
      server.stop()
    }
  })

  it("fails closed when the owned secret is absent", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const calls: string[] = []
      const err = await execute(
        { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "Say hello." },
        store(undefined, calls),
      ).catch((caught: unknown) => caught)
      expect(err).toBeInstanceOf(CanonicalExecuteError)
      expect((err as CanonicalExecuteError).code).toBe("missing-secret")
      expect(calls).toEqual([ref])
      expect(seen.path).toBe("")
    } finally {
      server.stop()
    }
  })

  it("keeps provider errors and serialized surfaces free of the secret", async () => {
    const seen = blank()
    const secret = "sk-live-secret"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        seen.path = new URL(req.url).pathname
        seen.auth = req.headers.get("authorization")
        await req.text()
        return new Response(JSON.stringify({ error: { message: "boom", type: "invalid_request_error" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const err = await execute(
        { providerId: "acme", modelId: "m1", record: record(endpoint, "openai/completions", ref), prompt: "Say hello." },
        store(secret, []),
      ).catch((caught: unknown) => caught)
      expect(err).toBeInstanceOf(CanonicalExecuteError)
      expect((err as CanonicalExecuteError).code).toBe("provider")
      expect(String(err)).not.toContain(secret)
      expect(JSON.stringify(err)).not.toContain(secret)
      expect(seen.path).toBe("/chat/completions")
      expect(seen.auth).toBe(`Bearer ${secret}`)
    } finally {
      server.stop()
    }
  })

  it("regression: modalities array and inherited model IDs are trust-boundary escapes without secret or network use", async () => {
    const seen = blank()
    const server = serve(chatBody, seen)
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const ref = "secret:kilo.credentials.global.provider.acme"
      const secret = "sk-regression-secret"
      const base = record(endpoint, "openai/completions", ref)
      // modalities: [] (including empty array) must be invalid-record before model selection, no secret, no HTTP
      {
        const rec = { ...base, models: { m1: { name: "M1", modalities: [] as unknown } } }
        const calls: string[] = []
        seen.path = ""
        const err = await execute({ providerId: "acme", modelId: "m1", record: rec, prompt: "hi" }, store(secret, calls)).catch((c: unknown) => c)
        expect(err).toBeInstanceOf(CanonicalExecuteError)
        expect((err as CanonicalExecuteError).code).toBe("invalid-record")
        expect(calls).toEqual([])
        expect(seen.path).toBe("")
        expect(String(err)).not.toContain(secret)
        expect(JSON.stringify(err)).not.toContain(secret)
      }
      {
        const rec = { ...base, models: { m1: { name: "M1", modalities: ["text"] as unknown } } }
        const calls: string[] = []
        seen.path = ""
        const err = await execute({ providerId: "acme", modelId: "m1", record: rec, prompt: "hi" }, store(secret, calls)).catch((c: unknown) => c)
        expect(err).toBeInstanceOf(CanonicalExecuteError)
        expect((err as CanonicalExecuteError).code).toBe("invalid-record")
        expect(calls).toEqual([])
        expect(seen.path).toBe("")
      }
      // inherited model IDs must be unknown-model, never reach secret resolution or HTTP
      for (const inherited of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
        const calls: string[] = []
        seen.path = ""
        const err = await execute({ providerId: "acme", modelId: inherited, record: base, prompt: "hi" }, store(secret, calls)).catch((c: unknown) => c)
        expect(err, inherited).toBeInstanceOf(CanonicalExecuteError)
        expect((err as CanonicalExecuteError).code, inherited).toBe("unknown-model")
        expect(calls, inherited).toEqual([])
        expect(seen.path, inherited).toBe("")
        expect(String(err), inherited).not.toContain(secret)
        expect(JSON.stringify(err), inherited).not.toContain(secret)
      }
      // also ensure plain own model still works (control)
      {
        const calls: string[] = []
        seen.path = ""
        const result = await execute({ providerId: "acme", modelId: "m1", record: base, prompt: "hi" }, store(secret, calls))
        expect(result.text).toBe("Hello")
        expect(calls).toEqual([ref])
        expect(seen.path).toBe("/chat/completions")
      }
    } finally {
      server.stop()
    }
  })
})
